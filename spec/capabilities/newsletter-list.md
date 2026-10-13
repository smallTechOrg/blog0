# Capability: Newsletter list (owned list with proof of consent)

Phase 7. Supersedes `newsletter-signup.md` (Phase 2). Sending is `newsletter-issues.md`. HOW
(tokens, mail transport, provider mapping, prune): `spec/architecture.md` §13; tables and
migrations `0002_newsletter`, `0003_newsletter_prune_fix`, `0004_newsletter_erasure` (fix pass): `spec/data.md`; HTTP: `spec/api.md` → newsletter; screens:
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
| Provider suppressions | blocklisted / list-unsubscribed / bounced addresses | sender adapter poll, or the secret-verified webhook | — |

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
| Sender adapter (Listmonk / stub) | sync a confirmed subscriber; blocklist an unsubscribed/bounced one; poll suppressions (blocklist, list-level unsubscribe, bounce) — the stub sender skips all of it | the blog0 change is already committed; the sync is retried by `pnpm newsletter:sync`; logged `newsletter.sync` at `warn`; never blocks the reader |

## Business Rules
- **blog0 is the source of truth.** Every status change happens in blog0 first; the provider gets a
  copy afterwards (`syncSubscriber` / `removeSubscriber`). A provider-side change (blocklist,
  list-level unsubscribe, bounce) is pulled into blog0 as a suppression + event; blog0 never reads
  the provider to answer "who is subscribed".
- **Provider copy only with a real sender.** The `provider_synced` / `provider_removed` events and
  the "Synced to Listmonk" timeline entry exist only with the Listmonk sender. The stub sender
  (designer mode, tests, E2E) skips sync entirely: no provider events, no sync timeline entry,
  `provider_synced_at` stays empty.
- **An opt-out anywhere wins.** A reader who leaves the `blog0` list inside Listmonk (list-level
  unsubscribe, without being blocklisted) is unsubscribed in blog0 by the next
  `pnpm newsletter:tick`, exactly like a provider blocklist or bounce (suppression `source:
  'provider'`). Until then — and always — a sync never re-adds a list membership whose provider
  unsubscribe is newer than blog0's latest confirmation of that subscriber. Only a fresh double
  opt-in confirmed **after** that unsubscribe may re-add the membership. HOW:
  `spec/architecture.md` §13.3.
- **Double opt-in.** A footer signup creates (or re-opens) a `pending` subscriber with a fresh
  token and sends one confirmation email. Nothing is `confirmed` until the link is clicked.
  Opening the confirm link marks the subscriber `confirmed` (`confirmed_at = now`, token cleared),
  appends `confirmed`, and syncs the subscriber to the provider. Only `confirmed` subscribers ever
  receive an issue.
- **Pending signups expire** after 72 h: the link then shows "This link has expired or was already
  used — sign up again from the footer." (the page renders it at HTTP 200; the JSON route answers
  410 `TOKEN_EXPIRED` — `spec/api.md`) and the row stays `pending` with the expiry visible to admins;
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
- **One-click header vs visible link.** Every message blog0 itself sends to a subscriber carries
  `List-Unsubscribe: <…/api/newsletter/unsubscribe?t=<token>>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`: the mail client POSTs there
  (`List-Unsubscribe=One-Click`, URL-encoded or multipart) and the subscriber is unsubscribed with
  source `one_click`, no page, no sign-in. A GET on that URL redirects (303) to the unsubscribe page.
  The **visible** unsubscribe link in every email body is always the page
  (`/newsletter/unsubscribe?t=…`, source `email_link`).
- **Concurrent opt-outs write once.** Every suppression re-reads the subscriber under a row lock
  and decides from that copy, so two simultaneous unsubscribes (link + one-click, webhook + tick)
  leave exactly one suppression row and one event; the one-time legacy confirmation is checked the
  same way, so racing clicks send one email.
- **Provider timestamps never undo a newer consent.** A webhook opt-out carrying a parseable
  `occurredAt` older than the subscriber's latest consent / confirmation is ignored (answered
  `accepted: true`, nothing written); equal or newer — or no/unparseable timestamp — is applied.
  Same rule as the tick and the sync (`newsletter-issues.md`).
- **Legacy subscribers** (every `subscribed` row from before Phase 7) become
  `legacy_unconfirmed` by the migration: kept, exported, visible, but **never** sent an issue and
  **never** synced until confirmed. They get **one** confirmation email, only when an admin clicks
  **Send confirmation** on that subscriber (or **Send confirmation to all legacy** once); the
  button is then spent for that subscriber. A legacy address that signs up again from the footer
  takes the normal pending → confirmed path. Legacy `unsubscribed` rows become suppressions.
- **Bounces.** A hard bounce reported by the provider (poll or webhook) sets `bounced`, writes a
  suppression (`reason: 'bounced'`) and blocklists; re-signup follows the suppressed-address rule.
- **IP retention.** `signup_ip` and `confirmed_ip` are nulled by `pnpm newsletter:tick` (event
  `ip_pruned`) once 12 months have passed since the subscriber's latest act of consent — the later
  of its last confirmation and its last (re)signup consent, or its first signup when it has
  neither — so a re-signup or re-confirmation restarts the clock. An event's IP is nulled only once
  that event itself is more than 12 months old. User agent, source URL and consent stay. Nothing
  else is ever pruned.
- **Rate limits** (`spec/architecture.md` §6): the existing signup caps stay (3 per email, 300 per
  site, 10 per known IP per hour); confirm and unsubscribe requests (pages and JSON routes, one
  shared pair of buckets) are capped at 30 per known IP and 1 000 per site per hour. Every
  **well-formed** token counts toward both caps whether or not it turns out valid; only a
  malformed token (wrong shape — 404 at once) is never counted. Over a cap the page shows "Too many
  requests — try again in N minutes." (rendered at HTTP 200) and the JSON route answers 429 with
  `Retry-After`.
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
> the footer sets `source = 'footer'` again. Slice S7.1's `sender-hook.ts` is a no-op; S7.3 wires it
> to the sync, which skips every row under the stub sender (`newsletter-issues.md` Assumed S7.3), so
> the confirm / unsubscribe criteria below assert **no** provider events — those are proven with the
> real Listmonk container.
> **Assumed (Phase 7 drift review):** the one-click header points at the JSON route rather than the
> page because RFC 8058 requires a POST-able URI and a GET-only page would let link scanners
> unsubscribe readers; the 303 on GET keeps a client that ignores `List-Unsubscribe-Post` working.
> The prune bar uses `greatest(confirmed_at, consented_at)` because a re-signup refreshes consent
> before (or without) a new confirmation; `0003_newsletter_prune_fix` exists because the
> `0002` function nulled every event IP of a pruned subscriber regardless of age, and lacked a fixed
> `search_path` (a `SECURITY DEFINER` hazard).
> **Assumed (fix):** `confirmed_ip` additionally ages out on its own `confirmed_at` (bar
> `coalesce(confirmed_at, anchor)`), so a pending re-signup — which refreshes `consented_at` but
> keeps the old confirmation — never extends the old confirmation's IP by another 12 months; the
> re-signup's `signup_ip` follows the anchor. A subscriber whose only due IPs are on old events gets
> those nulled too (candidate query includes "any event IP older than the bar"); `ip_pruned` details
> carry `hadSignupIp`, `hadConfirmedIp`, `eventRows` and `before` (the bar), and `ip_pruned_at` is set
> only when a row IP was nulled. The prune re-reads the row `FOR UPDATE` before deciding.
> **Assumed (fix):** suppression is decided under the subscriber row lock (`suppressOnce`): a row
> already `unsubscribed`/`bounced` when the lock is taken writes nothing and runs no sender hook, so
> racing link / one-click / webhook / tick requests yield exactly one suppression and one event (the
> losers answer `alreadyUnsubscribed: true`; admin unsubscribe answers 409). The legacy one-time
> confirmation claims `legacy_confirmation_sent_at` under `FOR UPDATE` before sending (the lock is not
> held across SMTP — the `newsletter_message` FK would wait on it); a mail failure restores the row
> exactly (MAIL_FAILED changes nothing) and the `legacy_confirmation_sent` event is appended after
> the transport accepted the message.
> **Assumed (fix):** a `GET /api/newsletter/unsubscribe` without `t` 303s to the bare page path; every
> non-JSON POST (urlencoded or multipart, token from `?t=`) is recorded as `one_click`.
> **Assumed (fix pass, post-freeze — supersedes any earlier line that says otherwise):**
> 1. **Scanner-safe links.** `GET /newsletter/confirm` and `GET /newsletter/unsubscribe` never change
>    state, never consume a token and never count toward the link caps: they only shape-check the
>    token (malformed → 404; an unsubscribe token with a bad signature → 404) and render a button —
>    "Confirm my subscription" / "Yes, unsubscribe me" — that POSTs the token to the existing
>    `POST /api/newsletter/confirm` / `POST /api/newsletter/unsubscribe` (JSON `{ token, source:
>    'email_link' }` for the unsubscribe button, so the suppression source stays `email_link`). The
>    POSTs are the rate-limited, state-changing calls and the page then shows the outcome copy
>    (success / expired-or-used / invalid / rate-limited). RFC 8058 one-click POST handling is
>    unchanged. The "opening the link" wording above means "opening the link and pressing the button".
> 2. **Unsubscribe secret.** `BLOG0_UNSUBSCRIBE_SECRET` (optional, ≥ 24 chars, placeholder-rejected)
>    signs new unsubscribe tokens; default = the session secret. Verification tries the unsubscribe
>    secret first, then the session secret, so rotating the session secret no longer breaks links
>    signed with a dedicated unsubscribe secret (`spec/architecture.md` §10, §13.1).
> 3. **Privacy, postal address, erasure.** (a) Site setting `privacyText` (seeded plain-language
>    **draft** — collected: email, name, IP, user agent, source page; why; IPs kept 12 months; how to
>    unsubscribe; how to request erasure by mailing the contact address) is served at `/privacy`,
>    editable in Admin → Site, and linked from the signup consent line and the issue footer.
>    **The site owner must review the wording before relying on it — it is a draft, not legal
>    advice.** (b) Site setting `newsletterPostalAddress` (empty default) is rendered in the issue
>    footer and the confirmation email when non-empty; sending with it empty shows a warning in the
>    admin (never blocks). (c) **Erasure**: `newsletter_erase_subscriber(p_subscriber_id)`
>    (migration `0004_newsletter_erasure`) redacts email, IP, user agent and source in
>    `newsletter_subscriber`, `newsletter_subscriber_event` and `newsletter_message`; the email
>    becomes the tombstone `erased+<hash>@erased.invalid` where `hash = sha256hex(erase_salt + ':' +
>    normalizedEmail)` (normalized = trimmed, lower-cased) and `erase_salt` is the per-site random
>    `site.newsletter_erase_salt` generated by the migration (independent of every secret, so
>    rotating a secret never breaks matching); a suppression row (`reason 'erased'`) keyed by that
>    hash is kept; one PII-free `erased` event is appended. A later signup computes the same hash
>    and, on a match, is **not a clean slate**: the address needs a fresh double opt-in, the new
>    `signup` event carries `details.resignup = true, erasedBefore = true`, and the tombstone
>    suppression stays. Admin triggers it via **Erase personal data** (typed address) →
>    `POST /api/admin/subscribers/:id/erase`; the provider copy is removed best-effort with
>    `sender.removeSubscriber` and the outcome logged (`newsletter.erase`).
> 4. **Confirmation-token redaction.** `newsletter_message` rows of kind `confirmation` store the
>    HTML and text with the link's token replaced: `…/newsletter/confirm?t=[redacted]`; the
>    transport still sends the real link; `0004` redacts existing rows. The stub transport's log line
>    (`confirm_url`) is unchanged (designer/E2E need it).
> **Frozen — not scheduled (Phase 7 known gap, not a rule):** unsubscribe requests should be exempt
> from the site-wide link bucket so a flood of well-formed garbage tokens cannot block real
> unsubscribes (`spec/roadmap.md` → Frozen — not scheduled); the rate-limit rule above (both caps,
> every well-formed token) is what ships.

## Success Criteria
- [ ] Integration: `POST /api/newsletter { email: ' A@B.com ', sourceUrl: '/p/humans-are-software' }` → `{ subscribed: true }`; the row is `pending`, `email = 'a@b.com'`, `signup_source_url` set, `consent_text`/`consent_version` equal the site settings, `confirm_token_hash` is 64 hex chars and is not the token; one `signup` + one `confirmation_sent` event; one `newsletter_message` row (stub) whose HTML contains `/newsletter/confirm?t=`.
- [ ] Integration: opening that link → 200 page containing "You’re subscribed"; the row is `confirmed` with `confirmed_at` set and the token hash null; a `confirmed` event; **no** `provider_synced` event and `provider_synced_at` null (stub sender skips sync); opening it again → the page (HTTP 200) shows "This link has expired or was already used", and `POST /api/newsletter/confirm` with the same token → 410 `TOKEN_EXPIRED`.
- [ ] Integration: with injected `now` 73 h later the unused link → the expired copy on the page (200) and 410 `TOKEN_EXPIRED` from the JSON route; a new signup for the same address issues a different hash and a second `confirmation_sent` event; a 4th signup within 24 h sends nothing (3 `confirmation_sent` events, 4 `signup` events).
- [ ] Integration: a signup for a `confirmed` address → same `{ subscribed: true }`, no new event, no message.
- [ ] Integration: opening the unsubscribe link of a confirmed subscriber → page "You’re unsubscribed"; status `unsubscribed`; one `newsletter_suppression` row (`reason: 'unsubscribed'`, `source: 'email_link'`); one `unsubscribed` event and **no** `provider_removed` event (stub sender); `POST /api/newsletter/unsubscribe` with the same token (`List-Unsubscribe=One-Click` body, no `Origin`) → 200; a tampered token → 404 and no row changes.
- [ ] Integration (one-click): for a confirmed subscriber, `POST /api/newsletter/unsubscribe?t=<token>` with body `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded` → 200 `{ unsubscribed: true, alreadyUnsubscribed: false }`, one suppression + one `unsubscribed` event with `source: 'one_click'`; the same as `multipart/form-data` for a second subscriber → the same outcome; `GET /api/newsletter/unsubscribe?t=<token>` → 303 with `Location` `/newsletter/unsubscribe?t=<token>` and no row written by the GET itself. The confirmation message's `List-Unsubscribe` header (built by the transport; asserted on the header builder or a captured SMTP message) is `<<base>/api/newsletter/unsubscribe?t=…>` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, while its HTML body's visible link is `/newsletter/unsubscribe?t=`.
- [ ] Integration (concurrency): two `unsubscribeByToken` calls for the same confirmed subscriber started together (`Promise.all`) → exactly one suppression row and one `unsubscribed` event; one result has `alreadyUnsubscribed: true`. Two concurrent `send-confirmation` calls on one legacy row → one message, the other 409 `CONFIRMATION_ALREADY_SENT`.
- [ ] Integration (webhook timestamp): a confirmed subscriber with `confirmed_at = T`; webhook `{ event: 'unsubscribe', email, occurredAt: T − 1 h }` → `{ accepted: true }`, status still `confirmed`, no suppression; `occurredAt: T` (tie) → `unsubscribed` + one suppression (`source: 'webhook'`); a second subscriber with `occurredAt: 'not-a-date'` → suppressed.
- [ ] Integration: a suppressed address signing up again → `pending` with a new token, consent and `signup` event (`details.resignup = true`); confirming → `confirmed` + `resubscribed` event; the suppression row count is unchanged (still 1); unsubscribing again → a second suppression row (count 2). `DELETE`/`UPDATE` on `newsletter_suppression` raise (trigger) — asserted directly with SQL.
- [ ] Integration (migration): a `blog0_test` seeded with two pre-Phase-7 rows (`subscribed`, `unsubscribed`) migrated by `0002_newsletter` yields `legacy_unconfirmed` and `unsubscribed` + one suppression row (`source: 'migration'`); `POST /api/admin/subscribers/:id/send-confirmation` on the legacy row sends one message and a second call → 409 `CONFIRMATION_ALREADY_SENT`.
- [ ] Integration: `GET /api/admin/subscribers?status=confirmed` lists only confirmed rows with `counts` per status; `?format=csv` has the header `email,name,status,subscribed_at,confirmed_at,unsubscribed_at,source,source_url,consent_version`; `?format=audit` downloads `blog0-newsletter-audit/1` JSON whose `subscribers[].events` and `suppressions` match the tables row for row.
- [ ] Integration: `pnpm newsletter:tick` with injected `now` 13 months after a confirmation nulls `signup_ip`/`confirmed_ip`, appends `ip_pruned`, and leaves user agent, source URL and consent intact; a second run changes nothing.
- [ ] Integration (prune bar, migration `0003_newsletter_prune_fix`): a subscriber confirmed 14 months ago who re-signed up 2 months ago (`consented_at` = now − 2 months, new `signup_ip`) → the tick prunes nothing; a subscriber confirmed 14 months ago with an `unsubscribed` event (with IP) from 3 months ago → row IPs nulled, the 14-month-old events' `ip` nulled, the 3-month-old event keeps its `ip`. `select pg_get_function_identity_arguments('newsletter_prune_event_ips'::regproc)` is `p_subscriber_id uuid, p_before timestamp with time zone`, and `proconfig` contains a `search_path=` entry; the one-argument version no longer exists.
- [ ] Integration: 31 confirm-link requests with a **well-formed** token (valid or not) from one known IP within an hour → the 31st: JSON route 429 with `Retry-After`, page shows the rate-limited copy at 200; requests with a **malformed** token (wrong shape) → 404 and are not counted.
- [ ] Integration (fix pass, scanner-safe, tests first): a plain `GET /newsletter/confirm?t=<valid>` leaves the row `pending`, the token hash unchanged and no event/rate-limit count (render contains "Confirm my subscription"); a `POST /api/newsletter/confirm` with that token then confirms it. A plain `GET /newsletter/unsubscribe?t=<valid>` leaves the status `confirmed`, no suppression row, no count (contains "Yes, unsubscribe me"); the POST `{ token, source: 'email_link' }` → `unsubscribed`, one suppression with `source: 'email_link'`. The existing 31st-request cap test counts POSTs only; GETs never count. Existing criteria above that "open" a link follow the button.
- [ ] Unit/integration (fix pass, secret): with `BLOG0_UNSUBSCRIBE_SECRET` set, a new token verifies with `[unsubscribeSecret, sessionSecret]`; a token signed with the session secret still verifies after the unsubscribe secret is added; a token signed with the unsubscribe secret still verifies after the session secret changes; `loadConfig` rejects a `replace-with-…` value and a value under 24 chars (aggregated `ConfigError`).
- [ ] Integration (fix pass, erasure; Postgres and PGlite): `newsletter_erase_subscriber(id)` on a confirmed subscriber with events, a suppression and messages → no row of that subscriber (subscriber, events, messages, suppressions) contains the original email, IP, user agent or source URL (asserted by scanning the rows); subscriber `email` = `erased+<hash>@erased.invalid`, status `unsubscribed`; a suppression row `reason 'erased'` exists; exactly one new `erased` event with `ip`/`user_agent` null and no email in `details`; a direct `UPDATE`/`DELETE` on the ledger still raises "append-only"; the function has `proconfig` with `search_path=`; re-signup of the same address (any casing) → `pending`, needs confirmation, `signup` event `details.erasedBefore = true`, tombstone suppression count unchanged. `POST /api/admin/subscribers/:id/erase` `{ confirmEmail }` with a wrong address → 400 `VALIDATION_FAILED`, nothing changes; with the right one → `{ erased: true }`, `removeSubscriber` called once (stub: skipped) and `newsletter.erase` logged.
- [ ] Integration (fix pass, token redaction): after a signup the stored `confirmation` message HTML and text contain `/newsletter/confirm?t=[redacted]` and never the token, while the captured transport message / stub log line carries the real link and it confirms; migration `0004` on a database with a pre-existing confirmation row redacts it.
- [ ] Integration (fix pass, privacy/address): `GET /privacy` → 200 in site chrome with the `privacyText`; the footer consent text and the issue footer link to `/privacy`; with `newsletterPostalAddress` set the issue footer and confirmation email contain it, empty → neither does; `PATCH /api/admin/site` accepts both fields.
- [ ] Unit: `signUnsubscribeToken(id, secret)` round-trips through `verifyUnsubscribeToken`; a one-character change fails; `hashConfirmToken` is deterministic and never equals its input; the confirmation templates (HTML + text) contain the confirm URL, the expiry note, the consent line and the brand.
- [ ] Integration (real Listmonk container; `PENDING DOCKER` when no daemon, never faked), with `BLOG0_NEWSLETTER_SENDER=listmonk`: confirming a subscriber appends `provider_synced` and sets `provider_synced_at`; unsubscribing it appends `provider_removed` and Listmonk shows it `blocklisted`.
- [ ] Integration (real Listmonk container, same rule): a confirmed, synced subscriber whose `blog0` list membership is set `unsubscribed` in Listmonk (not blocklisted) → `pnpm newsletter:sync` leaves the membership `unsubscribed`, appends no `provider_synced`, and reports `suppressedFromProvider 1` — blog0 status `unsubscribed`, one suppression (`reason: 'unsubscribed'`, `source: 'provider'`); (without the sync, `pnpm newsletter:tick` produces the same blog0 state); a following tick adds nothing; a fresh signup + confirm (new `confirmed_at` after the unsubscribe) → the next sync re-adds the membership as `confirmed`.
- [ ] E2E (Chromium, stub transport + stub sender, project `newsletter` after `smoke`): footer signup → "Almost there — check your inbox and confirm." → the confirm URL (from the stub's `newsletter.mail` log line — the stored message row is redacted) opens, the test presses **Confirm my subscription**, and "You’re subscribed" shows → Admin → Subscribers shows the address as **Confirmed** with its audit view (source `/`, consent v1, exactly three events — signup, confirmation sent, confirmed — and no sync entry) → **Export audit (JSON)** downloads a file naming that address → the unsubscribe link from a sent issue (`newsletter-issues.md`) → **Yes, unsubscribe me** → "You’re unsubscribed" → the subscriber shows **Unsubscribed** with one suppression row.
- [ ] Designer E2E (`pnpm test:e2e:design`, no `.env`; config forces `BLOG0_SMTP_HOST=''`, `BLOG0_NEWSLETTER_SENDER=stub`): signup → confirm via the `confirm_url` of the stub's `newsletter.mail` line in the server log (+ pressing **Confirm my subscription**) → the admin list shows **Confirmed**; no SMTP, no Listmonk.
