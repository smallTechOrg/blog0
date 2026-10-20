#!/usr/bin/env bash
# Idempotent Listmonk settings for the blog0 deploy (Stage B, spec/architecture.md §12.7).
#
#   deploy/listmonk-settings.sh [--env-file <file>] <listmonk-url>
#     VM    (deploy/vm/deploy-remote.sh, inside the `listmonk-ops` container on the compose network, whose
#           env file is listmonk.env): bash /ops/listmonk-settings.sh http://listmonk:9000
#     local (deploy/local/verify.sh runs deploy-remote.sh, so the same call)
#     by hand through the IAP tunnel (docs/deploy-gcp.md → Listmonk admin):
#           deploy/listmonk-settings.sh --env-file <listmonk.env> http://localhost:9000
# Values come from the environment; --env-file fills only variables the shell has not set (KEY=value
# lines, `#` comments, no quoting — the docker env-file format). Read:
#   LISTMONK_ADMIN_USER / LISTMONK_ADMIN_PASSWORD   the Super Admin (session login, as scripts/listmonk-dev.sh)
#   LISTMONK_ROOT_URL                               → app.root_url (opens/clicks/unsubscribe resolve there).
#                                                     Production: https://<SITE_DOMAIN>/lm - Listmonk's public paths are
#                                                     served under the /lm prefix by blog0's rewrites (one host)
#   LISTMONK_FROM_EMAIL (optional)                  → app.from_email
#   LISTMONK_SMTP_{HOST,PORT,USER,PASSWORD,TLS}     → the ONE SMTP entry (max_conns 2; TLS = STARTTLS|TLS|none;
#                                                     USER empty → no auth)
#   LISTMONK_BOUNCE_POP_{HOST,PORT,USER,PASSWORD}   → POP bounce mailbox (TLS, scan 15 m, hard bounce →
#                                                     blocklist); HOST empty → bounce processing off
# Also: privacy.unsubscribe_header on, export/wipe off, public archive + public subscription page off,
# sliding window 1 800 messages / 24 h (under Google Workspace's 2 000/day per user).
# GET /api/settings, merge only those keys, PUT, wait for Listmonk's reload, then read back and check.
# Prints `listmonk-settings: ok` (no secret is printed; the request body goes through a 0600 temp
# file, never argv). Exit 0 ok; 1 any API error; 2 usage / missing value. Needs curl + node.
set -euo pipefail

say() { echo "listmonk-settings: $*"; }
fail() {
  say "FAIL — $1"
  exit "${2:-1}"
}
usage() { fail "usage: deploy/listmonk-settings.sh [--env-file <file>] <listmonk-url>" 2; }

ENV_FILE=""
URL=""
while (($# > 0)); do
  case "$1" in
    --) ;;
    --env-file)
      [[ $# -ge 2 ]] || usage
      ENV_FILE="$2"
      shift
      ;;
    --env-file=*) ENV_FILE="${1#*=}" ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [[ -z "$URL" ]] || usage
      URL="${1%/}"
      ;;
  esac
  shift
done
[[ -n "$URL" ]] || usage
[[ "$URL" =~ ^https?:// ]] || usage
command -v node >/dev/null 2>&1 || fail "node is required (JSON merge)" 2
command -v curl >/dev/null 2>&1 || fail "curl is required" 2

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "env file ${ENV_FILE} not found" 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    [[ -n "${!key+x}" ]] && continue # the shell wins
    export "$key=${line#*=}"
  done <"$ENV_FILE"
fi

for v in LISTMONK_ADMIN_USER LISTMONK_ADMIN_PASSWORD LISTMONK_ROOT_URL LISTMONK_SMTP_HOST LISTMONK_SMTP_PORT; do
  [[ -n "${!v:-}" ]] || fail "${v} is not set" 2
done
case "${LISTMONK_SMTP_TLS:-STARTTLS}" in STARTTLS | TLS | none) ;; *) fail "LISTMONK_SMTP_TLS must be STARTTLS, TLS or none" 2 ;; esac
if [[ -n "${LISTMONK_BOUNCE_POP_HOST:-}" ]]; then
  for v in LISTMONK_BOUNCE_POP_USER LISTMONK_BOUNCE_POP_PASSWORD; do
    [[ -n "${!v:-}" ]] || fail "${v} is not set (LISTMONK_BOUNCE_POP_HOST is)" 2
  done
fi
export LISTMONK_SMTP_TLS="${LISTMONK_SMTP_TLS:-STARTTLS}"

umask 077
WORK="$(mktemp -d -t listmonk-settings.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
JAR="${WORK}/jar"

wait_for_login_page() {
  local deadline=$((SECONDS + 90))
  until [[ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${URL}/admin/login")" == "200" ]]; do
    ((SECONDS < deadline)) || fail "Listmonk did not answer on ${URL} within 90 s"
    sleep 1
  done
}

admin_login() {
  local page nonce code
  rm -f "$JAR"
  page="$(curl -sS -m 10 -c "$JAR" -b "$JAR" "${URL}/admin/login")" || fail "GET /admin/login"
  nonce="$(printf '%s' "$page" | grep -oE 'name="nonce"[^>]*value="[^"]*"' | sed -E 's/.*value="([^"]*)"/\1/')"
  [[ -n "$nonce" ]] || fail "no login nonce on /admin/login"
  # The password goes through a 0600 file (curl reads it), never argv.
  printf '%s' "$LISTMONK_ADMIN_PASSWORD" >"${WORK}/pw"
  code="$(curl -sS -m 10 -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "${URL}/admin/login" \
    --data-urlencode "username=${LISTMONK_ADMIN_USER}" --data-urlencode "password@${WORK}/pw" \
    --data-urlencode "nonce=${nonce}" --data-urlencode "next=/admin")" || fail "POST /admin/login"
  rm -f "${WORK}/pw"
  [[ "$code" == "302" ]] || fail "admin login answered ${code} (expected 302) — check LISTMONK_ADMIN_USER/PASSWORD"
}

api() { # <method> <path> <out-file> [body-file]
  local method="$1" path="$2" out="$3" body="${4:-}" code
  if [[ -n "$body" ]]; then
    code="$(curl -sS -m 30 -b "$JAR" -o "$out" -w '%{http_code}' -X "$method" -H 'content-type: application/json' --data-binary "@${body}" "${URL}${path}")" || fail "${method} ${path}"
  else
    code="$(curl -sS -m 30 -b "$JAR" -o "$out" -w '%{http_code}' -X "$method" "${URL}${path}")" || fail "${method} ${path}"
  fi
  if [[ "$code" != 2* ]]; then
    local msg
    msg="$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.message||""))}catch{}' "$out" 2>/dev/null || true)"
    fail "${method} ${path} → ${code}${msg:+ (${msg})}"
  fi
}

wait_for_login_page
admin_login
api GET /api/settings "${WORK}/current.json"

# Merge: only the keys this deploy owns; everything else (appearance, messengers, …) is kept as is.
node - "${WORK}/current.json" "${WORK}/body.json" <<'NODE' || fail "could not build the settings body"
const fs = require('fs');
const [src, dst] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(src, 'utf8')).data;
const env = process.env;
d['app.root_url'] = env.LISTMONK_ROOT_URL.replace(/\/+$/, '');
if (env.LISTMONK_FROM_EMAIL) d['app.from_email'] = env.LISTMONK_FROM_EMAIL;
d['app.enable_public_archive'] = false;
d['app.enable_public_subscription_page'] = false;
d['app.message_sliding_window'] = true;
d['app.message_sliding_window_duration'] = '24h';
d['app.message_sliding_window_rate'] = 1800;
d['privacy.unsubscribe_header'] = true;
d['privacy.allow_export'] = false;
d['privacy.allow_wipe'] = false;

const smtpBase = (Array.isArray(d.smtp) && d.smtp[0]) || {};
const tls = env.LISTMONK_SMTP_TLS;
const user = env.LISTMONK_SMTP_USER || '';
d.smtp = [{
  ...smtpBase, // keeps the entry's uuid (Listmonk matches passwords by uuid)
  enabled: true,
  host: env.LISTMONK_SMTP_HOST,
  port: Number(env.LISTMONK_SMTP_PORT),
  auth_protocol: user ? 'plain' : 'none',
  username: user,
  password: user ? env.LISTMONK_SMTP_PASSWORD || '' : '',
  tls_type: tls,
  tls_skip_verify: false,
  hello_hostname: smtpBase.hello_hostname || '',
  email_headers: Array.isArray(smtpBase.email_headers) ? smtpBase.email_headers : [],
  max_conns: 2,
  max_msg_retries: smtpBase.max_msg_retries ?? 2,
  idle_timeout: smtpBase.idle_timeout || '15s',
  wait_timeout: smtpBase.wait_timeout || '5s',
}];

if (env.LISTMONK_BOUNCE_POP_HOST) {
  const boxBase = (Array.isArray(d['bounce.mailboxes']) && d['bounce.mailboxes'][0]) || {};
  d['bounce.enabled'] = true;
  d['bounce.mailboxes'] = [{
    ...boxBase,
    enabled: true,
    type: 'pop',
    host: env.LISTMONK_BOUNCE_POP_HOST,
    port: Number(env.LISTMONK_BOUNCE_POP_PORT || 995),
    auth_protocol: 'userpass',
    username: env.LISTMONK_BOUNCE_POP_USER,
    password: env.LISTMONK_BOUNCE_POP_PASSWORD,
    return_path: boxBase.return_path || '',
    scan_interval: '15m',
    tls_enabled: true,
    tls_skip_verify: false,
  }];
  const actions = d['bounce.actions'] && typeof d['bounce.actions'] === 'object' ? d['bounce.actions'] : {};
  d['bounce.actions'] = { ...actions, hard: { ...(actions.hard || {}), count: 1, action: 'blocklist' } };
} else {
  d['bounce.enabled'] = false;
  if (Array.isArray(d['bounce.mailboxes'])) d['bounce.mailboxes'] = d['bounce.mailboxes'].map((b) => ({ ...b, enabled: false }));
}
fs.writeFileSync(dst, JSON.stringify(d), { mode: 0o600 });
NODE

api PUT /api/settings "${WORK}/put.json" "${WORK}/body.json"
rm -f "${WORK}/body.json"
# Listmonk reloads itself after a settings change; wait for it, then read back with a fresh session.
sleep 3
wait_for_login_page
admin_login
api GET /api/settings "${WORK}/after.json"
node - "${WORK}/after.json" <<'NODE' || fail "settings did not stick (see the message above)"
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).data;
const env = process.env;
const problems = [];
const want = (k, v) => { if (d[k] !== v) problems.push(`${k} = ${JSON.stringify(d[k])}, expected ${JSON.stringify(v)}`); };
want('app.root_url', env.LISTMONK_ROOT_URL.replace(/\/+$/, ''));
want('privacy.unsubscribe_header', true);
want('privacy.allow_export', false);
want('privacy.allow_wipe', false);
want('app.enable_public_archive', false);
want('app.enable_public_subscription_page', false);
want('app.message_sliding_window', true);
want('app.message_sliding_window_rate', 1800);
want('bounce.enabled', Boolean(env.LISTMONK_BOUNCE_POP_HOST));
const smtp = (d.smtp || []).filter((s) => s.enabled).map((s) => `${s.host}:${s.port}/${s.tls_type}`);
const expected = `${env.LISTMONK_SMTP_HOST}:${Number(env.LISTMONK_SMTP_PORT)}/${env.LISTMONK_SMTP_TLS}`;
if (smtp.length !== 1 || smtp[0] !== expected) problems.push(`enabled SMTP = ${JSON.stringify(smtp)}, expected ["${expected}"]`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`listmonk-settings: root_url ${d['app.root_url']}; SMTP ${smtp[0]} (max_conns 2); window 1800/24h; bounces ${d['bounce.enabled'] ? 'POP on' : 'off'}`);
NODE
say ok
