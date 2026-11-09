#!/usr/bin/env bash
# `pnpm lm:prefix-check` - proves Listmonk works under the /lm path prefix behind blog0's rewrites
# (spec/architecture.md §12.7 + §13; src/lib/http/listmonk-proxy.ts). Re-runnable, test stack only.
#
#   * needs `pnpm listmonk:test-up` (Listmonk :9001 -> Mailpit; the dev stack :9000 is NEVER used);
#   * sets the test Listmonk's app.root_url to http://127.0.0.1:<port>/lm (restored on exit);
#   * builds blog0 (BLOG0_DIST_DIR, default .next-gate) with BLOG0_LM_PROXY_TARGET=http://127.0.0.1:9001
#     unless that build already exists, and serves it on <port> (default 3492, range 3490-3499) with an
#     embedded PGlite (var/pglite-lm) - no .env database, no real SMTP;
#   * a campaign ({{ TrackLink }} + {{ TrackView }} + {{ UnsubscribeURL }}) is delivered to Mailpit and
#     every check below goes through blog0's port ONLY (Listmonk hardcodes its page assets as absolute
#     /public/... paths, so those three asset patterns are proxied unprefixed as well): tracked link 307 (+ Location kept, click counted),
#     open pixel (200 image/png, view counted), unsubscribe page 200 + all its assets 200 + the form POST
#     (subscriber ends up unsubscribed), and 404 (blog0's page, not proxied) for /lm/admin, /lm/api/*,
#     /lm/, /lm/subscription/{export,wipe,optin,form}, /lm/campaign/<c>/<s>.
# Exit 0 = `lm-prefix-check: PASS`; 3 = PENDING DOCKER / test stack down (never a pass); else FAIL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${BLOG0_LM_CHECK_PORT:-3492}"
DIST="${BLOG0_DIST_DIR:-.next-gate}"
BLOG="http://127.0.0.1:${PORT}"
LM_TARGET=http://127.0.0.1:9001
ENV_FILE=var/listmonk-test.env
ADMIN_USER="${LISTMONK_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${LISTMONK_ADMIN_PASSWORD:-listmonk-admin-dev-password}"
WORK="$(mktemp -d -t lm-prefix.XXXXXX)"
JAR="${WORK}/jar"
SERVER_PID=""
ORIG_ROOT=""
CAMP_ID="" LIST_ID="" SUB_ID="" TPL_ID=""
STARTED_SERVER=0

say() { echo "lm-prefix-check: $*"; }
fail() {
  say "FAIL - $*"
  exit 1
}
[[ "$PORT" =~ ^349[0-9]$ ]] || fail "BLOG0_LM_CHECK_PORT must be 3490-3499 (got ${PORT})"

json() { # <file> <expression over d>
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(function(d){return eval(process.argv[2])})(d);process.stdout.write(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"
}

lm_login() {
  local page nonce code
  rm -f "$JAR"
  page="$(curl -sS -m 10 -c "$JAR" -b "$JAR" "${LM_TARGET}/admin/login")" || fail "GET /admin/login"
  nonce="$(printf '%s' "$page" | grep -oE 'name="nonce"[^>]*value="[^"]*"' | sed -E 's/.*value="([^"]*)"/\1/')"
  code="$(curl -sS -m 10 -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "${LM_TARGET}/admin/login" \
    --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${ADMIN_PASSWORD}" \
    --data-urlencode "nonce=${nonce}" --data-urlencode "next=/admin")" || fail "POST /admin/login"
  [[ "$code" == 302 ]] || fail "Listmonk admin login -> ${code}"
}
lm() { # <method> <path> <out> [json]   (direct to the TEST Listmonk, admin session)
  local c
  if [[ -n "${4:-}" ]]; then
    c="$(curl -sS -m 20 -b "$JAR" -o "$3" -w '%{http_code}' -X "$1" -H 'content-type: application/json' -d "$4" "${LM_TARGET}$2")"
  else
    c="$(curl -sS -m 20 -b "$JAR" -o "$3" -w '%{http_code}' -X "$1" "${LM_TARGET}$2")"
  fi
  [[ "$c" == 2* ]] || fail "$1 $2 -> ${c}: $(head -c 300 "$3")"
}
wait_listmonk() {
  local deadline=$((SECONDS + 60))
  until [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${LM_TARGET}/admin/login")" == 200 ]]; do
    ((SECONDS < deadline)) || fail "Listmonk did not answer on ${LM_TARGET}"
    sleep 1
  done
}
set_root_url() { # <url>: only app.root_url changes (everything else is sent back as read)
  lm GET /api/settings "${WORK}/set.json"
  node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).data;d["app.root_url"]=process.argv[2];fs.writeFileSync(process.argv[3],JSON.stringify(d),{mode:0o600})' "${WORK}/set.json" "$1" "${WORK}/put.json"
  lm PUT /api/settings "${WORK}/o.json" "$(cat "${WORK}/put.json")"
  rm -f "${WORK}/put.json"
  sleep 3 # Listmonk reloads itself after a settings change
  wait_listmonk
  lm_login
}

cleanup() {
  local status=$?
  set +e
  if [[ -f "$JAR" ]]; then
    [[ -n "$CAMP_ID" ]] && curl -s -m 10 -b "$JAR" -X DELETE "${LM_TARGET}/api/campaigns/${CAMP_ID}" >/dev/null
    [[ -n "$SUB_ID" ]] && curl -s -m 10 -b "$JAR" -X DELETE "${LM_TARGET}/api/subscribers/${SUB_ID}" >/dev/null
    [[ -n "$LIST_ID" ]] && curl -s -m 10 -b "$JAR" -X DELETE "${LM_TARGET}/api/lists/${LIST_ID}" >/dev/null
    [[ -n "$TPL_ID" ]] && curl -s -m 10 -b "$JAR" -X DELETE "${LM_TARGET}/api/templates/${TPL_ID}" >/dev/null
    if [[ -n "$ORIG_ROOT" ]]; then
      set_root_url "$ORIG_ROOT" >/dev/null 2>&1 && say "root_url restored to ${ORIG_ROOT}"
    fi
  fi
  [[ "$STARTED_SERVER" == 1 && -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
  exit $status
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- preconditions ------------------------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  echo "PENDING DOCKER: docker daemon not reachable (start it: colima start, then pnpm listmonk:test-up)"
  exit 3
fi
if [[ ! -f "$ENV_FILE" ]] || [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${LM_TARGET}/admin/login")" != 200 ]]; then
  echo "PENDING LISTMONK TEST STACK: run pnpm listmonk:test-up (Listmonk :9001 -> Mailpit)"
  exit 3
fi
MAILPIT="$(sed -n 's/^BLOG0_MAILPIT_URL=//p' "$ENV_FILE")"
MAILPIT="${MAILPIT:-http://127.0.0.1:8025}"
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then fail "port ${PORT} is already in use (set BLOG0_LM_CHECK_PORT)"; fi

lm_login
lm GET /api/settings "${WORK}/s.json"
smtp="$(json "${WORK}/s.json" 'd.data.smtp.filter(s=>s.enabled).map(s=>s.host+":"+s.port).join(",")')"
[[ "$smtp" == "mailpit:1025" ]] || fail "the test Listmonk's enabled SMTP is '${smtp}', expected exactly mailpit:1025 (refusing to send)"
ORIG_ROOT="$(json "${WORK}/s.json" 'd.data["app.root_url"]')"

# --- blog0 production build with the proxy, served on PORT -------------------------------------------------------
if ! grep -q "${LM_TARGET}/link/" "${DIST}/routes-manifest.json" 2>/dev/null; then
  say "building blog0 (${DIST}) with BLOG0_LM_PROXY_TARGET=${LM_TARGET}"
  BLOG0_DIST_DIR="$DIST" BLOG0_LM_PROXY_TARGET="$LM_TARGET" pnpm -s build >"${WORK}/build.log" 2>&1 || {
    tail -20 "${WORK}/build.log"
    fail "pnpm build"
  }
fi
export BLOG0_DATABASE_URL=pglite://./var/pglite-lm
pnpm -s db:migrate >"${WORK}/migrate.log" 2>&1 || {
  cat "${WORK}/migrate.log"
  fail "db:migrate (pglite)"
}
BLOG0_DIST_DIR="$DIST" BLOG0_PORT="$PORT" BLOG0_PUBLIC_BASE_URL="$BLOG" BLOG0_NEWSLETTER_SENDER=stub BLOG0_SMTP_HOST= \
  BLOG0_STORAGE_DIR=var/storage-lm BLOG0_LOG_FILE=var/lm-server.log node scripts/serve.mjs start >"${WORK}/server.out" 2>&1 &
SERVER_PID=$!
STARTED_SERVER=1
deadline=$((SECONDS + 60))
until [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${BLOG}/api/health/live")" == 200 ]]; do
  ((SECONDS < deadline)) || {
    tail -20 "${WORK}/server.out"
    fail "blog0 did not come up on ${PORT}"
  }
  sleep 1
done
say "blog0 up on ${BLOG}; proxy target ${LM_TARGET}"

# --- Listmonk root URL = blog0's /lm ------------------------------------------------------------------------------
set_root_url "${BLOG}/lm"
say "test Listmonk app.root_url = ${BLOG}/lm (was ${ORIG_ROOT})"

# --- campaign -> Mailpit ------------------------------------------------------------------------------------------------
RCPT="lmprefix-$(date +%s)@example.test"
lm POST /api/lists "${WORK}/l.json" '{"name":"lm-prefix-check","type":"private","optin":"single"}'
LIST_ID="$(json "${WORK}/l.json" 'd.data.id')"
lm POST /api/subscribers "${WORK}/sub.json" "{\"email\":\"${RCPT}\",\"name\":\"Prefix\",\"status\":\"enabled\",\"lists\":[${LIST_ID}],\"preconfirm_subscriptions\":true}"
SUB_ID="$(json "${WORK}/sub.json" 'd.data.id')"
TARGET="${BLOG}/archive"
# blog0's own campaign template (src/server/newsletter/sender/listmonk.ts BLOG0_TEMPLATE_BODY): content + the open pixel only.
tpl="$(node -e 'process.stdout.write(JSON.stringify({name:"lm-prefix-check",type:"campaign",body:"{{ template \"content\" . }}\n{{ TrackView }}"}))')"
lm POST /api/templates "${WORK}/t.json" "$tpl"
TPL_ID="$(json "${WORK}/t.json" 'd.data.id')"
body="$(node -e 'process.stdout.write(JSON.stringify({name:"lm prefix check",subject:"lm prefix check",lists:[Number(process.argv[1])],template_id:Number(process.argv[3]),type:"regular",content_type:"html",
  body:`<p><a href="{{ TrackLink \"${process.argv[2]}\" }}">read</a> <a href="{{ UnsubscribeURL }}">unsub</a></p>`}))' "$LIST_ID" "$TARGET" "$TPL_ID")"
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
node -e '
  const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const h=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const hay=[m.HTML||"",m.Text||"",JSON.stringify(h)].join("\n").replace(/&amp;/g,"&");
  const re=new RegExp(process.argv[3].replace(/[.]/g,"\\.")+"/lm/[^\"<>\\s]+","g");
  fs.writeFileSync(process.argv[4], [...new Set(hay.match(re)||[])].join("\n")+"\n");
' "${WORK}/msg.json" "${WORK}/hdr.json" "$BLOG" "${WORK}/urls.txt"
say "URL shapes in the delivered message:"
sed -E "s#${BLOG}##; s#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#<uuid>#g" "${WORK}/urls.txt" | sort -u | sed 's/^/    /'
LINK="$(grep -E '/lm/link/' "${WORK}/urls.txt" | head -n 1 || true)"
PIXEL="$(grep -E '/px\.png$' "${WORK}/urls.txt" | head -n 1 || true)"
UNSUB="$(grep -E '/lm/subscription/' "${WORK}/urls.txt" | head -n 1 || true)"
[[ -n "$LINK" ]] || fail "no ${BLOG}/lm/link/... URL in the message"
[[ -n "$PIXEL" ]] || fail "no ${BLOG}/lm/campaign/.../px.png URL in the message"
[[ -n "$UNSUB" ]] || fail "no ${BLOG}/lm/subscription/... URL in the message"
# Nothing Listmonk generated may bypass the prefix: no URL at the bare root without /lm.
if grep -qE "${BLOG//./\\.}/(link|campaign|subscription|public)/" "${WORK}/msg.json"; then fail "the message holds an unprefixed Listmonk URL"; fi
# Only the shapes blog0 allow-lists may appear (anything else would 404 for the reader).
while IFS= read -r u; do
  [[ -n "$u" ]] || continue
  p="${u#"$BLOG"}"
  [[ "$p" =~ ^/lm/(link/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}|campaign/[0-9a-f-]{36}/[0-9a-f-]{36}/px\.png|subscription/[0-9a-f-]{36}/[0-9a-f-]{36})(\?.*)?$ ]] || fail "message URL outside the allow-list: ${p}"
done <"${WORK}/urls.txt"

# --- through blog0's port ----------------------------------------------------------------------------------------------------
IFS='|' read -r code loc < <(curl -sS -m 10 -o /dev/null -w '%{http_code}|%{redirect_url}\n' "$LINK")
[[ "$code" == 307 && "$loc" == "$TARGET" ]] || fail "click ${LINK#"$BLOG"} -> ${code} ${loc} (expected 307 to ${TARGET}; the proxy must not follow the redirect)"
say "click:  GET ${LINK#"$BLOG"} -> ${code}, Location ${loc}"
IFS='|' read -r code ctype < <(curl -sS -m 10 -o "${WORK}/px" -w '%{http_code}|%{content_type}\n' "$PIXEL")
[[ "$code" == 200 && "$ctype" == image/png* ]] || fail "pixel -> ${code} ${ctype}"
head -c 8 "${WORK}/px" | od -An -c | grep -q 'P   N   G' || fail "the pixel body is not a PNG"
say "open:   GET ${PIXEL#"$BLOG"} -> ${code} ${ctype}"

UNSUB_PAGE="${UNSUB%%\?*}"
curl -sS -m 10 -D "${WORK}/unsub.h" -o "${WORK}/unsub.html" "$UNSUB_PAGE" || fail "GET unsubscribe page"
code="$(awk 'NR==1{print $2}' "${WORK}/unsub.h")"
[[ "$code" == 200 ]] || fail "unsubscribe page -> ${code}"
grep -qiE 'unsubscribe' "${WORK}/unsub.html" || fail "the unsubscribe page has no 'unsubscribe' text"
say "page:   GET ${UNSUB_PAGE#"$BLOG"} -> ${code}, $(grep -ci '^content-type' "${WORK}/unsub.h") content-type, $(wc -c <"${WORK}/unsub.html" | tr -d ' ') bytes"
# Subresources only: stylesheets, icons, scripts, images (not the archive RSS <link rel=alternate> / the logo's anchor).
assets="$(grep -oE '<(link[^>]*rel="(stylesheet|icon)"[^>]*|script[^>]*|img[^>]*)>' "${WORK}/unsub.html" | grep -oE '(href|src)="[^"]+"' | sed -E 's/^(href|src)="([^"]+)"$/\2/' | grep -vE '^(#|mailto:|data:)' | sort -u || true)"
n_assets=0
for a in $assets; do
  case "$a" in
    "$BLOG"/*) url="$a" ;;
    /*) url="${BLOG}${a}" ;;
    http*) continue ;; # an external URL is not Listmonk's
    *) continue ;;
  esac
  [[ "$url" == "$UNSUB_PAGE" ]] && continue
  c="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$url")"
  say "asset:  ${url#"$BLOG"} -> ${c}"
  [[ "$c" == 200 ]] || fail "unsubscribe page asset ${url#"$BLOG"} -> ${c}"
  # Listmonk hardcodes /public/... (ignores root_url): those absolute paths are proxied unprefixed too (listmonk-proxy.ts).
  [[ "$url" == "${BLOG}/lm/"* || "$url" =~ ^${BLOG//./\\.}/public/(static/[A-Za-z0-9_][A-Za-z0-9._-]*|custom\.(css|js))(\?.*)?$ ]] || fail "page asset ${a} is neither under /lm nor an allow-listed /public asset"
  n_assets=$((n_assets + 1))
done
((n_assets > 0)) || fail "the unsubscribe page links no assets (unexpected)"
# Listmonk's own query string (manage preferences) survives the proxy.
c="$(curl -sS -m 10 -o "${WORK}/manage.html" -w '%{http_code}' "${UNSUB_PAGE}?manage=true")"
[[ "$c" == 200 ]] || fail "GET ?manage=true -> ${c}"
say "query:  GET ${UNSUB_PAGE#"$BLOG"}?manage=true -> ${c}"
# Form: action must stay under /lm (or empty = same URL).
action="$(grep -oE '<form[^>]*method="post"[^>]*' "${WORK}/unsub.html" | head -n 1 | grep -oE 'action="[^"]*"' | sed -E 's/action="([^"]*)"/\1/' || true)"
[[ -z "$action" || "$action" == /lm/* || "$action" == "$BLOG"/lm/* ]] || fail "form action '${action}' escapes the prefix"
say "form:   action '${action:-<same URL>}'"

# Not allow-listed -> blog0's own 404 (never proxied to Listmonk).
C_ID="$(basename "$(dirname "$UNSUB_PAGE")")"
S_ID="$(basename "$UNSUB_PAGE")"
for p in /lm /lm/ /lm/admin /lm/admin/login /lm/api/health /lm/api/settings /lm/api/subscribers /lm/uploads/x.png /lm/archive \
  /lm/subscription/form "/lm/subscription/export/${S_ID}" "/lm/subscription/wipe/${S_ID}" "/lm/subscription/optin/${S_ID}" \
  "/lm/campaign/${C_ID}/${S_ID}" /lm/public/static/ /lm/public/static/..%2fadmin /lm/link/x/y/z; do
  c="$(curl -sS -m 10 -L --max-redirs 2 -o "${WORK}/nf.html" -w '%{http_code}' --path-as-is "${BLOG}${p}")"
  [[ "$c" == 404 ]] || fail "${p} -> ${c} (expected blog0's 404)"
  grep -q 'blog0' "${WORK}/nf.html" || fail "${p}: the 404 body is not blog0's page"
  grep -qiE 'listmonk' "${WORK}/nf.html" && fail "${p}: the 404 body mentions Listmonk (proxied?)"
done
say "denied: admin, api, uploads, archive, root, export/wipe/optin/form, view-in-browser, traversal -> 404 (blog0's page)"
# Response headers: Listmonk's own pass through untouched (Next applies neither next.config headers() nor the
# proxy's response headers to an external rewrite); in particular blog0's nonce CSP must not be on its page.
grep -qi '^content-security-policy:' "${WORK}/unsub.h" && fail "blog0's nonce CSP leaked onto Listmonk's page"

# Counters (before the unsubscribe).
deadline=$((SECONDS + 40))
while :; do
  lm GET "/api/campaigns/${CAMP_ID}" "${WORK}/cs.json"
  views="$(json "${WORK}/cs.json" 'd.data.views')"
  clicks="$(json "${WORK}/cs.json" 'd.data.clicks')"
  [[ "${views:-0}" -ge 1 && "${clicks:-0}" -ge 1 ]] && break
  ((SECONDS < deadline)) || fail "Listmonk counts views=${views} clicks=${clicks} (expected >= 1 each)"
  sleep 2
done
say "counters: campaign ${CAMP_ID}: views ${views}, clicks ${clicks}"

# Unsubscribe form POST through the proxy.
fields="$(grep -oE '<input[^>]*>' "${WORK}/unsub.html" | tr '\n' ' ')"
post_args=(--data-urlencode "blocklist=true")
if grep -qE 'name="l"' <<<"$fields"; then :; fi
code="$(curl -sS -m 10 -o "${WORK}/unsub-post.html" -w '%{http_code}' -X POST "${post_args[@]}" "${UNSUB_PAGE}")"
[[ "$code" == 200 ]] || fail "POST unsubscribe -> ${code}: $(head -c 300 "${WORK}/unsub-post.html")"
lm GET "/api/subscribers/${SUB_ID}" "${WORK}/after.json"
st="$(json "${WORK}/after.json" 'd.data.status')"
ls_status="$(json "${WORK}/after.json" 'd.data.lists.map(l=>l.subscription_status).join(",")')"
[[ "$st" == blocklisted || "$ls_status" == *unsubscribed* ]] || fail "after the POST the subscriber is '${st}' / lists '${ls_status}'"
say "unsub:  POST ${UNSUB_PAGE#"$BLOG"} -> ${code}; subscriber status ${st}, list subscription ${ls_status}"
say PASS
