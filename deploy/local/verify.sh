#!/usr/bin/env bash
# `pnpm deploy:local [-- --keep]` — the GCP deploy kit end to end on this machine (Stage B,
# spec/architecture.md §12.7). Runs deploy/docker-compose.prod.yml + deploy/docker-compose.local.yml
# as compose project `blog0-prodlocal` (own volumes, own Postgres, Mailpit as Listmonk's ONLY SMTP;
# the dev stack `blog0` — Listmonk :9000, Postgres :5433 — is never touched). No cloud call, no real mail.
#
# Steps (each prints `deploy-local: <step>`):
#   1 config     compose config -q: prod alone (env templates) and prod + local
#   2 up         build blog0 + scheduler images, up -d --wait (release runs first)
#   3 release    docker compose run --rm release again → "0 pending: OK" (idempotent)
#   4 seed       site posts + fixture TLDR decks from the host (0 AI calls); a media file in the volume
#   5 listmonk   deploy/listmonk-settings.sh (root URL news.localtest.me:8443, SMTP → mailpit:1025)
#   6 tracking   list + subscriber + campaign ({{ TrackLink }} + {{ TrackView }}) → Mailpit; the
#                captured news-host URLs through Caddy: click → 3xx to the target, pixel → 200 image/png,
#                List-Unsubscribe page (+ its assets) → 200; Listmonk counts the view + click
#   7 scheduler  node /app/newsletter-tick.mjs, media-backup.sh (file mirrored), supercronic -test
#   8 smoke      BLOG0_SMOKE_RESOLVE=127.0.0.1 scripts/deploy-smoke.sh --insecure …  → PASS
#   9 non-root   blog0 and scheduler run as uid 1000; the listmonk process + uploads volume are uid 1000 (PUID)
# Exit 0 = `deploy-local: PASS`; 3 = PENDING DOCKER (never a pass); anything else = FAIL.
# The stack is torn down (down -v) on exit unless --keep. Ports: 8080/8443 (Caddy), 127.0.0.1:3491
# (Listmonk admin), :3494 (Postgres), :3495 (Mailpit UI/API).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROJECT=blog0-prodlocal
KEEP=0
for a in "$@"; do
  case "$a" in
    --) ;;
    --keep) KEEP=1 ;;
    *)
      echo "usage: deploy/local/verify.sh [--keep]" >&2
      exit 2
      ;;
  esac
done

BLOG=https://blog.localtest.me:8443
NEWS=https://news.localtest.me:8443
NEWS_HOSTPORT=news.localtest.me:8443
LISTMONK=http://127.0.0.1:3491
MAILPIT=http://127.0.0.1:3495
PG_HOST_URL=postgres://blog0:blog0@127.0.0.1:3494/blog0
LOCAL_ENV=deploy/local/listmonk.env
STEP=start

say() { echo "deploy-local: $*"; }
step() {
  STEP="$1"
  say "$*"
}
fail() {
  say "FAIL ${STEP}${1:+ — $1}"
  exit 1
}

if ! docker info >/dev/null 2>&1; then
  echo "PENDING DOCKER: docker daemon not reachable (start it: colima start, then pnpm deploy:local)"
  exit 3
fi

compose_bin() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "neither 'docker compose' nor 'docker-compose' is available"
  fi
}
dc() { compose_bin -p "$PROJECT" -f deploy/docker-compose.prod.yml -f deploy/docker-compose.local.yml --env-file deploy/local/compose.env "$@"; }

WORK="$(mktemp -d -t deploy-local.XXXXXX)"
cleanup() {
  local status=$?
  if [[ "$KEEP" == 1 ]]; then
    say "--keep: stack left running (down: docker compose -p ${PROJECT} -f deploy/docker-compose.prod.yml -f deploy/docker-compose.local.yml --env-file deploy/local/compose.env down -v)"
  elif [[ "$STEP" != start && "$STEP" != config ]]; then
    if [[ $status -ne 0 ]]; then
      dc logs --tail 25 release blog0 listmonk caddy scheduler 2>&1 | tail -n 120 || true
    fi
    say "teardown (down -v)"
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit $status
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

json() { # <file> <expression over d>
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(function(d){return eval(process.argv[2])})(d);process.stdout.write(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"
}

# --- 1. config ------------------------------------------------------------------------------------
step config "compose config -q (prod alone with the env templates; prod + local)"
mkdir -p "${WORK}/prod"
cp deploy/docker-compose.prod.yml deploy/Caddyfile "${WORK}/prod/"
cp deploy/blog0.env.example "${WORK}/prod/blog0.env"
cp deploy/listmonk.env.example "${WORK}/prod/listmonk.env"
compose_bin -f "${WORK}/prod/docker-compose.prod.yml" --env-file deploy/compose.env.example config -q || fail "prod compose config"
dc config -q || fail "prod + local compose config"
[[ "$(dc config --format json | json /dev/stdin 'd.name')" == "$PROJECT" ]] || fail "project name is not ${PROJECT}"
# Ports must be free unless this project already holds them (a --keep run).
if [[ -z "$(dc ps -q 2>/dev/null)" ]]; then
  for p in 8080 8443 3491 3494 3495; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then fail "port ${p} is already in use"; fi
  done
fi

# --- 2. build + up --------------------------------------------------------------------------------
step up "build blog0:prodlocal + blog0-scheduler:prodlocal, up -d --wait"
dc build release || fail "build the blog0 image"
dc build scheduler || fail "build the scheduler image"
dc up -d --build --wait --wait-timeout 300 || fail "compose up"
dc ps --format '{{.Service}} {{.State}} {{.Status}}' | sed 's/^/  /'
dc logs release 2>&1 | grep -q '0 pending: OK' || fail "the release service did not report '0 pending: OK'"

# --- 3. release is idempotent -------------------------------------------------------------------------
step release "docker compose run --rm release (second run)"
out="$(dc run --rm -T release 2>&1)" || {
  echo "$out"
  fail "release exited non-zero"
}
echo "$out" | grep -E '^(release|site)' | sed 's/^/  /'
grep -q '0 pending: OK' <<<"$out" || fail "release output lacks '0 pending: OK'"

# --- 4. seed (host → 127.0.0.1:3494; stubs only: nothing can reach a relay or the dev Listmonk) ------
step seed "posts + fixture TLDR decks (0 AI calls) + a media file"
seed_env=(
  BLOG0_DATABASE_URL="$PG_HOST_URL" BLOG0_SITE_SLUG=blog0 BLOG0_NEWSLETTER_SENDER=stub BLOG0_SMTP_HOST=
  BLOG0_LISTMONK_URL= BLOG0_LISTMONK_API_USER= BLOG0_LISTMONK_API_TOKEN= BLOG0_LISTMONK_LIST_ID=
  BLOG0_HEARTBEAT_BACKUP_URL= BLOG0_HEARTBEAT_TICK_URL= BLOG0_LOG_FILE= BLOG0_STORAGE_DIR="${WORK}/storage"
)
env "${seed_env[@]}" pnpm -s db:seed:posts || fail "pnpm db:seed:posts"
env "${seed_env[@]}" pnpm -s seed:tldr -- --source fixture || fail "pnpm seed:tldr -- --source fixture"
dc exec -T blog0 node -e "require('fs').writeFileSync('/data/storage/verify-media.txt','ok')" || fail "write /data/storage/verify-media.txt"

# --- 5. Listmonk settings (SMTP → Mailpit only) -----------------------------------------------------
step listmonk "deploy/listmonk-settings.sh ${LISTMONK}"
bash deploy/listmonk-settings.sh --env-file "$LOCAL_ENV" "$LISTMONK" || fail "listmonk-settings.sh"

# --- 6. tracking through Caddy's news host ------------------------------------------------------------
step tracking "campaign → Mailpit → open + click through ${NEWS_HOSTPORT}"
ADMIN_USER="$(sed -n 's/^LISTMONK_ADMIN_USER=//p' "$LOCAL_ENV")"
ADMIN_PASSWORD="$(sed -n 's/^LISTMONK_ADMIN_PASSWORD=//p' "$LOCAL_ENV")"
JAR="${WORK}/jar"
page="$(curl -sS -m 10 -c "$JAR" -b "$JAR" "${LISTMONK}/admin/login")" || fail "GET /admin/login"
nonce="$(printf '%s' "$page" | grep -oE 'name="nonce"[^>]*value="[^"]*"' | sed -E 's/.*value="([^"]*)"/\1/')"
code="$(curl -sS -m 10 -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "${LISTMONK}/admin/login" \
  --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${ADMIN_PASSWORD}" \
  --data-urlencode "nonce=${nonce}" --data-urlencode "next=/admin")"
[[ "$code" == 302 ]] || fail "Listmonk admin login → ${code}"
lm() { # <method> <path> <out> [json]
  local c
  if [[ -n "${4:-}" ]]; then
    c="$(curl -sS -m 20 -b "$JAR" -o "$3" -w '%{http_code}' -X "$1" -H 'content-type: application/json' -d "$4" "${LISTMONK}$2")"
  else
    c="$(curl -sS -m 20 -b "$JAR" -o "$3" -w '%{http_code}' -X "$1" "${LISTMONK}$2")"
  fi
  [[ "$c" == 2* ]] || fail "$1 $2 → ${c}: $(head -c 300 "$3")"
}
# Enabled SMTP must be exactly the sink before anything is sent.
lm GET /api/settings "${WORK}/s.json"
smtp="$(json "${WORK}/s.json" 'd.data.smtp.filter(s=>s.enabled).map(s=>s.host+":"+s.port).join(",")')"
[[ "$smtp" == "mailpit:1025" ]] || fail "Listmonk's enabled SMTP is '${smtp}', expected exactly mailpit:1025"
RCPT="verify-$(date +%s)@localtest.me"
lm POST /api/lists "${WORK}/l.json" '{"name":"deploy-local-verify","type":"private","optin":"single"}'
LIST_ID="$(json "${WORK}/l.json" 'd.data.id')"
lm POST /api/subscribers "${WORK}/sub.json" "{\"email\":\"${RCPT}\",\"name\":\"Verify\",\"status\":\"enabled\",\"lists\":[${LIST_ID}],\"preconfirm_subscriptions\":true}"
TARGET="${BLOG}/"
body="$(node -e 'process.stdout.write(JSON.stringify({name:"deploy-local verify",subject:"deploy-local verify",lists:[Number(process.argv[1])],type:"regular",content_type:"html",
  body:`<p>Tracking check: <a href="{{ TrackLink \"${process.argv[2]}\" }}">read</a></p>{{ TrackView }}`}))' "$LIST_ID" "$TARGET")"
lm POST /api/campaigns "${WORK}/c.json" "$body"
CAMP_ID="$(json "${WORK}/c.json" 'd.data.id')"
lm PUT "/api/campaigns/${CAMP_ID}/status" "${WORK}/st.json" '{"status":"running"}'
msg_id=""
deadline=$((SECONDS + 90))
while [[ -z "$msg_id" ]]; do
  ((SECONDS < deadline)) || fail "no Mailpit message for ${RCPT} within 90 s"
  sleep 2
  curl -fsS -m 5 -o "${WORK}/m.json" "${MAILPIT}/api/v1/search?query=to:${RCPT}" || continue
  msg_id="$(json "${WORK}/m.json" '(d.messages[0]||{}).ID')"
done
curl -fsS -m 10 -o "${WORK}/msg.json" "${MAILPIT}/api/v1/message/${msg_id}" || fail "Mailpit GET message"
curl -fsS -m 10 -o "${WORK}/hdr.json" "${MAILPIT}/api/v1/message/${msg_id}/headers" || fail "Mailpit GET headers"
# Every news-host URL in the message (HTML + text + List-Unsubscribe), UUIDs shown as U.
node -e '
  const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const h=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const hay=[m.HTML||"",m.Text||"",JSON.stringify(h)].join("\n").replace(/&amp;/g,"&");
  const re=new RegExp("https://"+process.argv[3].replace(/[.]/g,"\\.")+"/[^\"<>\\s]+","g");
  const urls=[...new Set(hay.match(re)||[])];
  fs.writeFileSync(process.argv[4], urls.join("\n")+"\n");
' "${WORK}/msg.json" "${WORK}/hdr.json" "$NEWS_HOSTPORT" "${WORK}/urls.txt"
say "  news-host URL shapes in the captured message:"
sed -E 's#https://[^/]+##; s#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#<uuid>#g' "${WORK}/urls.txt" | sort -u | sed 's/^/    /'
LINK="$(grep -E '/link/' "${WORK}/urls.txt" | head -n 1 || true)"
PIXEL="$(grep -E '/px\.png' "${WORK}/urls.txt" | head -n 1 || true)"
UNSUB="$(grep -E '/subscription/' "${WORK}/urls.txt" | head -n 1 || true)"
[[ -n "$LINK" ]] || fail "no ${NEWS_HOSTPORT}/link/… URL in the message"
[[ -n "$PIXEL" ]] || fail "no ${NEWS_HOSTPORT}/…/px.png URL in the message"
[[ -n "$UNSUB" ]] || fail "no ${NEWS_HOSTPORT}/subscription/… URL (List-Unsubscribe) in the message"
EDGE=(curl -sS -m 10 --insecure --resolve "${NEWS_HOSTPORT}:127.0.0.1" --resolve "blog.localtest.me:8443:127.0.0.1")
IFS='|' read -r code ctype loc < <("${EDGE[@]}" -o /dev/null -w '%{http_code}|%{content_type}|%{redirect_url}\n' "$LINK")
[[ "$code" == 3* && "$loc" == "$TARGET" ]] || fail "click ${LINK} → ${code} ${loc} (expected 3xx to ${TARGET})"
say "  click: ${code} → ${loc}"
IFS='|' read -r code ctype < <("${EDGE[@]}" -o "${WORK}/px" -w '%{http_code}|%{content_type}\n' "$PIXEL")
[[ "$code" == 200 && "$ctype" == image/png* ]] || fail "pixel ${PIXEL} → ${code} ${ctype}"
say "  open pixel: ${code} ${ctype}"
# Every other captured news-host URL (e.g. the default template's "view in browser" /campaign/<c>/<s>)
# must also reach Listmonk (no edge denial, < 400).
while IFS= read -r u; do
  [[ -n "$u" && "$u" != "$LINK" ]] || continue
  hdrs="$("${EDGE[@]}" -o /dev/null -D - "$u")" || fail "GET ${u}"
  c="$(head -n 1 <<<"$hdrs" | awk '{print $2}')"
  ! grep -qi '^x-blog0-edge:' <<<"$hdrs" || fail "${u} was denied by the edge"
  ((c < 400)) || fail "${u} → ${c}"
done <"${WORK}/urls.txt"
say "  every captured news-host URL reaches Listmonk through the edge"
UNSUB_PAGE="${UNSUB%%\?*}"
IFS='|' read -r code ctype < <("${EDGE[@]}" -o "${WORK}/unsub.html" -w '%{http_code}|%{content_type}\n' "$UNSUB_PAGE")
[[ "$code" == 200 ]] || fail "unsubscribe page ${UNSUB_PAGE} → ${code}"
say "  unsubscribe page (GET only, nothing submitted): ${code}"
# The page's own assets must pass the edge too.
assets="$(grep -oE '(href|src)="[^"]+"' "${WORK}/unsub.html" | sed -E 's/^(href|src)="([^"]+)"$/\2/' | grep -E "^(/|https://${NEWS_HOSTPORT}/)" | grep -vE '^/subscription/|/subscription/' | sort -u || true)"
for a in $assets; do
  [[ "$a" == /* ]] && a="${NEWS}${a}"
  c="$("${EDGE[@]}" -o /dev/null -w '%{http_code}' "$a")"
  say "  page asset ${a#"${NEWS}"} → ${c}"
  [[ "$c" == 200 ]] || fail "unsubscribe page asset ${a} → ${c} through the edge"
done
# Listmonk recorded the open and the click.
deadline=$((SECONDS + 30))
while :; do
  lm GET "/api/campaigns/${CAMP_ID}" "${WORK}/cs.json"
  views="$(json "${WORK}/cs.json" 'd.data.views')"
  clicks="$(json "${WORK}/cs.json" 'd.data.clicks')"
  [[ "${views:-0}" -ge 1 && "${clicks:-0}" -ge 1 ]] && break
  ((SECONDS < deadline)) || fail "Listmonk counts views=${views} clicks=${clicks} (expected ≥ 1 each)"
  sleep 2
done
say "  Listmonk campaign ${CAMP_ID}: views ${views}, clicks ${clicks}"

# --- 7. scheduler -----------------------------------------------------------------------------------
step scheduler "newsletter tick, media backup, crontab"
out="$(dc exec -T scheduler node /app/newsletter-tick.mjs 2>&1)" || {
  echo "$out"
  fail "node /app/newsletter-tick.mjs exited non-zero"
}
grep -E '^digest: ' <<<"$out" | sed 's/^/  /' || fail "tick printed no 'digest:' line"
out="$(dc exec -T scheduler /app/scheduler/media-backup.sh 2>&1)" || {
  echo "$out"
  fail "media-backup.sh exited non-zero"
}
echo "  $out"
[[ "$(dc exec -T scheduler cat /backup/media/verify-media.txt)" == ok ]] || fail "/backup/media/verify-media.txt is not 'ok'"
dc exec -T scheduler supercronic -test /app/scheduler/crontab >/dev/null 2>&1 || fail "supercronic -test /app/scheduler/crontab"
say "  media mirrored to /backup/media; crontab valid"

# --- 8. smoke ---------------------------------------------------------------------------------------
step smoke "scripts/deploy-smoke.sh --insecure ${BLOG} ${NEWS}"
BLOG0_SMOKE_RESOLVE=127.0.0.1 bash scripts/deploy-smoke.sh --insecure "$BLOG" "$NEWS" || fail "deploy-smoke"

# --- 9. non-root ------------------------------------------------------------------------------------
step non-root "uid of blog0, scheduler and listmonk"
for s in blog0 scheduler; do
  uid="$(dc exec -T "$s" id -u | tr -d '\r')"
  [[ "$uid" == 1000 ]] || fail "${s} runs as uid ${uid}, expected 1000"
done
# Listmonk: the image entrypoint starts as root and drops to PUID:PGID (1000) via su-exec — check the
# running `listmonk` process and the uploads volume, not `exec id` (which is root by design).
lm="$(dc exec -T listmonk sh -c 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = listmonk ] && stat -c %u "$p"; done; stat -c %u /listmonk/uploads' | tr -d '\r' | sort -u | tr '\n' ' ')"
[[ "$lm" == "1000 " ]] || fail "listmonk process / uploads owned by uid(s) '${lm}', expected 1000"
say "  blog0 1000, scheduler 1000, listmonk 1000 (process + uploads)"

STEP=done
say PASS
