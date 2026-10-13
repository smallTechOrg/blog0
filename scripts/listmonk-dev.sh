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
  [[ -f "$ENV_FILE" ]] || fail "${ENV_FILE} missing — run pnpm listmonk:up"
  cat "$ENV_FILE"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down "${2:-}" ;;
  reset) cmd_reset ;;
  token) cmd_token ;;
  *)
    echo "usage: scripts/listmonk-dev.sh up|down [-v]|reset|token" >&2
    exit 2
    ;;
esac
