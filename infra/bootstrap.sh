#!/usr/bin/env bash
# blog0 one-time GCP + GitHub bootstrap (spec/architecture.md §12.7; docs/deploy-gcp.md → Bootstrap).
# Run ONCE by the owner, locally, with an admin `gcloud` login and `gh` authenticated for the repo:
#
#   bash infra/bootstrap.sh [--dry-run] [--sync-env] [--rotate <SECRET_NAME>]...
#
# Idempotent — re-running creates nothing twice and rotates nothing unless asked:
#   * enables the APIs blog0 needs (sts, iap, … — enabling is additive);
#   * service accounts blog0-deployer (GitHub Actions via WIF, no keys) and blog0-vm (the VM);
#   * Workload Identity pool `blog0-github` + OIDC provider `github`, restricted to this repository;
#   * Artifact Registry repo `blog0` (docker, us-central1); backup bucket blog0-backups-<project>;
#   * IAM: only bindings FOR the two blog0 SAs (least privilege, see docs/deploy-gcp.md);
#   * Cloud SQL (shared instance ai-agent-db): databases blog0 + listmonk, users blog0_owner + listmonk
#     (never touches the instance's settings, other databases or other users);
#   * GitHub repo variables (non-secret) and secrets (values piped on stdin, never argv / output).
# Secrets: var/prod/secrets.env (mode 600, gitignored) is the source of truth for every GENERATED
# value — reused on every re-run; a value is generated only when it is in neither that file nor GitHub.
# Values COPIED from .env (OpenRouter key, SMTP, admin e-mail/name, heartbeats) are set when the
# GitHub secret is missing (--sync-env: always re-copy). BLOG0_JEV_MODEL is forced to typesafe/jev-1.13.
# --rotate <NAME>: regenerate that generated secret (DB passwords are also applied to Cloud SQL;
# BLOG0_DB_APP_PASSWORD is applied by the next deploy's release step). LISTMONK_ADMIN_* cannot be
# rotated here (Listmonk keeps its admin in its own database). The first admin's password is also
# written to var/prod-admin.txt (mode 600). Output: names + `set` / `exists` / `created` only.
# --dry-run: read-only (describes + `gh … list`); prints what it would do; writes no file.
# Exit 0 ok; 1 failure; 2 usage.
set -euo pipefail
((BASH_VERSINFO[0] >= 4)) || {
  echo "bootstrap: needs bash >= 4 (macOS: brew install bash; then run: bash infra/bootstrap.sh)" >&2
  exit 2
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PREFIX=bootstrap
# shellcheck source=lib/common.sh
source "${ROOT}/infra/lib/common.sh"

DRY_RUN=0
SYNC_ENV=0
ROTATE=" "
while (($# > 0)); do
  case "$1" in
    --) ;;
    --dry-run) DRY_RUN=1 ;;
    --sync-env) SYNC_ENV=1 ;;
    --rotate)
      [[ $# -ge 2 ]] || {
        echo "usage: infra/bootstrap.sh [--dry-run] [--sync-env] [--rotate <SECRET_NAME>]..." >&2
        exit 2
      }
      ROTATE+="$2 "
      shift
      ;;
    *)
      echo "usage: infra/bootstrap.sh [--dry-run] [--sync-env] [--rotate <SECRET_NAME>]..." >&2
      exit 2
      ;;
  esac
  shift
done

GCP_PROJECT="${GCP_PROJECT:-ai-agent-boilerplate0}"
GCP_REGION="${GCP_REGION:-us-central1}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GH_REPO="${GH_REPO:-$BLOG0_REPO_DEFAULT}"
SQL_INSTANCE="${SQL_INSTANCE:-ai-agent-db}"
SITE_DOMAIN="${SITE_DOMAIN:-blog0.smalltech.in}"
NEWS_DOMAIN="${NEWS_DOMAIN:-news.blog0.smalltech.in}"
DEPLOYER=blog0-deployer
VM_SA=blog0-vm
POOL=blog0-github
PROVIDER=github
AR_REPO=blog0
BUCKET="blog0-backups-${GCP_PROJECT}"
DEPLOYER_EMAIL="${DEPLOYER}@${GCP_PROJECT}.iam.gserviceaccount.com"
VM_SA_EMAIL="${VM_SA}@${GCP_PROJECT}.iam.gserviceaccount.com"
SECRETS_DIR="${ROOT}/var/prod"
SECRETS_FILE="${SECRETS_DIR}/secrets.env"
ADMIN_FILE="${ROOT}/var/prod-admin.txt"
DOTENV="${ROOT}/.env"
JEV_MODEL=typesafe/jev-1.13

require_cmd gcloud gh jq openssl
for r in $ROTATE; do
  case "$r" in LISTMONK_ADMIN_USER | LISTMONK_ADMIN_PASSWORD) fail "${r} cannot be rotated here (Listmonk keeps its admin in its database; change it in the Listmonk UI)" ;; esac
done

run() {
  if ((DRY_RUN)); then
    if [[ "$1" == g ]]; then
      shift
      echo "bootstrap: would: gcloud $* --project ${GCP_PROJECT}"
    else
      echo "bootstrap: would: $1 $2 $3 …"
    fi
  else
    "$@"
  fi
}
((DRY_RUN)) && say "DRY RUN — read-only; nothing below is created, changed or written"

# --- 0. preflight ----------------------------------------------------------------------------------
account="$(gcloud config get-value account 2>/dev/null || true)"
[[ -n "$account" ]] || fail "no active gcloud account (gcloud auth login)"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated (gh auth login)"
PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')" || fail "cannot describe project ${GCP_PROJECT}"
gh repo view "$GH_REPO" --json name >/dev/null 2>&1 || fail "cannot see GitHub repo ${GH_REPO}"
say "project ${GCP_PROJECT} (#${PROJECT_NUMBER}) as ${account}; repo ${GH_REPO}"

# --- 1. APIs -----------------------------------------------------------------------------------------
enabled="$(gcloud services list --enabled --project "$GCP_PROJECT" --format='value(config.name)')"
for api in sts iap iam iamcredentials artifactregistry compute sqladmin storage logging monitoring cloudresourcemanager; do
  if grep -qx "${api}.googleapis.com" <<<"$enabled"; then
    say "api ${api}: enabled"
  else
    run g services enable "${api}.googleapis.com"
    say "api ${api}: enabled now"
  fi
done

# --- 2. service accounts ----------------------------------------------------------------------------
for sa in "$DEPLOYER" "$VM_SA"; do
  if gcloud iam service-accounts describe "${sa}@${GCP_PROJECT}.iam.gserviceaccount.com" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    say "service account ${sa}: exists"
  else
    run g iam service-accounts create "$sa" --display-name "blog0 ${sa#blog0-}"
    say "service account ${sa}: created"
  fi
done

# --- 3. Workload Identity Federation (GitHub OIDC → blog0-deployer; no keys) ---------------------------
if gcloud iam workload-identity-pools describe "$POOL" --location global --project "$GCP_PROJECT" >/dev/null 2>&1; then
  say "wif pool ${POOL}: exists"
else
  run g iam workload-identity-pools create "$POOL" --location global --display-name "blog0 GitHub Actions"
  say "wif pool ${POOL}: created"
fi
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool "$POOL" --location global --project "$GCP_PROJECT" >/dev/null 2>&1; then
  say "wif provider ${PROVIDER}: exists"
else
  run g iam workload-identity-pools providers create-oidc "$PROVIDER" --workload-identity-pool "$POOL" --location global \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
    --attribute-condition "assertion.repository=='${GH_REPO}'"
  say "wif provider ${PROVIDER}: created (only ${GH_REPO})"
fi
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
WIF_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GH_REPO}"

# --- 4. IAM (bindings FOR blog0 SAs only; checked before adding) ---------------------------------------
has_binding() { # <policy-json> <role> <member>
  jq -e --arg r "$2" --arg m "$3" '[.bindings[]? | select(.role == $r) | .members[]] | index($m)' <<<"$1" >/dev/null
}
ensure_project_role() { # <member> <role>
  local policy
  policy="$(gcloud projects get-iam-policy "$GCP_PROJECT" --format=json)"
  if has_binding "$policy" "$2" "$1"; then
    say "iam project ${2} → ${1#serviceAccount:}: exists"
  else
    run g projects add-iam-policy-binding "$GCP_PROJECT" --member "$1" --role "$2" --condition=None
    say "iam project ${2} → ${1#serviceAccount:}: added"
  fi
}
ensure_sa_role() { # <sa-email> <member> <role>
  local policy
  policy="$(gcloud iam service-accounts get-iam-policy "$1" --project "$GCP_PROJECT" --format=json 2>/dev/null || echo '{}')"
  if has_binding "$policy" "$3" "$2"; then
    say "iam ${1%%@*}: ${3} → ${2##*/}: exists"
  else
    run g iam service-accounts add-iam-policy-binding "$1" --member "$2" --role "$3"
    say "iam ${1%%@*}: ${3} → ${2##*/}: added"
  fi
}
ensure_sa_role "$DEPLOYER_EMAIL" "$WIF_PRINCIPAL" roles/iam.workloadIdentityUser
ensure_sa_role "$VM_SA_EMAIL" "serviceAccount:${DEPLOYER_EMAIL}" roles/iam.serviceAccountUser
# VM-level powers (instanceAdmin, osAdminLogin) are IAM-conditioned to instances named blog0-*, so the
# deployer cannot touch the other live VMs in this shared project even by mistake.
ensure_project_role_instances_only() { # <member> <role>
  local policy cond
  cond="resource.type != \"compute.googleapis.com/Instance\" || resource.name.startsWith(\"projects/${GCP_PROJECT}/zones/${GCP_ZONE}/instances/blog0-\")"
  policy="$(gcloud projects get-iam-policy "$GCP_PROJECT" --format=json)"
  if jq -e --arg r "$2" --arg m "$1" '[.bindings[]? | select(.role == $r and .condition.title == "blog0-instances-only") | .members[]] | index($m)' <<<"$policy" >/dev/null; then
    say "iam project ${2} (blog0-* instances only) → ${1#serviceAccount:}: exists"
  else
    run g projects add-iam-policy-binding "$GCP_PROJECT" --member "$1" --role "$2" \
      --condition="expression=${cond},title=blog0-instances-only,description=blog0 deployer: blog0-* instances only"
    say "iam project ${2} (blog0-* instances only) → ${1#serviceAccount:}: added"
  fi
}
for role in roles/compute.instanceAdmin.v1 roles/compute.osAdminLogin; do
  ensure_project_role_instances_only "serviceAccount:${DEPLOYER_EMAIL}" "$role"
done
for role in roles/compute.loadBalancerAdmin roles/compute.securityAdmin roles/iap.tunnelResourceAccessor; do
  ensure_project_role "serviceAccount:${DEPLOYER_EMAIL}" "$role"
done
for role in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter; do
  ensure_project_role "serviceAccount:${VM_SA_EMAIL}" "$role"
done

# --- 5. Artifact Registry repo blog0 (repo-level bindings) ---------------------------------------------
if gcloud artifacts repositories describe "$AR_REPO" --location "$GCP_REGION" --project "$GCP_PROJECT" >/dev/null 2>&1; then
  say "artifact registry ${AR_REPO}: exists"
else
  run g artifacts repositories create "$AR_REPO" --location "$GCP_REGION" --repository-format docker --description "blog0 images (built by GitHub Actions)"
  say "artifact registry ${AR_REPO}: created"
fi
ar_policy="$(gcloud artifacts repositories get-iam-policy "$AR_REPO" --location "$GCP_REGION" --project "$GCP_PROJECT" --format=json 2>/dev/null || echo '{}')"
for pair in "serviceAccount:${DEPLOYER_EMAIL} roles/artifactregistry.writer" "serviceAccount:${VM_SA_EMAIL} roles/artifactregistry.reader"; do
  read -r member role <<<"$pair"
  if has_binding "$ar_policy" "$role" "$member"; then
    say "iam ar/${AR_REPO}: ${role} → ${member#serviceAccount:}: exists"
  else
    run g artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$GCP_REGION" --member "$member" --role "$role"
    say "iam ar/${AR_REPO}: ${role} → ${member#serviceAccount:}: added"
  fi
done

# --- 6. backup bucket (uniform access, versioning, noncurrent → deleted after 30 days) --------------------
if gcloud storage buckets describe "gs://${BUCKET}" --project "$GCP_PROJECT" >/dev/null 2>&1; then
  say "bucket ${BUCKET}: exists"
else
  run g storage buckets create "gs://${BUCKET}" --location "$GCP_REGION" --uniform-bucket-level-access --public-access-prevention
  say "bucket ${BUCKET}: created"
fi
bucket_json="$(gcloud storage buckets describe "gs://${BUCKET}" --project "$GCP_PROJECT" --format=json 2>/dev/null || echo '{}')"
if [[ "$(jq -r '.versioning_enabled // false' <<<"$bucket_json")" != true ]]; then
  run g storage buckets update "gs://${BUCKET}" --versioning
  say "bucket ${BUCKET}: versioning on"
fi
if ! jq -e '[.lifecycle_config.rule[]? | select(.action.type=="Delete" and .condition.daysSinceNoncurrentTime==30)] | length > 0' <<<"$bucket_json" >/dev/null; then
  lifecycle="$(mktemp -t blog0-lifecycle.XXXXXX)"
  echo '{"rule":[{"action":{"type":"Delete"},"condition":{"daysSinceNoncurrentTime":30,"isLive":false}}]}' >"$lifecycle"
  run g storage buckets update "gs://${BUCKET}" --lifecycle-file "$lifecycle"
  rm -f "$lifecycle"
  say "bucket ${BUCKET}: lifecycle (noncurrent versions deleted after 30 days)"
fi
bucket_policy="$(gcloud storage buckets get-iam-policy "gs://${BUCKET}" --project "$GCP_PROJECT" --format=json 2>/dev/null || echo '{}')"
if has_binding "$bucket_policy" roles/storage.objectAdmin "serviceAccount:${VM_SA_EMAIL}"; then
  say "iam bucket ${BUCKET}: storage.objectAdmin → ${VM_SA}: exists"
else
  run g storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${VM_SA_EMAIL}" --role roles/storage.objectAdmin
  say "iam bucket ${BUCKET}: storage.objectAdmin → ${VM_SA}: added"
fi

# --- 7. secrets: var/prod/secrets.env is the source of truth for generated values -----------------------
declare -A LOCAL=()
if [[ -f "$SECRETS_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] && LOCAL["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  done <"$SECRETS_FILE"
fi
declare -A DOT=()
if [[ -f "$DOTENV" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    DOT["$key"]="$val"
  done <"$DOTENV"
else
  warn ".env not found — the copied secrets (OpenRouter key, SMTP, admin e-mail) are skipped"
fi
GH_SECRETS="$(gh secret list --repo "$GH_REPO" --json name -q '.[].name' 2>/dev/null)" || fail "cannot list secrets of ${GH_REPO} (needs repo admin)"
in_gh() { grep -qx "$1" <<<"$GH_SECRETS"; }
gh_set_secret() { # <name> <value>   (value on stdin to gh; never argv, never printed)
  if ((DRY_RUN)); then
    echo "bootstrap: would: gh secret set $1 --repo ${GH_REPO} (value on stdin)"
  else
    printf '%s' "$2" | gh secret set "$1" --repo "$GH_REPO" >/dev/null
  fi
}
gen() { # <kind>
  case "$1" in
    b64) openssl rand -base64 48 | tr -d '\n' ;;
    b64s) openssl rand -base64 32 | tr -d '\n' ;;
    hex) openssl rand -hex 24 ;;
    pw) openssl rand -base64 30 | tr -d '\n/+=' | cut -c1-28 ;;
    # Cloud SQL's password policy wants lower + upper + digit + a symbol; '-' stays URL- and shell-safe.
    dbpw) printf '%s-Zq7' "$(openssl rand -base64 30 | tr -d '\n/+=' | cut -c1-26)" ;;
  esac
}
CHANGED_LOCAL=0
ROTATED=" "
# ensure_generated <NAME> <kind>
ensure_generated() {
  local name="$1" kind="$2"
  if [[ "$ROTATE" == *" ${name} "* ]]; then
    LOCAL["$name"]="$(gen "$kind")"
    CHANGED_LOCAL=1
    ROTATED+="${name} "
    gh_set_secret "$name" "${LOCAL[$name]}"
    say "secret ${name}: set (rotated)"
  elif [[ -n "${LOCAL[$name]:-}" ]]; then
    if in_gh "$name"; then
      say "secret ${name}: exists"
    else
      gh_set_secret "$name" "${LOCAL[$name]}"
      say "secret ${name}: set (from var/prod/secrets.env)"
    fi
  elif in_gh "$name"; then
    warn "secret ${name}: exists in GitHub but not in var/prod/secrets.env — kept (GitHub secrets cannot be read back)"
  else
    LOCAL["$name"]="$(gen "$kind")"
    CHANGED_LOCAL=1
    gh_set_secret "$name" "${LOCAL[$name]}"
    say "secret ${name}: set (generated)"
  fi
}
# ensure_fixed <NAME> <value>   (non-random generated value, e.g. the Listmonk admin user name)
ensure_fixed() {
  if [[ -z "${LOCAL[$1]:-}" ]]; then
    LOCAL["$1"]="$2"
    CHANGED_LOCAL=1
  fi
  if in_gh "$1"; then say "secret $1: exists"; else
    gh_set_secret "$1" "${LOCAL[$1]}"
    say "secret $1: set"
  fi
}
ensure_generated BLOG0_SESSION_SECRET b64
ensure_generated BLOG0_UNSUBSCRIBE_SECRET b64s
ensure_generated BLOG0_NEWSLETTER_WEBHOOK_SECRET b64s
ensure_generated BLOG0_DB_OWNER_PASSWORD dbpw
ensure_generated BLOG0_DB_APP_PASSWORD dbpw
ensure_generated LISTMONK_DB_PASSWORD dbpw
ensure_fixed LISTMONK_ADMIN_USER blog0-admin
ensure_generated LISTMONK_ADMIN_PASSWORD hex
ensure_generated BLOG0_ADMIN_PASSWORD pw

# Copied from .env (never generated). Missing in .env → warning, nothing set.
copy_secret() { # <NAME> [required]
  local name="$1" val="${DOT[$1]:-}"
  if [[ "$name" == BLOG0_JEV_MODEL ]]; then
    [[ -z "$val" || "$val" == "$JEV_MODEL" ]] || say "secret BLOG0_JEV_MODEL: .env names another model — forced ${JEV_MODEL}"
    val="$JEV_MODEL"
  fi
  if [[ -z "$val" ]]; then
    if in_gh "$name"; then say "secret ${name}: exists (not in .env)"; elif [[ "${2:-}" == required ]]; then warn "secret ${name}: not in .env and not in GitHub — set it, then re-run"; fi
    return 0
  fi
  if in_gh "$name" && ((SYNC_ENV == 0)); then
    say "secret ${name}: exists"
  else
    gh_set_secret "$name" "$val"
    say "secret ${name}: set (from .env)"
  fi
}
for name in BLOG0_OPENROUTER_API_KEY BLOG0_JEV_MODEL BLOG0_SMTP_HOST BLOG0_SMTP_PORT BLOG0_SMTP_USER BLOG0_SMTP_PASS BLOG0_SMTP_FROM BLOG0_ADMIN_EMAIL; do
  copy_secret "$name" required
done
for name in BLOG0_ADMIN_NAME BLOG0_HEARTBEAT_BACKUP_URL BLOG0_HEARTBEAT_TICK_URL; do copy_secret "$name"; done

if ((CHANGED_LOCAL)) && ((DRY_RUN == 0)); then
  install -d -m 700 "$SECRETS_DIR"
  umask 077
  tmp="${SECRETS_FILE}.tmp.$$"
  {
    echo "# blog0 production secrets — generated by infra/bootstrap.sh (source of truth; mode 600; never commit)"
    for k in $(printf '%s\n' "${!LOCAL[@]}" | sort); do printf '%s=%s\n' "$k" "${LOCAL[$k]}"; done
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$SECRETS_FILE"
  say "wrote var/prod/secrets.env (mode 600; values not shown)"
fi
if ((DRY_RUN == 0)) && [[ -n "${LOCAL[BLOG0_ADMIN_PASSWORD]:-}" ]]; then
  umask 077
  {
    echo "blog0 production admin (written by infra/bootstrap.sh; keep private, mode 600)"
    echo "url:      https://${SITE_DOMAIN}/admin"
    echo "email:    ${DOT[BLOG0_ADMIN_EMAIL]:-<BLOG0_ADMIN_EMAIL from .env>}"
    echo "password: ${LOCAL[BLOG0_ADMIN_PASSWORD]}"
  } >"$ADMIN_FILE"
  chmod 600 "$ADMIN_FILE"
  say "wrote var/prod-admin.txt (mode 600)"
fi

# --- 8. Cloud SQL: databases + users on the shared instance (nothing else touched) -------------------
sql_json="$(gcloud sql instances describe "$SQL_INSTANCE" --project "$GCP_PROJECT" --format=json)" || fail "cannot describe Cloud SQL ${SQL_INSTANCE}"
PRIVATE_IP="$(jq -r '[.ipAddresses[]? | select(.type=="PRIVATE") | .ipAddress][0] // empty' <<<"$sql_json")"
[[ -n "$PRIVATE_IP" ]] || fail "Cloud SQL ${SQL_INSTANCE} has no private IP"
dbs="$(gcloud sql databases list --instance "$SQL_INSTANCE" --project "$GCP_PROJECT" --format='value(name)')"
for db in blog0 listmonk; do
  if grep -qx "$db" <<<"$dbs"; then say "cloud sql database ${db}: exists"; else
    run g sql databases create "$db" --instance "$SQL_INSTANCE"
    say "cloud sql database ${db}: created"
  fi
done
users="$(gcloud sql users list --instance "$SQL_INSTANCE" --project "$GCP_PROJECT" --format='value(name)')"
# sql_user <user> <SECRET_NAME>
sql_user() {
  local user="$1" secret="$2" pw="${LOCAL[$2]:-}"
  if grep -qx "$user" <<<"$users"; then
    if [[ "$ROTATED" == *" ${secret} "* ]]; then
      if ((DRY_RUN)); then echo "bootstrap: would: gcloud sql users set-password ${user} --instance ${SQL_INSTANCE} (password from var/prod)"; else
        gcloud sql users set-password "$user" --instance "$SQL_INSTANCE" --project "$GCP_PROJECT" --password "$pw" --quiet >/dev/null
      fi
      say "cloud sql user ${user}: password rotated"
    else
      say "cloud sql user ${user}: exists"
    fi
    return
  fi
  if [[ -z "$pw" ]]; then
    if ((DRY_RUN)); then
      echo "bootstrap: would: gcloud sql users create ${user} --instance ${SQL_INSTANCE} (password generated into var/prod)"
      return
    fi
    fail "cloud sql user ${user} is missing and ${secret} is not in var/prod/secrets.env — re-run with --rotate ${secret}"
  fi
  if ((DRY_RUN)); then echo "bootstrap: would: gcloud sql users create ${user} --instance ${SQL_INSTANCE} (password from var/prod)"; else
    gcloud sql users create "$user" --instance "$SQL_INSTANCE" --project "$GCP_PROJECT" --password "$pw" --quiet >/dev/null
  fi
  say "cloud sql user ${user}: created"
}
sql_user blog0_owner BLOG0_DB_OWNER_PASSWORD
sql_user listmonk LISTMONK_DB_PASSWORD

# --- 9. GitHub repo variables (non-secret) ----------------------------------------------------------------
GH_VARS="$(gh variable list --repo "$GH_REPO" --json name,value 2>/dev/null || echo '[]')"
set_var() { # <name> <value>
  if [[ "$(jq -r --arg n "$1" '.[] | select(.name == $n) | .value' <<<"$GH_VARS")" == "$2" ]]; then
    say "variable $1: exists"
  else
    run gh variable set "$1" --repo "$GH_REPO" --body "$2"
    say "variable $1: set"
  fi
}
set_var GCP_PROJECT "$GCP_PROJECT"
set_var GCP_REGION "$GCP_REGION"
set_var GCP_ZONE "$GCP_ZONE"
set_var GCP_INSTANCE blog0-vm
set_var GCP_WIF_PROVIDER "$WIF_PROVIDER"
set_var GCP_DEPLOYER_SA "$DEPLOYER_EMAIL"
set_var GCP_VM_SA "$VM_SA_EMAIL"
set_var AR_REPO "$AR_REPO"
set_var BACKUP_BUCKET "$BUCKET"
set_var SITE_DOMAIN "$SITE_DOMAIN"
set_var NEWS_DOMAIN "$NEWS_DOMAIN"
set_var CLOUDSQL_PRIVATE_IP "$PRIVATE_IP"

((DRY_RUN)) && say "DRY RUN complete — nothing was changed" || say "OK — next: push infra/** (or run the 'provision' workflow), then 'deploy'; DNS + DKIM are the only manual steps (docs/deploy-gcp.md)"
