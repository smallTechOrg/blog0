#!/usr/bin/env bash
# Local Cloud SQL stand-in, first-run init (Stage B, spec/architecture.md §12.7; mounted by
# deploy/docker-compose.local.yml). The Cloud SQL shape: roles `blog0` and `listmonk` are plain
# LOGIN roles (no superuser, no CREATEDB) that OWN their databases and each database's `public`
# schema (the PostgreSQL 15+ rule — the runbook runs the same ALTERs on Cloud SQL). Dev-only passwords.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE blog0 LOGIN PASSWORD 'blog0';
CREATE ROLE listmonk LOGIN PASSWORD 'listmonk';
CREATE DATABASE blog0 OWNER blog0;
CREATE DATABASE listmonk OWNER listmonk;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname blog0 -c 'ALTER SCHEMA public OWNER TO blog0'
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname listmonk -c 'ALTER SCHEMA public OWNER TO listmonk'
