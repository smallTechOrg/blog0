#!/usr/bin/env bash
# Idempotent Listmonk API user + list for blog0's sender (GCP deploy, spec/architecture.md §12.7).
#
#   deploy/listmonk-api.sh [--env-file <file>] --out <file> [--blog0-url <url>] <listmonk-url>
#     VM    (deploy/vm/deploy-remote.sh, inside the `listmonk-ops` container on the compose network):
#           bash /ops/listmonk-api.sh --out /out/listmonk-api.env http://listmonk:9000
#     local (deploy/local/verify.sh): the same through `docker compose run listmonk-ops`
#
# Ensures the list LISTMONK_LIST_NAME (default `blog0`; private, single opt-in — blog0 runs its own
# double opt-in) and the API user `blog0` (the procedure of scripts/listmonk-dev.sh), then writes
# <out> (mode 600) with BLOG0_LISTMONK_URL (= --blog0-url, default <listmonk-url>), BLOG0_LISTMONK_API_USER,
# BLOG0_LISTMONK_API_TOKEN, BLOG0_LISTMONK_LIST_ID — the env file blog0 + the scheduler read.
# An existing <out> whose token still authenticates is kept (Listmonk shows a token only once); otherwise
# the API user is re-created. Admin login: LISTMONK_ADMIN_USER / LISTMONK_ADMIN_PASSWORD (environment;
# --env-file fills only unset variables). The token and password are never printed or put on argv.
# Exit 0 ok; 1 API error; 2 usage / missing value. Needs curl + node.
set -euo pipefail

say() { echo "listmonk-api: $*"; }
fail() {
  say "FAIL — $1"
  exit "${2:-1}"
}
usage() { fail "usage: deploy/listmonk-api.sh [--env-file <file>] --out <file> [--blog0-url <url>] <listmonk-url>" 2; }

ENV_FILE=""
OUT=""
URL=""
BLOG0_URL=""
while (($# > 0)); do
  case "$1" in
    --) ;;
    --env-file | --out | --blog0-url)
      [[ $# -ge 2 ]] || usage
      case "$1" in --env-file) ENV_FILE="$2" ;; --out) OUT="$2" ;; --blog0-url) BLOG0_URL="${2%/}" ;; esac
      shift
      ;;
    -*) usage ;;
    *)
      [[ -z "$URL" ]] || usage
      URL="${1%/}"
      ;;
  esac
  shift
done
[[ -n "$URL" && -n "$OUT" ]] || usage
[[ "$URL" =~ ^https?:// ]] || usage
BLOG0_URL="${BLOG0_URL:-$URL}"
command -v node >/dev/null 2>&1 || fail "node is required" 2
command -v curl >/dev/null 2>&1 || fail "curl is required" 2

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "env file ${ENV_FILE} not found" 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    [[ -n "${!key+x}" ]] && continue
    export "$key=${line#*=}"
  done <"$ENV_FILE"
fi
for v in LISTMONK_ADMIN_USER LISTMONK_ADMIN_PASSWORD; do [[ -n "${!v:-}" ]] || fail "${v} is not set" 2; done
LIST_NAME="${LISTMONK_LIST_NAME:-blog0}"
API_USER=blog0
[[ "$LIST_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "LISTMONK_LIST_NAME must be a plain name" 2

umask 077
WORK="$(mktemp -d -t listmonk-api.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
JAR="${WORK}/jar"

json() { # <file> <expression over d>
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(function(d){return eval(process.argv[2])})(d);process.stdout.write(v===undefined||v===null?"":String(v))' "$1" "$2"
}

wait_for_login_page() {
  local deadline=$((SECONDS + 120))
  until [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${URL}/admin/login")" == "200" ]]; do
    ((SECONDS < deadline)) || fail "Listmonk did not answer on ${URL} within 120 s"
    sleep 1
  done
}

admin_login() {
  local page nonce code
  rm -f "$JAR"
  page="$(curl -sS -m 10 -c "$JAR" -b "$JAR" "${URL}/admin/login")" || fail "GET /admin/login"
  nonce="$(printf '%s' "$page" | grep -oE 'name="nonce"[^>]*value="[^"]*"' | sed -E 's/.*value="([^"]*)"/\1/')"
  [[ -n "$nonce" ]] || fail "no login nonce on /admin/login"
  printf '%s' "$LISTMONK_ADMIN_PASSWORD" >"${WORK}/pw"
  code="$(curl -sS -m 10 -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "${URL}/admin/login" \
    --data-urlencode "username=${LISTMONK_ADMIN_USER}" --data-urlencode "password@${WORK}/pw" \
    --data-urlencode "nonce=${nonce}" --data-urlencode "next=/admin")" || fail "POST /admin/login"
  rm -f "${WORK}/pw"
  [[ "$code" == "302" ]] || fail "admin login answered ${code} (expected 302) — check LISTMONK_ADMIN_USER/PASSWORD"
}

api() { # <method> <path> <out-file> [json-body-file]
  local method="$1" path="$2" out="$3" body="${4:-}" code msg
  if [[ -n "$body" ]]; then
    code="$(curl -sS -m 20 -b "$JAR" -o "$out" -w '%{http_code}' -X "$method" -H 'content-type: application/json' --data-binary "@${body}" "${URL}${path}")" || fail "${method} ${path}"
  else
    code="$(curl -sS -m 20 -b "$JAR" -o "$out" -w '%{http_code}' -X "$method" "${URL}${path}")" || fail "${method} ${path}"
  fi
  if [[ "$code" != 2* ]]; then
    msg="$(json "$out" 'd.message' 2>/dev/null || true)"
    fail "${method} ${path} → ${code}${msg:+ (${msg})}"
  fi
}

# token_ok <user> <token-file> → 0 when that token authenticates (the token goes in a curl config file)
token_ok() {
  local cfg="${WORK}/auth.cfg" health
  printf 'header = "Authorization: token %s:%s"\n' "$1" "$(cat "$2")" >"$cfg"
  health="$(curl -sS -m 10 -K "$cfg" "${URL}/api/health" 2>/dev/null || true)"
  rm -f "$cfg"
  [[ "$health" == '{"data":true}' ]]
}

wait_for_login_page
admin_login

# --- list ---------------------------------------------------------------------------------------------
api GET '/api/lists?per_page=all' "${WORK}/lists.json"
LIST_ID="$(json "${WORK}/lists.json" "(d.data.results.find(l=>l.name===$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$LIST_NAME"))||{}).id")"
if [[ -z "$LIST_ID" ]]; then
  node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],type:"private",optin:"single",tags:["blog0"]}))' "$LIST_NAME" >"${WORK}/list-body.json"
  api POST /api/lists "${WORK}/list.json" "${WORK}/list-body.json"
  LIST_ID="$(json "${WORK}/list.json" 'd.data.id')"
  say "list ${LIST_NAME}: created (id ${LIST_ID})"
else
  say "list ${LIST_NAME}: exists (id ${LIST_ID})"
fi
[[ "$LIST_ID" =~ ^[0-9]+$ ]] || fail "could not determine the id of list ${LIST_NAME}"

# --- API user + token -------------------------------------------------------------------------------------
TOKEN_FILE="${WORK}/token"
status=""
if [[ -f "$OUT" ]]; then
  sed -n 's/^BLOG0_LISTMONK_API_TOKEN=//p' "$OUT" | tr -d '\n' >"$TOKEN_FILE"
  user="$(sed -n 's/^BLOG0_LISTMONK_API_USER=//p' "$OUT")"
  if [[ -s "$TOKEN_FILE" && "$user" == "$API_USER" ]] && token_ok "$API_USER" "$TOKEN_FILE"; then status=kept; fi
fi
if [[ -z "$status" ]]; then
  api GET /api/users "${WORK}/users.json"
  existing="$(json "${WORK}/users.json" "(d.data.find(u=>u.username==='${API_USER}')||{}).id")"
  if [[ -n "$existing" ]]; then
    api DELETE "/api/users/${existing}" "${WORK}/del.json"
    say "API user ${API_USER}: token not on this host — re-creating (Listmonk shows tokens once)"
  fi
  api GET /api/roles/users "${WORK}/roles.json"
  role_id="$(json "${WORK}/roles.json" "((d.data.find(r=>r.name==='Super Admin')||d.data[0])||{}).id")"
  [[ -n "$role_id" ]] || fail "no user role at /api/roles/users"
  echo "{\"username\":\"${API_USER}\",\"name\":\"blog0 (API)\",\"type\":\"api\",\"user_role_id\":${role_id},\"status\":\"enabled\",\"password_login\":false}" >"${WORK}/user-body.json"
  api POST /api/users "${WORK}/user.json" "${WORK}/user-body.json"
  json "${WORK}/user.json" 'd.data.password' >"$TOKEN_FILE"
  rm -f "${WORK}/user.json"
  [[ -s "$TOKEN_FILE" ]] || fail "POST /api/users returned no token"
  token_ok "$API_USER" "$TOKEN_FILE" || fail "the new API token does not authenticate"
  status=created
fi

tmp="${OUT}.tmp.$$"
{
  echo "# Listmonk API user for blog0 — written by deploy/listmonk-api.sh (mode 600; never commit)"
  echo "BLOG0_LISTMONK_URL=${BLOG0_URL}"
  echo "BLOG0_LISTMONK_API_USER=${API_USER}"
  printf 'BLOG0_LISTMONK_API_TOKEN=%s\n' "$(cat "$TOKEN_FILE")"
  echo "BLOG0_LISTMONK_LIST_ID=${LIST_ID}"
} >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$OUT"
say "API user ${API_USER}: token ${status}; list ${LIST_NAME} id ${LIST_ID} → ${OUT} (mode 600; token not shown)"
