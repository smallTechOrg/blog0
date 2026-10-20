#!/usr/bin/env bash
# Post-deploy smoke test (Stage B, spec/architecture.md §12.7; `pnpm deploy:smoke -- …`).
#
#   scripts/deploy-smoke.sh [--insecure] <base-url>
#     e.g. scripts/deploy-smoke.sh https://blog0.smalltech.in
#   scripts/deploy-smoke.sh --direct <blog0-url>
#     e.g. on the VM / locally: --direct http://127.0.0.1:3410
#
# ONE host: blog0 also serves Listmonk's public endpoints under <base>/lm (Next.js rewrites to the internal
# Listmonk; src/lib/http/listmonk-proxy.ts), so every check goes to the same base URL. Public mode: <base>
# must be https:// (through the shared load balancer). Without --insecure curl verifies the certificate -
# that IS the TLS check. BLOG0_SMOKE_RESOLVE=<ip> pins the host to that address (curl --resolve; before
# DNS). --direct talks to the container's own port (http or https). Read-only: GETs only, nothing is created.
# Checks (each prints `deploy-smoke: <check> ok`; the first failure prints
# `deploy-smoke: FAIL <check> (<detail>)` and exits 1; all green -> `deploy-smoke: PASS`, exit 0):
#   1 ready          GET <base>/api/health/ready -> 200 with "status":"ready"
#   2 pages          GET <base>/ and <base>/privacy -> 200
#   3 article        first /p/<slug> in <base>/sitemap.xml -> 200, and /p/<slug>/tldr -> 200
#   4 confirm        /newsletter/confirm?t=bogus -> 303 to ...status=invalid; /newsletter/confirmed?status=invalid -> 404
#   5 unsubscribe    /api/newsletter/unsubscribe?t=bogus -> 303 to /newsletter/unsubscribe?t=bogus
#   6 lm-public      the proxy reaches LISTMONK (answers only Listmonk gives; blog0's 404 page could not):
#                    /lm/link/<random uuids> -> 400 + X-Robots-Tag: noindex (Listmonk's "invalid link" page),
#                    /lm/campaign/<random>/<nil>/px.png -> 200 image/png (a real PNG; Listmonk serves the pixel
#                    for any campaign), /lm/public/static/favicon.png and the absolute /public/static/logo.svg,
#                    /public/custom.css (the unsubscribe page's assets) -> 200
#   7 lm-denied      /lm /lm/admin /lm/admin/login /lm/api/health /lm/api/settings /lm/subscription/form
#                    /lm/subscription/export/<uuid> /lm/subscription/wipe/<uuid> /lm/public/static/.env -> blog0's
#                    own 404 (no X-Robots-Tag: Listmonk sets it on everything it answers)
# Exit 2 = usage.
set -euo pipefail

say() { echo "deploy-smoke: $*"; }
usage() {
  echo "usage: scripts/deploy-smoke.sh [--insecure|--direct] <base-url>   (public mode: https://; BLOG0_SMOKE_RESOLVE=<ip> optional)" >&2
  exit 2
}

INSECURE=0
DIRECT=0
POS=()
for a in "$@"; do
  case "$a" in
    --) ;;
    --insecure) INSECURE=1 ;;
    --direct) DIRECT=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) POS+=("$a") ;;
  esac
done
[[ ${#POS[@]} -eq 1 ]] || usage
BASE="${POS[0]%/}"
if ((DIRECT)); then
  [[ "$BASE" =~ ^https?://[^/]+$ ]] || usage
  CURL=(curl -sS -m 20)
else
  [[ "$BASE" =~ ^https://[^/]+$ ]] || usage
  CURL=(curl -sS -m 20 --proto '=https')
fi
((INSECURE)) && CURL+=(--insecure)
if [[ -n "${BLOG0_SMOKE_RESOLVE:-}" ]] && ((DIRECT == 0)); then
  hostport="${BASE#https://}"
  host="${hostport%%:*}"
  port=443
  [[ "$hostport" == *:* ]] && port="${hostport##*:}"
  CURL+=(--resolve "${host}:${port}:${BLOG0_SMOKE_RESOLVE}")
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

# 6. Listmonk's public endpoints, through blog0's /lm proxy, really reach Listmonk
CHECK=lm-public
NIL=00000000-0000-0000-0000-000000000000
U1=3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b
U2=9d8c7b6a-1f2e-4d3c-8b4a-5e6f7a8b9c0d
fetch "${BASE}/lm/link/${U1}/${U2}/${NIL}"
[[ "$CODE" == 400 ]] || fail "GET /lm/link/<random uuids> -> ${CODE}, expected Listmonk's 400"
[[ "$(header x-robots-tag)" == *noindex* ]] || fail "/lm/link/<random uuids>: no X-Robots-Tag: noindex - not answered by Listmonk"
fetch "${BASE}/lm/campaign/${U2}/${NIL}/px.png"
[[ "$CODE" == 200 && "$(header content-type)" == image/png* ]] || fail "GET /lm/campaign/<random>/<nil>/px.png -> ${CODE} $(header content-type), expected 200 image/png"
head -c 8 "${WORK}/b" | od -An -c | grep -q 'P   N   G' || fail "the open pixel body is not a PNG"
for p in /lm/public/static/favicon.png /public/static/logo.svg /public/custom.css /public/custom.js; do
  fetch "${BASE}${p}"
  [[ "$CODE" == 200 ]] || fail "GET ${p} -> ${CODE}, expected 200"
done
say "lm-public ok"

# 7. everything else under /lm is blog0's own 404 (never proxied)
CHECK=lm-denied
for p in /lm /lm/admin /lm/admin/login /lm/api/health /lm/api/settings /lm/subscription/form "/lm/subscription/export/${U1}" "/lm/subscription/wipe/${U1}" /lm/public/static/.env; do
  fetch "${BASE}${p}"
  [[ "$CODE" == 404 ]] || fail "GET ${p} -> ${CODE}, expected 404"
  [[ -z "$(header x-robots-tag)" ]] || fail "GET ${p} was answered by Listmonk (X-Robots-Tag present)"
done
say "lm-denied ok"

say PASS
