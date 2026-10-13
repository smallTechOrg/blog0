# Capability: Abuse protection (persistent throttles + browser hardening)

Phase 5. Supersedes the in-memory throttle assumption (`spec/roadmap.md` → Assumptions). HOW
(store interface, SQL, proxy, header values): `spec/architecture.md` §6; table:
`spec/data.md` → `rate_limit_bucket`; slices and gate: `spec/roadmap.md` → Phase 5.

## What It Does
Keeps the sign-in and newsletter caps in force across restarts and across several app instances
by counting attempts in the database, and makes every page tell the browser to refuse injected
scripts, framing, MIME sniffing and needless powerful features.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Sign-in attempt | email + client IP + site | `POST /api/auth/login` | — |
| Newsletter signup | email + client IP + site | `POST /api/newsletter` (after validation) | — |
| `BLOG0_RATE_LIMIT_STORE` | `auto` \| `db` \| `memory` | env | no (default `auto`) |
| `BLOG0_PUBLIC_BASE_URL` | origin | env | no (https ⇒ HSTS + `upgrade-insecure-requests`) |
| Page request | any HTML route | browser | — |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Throttle verdict | allowed, or 429 `RATE_LIMITED` + `Retry-After` (unchanged contract) | API response |
| Counted windows | `rate_limit_bucket` rows | database |
| Security headers | response headers (values in `spec/architecture.md` §6) | every response / every page |
| Per-request script nonce | `'nonce-…'` in CSP + `nonce` on the theme script and Next's scripts | page HTML |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | one transaction per attempt: ensure window rows, lock them, check caps, increment all or none | request fails 500 `INTERNAL` (fail closed — never "allow because the counter is down") |
| Database | prune expired windows (at most once per 10 min per process) | logged `rate_limit.prune_failed` at `warn`; the request is unaffected |

## Business Rules
- **Caps are unchanged** (`spec/architecture.md` §6, `newsletter-list.md` — formerly `newsletter-signup.md`, `admin-auth.md`; Phase 7 adds the confirm/unsubscribe link caps in §6):
  login 5 failures per (email, IP) and 20 per email per 15 min; newsletter 3 per email, 300 per
  site, 10 per known client IP per hour. Every bucket is per site.
- **Atomic check-and-count across buckets:** an attempt is refused if **any** of its buckets is at
  its cap (nothing is counted); otherwise it is counted in **all** of them — in one database
  transaction with row locks, so N concurrent attempts against a cap of M admit exactly M, across
  processes. A correct password clears the (email, IP) count and refunds the per-email
  reservation in the same window.
- **Persistence:** with the database store, a cap reached before a restart (or on another
  instance) still holds after it, until its window ends.
- **Windows are aligned** to fixed boundaries (`floor(now / window) × window`, UTC epoch) in the
  database store; `Retry-After` = seconds until that window's end (≥ 1). The in-memory store keeps
  its first-hit windows.
- **Store selection:** `auto` = database store on `postgres://`, in-memory on `pglite://`
  (designer mode, single process); `db` / `memory` force one. Integration tests run with `memory`
  unless a test opts into the database store explicitly; E2E and the container run `auto`
  (database).
- Throttle keys are stored only as SHA-256 hashes (no email or IP in clear in the throttle table).
- Expired windows are deleted by a background-safe prune; the table never grows without bound.
- **Browser hardening (production server only — `pnpm start` / the container; `pnpm dev` and
  designer mode send none of the CSP/HSTS headers):** every HTML page carries a strict
  Content-Security-Policy whose scripts are allowed only by a fresh per-request nonce
  (`'strict-dynamic'`), no framing (`frame-ancestors 'none'`), `object-src 'none'`, same-origin
  `base-uri`/`form-action`/`connect-src`; images from self, `data:`, `blob:` and any `https:`
  host (Markdown may embed remote images); audio from self (and `blob:` for local previews). HSTS (1 year, subdomains) and
  `upgrade-insecure-requests` are added only when `BLOG0_PUBLIC_BASE_URL` is https. Every response
  (pages, API, `/media`, static assets) carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
  `Cross-Origin-Opener-Policy: same-origin` and a Permissions-Policy that disables camera,
  microphone, geolocation, payment, USB and Topics (clipboard and Web Share stay allowed — the
  share menu needs them).
- The no-flash theme script keeps running before first paint (it carries the nonce); no page
  produces a CSP violation in the browser console.
- `/media/…` keeps its own headers (type, ranges, ETag, immutable caching, inline disposition)
  unchanged.

> **Assumed:** nonce-based CSP via the proxy (Next 16 applies the nonce to its own inline scripts
> when the request carries the CSP) rather than a hash/`'unsafe-inline'` script policy — every HTML
> route is already dynamic, so the per-request nonce costs nothing extra.
> **Assumed:** `style-src 'self' 'unsafe-inline'` — React `style={…}` attributes (deck, figures,
> Shiki tokens) cannot carry nonces; style injection without script execution is accepted risk.
> **Assumed:** no CSP/HSTS in development so `pnpm dev` / `dev:design` HMR and error overlays work
> untouched; the E2E suite (production server) is where the policy is proven.
> **Assumed:** database-store windows are epoch-aligned (a burst straddling a boundary can see up
> to 2× a cap for one window) — accepted for these low caps; the in-memory store keeps first-hit
> windows so existing unit tests stand.
> **Assumed (S5.3):** the limiter wrappers keep their names but become async and site-scoped —
> `LoginRateLimiter.attempt(siteId, email, ip, now?)` / `recordSuccess(siteId, email, ip, now?)` and
> `NewsletterThrottle.attempt(key, now?)`, each with an optional injected `RateLimitStore` (default:
> `getRateLimitStore()` per call); the in-memory-only `NewsletterRateLimiter` and the sync
> `check`/`recordFailure`/`prune`/`size` helpers are removed (the store owns counting and pruning).
> The reset helpers keep an opted-in database store (its rows are wiped by the test's table reset).

## Success Criteria
- [ ] Integration (DB store, real `blog0_test`): 20 concurrent `attempt()` calls on a 5-cap bucket → exactly 5 allowed, 15 limited, the row's `count` = 5.
- [ ] Integration (DB store): 5 wrong passwords for one email → the 6th login is 429 with `Retry-After`; after replacing the store with a **new** `DbRateLimitStore` instance (simulated restart) the next attempt is still 429; after the window (injected `now` + 15 min) it is allowed.
- [ ] Integration (DB store): a correct password after 3 failures clears the pair row and leaves the per-email count at 3.
- [ ] Integration (DB store): newsletter with `perEmail` cap reached → 429, and the per-IP/site rows were **not** incremented by the refused attempt.
- [ ] Integration (DB store on `pglite://memory` after `runMigrations`): the same 5-cap attempt sequence behaves identically.
- [ ] Integration: `prune(now)` deletes exactly the rows with `expires_at <= now`; `rate_limit_bucket.key_hash` never equals the raw email or IP.
- [ ] Unit: `buildContentSecurityPolicy({ nonce: 'abc', https: false })` equals the exact string in `spec/architecture.md` §6; with `https: true` it ends with `; upgrade-insecure-requests`.
- [ ] E2E (production server): `GET /` response has `content-security-policy` containing `'nonce-` and `frame-ancestors 'none'`; two requests carry different nonces; the inline theme script's `nonce` property equals the header's nonce and `<html>` has `data-theme`; across home, an article, its deck, Listen, `/admin/login` and the desk no console message contains `Content Security Policy`.
- [ ] E2E: `GET /api/health` and `GET /media/<key>` carry `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: strict-origin-when-cross-origin`; the media response still has `accept-ranges: bytes` and `cache-control: public, max-age=31536000, immutable`.
- [ ] Boot check over http: no `strict-transport-security` header; unit: `runtimeSecurityHeaders({ nonce: 'abc', https: true })['strict-transport-security']` is `max-age=31536000; includeSubDomains` and absent for `https: false`.
- [ ] `pnpm dev` / `pnpm test:e2e:design` responses carry no `content-security-policy` header (designer E2E still green).
