#!/usr/bin/env bash
# Post-deploy smoke test (Stage B, spec/architecture.md §12.7; `pnpm deploy:smoke -- …`).
#
#   scripts/deploy-smoke.sh [--insecure] <base-url> <news-url>
#     e.g. scripts/deploy-smoke.sh https://example.com https://news.example.com
#
# Both URLs must be https://. Without --insecure curl verifies the certificates — that IS the TLS
# check (--insecure is for the local Caddy CA only). BLOG0_SMOKE_RESOLVE=<ip> pins both hosts to that
# address (curl --resolve; offline / before DNS). Read-only: GETs only, nothing is created.
# Checks (each prints `deploy-smoke: <check> ok`; the first failure prints
# `deploy-smoke: FAIL <check> (<detail>)` and exits 1; all green → `deploy-smoke: PASS`, exit 0):
#   1 ready          GET <base>/api/health/ready → 200 with "status":"ready"
#   2 pages          GET <base>/ and <base>/privacy → 200
#   3 article        first /p/<slug> in <base>/sitemap.xml → 200, and /p/<slug>/tldr → 200
#   4 confirm        /newsletter/confirm?t=bogus → 303 to …status=invalid; /newsletter/confirmed?status=invalid → 404
#   5 unsubscribe    /api/newsletter/unsubscribe?t=bogus → 303 to /newsletter/unsubscribe?t=bogus
#   6 news-public    <news>/link/<nil>/<nil>/<nil> and /campaign/<nil>/<nil>/px.png → < 500, no X-Blog0-Edge
#   7 news-denied    <news>/ /admin /admin/login /api/settings /subscription/form → 404 + X-Blog0-Edge: denied
# Exit 2 = usage.
set -euo pipefail

say() { echo "deploy-smoke: $*"; }
usage() {
  echo "usage: scripts/deploy-smoke.sh [--insecure] <base-url> <news-url>   (both https://; BLOG0_SMOKE_RESOLVE=<ip> optional)" >&2
  exit 2
}

INSECURE=0
POS=()
for a in "$@"; do
  case "$a" in
    --) ;;
    --insecure) INSECURE=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) POS+=("$a") ;;
  esac
done
[[ ${#POS[@]} -eq 2 ]] || usage
BASE="${POS[0]%/}"
NEWS="${POS[1]%/}"
[[ "$BASE" =~ ^https://[^/]+$ && "$NEWS" =~ ^https://[^/]+$ ]] || usage

CURL=(curl -sS -m 20 --proto '=https')
((INSECURE)) && CURL+=(--insecure)
if [[ -n "${BLOG0_SMOKE_RESOLVE:-}" ]]; then
  for u in "$BASE" "$NEWS"; do
    hostport="${u#https://}"
    host="${hostport%%:*}"
    port=443
    [[ "$hostport" == *:* ]] && port="${hostport##*:}"
    CURL+=(--resolve "${host}:${port}:${BLOG0_SMOKE_RESOLVE}")
  done
fi

WORK="$(mktemp -d -t deploy-smoke.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
CHECK=""
fail() {
  say "FAIL ${CHECK} ($1)"
  exit 1
}

# fetch <url> → sets CODE, HEADERS file, BODY file. Transport/TLS errors fail the current check.
fetch() {
  local err
  : >"${WORK}/h"
  : >"${WORK}/b"
  if ! CODE="$("${CURL[@]}" -D "${WORK}/h" -o "${WORK}/b" -w '%{http_code}' "$1" 2>"${WORK}/e")"; then
    err="$(tr '\n' ' ' <"${WORK}/e" | cut -c1-200)"
    fail "GET $1: ${err:-curl failed}"
  fi
}
header() { # <name> → value of the last such header (case-insensitive), CR stripped
  grep -i "^$1:" "${WORK}/h" | tail -n 1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r' || true
}
expect_code() { # <url> <code>
  fetch "$1"
  [[ "$CODE" == "$2" ]] || fail "GET $1 → ${CODE}, expected $2"
}

# 1. readiness
CHECK=ready
expect_code "${BASE}/api/health/ready" 200
grep -q '"status":"ready"' "${WORK}/b" || fail "body lacks \"status\":\"ready\": $(head -c 200 "${WORK}/b")"
say "ready ok"

# 2. pages
CHECK=pages
expect_code "${BASE}/" 200
expect_code "${BASE}/privacy" 200
say "pages ok"

# 3. one published article + its TLDR (paths from the sitemap, fetched against <base>)
CHECK=article
expect_code "${BASE}/sitemap.xml" 200
slug="$(grep -oE '<loc>[^<]*/p/[^</?#]+</loc>' "${WORK}/b" | head -n 1 | sed -E 's#.*/p/([^</?#]+)</loc>#\1#' || true)"
[[ -n "$slug" ]] || fail "no published article in /sitemap.xml"
expect_code "${BASE}/p/${slug}" 200
expect_code "${BASE}/p/${slug}/tldr" 200
say "article ok (/p/${slug} + /tldr)"

# 4. confirmation link with a bogus token
CHECK=confirm
expect_code "${BASE}/newsletter/confirm?t=bogus" 303
loc="$(header location)"
[[ "$loc" == *status=invalid* ]] || fail "Location '${loc}' lacks status=invalid"
expect_code "${BASE}/newsletter/confirmed?status=invalid" 404
say "confirm ok"

# 5. one-click unsubscribe GET with a bogus token → the unsubscribe page
CHECK=unsubscribe
expect_code "${BASE}/api/newsletter/unsubscribe?t=bogus" 303
loc="$(header location)"
[[ "$loc" == */newsletter/unsubscribe\?t=bogus ]] || fail "Location '${loc}' is not /newsletter/unsubscribe?t=bogus"
say "unsubscribe ok"

# 6. Listmonk's public tracking paths reach Listmonk (not Caddy's deny rule)
CHECK=news-public
NIL=00000000-0000-0000-0000-000000000000
for p in "/link/${NIL}/${NIL}/${NIL}" "/campaign/${NIL}/${NIL}/px.png"; do
  fetch "${NEWS}${p}"
  ((CODE > 0 && CODE < 500)) || fail "GET ${NEWS}${p} → ${CODE}, expected < 500"
  [[ -z "$(header x-blog0-edge)" ]] || fail "GET ${NEWS}${p} was denied by the edge (X-Blog0-Edge present)"
done
say "news-public ok"

# 7. everything else on the news host is denied at the edge
CHECK=news-denied
for p in / /admin /admin/login /api/settings /subscription/form; do
  fetch "${NEWS}${p}"
  [[ "$CODE" == 404 ]] || fail "GET ${NEWS}${p} → ${CODE}, expected 404"
  [[ "$(header x-blog0-edge)" == denied ]] || fail "GET ${NEWS}${p} lacks X-Blog0-Edge: denied"
done
say "news-denied ok"

say PASS
