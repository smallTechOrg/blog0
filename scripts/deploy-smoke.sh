#!/usr/bin/env bash
# Post-deploy smoke test (Stage B, spec/architecture.md §12.7; `pnpm deploy:smoke -- …`).
#
#   scripts/deploy-smoke.sh [--insecure] <base-url> <news-url>
#     e.g. scripts/deploy-smoke.sh https://blog0.smalltech.in https://news.blog0.smalltech.in
#   scripts/deploy-smoke.sh --direct <blog0-url> <listmonk-url>
#     e.g. on the VM / locally: --direct http://127.0.0.1:3410 http://127.0.0.1:9000
#
# Public mode: both URLs must be https:// (through the shared load balancer). Without --insecure curl
# verifies the certificates — that IS the TLS check. BLOG0_SMOKE_RESOLVE=<ip> pins both hosts to that
# address (curl --resolve; before DNS). --direct talks to the containers' own ports (http or https):
# the news-denied check is skipped there (Listmonk's own port serves its whole surface; the url map
# denies the rest in public mode). Read-only: GETs only, nothing is created.
# Checks (each prints `deploy-smoke: <check> ok`; the first failure prints
# `deploy-smoke: FAIL <check> (<detail>)` and exits 1; all green → `deploy-smoke: PASS`, exit 0):
#   1 ready          GET <base>/api/health/ready → 200 with "status":"ready"
#   2 pages          GET <base>/ and <base>/privacy → 200
#   3 article        first /p/<slug> in <base>/sitemap.xml → 200, and /p/<slug>/tldr → 200
#   4 confirm        /newsletter/confirm?t=bogus → 303 to …status=invalid; /newsletter/confirmed?status=invalid → 404
#   5 unsubscribe    /api/newsletter/unsubscribe?t=bogus → 303 to /newsletter/unsubscribe?t=bogus
#   6 news-public    <news>/link/<nil>/<nil>/<nil> and /campaign/<nil>/<nil>/px.png → < 500, no X-Blog0-Edge
#   7 news-denied    (public mode only) <news>/ /admin /admin/login /api/settings /public/static/.env → 404 (the url map's fault-injection 404 or Listmonk's own)
# Exit 2 = usage.
set -euo pipefail

say() { echo "deploy-smoke: $*"; }
usage() {
  echo "usage: scripts/deploy-smoke.sh [--insecure|--direct] <base-url> <news-url>   (public mode: both https://; BLOG0_SMOKE_RESOLVE=<ip> optional)" >&2
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
[[ ${#POS[@]} -eq 2 ]] || usage
BASE="${POS[0]%/}"
NEWS="${POS[1]%/}"
if ((DIRECT)); then
  [[ "$BASE" =~ ^https?://[^/]+$ && "$NEWS" =~ ^https?://[^/]+$ ]] || usage
  CURL=(curl -sS -m 20)
else
  [[ "$BASE" =~ ^https://[^/]+$ && "$NEWS" =~ ^https://[^/]+$ ]] || usage
  CURL=(curl -sS -m 20 --proto '=https')
fi
((INSECURE)) && CURL+=(--insecure)
if [[ -n "${BLOG0_SMOKE_RESOLVE:-}" ]] && ((DIRECT == 0)); then
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

# 6. Listmonk's public tracking paths reach Listmonk (through the url map's news matcher)
CHECK=news-public
NIL=00000000-0000-0000-0000-000000000000
for p in "/link/${NIL}/${NIL}/${NIL}" "/campaign/${NIL}/${NIL}/px.png"; do
  fetch "${NEWS}${p}"
  ((CODE > 0 && CODE < 500)) || fail "GET ${NEWS}${p} → ${CODE}, expected < 500"
  [[ -z "$(header x-blog0-edge)" ]] || fail "GET ${NEWS}${p} was denied by the edge (X-Blog0-Edge present)"
done
say "news-public ok"

# 7. everything else on the news host is denied by the url map (public mode only)
if ((DIRECT == 0)); then
  CHECK=news-denied
  for p in / /admin /admin/login /api/settings /subscription/form /public/static/.env; do
    fetch "${NEWS}${p}"
    [[ "$CODE" == 404 ]] || fail "GET ${NEWS}${p} → ${CODE}, expected 404"
  done
  say "news-denied ok"
else
  say "news-denied skipped (--direct)"
fi

say PASS
