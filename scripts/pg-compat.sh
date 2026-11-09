#!/usr/bin/env bash
# pnpm pg:compat -- <major>   (spec/architecture.md §12.7, Stage B)
#
# Proves blog0 on a given PostgreSQL major (the Cloud SQL target) on this machine:
#   1. docker run postgres:<major> on 127.0.0.1:${BLOG0_PG_COMPAT_PORT:-5440} (container blog0-pg-compat)
#   2. the Cloud SQL shape: a NON-superuser role `blog0` owning database `blog0` and its `public`
#      schema; `pnpm db:migrate` + `pnpm db:verify` run as that role
#   3. the full integration suite against blog0_test on the same server (the harness creates,
#      resets and migrates it). Listmonk tests use `pnpm listmonk:test-up` as usual — when the test
#      stack is not up they skip visibly (never a pass for them).
#   4. always removes the container.
# Prints `pg-compat: PostgreSQL <major> PASS|FAIL`. Exit 0 pass, 1 fail, 2 usage, 3 PENDING DOCKER.
# The dev stack (compose project `blog0`) is never touched. No secret is printed.
set -euo pipefail

cd "$(dirname "$0")/.."

[[ "${1:-}" == "--" ]] && shift
MAJOR="${1:-}"
if [[ ! "$MAJOR" =~ ^[0-9]{2}$ ]]; then
  echo "usage: pnpm pg:compat -- <major>   (e.g. 18)" >&2
  exit 2
fi

PORT="${BLOG0_PG_COMPAT_PORT:-5440}"
NAME=blog0-pg-compat
IMAGE="postgres:${MAJOR}"
SUPER_PW=postgres
APP_PW=blog0-compat-pw

say() { echo "pg-compat: $*"; }

if ! docker info >/dev/null 2>&1; then
  echo "PENDING DOCKER: docker daemon not reachable (start it: colima start, then pnpm pg:compat -- ${MAJOR})"
  exit 3
fi

result=FAIL
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "pg-compat: PostgreSQL ${MAJOR} ${result}"
}
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
say "starting ${IMAGE} on 127.0.0.1:${PORT}"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$SUPER_PW" \
  -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null

# pg_isready inside the container, then a real query over TCP (the entrypoint restarts once).
ready=0
for _ in $(seq 1 90); do
  if docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 \
    && docker exec "$NAME" psql -U postgres -h 127.0.0.1 -tAc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  docker logs "$NAME" 2>&1 | tail -n 30
  say "server did not become ready"
  exit 1
fi
say "server: $(docker exec "$NAME" psql -U postgres -tAc 'show server_version')"

psql_super() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -q "$@"; }

# Cloud SQL shape: the app role is not a superuser; it owns its database and the public schema
# (PG 15+ revoked CREATE on public from PUBLIC).
psql_super <<SQL
CREATE ROLE blog0 LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE blog0 OWNER blog0;
SQL
psql_super -d blog0 -c 'ALTER SCHEMA public OWNER TO blog0;'

APP_URL="postgres://blog0:${APP_PW}@127.0.0.1:${PORT}/blog0"
TEST_URL="postgres://postgres:${SUPER_PW}@127.0.0.1:${PORT}/blog0_test"

say "pnpm db:migrate + db:verify as the non-superuser owner"
BLOG0_DATABASE_URL="$APP_URL" pnpm -s db:migrate
BLOG0_DATABASE_URL="$APP_URL" pnpm -s db:verify
# Idempotent: a second run applies nothing.
BLOG0_DATABASE_URL="$APP_URL" pnpm -s db:migrate

lm_code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:9001/api/health 2>/dev/null || true)"
if [[ -f var/listmonk-test.env && "$lm_code" =~ ^[234] ]]; then
  say "Listmonk test stack answers on :9001 — the Listmonk tests run"
else
  say "Listmonk test stack not up — the Listmonk tests SKIP (run pnpm listmonk:test-up first to include them)"
fi

say "integration suite against ${IMAGE} (blog0_test)"
# BLOG0_DATABASE_URL points at the compat server's `blog0` database so the harness's
# "test DB ≠ dev DB" guard compares like with like; the suite itself only touches blog0_test.
BLOG0_DATABASE_URL="$APP_URL" BLOG0_TEST_DATABASE_URL="$TEST_URL" pnpm -s test:integration

result=PASS
exit 0
