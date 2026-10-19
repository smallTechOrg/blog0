#!/usr/bin/env bash
# blog0 GCP provisioning (spec/architecture.md §12.7; docs/deploy-gcp.md) — run by
# .github/workflows/provision.yml as the `blog0-deployer` service account (WIF), or by an operator:
#
#   bash infra/provision.sh [--dry-run]
#
# Idempotent: every step checks what exists and only creates/updates what differs. Creates ONLY
# blog0-* resources in the SHARED project; the shared load balancer (url map + HTTPS proxy of
# zero-vanguard) is changed ONLY additively — two host rules + two path matchers appended, blog0-cert
# appended to the proxy's certificate list (existing order kept). Before any LB change the url map and
# both proxies are exported to $LB_BACKUP_DIR (default var/lb-backup-<utc-ts>/, with RESTORE.txt).
# After the LB steps https:// and http:// vanguard must still answer 200 — else exit 1 with the backup
# path and the restore commands (never an automatic rollback of the shared LB). Never restarts,
# stops or recreates an existing VM.
#
# --dry-run: read-only — every describe/export runs, every mutation is printed as `would: …`.
#
# Environment (repo variables in CI):
#   GCP_PROJECT GCP_REGION GCP_ZONE GCP_INSTANCE (blog0-vm) GCP_VM_SA SITE_DOMAIN NEWS_DOMAIN
# Optional overrides: LB_URLMAP (zero-vanguard-urlmap), LB_HTTPS_PROXY (zero-vanguard-httpsproxy),
#   LB_HTTP_PROXY (zero-vanguard-httpproxy), LB_HTTPS_RULE (zero-vanguard-fr-https),
#   CANARY_HOST (vanguard.smalltech.in), LISTMONK_HC_PATH, LB_BACKUP_DIR.
# Exit 0 ok; 1 failure; 2 usage.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PREFIX=provision
# shellcheck source=lib/common.sh
source "${ROOT}/infra/lib/common.sh"

DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --) ;;
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "usage: infra/provision.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

require_cmd gcloud jq node curl
require_env GCP_PROJECT GCP_REGION GCP_ZONE GCP_INSTANCE GCP_VM_SA SITE_DOMAIN NEWS_DOMAIN
assert_ours "$GCP_INSTANCE"

LB_URLMAP="${LB_URLMAP:-zero-vanguard-urlmap}"
LB_HTTPS_PROXY="${LB_HTTPS_PROXY:-zero-vanguard-httpsproxy}"
LB_HTTP_PROXY="${LB_HTTP_PROXY:-zero-vanguard-httpproxy}"
LB_HTTPS_RULE="${LB_HTTPS_RULE:-zero-vanguard-fr-https}"
CANARY_HOST="${CANARY_HOST:-vanguard.smalltech.in}"
# Listmonk v5.1.0 answers this static asset 200 without a session (/api/health needs one → 403).
LISTMONK_HC_PATH="${LISTMONK_HC_PATH:-/public/static/favicon.png}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LB_BACKUP_DIR="${LB_BACKUP_DIR:-${ROOT}/var/lb-backup-${TS}}"

NETWORK=default
TAG=blog0
IG=blog0-ig
HC_APP=blog0-hc
HC_LISTMONK=blog0-listmonk-hc
BES_APP=blog0-bes
BES_LISTMONK=blog0-listmonk-bes
CERT=blog0-cert
LB_RANGES=130.211.0.0/22,35.191.0.0/16
IAP_RANGE=35.235.240.0/20
COMPUTE="https://www.googleapis.com/compute/v1/projects/${GCP_PROJECT}"

# Mutations go through run(): printed (never executed) under --dry-run.
run() {
  if ((DRY_RUN)); then
    if [[ "$1" == g ]]; then
      shift
      echo "provision: would: gcloud $* --project ${GCP_PROJECT}"
    else
      echo "provision: would: $*"
    fi
  else
    "$@"
  fi
}
((DRY_RUN)) && say "DRY RUN — read-only; nothing below is created or changed"
say "project ${GCP_PROJECT}, zone ${GCP_ZONE}, instance ${GCP_INSTANCE}, hosts ${SITE_DOMAIN} + ${NEWS_DOMAIN}"

# --- 0. backup of the shared LB (before anything else) ---------------------------------------------
backup_lb() {
  mkdir -p "$LB_BACKUP_DIR"
  gcloud compute url-maps export "$LB_URLMAP" --global --project "$GCP_PROJECT" --destination "${LB_BACKUP_DIR}/urlmap.yaml" --quiet >/dev/null
  grep -v '^fingerprint:' "${LB_BACKUP_DIR}/urlmap.yaml" >"${LB_BACKUP_DIR}/urlmap.restore.yaml"
  gcloud compute target-https-proxies describe "$LB_HTTPS_PROXY" --global --project "$GCP_PROJECT" --format=yaml >"${LB_BACKUP_DIR}/https-proxy.yaml"
  gcloud compute target-http-proxies describe "$LB_HTTP_PROXY" --global --project "$GCP_PROJECT" --format=yaml >"${LB_BACKUP_DIR}/http-proxy.yaml"
  local certs
  certs="$(gcloud compute target-https-proxies describe "$LB_HTTPS_PROXY" --global --project "$GCP_PROJECT" --format=json | jq -r '[.sslCertificates[] | split("/") | last] | join(",")')"
  cat >"${LB_BACKUP_DIR}/RESTORE.txt" <<EOF
Shared LB backup taken by infra/provision.sh at ${TS} (project ${GCP_PROJECT}).
Restore ONLY if a blog0 change broke the shared load balancer:
  gcloud compute url-maps import ${LB_URLMAP} --global --project ${GCP_PROJECT} --source urlmap.restore.yaml
  gcloud compute target-https-proxies update ${LB_HTTPS_PROXY} --global --project ${GCP_PROJECT} --ssl-certificates=${certs}
(urlmap.restore.yaml = urlmap.yaml without its fingerprint, so the import is accepted after later changes.)
EOF
  say "LB backup → ${LB_BACKUP_DIR} (url map, both proxies, RESTORE.txt)"
}
backup_lb

# --- 1. firewall (blog0-* rules only; target tag blog0) -----------------------------------------------
# fw_ensure <name> <ALLOW|DENY> <rules> <source-ranges> <priority> <description>
fw_ensure() {
  local name="$1" action="$2" rules="$3" ranges="$4" prio="$5" desc="$6" cur want
  assert_ours "$name"
  want="$(jq -cn --arg a "$action" --arg r "$rules" --arg s "$ranges" --argjson p "$prio" --arg t "$TAG" \
    '{a:$a, r:($r|split(",")|sort), s:($s|split(",")|sort), p:$p, t:[$t]}')"
  if cur="$(gcloud compute firewall-rules describe "$name" --project "$GCP_PROJECT" --format=json 2>/dev/null)"; then
    cur="$(jq -c '{a:(if .allowed then "ALLOW" else "DENY" end),
      r:([(.allowed // .denied)[] | .IPProtocol as $p | if .ports then .ports[] | "\($p):\(.)" else $p end] | sort),
      s:(.sourceRanges|sort), p:.priority, t:(.targetTags // [])}' <<<"$cur")"
    if [[ "$cur" == "$want" ]]; then
      say "firewall ${name}: ok"
      return
    fi
    run g compute firewall-rules update "$name" --rules="$rules" --source-ranges="$ranges" --priority="$prio" --target-tags="$TAG" --description="$desc"
    say "firewall ${name}: updated"
  else
    run g compute firewall-rules create "$name" --network="$NETWORK" --direction=INGRESS --action="$action" \
      --rules="$rules" --source-ranges="$ranges" --priority="$prio" --target-tags="$TAG" --description="$desc"
    say "firewall ${name}: created"
  fi
}
fw_ensure blog0-allow-lb ALLOW tcp:3410,tcp:9000 "$LB_RANGES" 900 "blog0: Google LB proxies + health checks to blog0 (3410) and Listmonk (9000)"
fw_ensure blog0-allow-iap-ssh ALLOW tcp:22 "$IAP_RANGE" 900 "blog0: SSH only through IAP"
# The project has untagged 0.0.0.0/0 allows (ssh/rdp at 65534, tcp:5000 / tcp:8001 at 1000). This deny
# (priority 1000; a deny wins over an allow of equal priority) keeps blog0-vm closed to everything but
# the two priority-900 allows above.
fw_ensure blog0-deny-public DENY tcp,udp 0.0.0.0/0 1000 "blog0: deny all other ingress to blog0-tagged VMs"

# --- 2. VM (create once; never restarted here) ----------------------------------------------------------
STARTUP="${ROOT}/infra/vm-startup.sh"
rm -f "${LB_BACKUP_DIR}/vm.json"
if vm_json="$(gcloud compute instances describe "$GCP_INSTANCE" --zone "$GCP_ZONE" --project "$GCP_PROJECT" --format=json 2>/dev/null)"; then
  printf '%s\n' "$vm_json" >"${LB_BACKUP_DIR}/vm.json"
  status="$(jq -r .status "${LB_BACKUP_DIR}/vm.json")"
  say "vm ${GCP_INSTANCE}: exists (${status})"
  [[ "$status" == RUNNING ]] || warn "vm ${GCP_INSTANCE} is ${status} — provision never starts/restarts it; start it yourself if intended"
  cur_startup="$(jq -r '[.metadata.items[]? | select(.key=="startup-script") | .value][0] // ""' "${LB_BACKUP_DIR}/vm.json")"
  cur_oslogin="$(jq -r '[.metadata.items[]? | select(.key=="enable-oslogin") | .value][0] // ""' "${LB_BACKUP_DIR}/vm.json")"
  if [[ "$cur_startup" != "$(cat "$STARTUP")" || "$cur_oslogin" != TRUE ]]; then
    run g compute instances add-metadata "$GCP_INSTANCE" --zone "$GCP_ZONE" --metadata enable-oslogin=TRUE --metadata-from-file startup-script="$STARTUP"
    say "vm ${GCP_INSTANCE}: metadata updated (startup script / OS Login; applies at the next boot, no restart)"
  fi
  if ! jq -e --arg t "$TAG" '.tags.items // [] | index($t)' "${LB_BACKUP_DIR}/vm.json" >/dev/null; then
    run g compute instances add-tags "$GCP_INSTANCE" --zone "$GCP_ZONE" --tags "$TAG"
    say "vm ${GCP_INSTANCE}: tag ${TAG} added"
  fi
else
  run g compute instances create "$GCP_INSTANCE" --zone "$GCP_ZONE" --machine-type e2-micro \
    --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB --boot-disk-type pd-balanced \
    --network "$NETWORK" --tags "$TAG" --service-account "$GCP_VM_SA" --scopes cloud-platform \
    --metadata enable-oslogin=TRUE --metadata-from-file startup-script="$STARTUP" \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring --labels app=blog0
  say "vm ${GCP_INSTANCE}: created (e2-micro, Debian 12, ephemeral external IP; the startup script installs Docker + 2 GB swap)"
fi

# --- 3. unmanaged instance group + named ports ----------------------------------------------------------
if ! exists compute instance-groups unmanaged describe "$IG" --zone "$GCP_ZONE"; then
  run g compute instance-groups unmanaged create "$IG" --zone "$GCP_ZONE" --description "blog0: the one VM behind the shared LB"
  say "instance group ${IG}: created"
fi
ports="$(gcloud compute instance-groups unmanaged describe "$IG" --zone "$GCP_ZONE" --project "$GCP_PROJECT" --format=json 2>/dev/null |
  jq -r '[.namedPorts[]? | "\(.name):\(.port)"] | sort | join(",")' || true)"
if [[ "$ports" != "blog0:3410,listmonk:9000" ]]; then
  run g compute instance-groups unmanaged set-named-ports "$IG" --zone "$GCP_ZONE" --named-ports blog0:3410,listmonk:9000
  say "instance group ${IG}: named ports blog0:3410, listmonk:9000"
fi
members="$(gcloud compute instance-groups unmanaged list-instances "$IG" --zone "$GCP_ZONE" --project "$GCP_PROJECT" --format='value(instance.basename())' 2>/dev/null || true)"
if ! grep -qx "$GCP_INSTANCE" <<<"$members"; then
  run g compute instance-groups unmanaged add-instances "$IG" --zone "$GCP_ZONE" --instances "$GCP_INSTANCE"
  say "instance group ${IG}: ${GCP_INSTANCE} added"
else
  say "instance group ${IG}: ok"
fi

# --- 4. health checks -------------------------------------------------------------------------------
# hc_ensure <name> <port> <path>
hc_ensure() {
  local name="$1" port="$2" path="$3" cur
  assert_ours "$name"
  if cur="$(gcloud compute health-checks describe "$name" --global --project "$GCP_PROJECT" --format=json 2>/dev/null)"; then
    if [[ "$(jq -r '"\(.httpHealthCheck.port) \(.httpHealthCheck.requestPath)"' <<<"$cur")" == "${port} ${path}" ]]; then
      say "health check ${name}: ok"
      return
    fi
    run g compute health-checks update http "$name" --global --port "$port" --request-path "$path"
    say "health check ${name}: updated (${port} ${path})"
  else
    run g compute health-checks create http "$name" --global --port "$port" --request-path "$path" \
      --check-interval 10s --timeout 5s --healthy-threshold 2 --unhealthy-threshold 3
    say "health check ${name}: created (HTTP ${port} ${path})"
  fi
}
hc_ensure "$HC_APP" 3410 /api/health/live
hc_ensure "$HC_LISTMONK" 9000 "$LISTMONK_HC_PATH"

# --- 5. backend services (global, EXTERNAL_MANAGED, HTTP, 60 s) -----------------------------------------
# bes_ensure <name> <port-name> <health-check>
bes_ensure() {
  local name="$1" port_name="$2" hc="$3" cur
  assert_ours "$name"
  if cur="$(gcloud compute backend-services describe "$name" --global --project "$GCP_PROJECT" --format=json 2>/dev/null)"; then
    if [[ "$(jq -r '"\(.portName) \(.timeoutSec) \(.healthChecks[0] | split("/") | last)"' <<<"$cur")" != "${port_name} 60 ${hc}" ]]; then
      run g compute backend-services update "$name" --global --port-name "$port_name" --timeout 60s --health-checks "$hc" --global-health-checks
      say "backend service ${name}: updated"
    else
      say "backend service ${name}: ok"
    fi
  else
    run g compute backend-services create "$name" --global --load-balancing-scheme EXTERNAL_MANAGED --protocol HTTP \
      --port-name "$port_name" --health-checks "$hc" --global-health-checks --timeout 60s --connection-draining-timeout 10s
    say "backend service ${name}: created"
    cur='{}'
  fi
  if ! jq -e --arg g "/zones/${GCP_ZONE}/instanceGroups/${IG}" '[.backends[]?.group | endswith($g)] | any' <<<"$cur" >/dev/null; then
    run g compute backend-services add-backend "$name" --global --instance-group "$IG" --instance-group-zone "$GCP_ZONE" \
      --balancing-mode UTILIZATION --max-utilization 0.8
    say "backend service ${name}: backend ${IG} added"
  fi
}
bes_ensure "$BES_APP" blog0 "$HC_APP"
bes_ensure "$BES_LISTMONK" listmonk "$HC_LISTMONK"

# --- 6. Google-managed certificate ---------------------------------------------------------------------
want_domains="$(printf '%s\n' "$SITE_DOMAIN" "$NEWS_DOMAIN" | sort | paste -sd, -)"
if cur="$(gcloud compute ssl-certificates describe "$CERT" --global --project "$GCP_PROJECT" --format=json 2>/dev/null)"; then
  have="$(jq -r '.managed.domains | sort | join(",")' <<<"$cur")"
  [[ "$have" == "$want_domains" ]] || fail "certificate ${CERT} covers ${have}, expected ${want_domains} — a managed certificate cannot change domains; delete it (docs/deploy-gcp.md → Live inventory) and re-run"
  say "certificate ${CERT}: ok"
else
  run g compute ssl-certificates create "$CERT" --global --domains "$want_domains" --description "blog0: ${SITE_DOMAIN} + ${NEWS_DOMAIN}"
  say "certificate ${CERT}: created (${want_domains}; ACTIVE once DNS points at the LB)"
fi

# --- 7. shared url map: additive host rules + path matchers --------------------------------------------
gcloud compute url-maps describe "$LB_URLMAP" --global --project "$GCP_PROJECT" --format=json >"${LB_BACKUP_DIR}/urlmap.describe.json"
patch_out="$(node "${ROOT}/infra/lib/urlmap-patch.mjs" --in "${LB_BACKUP_DIR}/urlmap.describe.json" --out "${LB_BACKUP_DIR}/urlmap.patched.json" \
  --site "$SITE_DOMAIN" --news "$NEWS_DOMAIN" \
  --site-service "${COMPUTE}/global/backendServices/${BES_APP}" --news-service "${COMPUTE}/global/backendServices/${BES_LISTMONK}")" || fail "url map patch refused (see above); nothing was changed on ${LB_URLMAP}"
echo "$patch_out"
LB_CHANGED=0
if [[ "$patch_out" == *": changed"* ]]; then
  if exists compute backend-services describe "$BES_APP" --global && exists compute backend-services describe "$BES_LISTMONK" --global; then
    gcloud compute url-maps validate --global --project "$GCP_PROJECT" --load-balancing-scheme EXTERNAL_MANAGED \
      --source "${LB_BACKUP_DIR}/urlmap.patched.json" | tee "${LB_BACKUP_DIR}/urlmap.validate.txt"
    grep -q 'loadSucceeded: true' "${LB_BACKUP_DIR}/urlmap.validate.txt" || fail "url map validation failed; nothing imported"
  else
    say "url map: validation skipped (backend services not created yet — dry run)"
  fi
  run g compute url-maps import "$LB_URLMAP" --global --source "${LB_BACKUP_DIR}/urlmap.patched.json"
  LB_CHANGED=1
  say "url map ${LB_URLMAP}: blog0 host rules applied"
else
  say "url map ${LB_URLMAP}: ok"
fi

# --- 8. shared HTTPS proxy: append blog0-cert (order kept) -------------------------------------------
certs_json="$(gcloud compute target-https-proxies describe "$LB_HTTPS_PROXY" --global --project "$GCP_PROJECT" --format=json | jq -c '[.sslCertificates[] | split("/") | last]')"
if jq -e --arg c "$CERT" 'index($c)' <<<"$certs_json" >/dev/null; then
  say "https proxy ${LB_HTTPS_PROXY}: ${CERT} attached"
else
  new_list="$(jq -r --arg c "$CERT" '. + [$c] | join(",")' <<<"$certs_json")"
  run g compute target-https-proxies update "$LB_HTTPS_PROXY" --global --ssl-certificates "$new_list"
  LB_CHANGED=1
  say "https proxy ${LB_HTTPS_PROXY}: certificates ${new_list}"
fi

# --- 9. canary: the shared LB still serves its existing site ---------------------------------------------
canary() { # <url> → prints the status code; retries 6 × 10 s for a 200
  local code="" i
  for i in 1 2 3 4 5 6; do
    code="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' "$1" 2>/dev/null || true)"
    [[ "$code" == 200 ]] && break
    ((i < 6)) && sleep 10
  done
  printf '%s' "$code"
}
https_code="$(canary "https://${CANARY_HOST}/")"
http_code="$(canary "http://${CANARY_HOST}/")"
say "canary https://${CANARY_HOST}/ → ${https_code}; http://${CANARY_HOST}/ → ${http_code}"
if [[ "$https_code" != 200 || "$http_code" != 200 ]]; then
  echo "provision: FAIL — the shared LB no longer serves ${CANARY_HOST} with 200 (https ${https_code}, http ${http_code})." >&2
  if ((LB_CHANGED)); then
    echo "provision: NOT rolled back automatically. Backup: ${LB_BACKUP_DIR}; restore commands:" >&2
    sed -n '3,4p' "${LB_BACKUP_DIR}/RESTORE.txt" >&2
  fi
  exit 1
fi

# --- 10. status ----------------------------------------------------------------------------------------
lb_ip="$(gcloud compute forwarding-rules describe "$LB_HTTPS_RULE" --global --project "$GCP_PROJECT" --format='value(IPAddress)' 2>/dev/null || true)"
cert_status="$(gcloud compute ssl-certificates describe "$CERT" --global --project "$GCP_PROJECT" --format='value(managed.status)' 2>/dev/null || echo 'not created')"
domain_status="$(gcloud compute ssl-certificates describe "$CERT" --global --project "$GCP_PROJECT" --format=json 2>/dev/null | jq -r '.managed.domainStatus // {} | to_entries | map("\(.key)=\(.value)") | join(" ")' || true)"
say "certificate ${CERT}: ${cert_status}${domain_status:+ (${domain_status})}"
say "DNS (GoDaddy, manual): A ${SITE_DOMAIN} → ${lb_ip:-<LB IP>}; A ${NEWS_DOMAIN} → ${lb_ip:-<LB IP>}"
((DRY_RUN)) && say "DRY RUN complete — nothing was changed" || say "OK"
