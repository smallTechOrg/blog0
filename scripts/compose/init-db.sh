#!/usr/bin/env bash
# docker-compose Postgres first-run init (spec/architecture.md §12.6): one instance, separate
# databases. Runs once, on an empty data volume, as the superuser from POSTGRES_USER (an existing
# volume gets listmonk_test from `pnpm listmonk:test-up`).
# Creates: role `listmonk` (password `listmonk`, dev-only), databases `listmonk` + `listmonk_test`
# (owner listmonk; listmonk_test backs the `test`-profile listmonk-test → Mailpit),
# `blog0` and `blog0_test` (owner postgres — the `--profile app` path and nothing else).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE listmonk LOGIN PASSWORD 'listmonk';
CREATE DATABASE listmonk OWNER listmonk;
CREATE DATABASE listmonk_test OWNER listmonk;
CREATE DATABASE blog0;
CREATE DATABASE blog0_test;
SQL
