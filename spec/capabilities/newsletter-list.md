# Capability: Newsletter list (owned list with proof of consent)

Phase 7. Supersedes `newsletter-signup.md` (Phase 2). Sending is `newsletter-issues.md`. HOW
(tokens, mail transport, provider mapping, prune): `spec/architecture.md` §13; tables and
migration `0002_newsletter`: `spec/data.md`; HTTP: `spec/api.md` → newsletter; screens:
`spec/ui.md` §4 Subscribers; slices and gate: `spec/roadmap.md` → Phase 7.

## What It Does
blog0 owns the subscriber list — every address, its proof of consent and its whole history live in
blog0's database — and a reader joins only by double opt-in: footer signup → confirmation email →
click. The sending provider (Listmonk) only ever receives a copy and never becomes the record.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Email | address ≤ 254 | footer form | yes |
| Name | text ≤ 120 | footer form | no |
| Source page | relative path ≤ 500 (`/`, `/p/<slug>`, `/archive?topic=…`) | footer form (current location) | no (default `/`) |
| Client IP, user agent | request headers (`spec/architecture.md` §6 client-IP derivation; UA ≤ 300 chars) | request | — |
| Consent text + version | the site's newsletter settings at signup time | `site` row (`newsletter-issues.md` settings) | — |
| Confirmation token | 256-bit random, from the emailed link `?t=` | reader's click | yes to confirm |
| Unsubscribe token | signed link from an issue or confirmation email | reader's click, or RFC 8058 one-click POST | yes to unsubscribe |
| Admin actions | send confirmation, unsubscribe, export | Admin → Subscribers | — |
| Provider suppressions | blocklisted / bounced addresses | sender adapter poll, or the secret-verified webhook | — |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Subscriber record | status `pending` \| `confirmed` \| `unsubscribed` \| `bounced` \| `legacy_unconfirmed`, signup + confirmation timestamps, IP, UA, source URL, consent text + version, hashed token | `newsletter_subscriber` |
| Event ledger | append-only rows: signup, confirmation_sent, confirmed, unsubscribed, resubscribed, bounced, provider_synced, provider_removed, ip_pruned | `newsletter_subscriber_event` |
| Suppression ledger | append-only rows (email, reason, source, when) — never deleted | `newsletter_suppression` |
| Confirmation email | transactional message (HTML + text) with the confirm link | reader's inbox (SMTP) or `newsletter_message` (stub) |
| Footer copy | "Almost there — check your inbox and confirm." | footer form |
| Confirm / unsubscribe pages | site-chrome pages stating the outcome | reader |
| Provider copy | subscriber upsert / blocklist with consent metadata as attributes | sender adapter (`newsletter-issues.md`) |
| Subscriber list, filters, per-subscriber audit view | table + detail | Admin → Subscribers |
| Export CSV; export audit bundle (JSON) | downloads | Admin → Subscribers |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | insert/update subscriber, append events + suppressions, in one transaction per action | form shows "That didn’t go through. Try again?"; links show "Something went wrong — try the link again." |
| SMTP (nodemailer) | send the confirmation email | signup still succeeds (row `pending`, event `confirmation_sent` with `outcome: 'failed'`); logged `newsletter.mail` at `warn`; admin can resend; with no SMTP configured the stub transport records the message instead (never an error) |
| Sender adapter (Listmonk / stub) | sync a confirmed subscriber; blocklist an unsubscribed/bounced one; poll suppressions | the blog0 change is already committed; the sync is retried by `pnpm newsletter:sync`; logged `newsletter.sync` at `warn`; never blocks the reader |

## Business Rules
- **blog0 is the source of truth.** Every status change happens in blog0 first; the provider gets a
  copy afterwards (`syncSubscriber` / `removeSubscriber`). A provider-side change (blocklist,
  bounce) is pulled into blog0 as a suppression + event; blog0 never reads the provider to answer
  "who is subscribed".
- **Double opt-in.** A footer signup creates (or re-opens) a `pending` subscriber with a fresh
  token and sends one confirmation email. Nothing is `confirmed` until the link is clicked.
  Opening the confirm link marks the subscriber `confirmed` (`confirmed_at = now`, token cleared),
  appends `confirmed`, and syncs the subscriber to the provider. Only `confirmed` subscribers ever
  receive an issue.
- **Pending signups expire** after 72 h: the link then answers "This link has expired — sign up
  again from the footer." (410) and the row stays `pending` with the expiry visible to admins;
  a new signup issues a new token. Confirmation emails per subscriber: at most 3 per 24 h (a 4th
  signup in that window succeeds silently without sending).
- **Proof per subscriber** (stored at signup): signup time, client IP (only when a real address is
  known — `spec/architecture.md` §6; else null), user agent, source page URL, consent text and
  consent version exactly as shown under the form; at confirmation: time, IP, user agent. Tokens
  are stored only hashed.
- **No enumeration.** The footer form gets the same success whether the address was new, pending,
  confirmed or suppressed. A `confirmed` address signing up again changes nothing and sends nothing.
- **Suppression is append-only and permanent.** Unsubscribing (link, one-click POST, admin, or
  provider) writes a `newsletter_suppression` row and an `unsubscribed`/`bounced` event, sets the
  status, and blocklists the address at the provider. Suppression rows are never deleted or
  edited, not by admins, not by a re-signup.
- **Re-signup of a suppressed address** is allowed only through a fresh double opt-in: the row
  goes back to `pending` with new signup metadata, consent and token; the old suppression and
  events remain; confirming appends `resubscribed`, sets `confirmed`, and re-enables the address at
  the provider. A suppressed address that merely gets re-synced is never re-enabled.
- **Unsubscribe is one click.** The link in every issue and in the confirmation email needs no
  sign-in; opening it unsubscribes at once and shows "You’re unsubscribed. Sorry to see you go."
  `POST /api/newsletter/unsubscribe` honours RFC 8058 one-click (`List-Unsubscribe-Post`). An
  already-unsubscribed address shows the same page. The signed link does not expire.
- **Legacy subscribers** (every `subscribed` row from before Phase 7) become
  `legacy_unconfirmed` by the migration: kept, exported, visible, but **never** sent an issue and
  **never** synced until confirmed. They get **one** confirmation email, only when an admin clicks
  **Send confirmation** on that subscriber (or **Send confirmation to all legacy** once); the
  button is then spent for that subscriber. A legacy address that signs up again from the footer
  takes the normal pending → confirmed path. Legacy `unsubscribed` rows become suppressions.
- **Bounces.** A hard bounce reported by the provider (poll or webhook) sets `bounced`, writes a
  suppression (`reason: 'bounced'`) and blocklists; re-signup follows the suppressed-address rule.
- **IP retention.** `signup_ip` and `confirmed_ip` are nulled 12 months after confirmation (or
  after signup for never-confirmed rows) by `pnpm newsletter:tick` (event `ip_pruned`); user agent,
  source URL and consent stay. Nothing else is ever pruned.
- **Rate limits** (`spec/architecture.md` §6): the existing signup caps stay (3 per email, 300 per
  site, 10 per known IP per hour); confirm and unsubscribe links are capped at 30 per known IP and
  1 000 per site per hour (429 pages, never counted for invalid tokens).
- **Admin → Subscribers** shows counts per status, filters, search by email, the per-subscriber
  audit view (every stored field, the full event timeline, suppression rows for that email,
  provider id + last sync), **Send confirmation** (legacy: once; pending: resend, within the
  3-per-24 h cap), **Unsubscribe** (admin-sourced suppression, with confirm), **Export CSV**
  (every subscriber, every status) and **Export audit (JSON)** — one bundle with the settings
  snapshot, every subscriber with its events, and every suppression row, enough to prove consent
  for any address without database access.
- **Designer mode and tests never need SMTP**: without `BLOG0_SMTP_HOST` the stub transport stores
  each message in `newsletter_message` and logs the confirm URL (stub only), so the full
  signup → confirm walk runs with nothing configured.

> **Assumed:** 72 h token expiry, 3 confirmation emails per 24 h per subscriber, 12-month IP
> retention — all constants in `src/server/newsletter/constants.ts`, each reversible.
> **Assumed:** the unsubscribe link is a signed, stateless token (subscriber id + HMAC with the
> session secret) rather than a stored one, so Listmonk-sent issues can carry a blog0 link through a
> subscriber attribute without a round trip; it never expires because an unsubscribe must always
> work.
> **Assumed:** confirmation on GET (one click from the email) is accepted even though some mail
> scanners prefetch links — the same choice most list tools make; the confirm page sends
> `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
> **Assumed:** footer success copy changes from "You’re in. First issue lands Thursday." to
> "Almost there — check your inbox and confirm." (design divergence 15 amended), because the old
> line would be false under double opt-in.
> **Assumed:** a signup whose confirmation email fails to send still creates the pending row (the
> reader can sign up again and the admin can resend) — losing the signup is worse than a delayed
> email.
> **Assumed:** expired pending rows are kept (status `pending`, expiry visible) rather than deleted,
> so repeated abuse of one address stays visible; their IP is pruned on the normal 12-month rule.
> **Assumed (S7.1):** a used confirm token is still recognisable after confirmation even though the
> row's hash is cleared: the `confirmed` / `resubscribed` event keeps `details.tokenHash` (the hash of
> a spent one-time secret), so a second click answers 410 "already used" instead of 404.
> **Assumed (S7.1):** Next's App Router fixes a page's HTTP status at 200 except through `notFound()`,
> so the HTML link pages answer a true 404 for an invalid token (segment `not-found.tsx`) and render
> the expired / rate-limited copy at 200; the JSON routes (`POST /api/newsletter/confirm|unsubscribe`)
> carry the exact 410 / 429 codes. `X-Robots-Tag` on the pages is replaced by `robots: noindex`
> metadata (`Cache-Control: no-store` comes from `force-dynamic`).
> **Assumed (S7.1):** the ledger guard lets a draft issue's cascade delete pass (the parent row is
> already gone when the row trigger fires) and lets `newsletter_prune_event_ips()` null `ip` only
> while `blog0.newsletter_prune = '1'` is set for that transaction; every other UPDATE / DELETE on
> the three append-only tables raises `integrity_constraint_violation` ("append-only").
> **Assumed (S7.1):** a capped signup (4th in 24 h) keeps the token already in the inbox rather than
> issuing one it cannot deliver; a failed send is recorded (`outcome: 'failed'`) but does not count
> toward the cap. Legacy rows backfilled by the migration get `source = 'legacy'`; a re-signup from
> the footer sets `source = 'footer'` again. Slice S7.1's `sender-hook.ts` is a no-op, so the
> `provider_synced` event of the confirm criterion arrives with slice S7.3's sync wiring.

## Success Criteria
- [ ] Integration: `POST /api/newsletter { email: ' A@B.com ', sourceUrl: '/p/humans-are-software' }` → `{ subscribed: true }`; the row is `pending`, `email = 'a@b.com'`, `signup_source_url` set, `consent_text`/`consent_version` equal the site settings, `confirm_token_hash` is 64 hex chars and is not the token; one `signup` + one `confirmation_sent` event; one `newsletter_message` row (stub) whose HTML contains `/newsletter/confirm?t=`.
- [ ] Integration: opening that link → 200 page containing "You’re subscribed"; the row is `confirmed` with `confirmed_at` set and the token hash null; a `confirmed` event; a `provider_synced` event (stub sender); opening it again → 410 page "This link has expired or was already used".
- [ ] Integration: with injected `now` 73 h later the unused link → 410; a new signup for the same address issues a different hash and a second `confirmation_sent` event; a 4th signup within 24 h sends nothing (3 `confirmation_sent` events, 4 `signup` events).
- [ ] Integration: a signup for a `confirmed` address → same `{ subscribed: true }`, no new event, no message.
- [ ] Integration: opening the unsubscribe link of a confirmed subscriber → page "You’re unsubscribed"; status `unsubscribed`; one `newsletter_suppression` row (`reason: 'unsubscribed'`, `source: 'email_link'`); `unsubscribed` + `provider_removed` events; `POST /api/newsletter/unsubscribe` with the same token (`List-Unsubscribe=One-Click` body, no `Origin`) → 200; a tampered token → 404 and no row changes.
- [ ] Integration: a suppressed address signing up again → `pending` with a new token, consent and `signup` event (`details.resignup = true`); confirming → `confirmed` + `resubscribed` event; the suppression row count is unchanged (still 1); unsubscribing again → a second suppression row (count 2). `DELETE`/`UPDATE` on `newsletter_suppression` raise (trigger) — asserted directly with SQL.
- [ ] Integration (migration): a `blog0_test` seeded with two pre-Phase-7 rows (`subscribed`, `unsubscribed`) migrated by `0002_newsletter` yields `legacy_unconfirmed` and `unsubscribed` + one suppression row (`source: 'migration'`); `POST /api/admin/subscribers/:id/send-confirmation` on the legacy row sends one message and a second call → 409 `CONFIRMATION_ALREADY_SENT`.
- [ ] Integration: `GET /api/admin/subscribers?status=confirmed` lists only confirmed rows with `counts` per status; `?format=csv` has the header `email,name,status,subscribed_at,confirmed_at,unsubscribed_at,source,source_url,consent_version`; `?format=audit` downloads `blog0-newsletter-audit/1` JSON whose `subscribers[].events` and `suppressions` match the tables row for row.
- [ ] Integration: `pnpm newsletter:tick` with injected `now` 13 months after a confirmation nulls `signup_ip`/`confirmed_ip`, appends `ip_pruned`, and leaves user agent, source URL and consent intact; a second run changes nothing.
- [ ] Integration: 31 confirm-link requests from one known IP within an hour → the 31st is 429 with `Retry-After`; invalid-token requests are not counted.
- [ ] Unit: `signUnsubscribeToken(id, secret)` round-trips through `verifyUnsubscribeToken`; a one-character change fails; `hashConfirmToken` is deterministic and never equals its input; the confirmation templates (HTML + text) contain the confirm URL, the expiry note, the consent line and the brand.
- [ ] E2E (Chromium, stub transport + stub sender): footer signup → "Almost there — check your inbox and confirm." → the confirm URL from the server log/`newsletter_message` opens "You’re subscribed" → Admin → Subscribers shows the address as **Confirmed** with its audit view (source `/`, consent v1, two events) → **Export audit (JSON)** downloads a file naming that address → the unsubscribe link from a sent issue (`newsletter-issues.md`) → "You’re unsubscribed" → the subscriber shows **Unsubscribed** with one suppression row.
- [ ] Designer E2E (`pnpm test:e2e:design`, no `.env`): signup → confirm via the logged URL → the admin list shows **Confirmed**; no SMTP, no Listmonk.
