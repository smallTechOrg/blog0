#!/usr/bin/env bash
# Shared helpers for infra/bootstrap.sh and infra/provision.sh (sourced, never run).
# Every create is guarded by an existence check (idempotent); every name this code creates starts
# with `blog0` (shared project — nothing else is modified). Secrets are never printed.

# shellcheck disable=SC2034 # constants used by the sourcing scripts
BLOG0_REPO_DEFAULT="smallTechOrg/blog0"

say() { echo "${LOG_PREFIX:-infra}: $*"; }
warn() { echo "${LOG_PREFIX:-infra}: WARNING — $*" >&2; }
fail() {
  echo "${LOG_PREFIX:-infra}: FAIL — $*" >&2
  exit 1
}

require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || fail "'$c' is required"; done
}

require_env() {
  local v
  for v in "$@"; do [[ -n "${!v:-}" ]] || fail "${v} is not set"; done
}

# True when a gcloud describe succeeds (quiet). Usage: exists compute instances describe NAME --zone Z
exists() { gcloud "$@" --project "$GCP_PROJECT" --format='value(name)' >/dev/null 2>&1; }

# gcloud with the project pinned, quiet prompts.
g() { gcloud "$@" --project "$GCP_PROJECT" --quiet; }

# Ensures a blog0-* name (guards every mutating helper against touching foreign resources).
assert_ours() {
  [[ "$1" == blog0* ]] || fail "refusing to modify '$1' — only blog0* resources are managed here"
}
