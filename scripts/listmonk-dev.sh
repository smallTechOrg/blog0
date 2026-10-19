#!/usr/bin/env bash
# Local Listmonk for the sender adapter (spec/architecture.md §12.6; `pnpm listmonk:up|down|reset`).
#
#   up     docker compose up postgres + listmonk (waits for health), then — idempotently — ensures
#          the list `blog0-test` and an API user `blog0` and writes var/listmonk-dev.env (0600):
#          BLOG0_LISTMONK_URL / BLOG0_LISTMONK_API_USER / BLOG0_LISTMONK_API_TOKEN / BLOG0_LISTMONK_LIST_ID
#          Exit 0 = ready; exit 3 = PENDING DOCKER (daemon unreachable — never a pass); else FAIL.
#   down   docker compose down (keeps volumes).  down -v / `BLOG0_LISTMONK_PURGE=1` also drops them.
#   reset  drop + recreate the `listmonk` database (fresh state), then `up`.
#   token  print var/listmonk-dev.env.
#
#   test-up    the TEST stack (compose profile `test`): mailpit (SMTP 127.0.0.1:1025, UI/API :8025) +
#              listmonk-test on :9001 with its own database `listmonk_test` (created here when the
#              Postgres volume predates it). Points listmonk-test's SMTP at mailpit:1025 (no auth/TLS,
#              every other SMTP entry dropped), then the same list + API user steps, writing
#              var/listmonk-test.env (+ BLOG0_MAILPIT_URL). Idempotent. The integration tests use ONLY this.
#   test-down  stop listmonk-test + mailpit (volumes kept; the dev stack is never touched).
#   test-token print var/listmonk-test.env.
#
# The dev stack (`up`) may carry the owner's REAL relay (configured in its admin UI); this script
# never changes the dev instance's SMTP. Tests refuse any Listmonk whose enabled SMTP is not the sink.
#
# Listmonk v5 procedure (automated here; the admin password is used only for this):
#   1. GET  /admin/login            → nonce cookie + hidden `nonce` field
#   2. POST /admin/login            form {username,password,nonce,next} → session cookie (302)
#   3. GET  /api/roles/users        → role id of "Super Admin" (the install default)
#   4. POST /api/users              {username:'blog0', type:'api', user_role_id, status:'enabled'}
#                                   → data.password = the API token, returned ONCE at creation
#   5. POST /api/lists              {name:'blog0-test', type:'private', optin:'single'} (if missing)
#   API calls afterwards use `Authorization: token blog0:<token>` (basic auth works too).
# A lost env file ⇒ the user is deleted (DELETE /api/users/:id) and re-created (tokens cannot be read back).
# Secret hygiene: the token is written to the env file only; nothing prints it.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=var/listmonk-dev.env
PORT="${BLOG0_LISTMONK_PORT:-9000}"
URL="http://localhost:${PORT}"
MAILPIT_URL=""

# The test stack: listmonk-test on :9001 → mailpit. Switches every global the steps below read.
use_test_stack() {
  ENV_FILE=var/listmonk-test.env
  PORT=9001
  URL="http://localhost:${PORT}"
  MAILPIT_URL=http://127.0.0.1:8025
}
ADMIN_USER="${LISTMONK_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${LISTMONK_ADMIN_PASSWORD:-listmonk-admin-dev-password}"
API_USER=blog0
LIST_NAME=blog0-test
JAR="$(mktemp -t listmonk-jar.XXXXXX)"
trap 'rm -f "$JAR"' EXIT

say() { echo "listmonk-dev: $*"; }
fail() {
  say "FAIL — $*"
  exit 1
}

# `docker compose` (plugin) or the standalone `docker-compose` binary — whichever this host has.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "neither 'docker compose' nor 'docker-compose' is available"
  fi
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "PENDING DOCKER: docker daemon not reachable (start it: colima start, then pnpm listmonk:up)"
    exit 3
  fi
}

json_field() { # <file> <node expression over `d` (the parsed JSON)>
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(function(d){return eval(process.argv[2])})(d);process.stdout.write(v===undefined||v===null?"":String(v))' "$1" "$2"
}

# --- admin session (steps 1–2) -----------------------------------------------------------------
admin_login() {
  local page nonce code
  page="$(curl -sS -m 10 -c "$JAR" -b "$JAR" "${URL}/admin/login")" || fail "GET /admin/login"
  nonce="$(printf '%s' "$page" | grep -oE 'name="nonce"[^>]*value="[^"]*"' | sed -E 's/.*value="([^"]*)"/\1/')"
  [[ -n "$nonce" ]] || fail "no login nonce on /admin/login"
  code="$(curl -sS -m 10 -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "${URL}/admin/login" \
    --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${ADMIN_PASSWORD}" \
    --data-urlencode "nonce=${nonce}" --data-urlencode "next=/admin")" || fail "POST /admin/login"
  [[ "$code" == "302" ]] || fail "admin login answered ${code} (expected 302) — check LISTMONK_ADMIN_USER/PASSWORD"
  local health
  health="$(curl -sS -m 10 -b "$JAR" "${URL}/api/health")" || fail "GET /api/health with the admin session"
  [[ "$health" == '{"data":true}' ]] || fail "admin session rejected: ${health}"
}

admin_api() { # <method> <path> [json-body]  → body on stdout; fails on non-2xx
  local method="$1" path="$2" body="${3:-}" out code
  out="$(mktemp -t listmonk-out.XXXXXX)"
  if [[ -n "$body" ]]; then
    code="$(curl -sS -m 20 -b "$JAR" -o "$out" -w '%{http_code}' -X "$method" -H 'content-type: application/json' "${URL}${path}" -d "$body")"
  else
    code="$(curl -sS -m 20 -b "$JAR" -o "$out" -w '%{http_code}' -X "$method" "${URL}${path}")"
  fi
  if [[ "$code" != 2* ]]; then
    local msg
    msg="$(json_field "$out" 'd.message' 2>/dev/null || true)"
    rm -f "$out"
    fail "${method} ${path} → ${code}${msg:+ (${msg})}"
  fi
  cat "$out"
  rm -f "$out"
}

# --- ensure the list (step 5) -------------------------------------------------------------------
ensure_list() { # → list id on stdout
  local tmp id
  tmp="$(mktemp -t listmonk-lists.XXXXXX)"
  admin_api GET '/api/lists?per_page=all' >"$tmp"
  id="$(json_field "$tmp" "(d.data.results.find(l=>l.name==='${LIST_NAME}')||{}).id")"
  rm -f "$tmp"
  if [[ -z "$id" ]]; then
    tmp="$(mktemp -t listmonk-list.XXXXXX)"
    admin_api POST /api/lists "{\"name\":\"${LIST_NAME}\",\"type\":\"private\",\"optin\":\"single\"}" >"$tmp"
    id="$(json_field "$tmp" 'd.data.id')"
    rm -f "$tmp"
    say "created list ${LIST_NAME} (id ${id})" >&2
  else
    say "list ${LIST_NAME} exists (id ${id})" >&2
  fi
  [[ -n "$id" ]] || fail "could not determine the id of list ${LIST_NAME}"
  printf '%s' "$id"
}

# --- the API user + token (steps 3–4) ------------------------------------------------------------
# Returns 0 when the env file's token still authenticates against this Listmonk and the user is enabled.
env_file_valid() {
  [[ -f "$ENV_FILE" ]] || return 1
  local user token health
  user="$(sed -n 's/^BLOG0_LISTMONK_API_USER=//p' "$ENV_FILE")"
  token="$(sed -n 's/^BLOG0_LISTMONK_API_TOKEN=//p' "$ENV_FILE")"
  [[ -n "$user" && -n "$token" ]] || return 1
  health="$(curl -sS -m 10 -H "Authorization: token ${user}:${token}" "${URL}/api/health" 2>/dev/null || true)"
  [[ "$health" == '{"data":true}' ]]
}

write_env_file() { # <token> <list id>
  mkdir -p var
  umask 077
  cat >"$ENV_FILE" <<EOF
BLOG0_LISTMONK_URL=${URL}
BLOG0_LISTMONK_API_USER=${API_USER}
BLOG0_LISTMONK_API_TOKEN=$1
BLOG0_LISTMONK_LIST_ID=$2
EOF
  if [[ -n "$MAILPIT_URL" ]]; then echo "BLOG0_MAILPIT_URL=${MAILPIT_URL}" >>"$ENV_FILE"; fi
  chmod 600 "$ENV_FILE"
}

ensure_api_user() { # <list id>; writes the env file; prints nothing secret
  local list_id="$1" tmp existing role_id token
  if env_file_valid; then
    # keep the token; refresh the list id only (the env file is the only copy of the token)
    token="$(sed -n 's/^BLOG0_LISTMONK_API_TOKEN=//p' "$ENV_FILE")"
    write_env_file "$token" "$list_id"
    say "API user ${API_USER}: existing token still valid (${ENV_FILE} refreshed)"
    return 0
  fi
  tmp="$(mktemp -t listmonk-users.XXXXXX)"
  admin_api GET '/api/users' >"$tmp"
  existing="$(json_field "$tmp" "(d.data.find(u=>u.username==='${API_USER}')||{}).id")"
  rm -f "$tmp"
  if [[ -n "$existing" ]]; then
    say "API user ${API_USER} exists but its token is not on this machine — re-creating (tokens are shown once)"
    admin_api DELETE "/api/users/${existing}" >/dev/null
  fi
  tmp="$(mktemp -t listmonk-roles.XXXXXX)"
  admin_api GET '/api/roles/users' >"$tmp"
  role_id="$(json_field "$tmp" "((d.data.find(r=>r.name==='Super Admin')||d.data[0])||{}).id")"
  rm -f "$tmp"
  [[ -n "$role_id" ]] || fail "no user role found at /api/roles/users"
  tmp="$(mktemp -t listmonk-user.XXXXXX)"
  admin_api POST /api/users "{\"username\":\"${API_USER}\",\"name\":\"blog0 (API)\",\"type\":\"api\",\"user_role_id\":${role_id},\"status\":\"enabled\",\"password_login\":false}" >"$tmp"
  token="$(json_field "$tmp" 'd.data.password')"
  rm -f "$tmp"
  [[ -n "$token" ]] || fail "POST /api/users returned no token"
  write_env_file "$token" "$list_id"
  say "created API user ${API_USER} (role ${role_id}); token written to ${ENV_FILE} (mode 0600; not shown)"
}

wait_for_login_page() {
  local deadline=$((SECONDS + 90))
  until [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${URL}/admin/login")" == "200" ]]; do
    ((SECONDS < deadline)) || fail "Listmonk did not answer on ${URL} within 90 s"
    sleep 1
  done
}

cmd_up() {
  require_docker
  local t0=$SECONDS
  say "docker compose up postgres + listmonk (Listmonk on ${URL}, Postgres on 127.0.0.1:5433)"
  BLOG0_LISTMONK_PORT="$PORT" compose up -d --wait postgres listmonk || {
    compose logs --tail 30 listmonk 2>&1 | sed "s/${ADMIN_PASSWORD}/[redacted]/g" || true
    fail "compose up (see the logs above)"
  }
  wait_for_login_page
  say "containers healthy in $((SECONDS - t0)) s"
  admin_login
  local list_id
  list_id="$(ensure_list)"
  ensure_api_user "$list_id"
  # Final proof with the API user itself (what the adapter test will do)
  local user token health
  user="$(sed -n 's/^BLOG0_LISTMONK_API_USER=//p' "$ENV_FILE")"
  token="$(sed -n 's/^BLOG0_LISTMONK_API_TOKEN=//p' "$ENV_FILE")"
  health="$(curl -sS -m 10 -H "Authorization: token ${user}:${token}" "${URL}/api/lists/${list_id}")" || fail "API user cannot read the list"
  grep -q "\"name\":\"${LIST_NAME}\"" <<<"$health" || fail "API user cannot read list ${list_id}: ${health}"
  say "ready in $((SECONDS - t0)) s — source it: set -a && . ${ENV_FILE} && set +a"
}

cmd_down() {
  require_docker
  if [[ "${1:-}" == "-v" || "${BLOG0_LISTMONK_PURGE:-0}" == "1" ]]; then
    compose down -v --remove-orphans
    rm -f "$ENV_FILE"
    say "down (volumes removed, ${ENV_FILE} deleted)"
  else
    compose down --remove-orphans
    say "down (volumes kept; 'pnpm listmonk:down -- -v' also removes them)"
  fi
}

cmd_reset() {
  require_docker
  say "reset: dropping and re-creating the listmonk database"
  BLOG0_LISTMONK_PORT="$PORT" compose up -d --wait postgres || fail "compose up postgres"
  compose stop listmonk >/dev/null 2>&1 || true
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c 'DROP DATABASE IF EXISTS listmonk WITH (FORCE)' -c 'CREATE DATABASE listmonk OWNER listmonk' >/dev/null || fail "recreate the listmonk database"
  rm -f "$ENV_FILE" # the API user is gone with the database
  cmd_up
}

cmd_token() {
  [[ -f "$ENV_FILE" ]] || fail "${ENV_FILE} missing — run pnpm listmonk:up (dev) or pnpm listmonk:test-up (test)"
  cat "$ENV_FILE"
}

# --- TEST stack ----------------------------------------------------------------------------------
# listmonk-test's SMTP → mailpit:1025 + its root URL (settings live in Listmonk's database, not its
# env; the install default root URL is :9000): GET the settings, keep the first SMTP entry's shape,
# replace the list with one sink entry, PUT only when something differs. Listmonk reloads itself after a settings PUT; we wait for it to answer again.
configure_sink_smtp() {
  local tmp body
  tmp="$(mktemp -t listmonk-settings.XXXXXX)"
  admin_api GET /api/settings >"$tmp"
  body="$(node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).data;
    const s = Array.isArray(d.smtp) ? d.smtp : [];
    const ok = s.length === 1 && s[0].enabled === true && s[0].host === "mailpit" && Number(s[0].port) === 1025 &&
      s[0].auth_protocol === "none" && s[0].tls_type === "none" && d["app.root_url"] === process.argv[2];
    if (ok) process.exit(0);
    const base = s[0] || {};
    d.smtp = [{ ...base, enabled: true, host: "mailpit", port: 1025, auth_protocol: "none", username: "", password: "",
      tls_type: "none", tls_skip_verify: true, hello_hostname: "", email_headers: [], max_conns: base.max_conns || 10,
      max_msg_retries: base.max_msg_retries ?? 2, idle_timeout: base.idle_timeout || "15s", wait_timeout: base.wait_timeout || "5s" }];
    d["app.from_email"] = "blog0 test <listmonk-test@example.test>";
    d["app.root_url"] = process.argv[2];
    process.stdout.write(JSON.stringify(d));
  ' "$tmp" "$URL")" || fail "could not build the sink SMTP settings"
  rm -f "$tmp"
  if [[ -z "$body" ]]; then
    say "SMTP already → mailpit:1025 (no auth, no TLS); root URL ${URL}"
    return 0
  fi
  admin_api PUT /api/settings "$body" >/dev/null
  say "SMTP set → mailpit:1025 (no auth, no TLS), root URL ${URL}; waiting for Listmonk to reload"
  sleep 3
  wait_for_login_page
}

ensure_test_database() {
  local exists
  exists="$(compose exec -T postgres psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'listmonk_test'")" || fail "query pg_database"
  if [[ "$exists" != "1" ]]; then
    compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'CREATE DATABASE listmonk_test OWNER listmonk' >/dev/null || fail "create database listmonk_test"
    say "created database listmonk_test"
  fi
}

cmd_test_up() {
  use_test_stack
  require_docker
  local t0=$SECONDS
  say "TEST stack: postgres + mailpit + listmonk-test (Listmonk on ${URL}, Mailpit on ${MAILPIT_URL}, SMTP sink 127.0.0.1:1025)"
  compose up -d --wait postgres || fail "compose up postgres"
  ensure_test_database
  compose --profile test up -d --wait mailpit listmonk-test || {
    compose --profile test logs --tail 30 listmonk-test 2>&1 | sed "s/${ADMIN_PASSWORD}/[redacted]/g" || true
    fail "compose up the test stack (see the logs above)"
  }
  wait_for_login_page
  say "containers healthy in $((SECONDS - t0)) s"
  admin_login
  configure_sink_smtp
  admin_login # a settings reload may drop the session
  local list_id
  list_id="$(ensure_list)"
  ensure_api_user "$list_id"
  # Final proof with the API user itself: the only enabled SMTP is the sink (what the tests' guard checks).
  local user token settings smtp
  user="$(sed -n 's/^BLOG0_LISTMONK_API_USER=//p' "$ENV_FILE")"
  token="$(sed -n 's/^BLOG0_LISTMONK_API_TOKEN=//p' "$ENV_FILE")"
  settings="$(mktemp -t listmonk-settings.XXXXXX)"
  curl -fsS -m 10 -H "Authorization: token ${user}:${token}" -o "$settings" "${URL}/api/settings" || fail "API user cannot read /api/settings"
  smtp="$(json_field "$settings" 'd.data.smtp.filter(s=>s.enabled).map(s=>s.host+":"+s.port).join(",")')"
  rm -f "$settings"
  [[ "$smtp" == "mailpit:1025" ]] || fail "listmonk-test enabled SMTP is '${smtp}', expected exactly mailpit:1025"
  curl -fsS -m 5 -o /dev/null "${MAILPIT_URL}/api/v1/messages" || fail "Mailpit API not reachable on ${MAILPIT_URL}"
  say "TEST stack ready in $((SECONDS - t0)) s — ${ENV_FILE}; SMTP → mailpit:1025 only; stop: pnpm listmonk:test-down"
}

cmd_test_down() {
  require_docker
  compose --profile test stop listmonk-test mailpit
  say "test stack stopped (volumes kept; the dev stack is untouched)"
}

case "${1:-}" in
  test-up) cmd_test_up ;;
  test-down) cmd_test_down ;;
  test-token)
    use_test_stack
    cmd_token
    ;;
  up) cmd_up ;;
  down) cmd_down "${2:-}" ;;
  reset) cmd_reset ;;
  token) cmd_token ;;
  *)
    echo "usage: scripts/listmonk-dev.sh up|down [-v]|reset|token|test-up|test-down|test-token" >&2
    exit 2
    ;;
esac
