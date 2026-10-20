#!/usr/bin/env bash
# Renders the VM's env files from the environment (GitHub repo variables + secrets in
# .github/workflows/deploy.yml; spec/architecture.md §12.7):
#
#   deploy/vm/render-env.sh <out-dir> <image-tag>
#
# Writes (umask 077; mode 600; values never printed — only names in errors):
#   blog0.env     blog0 + scheduler runtime (DATABASE_URL = restricted role blog0_app, sslmode=require)
#   release.env   release step only (DATABASE_URL = schema owner blog0_owner; app role + first admin)
#   listmonk.env  Listmonk config (Cloud SQL private IP, ssl_mode=require, tiny pool) + the values
#                 deploy/listmonk-settings.sh reads (Workspace SMTP, POP bounces on the same mailbox)
#   compose.env   compose interpolation (image names + tag, media backup target)
# Docker env files take each line literally (no quotes); a value with a newline is refused.
# Required: GCP_PROJECT GCP_REGION AR_REPO BACKUP_BUCKET SITE_DOMAIN CLOUDSQL_PRIVATE_IP
#   BLOG0_SESSION_SECRET BLOG0_OPENROUTER_API_KEY BLOG0_DB_OWNER_PASSWORD BLOG0_DB_APP_PASSWORD
#   LISTMONK_DB_PASSWORD LISTMONK_ADMIN_USER LISTMONK_ADMIN_PASSWORD BLOG0_ADMIN_EMAIL BLOG0_ADMIN_PASSWORD
#   BLOG0_SMTP_HOST BLOG0_SMTP_PORT BLOG0_SMTP_USER BLOG0_SMTP_PASS BLOG0_SMTP_FROM
# Optional: LISTMONK_SMTP_TLS (STARTTLS default; local Mailpit: none) BLOG0_ADMIN_NAME BLOG0_UNSUBSCRIBE_SECRET BLOG0_NEWSLETTER_WEBHOOK_SECRET BLOG0_JEV_MODEL
#   BLOG0_HEARTBEAT_BACKUP_URL BLOG0_HEARTBEAT_TICK_URL LISTMONK_BOUNCE_POP_HOST (default pop.gmail.com;
#   set to "off" to disable bounce processing).
# Exit 0 ok; 2 usage / missing value.
set -euo pipefail

say() { echo "render-env: $*"; }
die() {
  echo "render-env: FAIL — $1" >&2
  exit 2
}
[[ $# -eq 2 ]] || die "usage: deploy/vm/render-env.sh <out-dir> <image-tag>"
OUT="$1"
TAG="$2"
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || die "image tag must be a git sha (7–40 hex)"
command -v jq >/dev/null 2>&1 || die "jq is required"

missing=()
for v in GCP_PROJECT GCP_REGION AR_REPO BACKUP_BUCKET SITE_DOMAIN CLOUDSQL_PRIVATE_IP \
  BLOG0_SESSION_SECRET BLOG0_OPENROUTER_API_KEY BLOG0_DB_OWNER_PASSWORD BLOG0_DB_APP_PASSWORD \
  LISTMONK_DB_PASSWORD LISTMONK_ADMIN_USER LISTMONK_ADMIN_PASSWORD BLOG0_ADMIN_EMAIL BLOG0_ADMIN_PASSWORD \
  BLOG0_SMTP_HOST BLOG0_SMTP_PORT BLOG0_SMTP_USER BLOG0_SMTP_PASS BLOG0_SMTP_FROM; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
((${#missing[@]} == 0)) || die "not set: ${missing[*]} (run infra/bootstrap.sh; see docs/deploy-gcp.md)"
for v in $(compgen -v | grep -E '^(BLOG0_|LISTMONK_|GCP_|AR_REPO|BACKUP_BUCKET|SITE_DOMAIN|CLOUDSQL_)'); do
  [[ "${!v}" != *$'\n'* && "${!v}" != *$'\r'* ]] || die "${v} contains a newline"
done

enc() { jq -rn --arg v "$1" '$v|@uri'; }
DB_HOST="$CLOUDSQL_PRIVATE_IP"
APP_URL="postgres://blog0_app:$(enc "$BLOG0_DB_APP_PASSWORD")@${DB_HOST}:5432/blog0?sslmode=require"
OWNER_URL="postgres://blog0_owner:$(enc "$BLOG0_DB_OWNER_PASSWORD")@${DB_HOST}:5432/blog0?sslmode=require"
AR_HOST="${GCP_REGION}-docker.pkg.dev"
# LISTMONK_SMTP_TLS=none (local Mailpit only) means no SMTP auth: Go's smtp refuses to send a password
# over an unencrypted connection.
LM_SMTP_TLS="${LISTMONK_SMTP_TLS:-STARTTLS}"
LM_SMTP_USER="$BLOG0_SMTP_USER"
LM_SMTP_PASS="$BLOG0_SMTP_PASS"
if [[ "$LM_SMTP_TLS" == none ]]; then
  LM_SMTP_USER=""
  LM_SMTP_PASS=""
fi
POP_HOST="${LISTMONK_BOUNCE_POP_HOST:-pop.gmail.com}"
[[ "$POP_HOST" == off ]] && POP_HOST=""

umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"

cat >"${OUT}/blog0.env" <<EOF
# blog0 runtime env (blog0 + scheduler) — rendered by deploy/vm/render-env.sh; never commit
BLOG0_DATABASE_URL=${APP_URL}
BLOG0_PUBLIC_BASE_URL=https://${SITE_DOMAIN}
BLOG0_SITE_SLUG=blog0
BLOG0_TRUSTED_PROXY_HOPS=2
BLOG0_RATE_LIMIT_STORE=auto
BLOG0_SHUTDOWN_TIMEOUT_MS=8000
BLOG0_LOG_LEVEL=info
BLOG0_LOG_FILE=
BLOG0_SESSION_SECRET=${BLOG0_SESSION_SECRET}
BLOG0_UNSUBSCRIBE_SECRET=${BLOG0_UNSUBSCRIBE_SECRET:-}
BLOG0_OPENROUTER_API_KEY=${BLOG0_OPENROUTER_API_KEY}
BLOG0_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
BLOG0_OPENROUTER_DECISIONS_URL=https://openrouter.ai/api/alpha/decisions
BLOG0_JEV_MODEL=${BLOG0_JEV_MODEL:-typesafe/jev-1.13}
BLOG0_JEV_TIMEOUT_MS=45000
BLOG0_MAX_AUDIO_MB=50
BLOG0_MAX_AUDIO_MINUTES=30
BLOG0_MAX_IMAGE_MB=8
BLOG0_SMTP_HOST=${BLOG0_SMTP_HOST}
BLOG0_SMTP_PORT=${BLOG0_SMTP_PORT}
BLOG0_SMTP_USER=${BLOG0_SMTP_USER}
BLOG0_SMTP_PASS=${BLOG0_SMTP_PASS}
BLOG0_SMTP_FROM=${BLOG0_SMTP_FROM}
BLOG0_NEWSLETTER_SENDER=listmonk
BLOG0_NEWSLETTER_WEBHOOK_SECRET=${BLOG0_NEWSLETTER_WEBHOOK_SECRET:-}
BLOG0_HEARTBEAT_BACKUP_URL=${BLOG0_HEARTBEAT_BACKUP_URL:-}
BLOG0_HEARTBEAT_TICK_URL=${BLOG0_HEARTBEAT_TICK_URL:-}
EOF

cat >"${OUT}/release.env" <<EOF
# release step only (migrations as the schema owner) — rendered by deploy/vm/render-env.sh
BLOG0_DATABASE_URL=${OWNER_URL}
BLOG0_APP_DB_ROLE=blog0_app
BLOG0_APP_DB_PASSWORD=${BLOG0_DB_APP_PASSWORD}
BLOG0_ADMIN_EMAIL=${BLOG0_ADMIN_EMAIL}
BLOG0_ADMIN_PASSWORD=${BLOG0_ADMIN_PASSWORD}
BLOG0_ADMIN_NAME=${BLOG0_ADMIN_NAME:-}
EOF

cat >"${OUT}/listmonk.env" <<EOF
# Listmonk env — rendered by deploy/vm/render-env.sh; never commit
LISTMONK_db__host=${DB_HOST}
LISTMONK_db__port=5432
LISTMONK_db__user=listmonk
LISTMONK_db__password=${LISTMONK_DB_PASSWORD}
LISTMONK_db__database=listmonk
LISTMONK_db__ssl_mode=require
LISTMONK_db__max_open=4
LISTMONK_db__max_idle=2
LISTMONK_ADMIN_USER=${LISTMONK_ADMIN_USER}
LISTMONK_ADMIN_PASSWORD=${LISTMONK_ADMIN_PASSWORD}
LISTMONK_ROOT_URL=https://${SITE_DOMAIN}/lm
LISTMONK_FROM_EMAIL=${BLOG0_SMTP_FROM}
LISTMONK_SMTP_HOST=${BLOG0_SMTP_HOST}
LISTMONK_SMTP_PORT=${BLOG0_SMTP_PORT}
LISTMONK_SMTP_USER=${LM_SMTP_USER}
LISTMONK_SMTP_PASSWORD=${LM_SMTP_PASS}
LISTMONK_SMTP_TLS=${LM_SMTP_TLS}
LISTMONK_BOUNCE_POP_HOST=${POP_HOST}
LISTMONK_BOUNCE_POP_PORT=995
LISTMONK_BOUNCE_POP_USER=${BLOG0_SMTP_USER}
LISTMONK_BOUNCE_POP_PASSWORD=${BLOG0_SMTP_PASS}
EOF

cat >"${OUT}/compose.env" <<EOF
# compose interpolation — rendered by deploy/vm/render-env.sh (no secret here)
BLOG0_IMAGE=${AR_HOST}/${GCP_PROJECT}/${AR_REPO}/blog0
BLOG0_SCHEDULER_IMAGE=${AR_HOST}/${GCP_PROJECT}/${AR_REPO}/blog0-scheduler
BLOG0_IMAGE_TAG=${TAG}
AR_HOST=${AR_HOST}
MEDIA_BACKUP_DEST=:gcs,env_auth=true,bucket_policy_only=true:${BACKUP_BUCKET}/media
EOF

chmod 600 "${OUT}"/*.env
say "wrote blog0.env release.env listmonk.env compose.env to ${OUT} (mode 600; values not shown)"
