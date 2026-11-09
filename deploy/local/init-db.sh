#!/usr/bin/env bash
# Local Cloud SQL stand-in, first-run init (spec/architecture.md §12.7; mounted by
# deploy/local/docker-compose.yml). The Cloud SQL shape created by infra/bootstrap.sh: users
# `blog0_owner` (owns database blog0; as a Cloud SQL user it may CREATE ROLE, so CREATEROLE here) and
# `listmonk` (owns database listmonk); the restricted `blog0_app` role is NOT created here - the release
# step ensures it, exactly as on Cloud SQL. Dev-only passwords (= deploy/local/render.env).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE blog0_owner LOGIN CREATEROLE PASSWORD 'local-owner-password-0001';
CREATE ROLE listmonk LOGIN PASSWORD 'local-listmonk-db-password-01';
CREATE DATABASE blog0 OWNER blog0_owner;
CREATE DATABASE listmonk OWNER listmonk;
SQL
