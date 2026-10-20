#!/usr/bin/env bash
# `pnpm deploy:local [-- --keep]` - the GCP deploy kit end to end on this machine (spec/architecture.md
# §12.7). It runs the REAL deploy/vm/deploy-remote.sh (the script .github/workflows/deploy.yml runs on
# blog0-vm) against deploy/vm/docker-compose.yml + deploy/local/docker-compose.yml as compose project
# `blog0-prodlocal`: own volumes, a TLS Postgres 17 as the Cloud SQL stand-in, Mailpit as Listmonk's ONLY
# SMTP. The dev stack `blog0` (Listmonk :9000, Postgres :5433) and :3410 are never touched. No cloud call,
# no real mail. Env files come from deploy/vm/render-env.sh with the dev-only values of deploy/local/render.env.
#
# Steps (each prints `deploy-local: <step>`):
#   1 config     render env files; compose config -q (VM compose alone and + local override)
#   2 build      docker build --target app / scheduler (tagged like the Artifact Registry images)
#   3 deploy     deploy-remote.sh: release (owner role, restricted role blog0_app) -> content seed ->
#                Listmonk install/upgrade -> API user -> settings -> up -d --wait; no secret in its output
#   4 redeploy   the same sha again: idempotent (0 pending, seed skipped, token kept)
#   5 db-role    blog0 runs as blog0_app over TLS: seeded articles readable, DROP/ALTER refused
#   6 listmonk   enabled SMTP = mailpit:1025 only; settings applied
#   7 tracking   list + subscriber + campaign ({{ TrackLink }} + {{ TrackView }}) -> Mailpit; the captured
#                https://<site>/lm/... URLs, requested through BLOG0'S port 3490 (the image's /lm rewrites ->
#                http://listmonk:9000): click -> 307 to the target, pixel -> 200 image/png, List-Unsubscribe
#                page (+ its assets) -> 200; Listmonk counts the view + click
#   8 scheduler  node /app/newsletter-tick.mjs, media-backup.sh (file mirrored), supercronic -test
#  9 smoke      scripts/deploy-smoke.sh --direct http://127.0.0.1:3490 -> PASS (one base URL; incl. the /lm checks)
#  10 non-root   blog0 and scheduler run as uid 1000; the listmonk process + uploads volume are uid 1000
# Exit 0 = `deploy-local: PASS`; 3 = PENDING DOCKER (never a pass); anything else = FAIL.
# The stack is torn down (down -v, images removed) on exit unless --keep. Ports (127.0.0.1): 3490 blog0,
# 3491 Listmonk, 3494 Postgres, 3495 Mailpit.
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

BLOG=http://127.0.0.1:3490
LISTMONK=http://127.0.0.1:3491
SITE_HOST=blog.localtest.me # = SITE_DOMAIN of deploy/local/render.env; Listmonk's root URL is https://${SITE_HOST}/lm
MAILPIT=http://127.0.0.1:3495
RUN="${ROOT}/var/deploy-local"
STAGE="${RUN}/stage"
DIR="${RUN}/opt"
TAG="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo 0123456789ab)"
STEP=start

say() { echo "deploy-local: $*"; }
step() {
  STEP="$1"
  say "$*"
}
fail() {
  say "FAIL ${STEP}${1:+ - $1}"
  exit 1
}

if ! docker info >/dev/null 2>&1; then
  echo "PENDING DOCKER: docker daemon not reachable (start it: colima start, then pnpm deploy:local)"
  exit 3
fi
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else fail "docker compose (v2.24+) is required"; fi
command -v jq >/dev/null 2>&1 || fail "jq is required (deploy/vm/render-env.sh)"

# Dev-only inputs (deploy/local/render.env): exported for render-env.sh and the assertions below.
set -a
# shellcheck source=render.env
source deploy/local/render.env
set +a

dc() {
  "${COMPOSE[@]}" --project-directory "$DIR" -f "${DIR}/docker-compose.yml" -f "${DIR}/docker-compose.local.yml" \
    --env-file "${DIR}/compose.env" "$@"
}
IMG_APP="" IMG_SCHED=""
WORK="$(mktemp -d -t deploy-local.XXXXXX)"
cleanup() {
  local status=$?
  if [[ "$KEEP" == 1 ]]; then
    say "--keep: stack left running (down: docker compose -p ${PROJECT} --project-directory ${DIR} -f ${DIR}/docker-compose.yml -f ${DIR}/docker-compose.local.yml --env-file ${DIR}/compose.env down -v)"
  else
    if [[ -f "${DIR}/compose.env" ]]; then
      if [[ $status -ne 0 && "$STEP" != start && "$STEP" != config ]]; then
        dc logs --tail 25 blog0 listmonk scheduler postgres 2>&1 | grep -viE 'password|token' | tail -n 100 || true
      fi
      say "teardown (down -v)"
      dc down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    [[ -n "$IMG_APP" ]] && docker rmi "${IMG_APP}:${TAG}" >/dev/null 2>&1 || true
    [[ -n "$IMG_SCHED" ]] && docker rmi "${IMG_SCHED}:${TAG}" >/dev/null 2>&1 || true
    rm -rf "$RUN" 2>/dev/null || true
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
local_url() { # a captured https://blog.localtest.me/lm/… URL -> blog0's own port (the /lm rewrites)
  printf '%s' "${1/https:\/\/${SITE_HOST}/${BLOG}}"
}

# Renders the stage exactly as .github/workflows/deploy.yml does, with the local differences:
# media backup to a volume, direct 127.0.0.1 ports (never :3410 / the dev Listmonk :9000).
make_stage() {
  rm -rf "$STAGE"
  mkdir -p "$STAGE" "$DIR"
  bash deploy/vm/render-env.sh "$STAGE" "$TAG" >/dev/null || fail "render-env.sh"
  sed -i.bak 's#^MEDIA_BACKUP_DEST=.*#MEDIA_BACKUP_DEST=/backup/media#' "${STAGE}/compose.env" && rm -f "${STAGE}/compose.env.bak"
  {
    echo "BLOG0_HTTP_BIND=127.0.0.1"
    echo "BLOG0_HOST_PORT=3490"
    echo "LISTMONK_HTTP_BIND=127.0.0.1"
    echo "LISTMONK_HOST_PORT=3491"
  } >>"${STAGE}/compose.env"
  cp deploy/vm/docker-compose.yml deploy/vm/deploy-remote.sh deploy/listmonk-api.sh deploy/listmonk-settings.sh "$STAGE/"
  cp deploy/local/docker-compose.yml "${DIR}/docker-compose.local.yml"
  cp deploy/local/init-db.sh "${DIR}/init-db.sh"
}
run_deploy() { # -> $WORK/deploy.out; fails with the (secret-free) output on error
  BLOG0_DEPLOY_DIR="$DIR" BLOG0_DEPLOY_LOCAL=1 BLOG0_COMPOSE_EXTRA="${DIR}/docker-compose.local.yml" \
    bash "${STAGE}/deploy-remote.sh" "$TAG" >"${WORK}/deploy.out" 2>&1 || {
    sed 's/^/  | /' "${WORK}/deploy.out"
    fail "deploy-remote.sh exited non-zero"
  }
  sed 's/^/  | /' "${WORK}/deploy.out"
  # No secret value may appear in the deploy output.
  for v in BLOG0_DB_OWNER_PASSWORD BLOG0_DB_APP_PASSWORD LISTMONK_DB_PASSWORD LISTMONK_ADMIN_PASSWORD BLOG0_ADMIN_PASSWORD BLOG0_SMTP_PASS BLOG0_SESSION_SECRET; do
    ! grep -qF -- "${!v}" "${WORK}/deploy.out" || fail "the value of ${v} appears in the deploy output"
  done
  if [[ -d "$STAGE" ]] && ls "$STAGE"/*.env >/dev/null 2>&1; then fail "the stage still holds env files after the deploy"; fi
}

# --- 1. config ------------------------------------------------------------------------------------
step config "render env files; compose config -q (VM compose; + local override)"
for p in 3490 3491 3494 3495; do
  if [[ -z "$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null)" ]] && (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then
    fail "port ${p} is already in use"
  fi
done
make_stage
cp "${STAGE}"/*.env "${STAGE}/docker-compose.yml" "$DIR/"
dc config -q || fail "VM + local compose config"
"${COMPOSE[@]}" --project-directory "$DIR" -f "${DIR}/docker-compose.yml" --env-file "${DIR}/compose.env" config -q || fail "VM compose config"
[[ "$(dc config --format json | json /dev/stdin 'd.name')" == "$PROJECT" ]] || fail "project name is not ${PROJECT}"
ls -l "${STAGE}"/*.env | awk '{print $1}' | grep -vqx -- '-rw-------' && fail "an env file is not mode 600"
IMG_APP="$(sed -n 's/^BLOG0_IMAGE=//p' "${DIR}/compose.env")"
IMG_SCHED="$(sed -n 's/^BLOG0_SCHEDULER_IMAGE=//p' "${DIR}/compose.env")"
rm -f "${DIR}"/blog0.env "${DIR}"/release.env "${DIR}"/listmonk.env "${DIR}"/compose.env "${DIR}"/docker-compose.yml

# --- 2. build -------------------------------------------------------------------------------------------
step build "docker build --target app + scheduler (${IMG_APP}:${TAG})"
docker build -q --target app -t "${IMG_APP}:${TAG}" . >/dev/null || fail "build the app image"
docker build -q --target scheduler -t "${IMG_SCHED}:${TAG}" . >/dev/null || fail "build the scheduler image"

# --- 3. deploy ------------------------------------------------------------------------------------------
step deploy "deploy-remote.sh ${TAG} (first deploy)"
run_deploy
grep -q 'app role blog0_app ok (created)' "${WORK}/deploy.out" || fail "first deploy did not create the app role"
grep -q '5 posts created' "${WORK}/deploy.out" || fail "first deploy did not seed the 5 posts"
[[ -f "${DIR}/listmonk-api.env" ]] || fail "listmonk-api.env missing"
[[ "$(ls -l "${DIR}/listmonk-api.env" | awk '{print $1}')" == "-rw-------" ]] || fail "listmonk-api.env is not mode 600"
grep -q '^BLOG0_LISTMONK_API_TOKEN=.' "${DIR}/listmonk-api.env" || fail "listmonk-api.env has no token"

# --- 4. redeploy (idempotent) ---------------------------------------------------------------------------------------
step redeploy "deploy-remote.sh ${TAG} again"
make_stage
run_deploy
grep -q '0 pending: OK' "${WORK}/deploy.out" || fail "redeploy: not 0 pending"
grep -q 'app role blog0_app ok (updated)' "${WORK}/deploy.out" || fail "redeploy: app role not 'updated'"
grep -q 'article(s).*skipped' "${WORK}/deploy.out" || fail "redeploy: the content seed did not skip"
grep -q 'token kept' "${WORK}/deploy.out" || fail "redeploy: the Listmonk API token was not kept"

# --- 5. the runtime DB role ---------------------------------------------------------------------------------------------
step db-role "blog0 connects as blog0_app over TLS; DDL refused"
psql_app() { dc exec -T -e "PGPASSWORD=${BLOG0_DB_APP_PASSWORD}" -e PGSSLMODE=require postgres psql -h 127.0.0.1 -U blog0_app -d blog0 -tAq "$@"; }
[[ "$(psql_app -c "select ssl from pg_stat_ssl where pid = pg_backend_pid()")" == t ]] || fail "the app role's connection is not TLS"
n="$(psql_app -c "select count(*) from article")"
[[ "$n" -ge 5 ]] || fail "expected >= 5 seeded articles, found ${n}"
! psql_app -c 'drop table article' >/dev/null 2>&1 || fail "blog0_app was able to DROP a table"
! psql_app -c 'alter table article add column x int' >/dev/null 2>&1 || fail "blog0_app was able to ALTER a table"
! psql_app -c 'truncate article' >/dev/null 2>&1 || fail "blog0_app was able to TRUNCATE a table"
dc exec -T blog0 sh -c 'echo "$BLOG0_DATABASE_URL"' | grep -q '^postgres://blog0_app:' || fail "the blog0 container does not connect as blog0_app"
say "  article rows ${n}; TLS on; DROP/ALTER/TRUNCATE refused"

# --- 6. Listmonk settings ----------------------------------------------------------------------------------------------------
step listmonk "settings applied (SMTP -> mailpit only)"
ADMIN_USER="$LISTMONK_ADMIN_USER"
ADMIN_PASSWORD="$LISTMONK_ADMIN_PASSWORD"
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
lm GET /api/settings "${WORK}/s.json"
smtp="$(json "${WORK}/s.json" 'd.data.smtp.filter(s=>s.enabled).map(s=>s.host+":"+s.port).join(",")')"
[[ "$smtp" == "mailpit:1025" ]] || fail "Listmonk's enabled SMTP is '${smtp}', expected exactly mailpit:1025"
[[ "$(json "${WORK}/s.json" 'd.data["app.root_url"]')" == "https://${SITE_HOST}/lm" ]] || fail "app.root_url is not https://${SITE_HOST}/lm"
[[ "$(json "${WORK}/s.json" 'd.data["app.message_sliding_window_rate"]')" == 1800 ]] || fail "sliding window is not 1800"
say "  SMTP mailpit:1025 only; root_url https://${SITE_HOST}/lm; 1800/24h"

# --- 7. tracking ------------------------------------------------------------------------------------
step tracking "campaign -> Mailpit -> open + click + unsubscribe page through blog0 (${BLOG}/lm)"
RCPT="verify-$(date +%s)@localtest.me"
lm POST /api/lists "${WORK}/l.json" '{"name":"deploy-local-verify","type":"private","optin":"single"}'
LIST_ID="$(json "${WORK}/l.json" 'd.data.id')"
lm POST /api/subscribers "${WORK}/sub.json" "{\"email\":\"${RCPT}\",\"name\":\"Verify\",\"status\":\"enabled\",\"lists\":[${LIST_ID}],\"preconfirm_subscriptions\":true}"
TARGET="${BLOG}/"
# blog0's own campaign template (src/server/newsletter/sender/listmonk.ts BLOG0_TEMPLATE_BODY): content + the
# open pixel only - no "view in browser" link, so /lm/campaign/<c>/<s> (not proxied) never appears in a mail.
lm POST /api/templates "${WORK}/t.json" "$(node -e 'process.stdout.write(JSON.stringify({name:"deploy-local-verify",type:"campaign",body:"{{ template \"content\" . }}\n{{ TrackView }}"}))')"
TPL_ID="$(json "${WORK}/t.json" 'd.data.id')"
body="$(node -e 'process.stdout.write(JSON.stringify({name:"deploy-local verify",subject:"deploy-local verify",lists:[Number(process.argv[1])],template_id:Number(process.argv[3]),type:"regular",content_type:"html",
  body:`<p>Tracking check: <a href="{{ TrackLink \"${process.argv[2]}\" }}">read</a></p>`}))' "$LIST_ID" "$TARGET" "$TPL_ID")"
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
# Every /lm URL in the message (HTML + text + List-Unsubscribe), UUIDs shown as U.
node -e '
  const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const h=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const hay=[m.HTML||"",m.Text||"",JSON.stringify(h)].join("\n").replace(/&amp;/g,"&");
  const re=new RegExp("https://"+process.argv[3].replace(/[.]/g,"\\.")+"/lm/[^\"<>\\s]+","g");
  const urls=[...new Set(hay.match(re)||[])];
  fs.writeFileSync(process.argv[4], urls.join("\n")+"\n");
' "${WORK}/msg.json" "${WORK}/hdr.json" "$SITE_HOST" "${WORK}/urls.txt"
say "  /lm URL shapes in the captured message:"
sed -E 's#https://[^/]+/lm##; s#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#<uuid>#g' "${WORK}/urls.txt" | sort -u | sed 's/^/    /'
LINK="$(grep -E '/lm/link/' "${WORK}/urls.txt" | head -n 1 || true)"
PIXEL="$(grep -E '/px\.png' "${WORK}/urls.txt" | head -n 1 || true)"
UNSUB="$(grep -E '/lm/subscription/' "${WORK}/urls.txt" | head -n 1 || true)"
[[ -n "$LINK" ]] || fail "no ${SITE_HOST}/lm/link/… URL in the message"
[[ -n "$PIXEL" ]] || fail "no ${SITE_HOST}/lm/campaign/…/px.png URL in the message"
[[ -n "$UNSUB" ]] || fail "no ${SITE_HOST}/lm/subscription/… URL (List-Unsubscribe) in the message"
EDGE=(curl -sS -m 10)
IFS='|' read -r code ctype loc < <("${EDGE[@]}" -o /dev/null -w '%{http_code}|%{content_type}|%{redirect_url}\n' "$(local_url "$LINK")")
[[ "$code" == 3* && "$loc" == "$TARGET" ]] || fail "click ${LINK} → ${code} ${loc} (expected 3xx to ${TARGET})"
say "  click: ${code} → ${loc}"
IFS='|' read -r code ctype < <("${EDGE[@]}" -o "${WORK}/px" -w '%{http_code}|%{content_type}\n' "$(local_url "$PIXEL")")
[[ "$code" == 200 && "$ctype" == image/png* ]] || fail "pixel ${PIXEL} → ${code} ${ctype}"
say "  open pixel: ${code} ${ctype}"
# Every other captured /lm URL must also reach Listmonk through blog0 (< 400).
while IFS= read -r u; do
  [[ -n "$u" && "$u" != "$LINK" ]] || continue
  hdrs="$("${EDGE[@]}" -o /dev/null -D - "$(local_url "$u")")" || fail "GET ${u}"
  c="$(head -n 1 <<<"$hdrs" | awk '{print $2}')"
  ((c < 400)) || fail "${u} → ${c}"
done <"${WORK}/urls.txt"
say "  every captured /lm URL reaches Listmonk through blog0"
UNSUB_PAGE="${UNSUB%%\?*}"
IFS='|' read -r code ctype < <("${EDGE[@]}" -o "${WORK}/unsub.html" -w '%{http_code}|%{content_type}\n' "$(local_url "$UNSUB_PAGE")")
[[ "$code" == 200 ]] || fail "unsubscribe page ${UNSUB_PAGE} → ${code}"
say "  unsubscribe page (GET only, nothing submitted): ${code}"
# The page's own subresources are served too (Listmonk hardcodes absolute /public/... paths; blog0 proxies them).
assets="$(grep -oE '<(link[^>]*rel="(stylesheet|icon)"[^>]*|script[^>]*|img[^>]*)>' "${WORK}/unsub.html" | grep -oE '(href|src)="[^"]+"' | sed -E 's/^(href|src)="([^"]+)"$/\2/' | grep -E "^/" | sort -u || true)"
[[ -n "$assets" ]] || fail "the unsubscribe page links no assets"
for a in $assets; do
  a="${BLOG}${a}"
  c="$("${EDGE[@]}" -o /dev/null -w '%{http_code}' "$a")"
  say "  page asset ${a#"${BLOG}"} → ${c}"
  [[ "$c" == 200 ]] || fail "unsubscribe page asset ${a} → ${c} "
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


# --- 8. scheduler -----------------------------------------------------------------------------------
step scheduler "newsletter tick, media backup, crontab"
dc exec -T blog0 node -e "require('fs').writeFileSync('/data/storage/verify-media.txt','ok')" || fail "write /data/storage/verify-media.txt"
out="$(dc exec -T scheduler node /app/newsletter-tick.mjs 2>&1)" || {
  echo "$out" | grep -viE 'password|token'
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

# --- 9. smoke ---------------------------------------------------------------------------------------
step smoke "scripts/deploy-smoke.sh --direct ${BLOG}"
bash scripts/deploy-smoke.sh --direct "$BLOG" || fail "deploy-smoke"

# --- 10. non-root -----------------------------------------------------------------------------------
step non-root "uid of blog0, scheduler and listmonk"
for s in blog0 scheduler; do
  uid="$(dc exec -T "$s" id -u | tr -d '\r')"
  [[ "$uid" == 1000 ]] || fail "${s} runs as uid ${uid}, expected 1000"
done
# Listmonk: the image entrypoint starts as root and drops to PUID:PGID (1000) via su-exec - check the
# running `listmonk` process and the uploads volume, not `exec id` (which is root by design).
lmuid="$(dc exec -T listmonk sh -c 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = listmonk ] && stat -c %u "$p"; done; stat -c %u /listmonk/uploads' | tr -d '\r' | sort -u | tr '\n' ' ')"
[[ "$lmuid" == "1000 " ]] || fail "listmonk process / uploads owned by uid(s) '${lmuid}', expected 1000"
say "  blog0 1000, scheduler 1000, listmonk 1000 (process + uploads)"

STEP=done
say PASS
