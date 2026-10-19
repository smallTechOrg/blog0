#!/usr/bin/env bash
# Container E2E (`pnpm test:container`, spec/architecture.md §12.5): build (or reuse) blog0:local,
# run the release step against blog0_test, start the image on host port 3412 with the uploads
# volume and log file bind-mounted, run the full Playwright suite against it, then prove graceful
# shutdown. Exit 0 = PASS; exit 3 = PENDING DOCKER (never a pass); anything else = FAIL.
#
# Secrets: the container env file (var/container-e2e.env, mode 0600) is written by
# scripts/lib/container-env.mjs; no secret value is ever echoed. The OpenRouter key from .env/shell
# is passed through only when it is a real key (else `pending-placeholder` ⇒ PENDING KEY skip).
#
# Knobs: BLOG0_CONTAINER_BUILD=auto (default: rebuild only when a context file is newer than the
# image) | always | never.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=blog0:local
NAME=blog0-e2e
HOST_PORT=3412
BASE_URL="http://localhost:${HOST_PORT}"
ENV_FILE=var/container-e2e.env
STORAGE_DIR=var/storage-e2e
LOG_DIR=test-results
E2E_OUT="${LOG_DIR}/container-e2e.out"
STEP=start
E2E_SUMMARY="not run"
KEY_STATUS="unknown"
BUILD_NOTE=""

say() { echo "container-e2e: $*"; }
step() {
  STEP="$1"
  say "$1"
}
fail() {
  say "FAIL ${STEP}${1:+ — $1}"
  summary FAIL
  exit 1
}
summary() {
  echo "------------------------------------------------------------------"
  echo "container-e2e summary: $1"
  echo "  image:      ${IMAGE}${BUILD_NOTE:+ (${BUILD_NOTE})}"
  echo "  base URL:   ${BASE_URL}"
  echo "  E2E:        ${E2E_SUMMARY}"
  echo "  real key:   ${KEY_STATUS}"
  echo "------------------------------------------------------------------"
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" # holds a copy of the OpenRouter key: never left behind
}

# 1. Docker reachable?
STEP="docker"
if ! docker info >/dev/null 2>&1; then
  echo "PENDING DOCKER: docker daemon not reachable (start it: colima start)"
  exit 3
fi
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
cleanup # a leftover container from an aborted run

# 2. Image
step "build ${IMAGE}"
mode="${BLOG0_CONTAINER_BUILD:-auto}"
build=1
if [[ "$mode" == "never" ]]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "BLOG0_CONTAINER_BUILD=never but ${IMAGE} does not exist"
  build=0
  BUILD_NOTE="reused, BLOG0_CONTAINER_BUILD=never"
elif [[ "$mode" == "auto" ]] && created="$(docker image inspect -f '{{.Created}}' "$IMAGE" 2>/dev/null)"; then
  if reason="$(node scripts/lib/container-env.mjs stale "$created")"; then
    say "rebuilding: ${reason}"
  else
    build=0
    BUILD_NOTE="reused, no context file newer than the image"
  fi
fi
if [[ "$build" == 1 ]]; then
  docker build -t "$IMAGE" . || fail "docker build"
  BUILD_NOTE="built"
else
  say "reusing ${IMAGE} (${BUILD_NOTE})"
fi

# 3. Container env file + the DB URL the container uses (never echoed)
step "env file"
mkdir -p var "$LOG_DIR"
DB_URL="$(node scripts/lib/container-env.mjs env 2>"${LOG_DIR}/container-env.err")" || {
  cat "${LOG_DIR}/container-env.err" >&2
  fail "container env"
}
if grep -q '^key: real$' "${LOG_DIR}/container-env.err"; then
  KEY_STATUS="present — the Jev Generate step runs for real"
else
  KEY_STATUS="PENDING KEY (no real BLOG0_OPENROUTER_API_KEY; the real-key step is skipped)"
fi
grep -v '^key: ' "${LOG_DIR}/container-env.err" >&2 || true
rm -f "${LOG_DIR}/container-env.err"
say "wrote ${ENV_FILE} (mode 0600; values not shown); OpenRouter key: ${KEY_STATUS}"

# 4. Fresh blog0_test + release step inside the image
step "release step"
node scripts/lib/container-env.mjs reset-db || fail "create/reset blog0_test"
release_out="$(docker run --rm --add-host=host.docker.internal:host-gateway --env-file "$ENV_FILE" \
  -e BLOG0_DATABASE_URL="$DB_URL" "$IMAGE" node release.mjs 2>&1)" || {
  echo "$release_out"
  fail "release step exited non-zero"
}
echo "$release_out"
grep -q '0 pending: OK' <<<"$release_out" || fail "release output lacks '0 pending: OK'"

# 4b. Stage A: the bundled password-reset CLI inside the image (a throwaway admin seeded by a second,
# idempotent release run; the E2E global setup resets blog0_test right after, so nothing leaks).
step "reset-password step"
RESET_EMAIL="reset-check@example.test"
RESET_PW_OLD="container-reset-old-$$-pw"
RESET_PW_NEW="container-reset-new-$$-pw"
docker run --rm --add-host=host.docker.internal:host-gateway --env-file "$ENV_FILE" \
  -e BLOG0_DATABASE_URL="$DB_URL" -e BLOG0_ADMIN_EMAIL="$RESET_EMAIL" -e BLOG0_ADMIN_PASSWORD="$RESET_PW_OLD" \
  -e BLOG0_ADMIN_NAME="Reset Check" "$IMAGE" node release.mjs >/dev/null 2>&1 || fail "seeding the reset-check admin"
reset_out="$(docker run --rm --add-host=host.docker.internal:host-gateway --env-file "$ENV_FILE" \
  -e BLOG0_DATABASE_URL="$DB_URL" -e BLOG0_NEW_ADMIN_PASSWORD="$RESET_PW_NEW" "$IMAGE" \
  node reset-password.mjs --email "$RESET_EMAIL" 2>&1)" || {
  echo "$reset_out"
  fail "node reset-password.mjs exited non-zero"
}
grep -q 'password reset for r\*\*\*@example.test · 0 sessions ended' <<<"$reset_out" || {
  echo "$reset_out"
  fail "reset-password output lacks the masked line"
}
! grep -q "$RESET_PW_NEW" <<<"$reset_out" || fail "reset-password printed the password"
say "reset-password: $(grep 'password reset for' <<<"$reset_out")"

# 5. App container
step "start ${NAME} on ${HOST_PORT}"
mkdir -p "$STORAGE_DIR" "$LOG_DIR"
docker run -d --name "$NAME" --add-host=host.docker.internal:host-gateway -p "${HOST_PORT}:3410" \
  --env-file "$ENV_FILE" -e BLOG0_DATABASE_URL="$DB_URL" -e BLOG0_PUBLIC_BASE_URL="$BASE_URL" \
  -e BLOG0_LOG_FILE=/logs/e2e-server.log \
  -v "$PWD/${STORAGE_DIR}:/data/storage" -v "$PWD/${LOG_DIR}:/logs" "$IMAGE" >/dev/null || fail "docker run"

# 6. Probes: live (≤ 60 s) → Docker HEALTHCHECK healthy (≤ 60 s) → ready
step "probes"
wait_for() { # <seconds> <command…>
  local deadline=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then return 1; fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]]; then
      docker logs --tail 40 "$NAME" 2>&1 || true
      return 1
    fi
    sleep 1
  done
}
healthy() { [[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" == "healthy" ]]; }
wait_for 60 curl -fsS "${BASE_URL}/api/health/live" || fail "/api/health/live did not answer within 60 s"
say "live: $(curl -fsS "${BASE_URL}/api/health/live")"
wait_for 60 healthy || fail "docker health did not become healthy within 60 s"
ready="$(curl -sS "${BASE_URL}/api/health/ready")"
say "ready: ${ready}"
grep -q '"status":"ready"' <<<"$ready" || fail "/api/health/ready is not ready"

# 7. Non-root (no page request before the suite: a page would cache the site row global setup replaces)
step "non-root"
uid="$(docker exec "$NAME" id -u)"
[[ "$uid" == "1000" ]] || fail "container runs as uid ${uid}, expected 1000"

# 8. The full E2E suite against the container
step "pnpm test:e2e against ${BASE_URL}"
set +e
BLOG0_E2E_BASE_URL="$BASE_URL" BLOG0_E2E_LOG_FILE="${LOG_DIR}/e2e-server.log" pnpm test:e2e 2>&1 | tee "$E2E_OUT"
e2e_status=${PIPESTATUS[0]}
set -e
counts="$(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run|interrupted)' "$E2E_OUT" | sed -E 's/^ +//; s/ \(.*\)$//' | paste -sd ',' - | sed 's/,/, /g')"
E2E_SUMMARY="${counts:-no Playwright summary} (exit ${e2e_status})"
pending_key="$(grep -c 'PENDING KEY' "$E2E_OUT" || true)"
if [[ "$pending_key" != "0" && "$KEY_STATUS" == present* ]]; then
  KEY_STATUS="present, but the suite reported PENDING KEY"
fi
if [[ "$e2e_status" != 0 ]]; then
  docker logs --tail 40 "$NAME" 2>&1 || true
  fail "Playwright exit ${e2e_status}"
fi

# 9. Uploads landed on the host through the volume; headers on the live page
step "volume + headers"
mp3s="$(find "$STORAGE_DIR/blog0/audio" -mindepth 3 -maxdepth 3 -name '*.mp3' -type f 2>/dev/null | wc -l | tr -d ' ')"
[[ "$mp3s" -ge 1 ]] || fail "no var/storage-e2e/blog0/audio/*/*/*.mp3 on the host"
say "uploads on the host volume: ${mp3s} mp3 file(s)"
headers="$(curl -sSI "${BASE_URL}/")"
grep -qi "^content-security-policy:.*'nonce-" <<<"$headers" || fail "GET / has no nonce CSP"
grep -qi '^x-frame-options: DENY' <<<"$headers" || fail "GET / has no x-frame-options: DENY"

# 10. Graceful shutdown
step "graceful stop"
t0="$(node -e 'process.stdout.write(String(Date.now()))')"
docker stop -t 20 "$NAME" >/dev/null || fail "docker stop"
t1="$(node -e 'process.stdout.write(String(Date.now()))')"
elapsed=$((t1 - t0))
code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
say "stopped in ${elapsed} ms, exit code ${code}"
((elapsed < 12000)) || fail "docker stop took ${elapsed} ms (≥ 12 s)"
[[ "$code" == "143" ]] || fail "exit code ${code}, expected 143"
docker logs "$NAME" 2>&1 | grep '"app.shutdown"' | grep -q '"phase":"draining"' || fail "no app.shutdown draining line in the container logs"
docker logs "$NAME" 2>&1 | grep '"app.shutdown"' | grep -q '"outcome":"drained"' || fail "no app.shutdown drained line in the container logs"

# 11. Done
say "PASS"
summary PASS
exit 0
