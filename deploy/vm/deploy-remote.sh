#!/usr/bin/env bash
# Runs ON blog0-vm as root — the VM half of .github/workflows/deploy.yml (spec/architecture.md §12.7):
#
#   sudo bash /tmp/blog0-stage/deploy-remote.sh <image-tag>
#
# The workflow scp's (IAP tunnel) these files into the stage directory beside this script, then runs it:
#   deploy-remote.sh docker-compose.yml compose.env blog0.env release.env listmonk.env
#   listmonk-api.sh listmonk-settings.sh
# Steps (idempotent; re-running a sha re-applies it; any failing step stops the deploy with a message):
#   1 wait      Docker + compose plugin + swap (the VM startup script's marker)
#   2 install   stage → /opt/blog0 (env files mode 600, ops scripts mode 755); the stage's env files are
#               deleted at the end
#   3 pull      gcloud auth configure-docker (the VM service account) + docker compose pull for <image-tag>
#   4 release   one-off as the schema OWNER: migrate → 0 pending → restricted role blog0_app → site + admin
#   5 seed      one-off, first deploy only (the script itself skips a site that has articles): 5 posts +
#               fixture decks, 0 AI calls
#   6 listmonk  one-off `--install --idempotent` then `--upgrade`; start Listmonk; API user/token →
#               /opt/blog0/listmonk-api.env (mode 600); settings (Workspace SMTP, POP bounces, root URL,
#               1 800/day) via listmonk-api.sh + listmonk-settings.sh from a container on the compose network
#   7 up        docker compose up -d --wait: blog0, listmonk, scheduler with the RESTRICTED db role
#   8 prune     images: keep this tag and the previous one; print free -m + docker stats
# The VM is never restarted; only containers are. Env values are never printed.
# Overrides (local verification: deploy/local/verify.sh runs this very script against a throw-away dir):
#   BLOG0_DEPLOY_DIR (default /opt/blog0)   BLOG0_DEPLOY_LOCAL=1 (skip the VM waits + registry login + pull)
#   BLOG0_COMPOSE_EXTRA=<file> (an extra compose override file)
# Exit 0 ok; 1 failure; 2 usage.
set -euo pipefail

say() { echo "deploy-remote: $*"; }
fail() {
  echo "deploy-remote: FAIL — $*" >&2
  exit 1
}

[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{7,40}$ ]] || {
  echo "usage: sudo bash deploy-remote.sh <image-tag (git sha)>" >&2
  exit 2
}
TAG="$1"
STAGE="$(cd "$(dirname "$0")" && pwd)"
DIR="${BLOG0_DEPLOY_DIR:-/opt/blog0}"
LOCAL="${BLOG0_DEPLOY_LOCAL:-0}"
EXTRA="${BLOG0_COMPOSE_EXTRA:-}"
[[ "$(id -u)" == 0 || "$LOCAL" == 1 ]] || fail "run as root (sudo bash deploy-remote.sh <sha>)"

STAGED=(docker-compose.yml compose.env blog0.env release.env listmonk.env listmonk-api.sh listmonk-settings.sh)
for f in "${STAGED[@]}"; do [[ -f "${STAGE}/${f}" ]] || fail "${STAGE}/${f} is missing (the workflow uploads it first)"; done
cleanup() {
  # The stage holds rendered secrets: remove exactly what was uploaded (and the directory if empty).
  for f in "${STAGED[@]}" deploy-remote.sh; do rm -f "${STAGE:?}/${f}"; done
  rmdir "$STAGE" 2>/dev/null || true
}
trap cleanup EXIT

# --- 1. wait for docker + swap ---------------------------------------------------------------------------
if [[ "$LOCAL" != 1 ]]; then
  say "1/8 wait for docker + swap"
  deadline=$((SECONDS + 600))
  until [[ -f /var/lib/blog0/startup.done ]] && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 &&
    swapon --show=NAME --noheadings | grep -qx /swapfile; do
    ((SECONDS < deadline)) || fail "docker/swap not ready after 600 s (VM startup script: sudo journalctl -u google-startup-scripts)"
    sleep 5
  done
else
  say "1/8 wait skipped (local verification)"
fi
docker info >/dev/null 2>&1 || fail "docker daemon not reachable"

# --- 2. install the staged files -------------------------------------------------------------------------
say "2/8 install ${STAGE} → ${DIR}"
install -d -m 0755 "$DIR" "$DIR/ops"
install -m 0644 "${STAGE}/docker-compose.yml" "${DIR}/docker-compose.yml"
for f in compose.env blog0.env release.env listmonk.env; do install -m 0600 "${STAGE}/${f}" "${DIR}/${f}"; done
install -m 0755 "${STAGE}/listmonk-api.sh" "${STAGE}/listmonk-settings.sh" "${DIR}/ops/"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif [[ "$LOCAL" == 1 ]] && command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose) # local verification on a machine with only the standalone binary
else
  fail "the docker compose plugin is missing"
fi
dc() {
  "${COMPOSE[@]}" --project-directory "$DIR" -f "${DIR}/docker-compose.yml" ${EXTRA:+-f "$EXTRA"} --env-file "${DIR}/compose.env" "$@"
}
AR_HOST="$(sed -n 's/^AR_HOST=//p' "${DIR}/compose.env")"
BLOG0_IMAGE="$(sed -n 's/^BLOG0_IMAGE=//p' "${DIR}/compose.env")"
SCHED_IMAGE="$(sed -n 's/^BLOG0_SCHEDULER_IMAGE=//p' "${DIR}/compose.env")"
[[ "$(sed -n 's/^BLOG0_IMAGE_TAG=//p' "${DIR}/compose.env")" == "$TAG" ]] || fail "compose.env names another image tag than ${TAG}"
dc config -q >/dev/null 2>&1 || fail "docker compose config is invalid (a required value is missing in the env files)"

# --- 3. registry login + pull ------------------------------------------------------------------------------
if [[ "$LOCAL" != 1 ]]; then
  say "3/8 pull ${TAG} from ${AR_HOST}"
  command -v gcloud >/dev/null 2>&1 || fail "gcloud is missing on the VM image"
  gcloud auth configure-docker "$AR_HOST" -q >/dev/null 2>&1 || fail "gcloud auth configure-docker ${AR_HOST} failed"
  dc pull --quiet blog0 scheduler || fail "cannot pull ${BLOG0_IMAGE}:${TAG} / ${SCHED_IMAGE}:${TAG} (was the build+push step green? does blog0-vm have artifactregistry.reader?)"
  dc pull --quiet listmonk-install || fail "cannot pull the Listmonk image"
else
  say "3/8 pull skipped (local images)"
fi

# --- 4. release (owner role) -----------------------------------------------------------------------------------
say "4/8 release (migrations + site/admin + restricted role)"
out="$(dc run --rm -T release 2>&1)" || {
  echo "$out" | sed 's/^/  /'
  fail "the release step failed (output above)"
}
echo "$out" | grep -E '^(release|site|app role|postgres|pglite)|: applied |up to date' | sed 's/^/  /' || true
grep -q '0 pending: OK' <<<"$out" || fail "the release step did not report '0 pending: OK'"
grep -q '^app role ' <<<"$out" || fail "the release step did not ensure the restricted app role (BLOG0_APP_DB_* in release.env)"

# --- 5. first-deploy content seed (0 AI calls; skipped when the site has articles) -----------------------------------
say "5/8 seed content (first deploy only)"
out="$(dc run --rm -T seed 2>&1)" || {
  echo "$out" | sed 's/^/  /'
  fail "seed-content failed (output above)"
}
echo "$out" | grep -E '^(seed-content|warning)' | sed 's/^/  /'

# --- 6. Listmonk: install/upgrade, API user, settings -------------------------------------------------------------------
say "6/8 Listmonk install/upgrade + API user + settings"
out="$(dc run --rm -T listmonk-install 2>&1)" || {
  echo "$out" | grep -viE 'password|token' | tail -n 30 | sed 's/^/  /'
  fail "listmonk --install/--upgrade failed (output above, secrets filtered)"
}
echo "$out" | grep -iE 'install|upgrad|database|already|skipp' | grep -viE 'password|token' | tail -n 6 | sed 's/^/  /' || true
dc up -d --wait --wait-timeout 240 --pull never listmonk || fail "listmonk did not become healthy (docker logs: dc logs listmonk)"
dc run --rm -T --user root -v "${DIR}:/out" listmonk-ops /ops/listmonk-api.sh --out /out/listmonk-api.env \
  --blog0-url http://listmonk:9000 http://listmonk:9000 || fail "listmonk-api.sh failed"
[[ -f "${DIR}/listmonk-api.env" ]] || fail "${DIR}/listmonk-api.env was not written"
chmod 600 "${DIR}/listmonk-api.env"
dc run --rm -T listmonk-ops /ops/listmonk-settings.sh http://listmonk:9000 || fail "listmonk-settings.sh failed"

# --- 7. up (restricted role) -----------------------------------------------------------------------------------------------
say "7/8 docker compose up -d: blog0, listmonk, scheduler"
dc up -d --wait --wait-timeout 300 --pull never --remove-orphans || {
  dc ps --format '{{.Service}} {{.State}} {{.Status}}' | sed 's/^/  /' || true
  dc logs --tail 20 blog0 scheduler 2>&1 | grep -viE 'password|token|secret' | sed 's/^/  /' || true
  fail "the stack did not become healthy (output above)"
}
dc ps --format '{{.Service}} {{.State}} {{.Status}}' | sed 's/^/  /'

# --- 8. prune old images (keep this tag + the previous one), report memory --------------------------------------------------
say "8/8 prune images, memory"
STATE="${DIR}/.deployed-tags"
prev=""
[[ -f "$STATE" ]] && prev="$(grep -vx "$TAG" "$STATE" | head -n 1 || true)"
{
  echo "$TAG"
  [[ -n "$prev" ]] && echo "$prev"
} >"${STATE}.new"
mv "${STATE}.new" "$STATE"
for repo in "$BLOG0_IMAGE" "$SCHED_IMAGE"; do
  while IFS= read -r t; do
    [[ -n "$t" && "$t" != "<none>" ]] || continue
    grep -qx "$t" "$STATE" || docker rmi "${repo}:${t}" >/dev/null 2>&1 || true
  done < <(docker images --format '{{.Tag}}' "$repo")
done
docker image prune -f >/dev/null 2>&1 || true
say "images kept: $(tr '\n' ' ' <"$STATE")"
if [[ "$LOCAL" != 1 ]]; then
  df -h / | tail -n 1 | awk '{print "deploy-remote: disk " $3 " used of " $2 " (" $5 ")"}'
  free -m | sed 's/^/  /'
fi
docker stats --no-stream --format '  {{.Name}}: mem {{.MemUsage}} ({{.MemPerc}}), cpu {{.CPUPerc}}' || true
say "OK — ${TAG} is live"
