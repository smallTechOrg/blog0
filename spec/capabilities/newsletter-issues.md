# Capability: Newsletter issues (sender adapter + issues)

Phase 7. The list itself is `newsletter-list.md`. HOW (adapter interface, Listmonk REST mapping,
issue rendering, triggers, docker-compose): `spec/architecture.md` §13 and §12.6; tables:
`spec/data.md` → `newsletter_issue`, `newsletter_issue_event`, `site` newsletter columns; HTTP:
`spec/api.md` → newsletter; screens: `spec/ui.md` §4 Newsletter; slices and gate:
`spec/roadmap.md` → Phase 7.

## What It Does
Turns published articles into newsletter issues — automatically per post, as a digest, or by hand —
lets an admin preview, test and send each issue with one explicit click, and hands the actual
delivery to a pluggable sender (Listmonk in production, a recording stub everywhere else) while
blog0 keeps the issue, its send log and its stats.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Newsletter settings | `mode` `per_post` \| `digest` \| `manual`; `autoSend` boolean; `digestDays` 1–60; `digestPosts` 1–20; consent text ≤ 300 + version ≤ 20 | Admin → Site → Newsletter | yes (defaults: `manual`, `false`, 7, 3, the seeded consent line, `v1`) |
| First publish of an article | `publishArticle` hook (first publish only) | `article-authoring.md` | — |
| Manual compose | title ≤ 150, intro Markdown ≤ 5 000, 1–10 published articles in order | Admin → Newsletter → New issue | — |
| Admin actions | preview, send test, send, refresh stats, delete draft | Admin → Newsletter | — |
| Sender configuration | `BLOG0_NEWSLETTER_SENDER` + Listmonk URL / API user / token / list id | env (`spec/architecture.md` §10) | `stub` by default |
| Confirmed subscribers | status `confirmed` only | `newsletter-list.md` | — |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Issue | number, title, intro, post snapshot (title, dek, excerpt, Read / TLDR / Listen links), status `draft` \| `sending` \| `sent` \| `failed`, rendered HTML + text frozen at send | `newsletter_issue` |
| Send log | append-only events: created, updated, test_sent, send_requested, provider_created, provider_started, sent, failed, stats_fetched | `newsletter_issue_event` |
| Stats | recipients, sent, delivered (when known), opens, clicks, bounces, unsubscribes, fetched-at | `newsletter_issue.stats` + Admin → Newsletter |
| Campaign | one provider campaign per sent issue, using blog0's own template | sender adapter |
| Test message | the issue rendered for the signed-in admin, subject prefixed `[Test]` | admin's inbox (SMTP) or `newsletter_message` (stub) |
| Stub deliveries | one `newsletter_message` row per confirmed recipient | stub sender (designer mode, tests, E2E) |
| Subscriber copy at the provider | upsert with consent attributes; blocklist on suppression | Listmonk (`pnpm newsletter:sync` and live syncs) |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Listmonk REST | ensure list + template; upsert / blocklist subscribers; create campaign; start campaign; read campaign stats; read blocklisted + bounced subscribers | the blog0 write is already committed; the issue is marked `failed` with `last_error` (send) or the sync is retried by `pnpm newsletter:sync` / `newsletter:tick`; every call logs `newsletter.provider`; admins see the error inline with **Try again** |
| SMTP (nodemailer) | the test message only (issues are never sent through SMTP by blog0) | 503 `MAIL_NOT_CONFIGURED` only when neither SMTP nor the stub applies (never happens — the stub always applies without SMTP); other failures 502 with the transport message |
| Database | issue rows, events, settings, recipient query | API error envelope; the UI shows it inline with **Retry** |

## Business Rules
- **Never auto-send without the explicit setting.** `autoSend` defaults to `false`; with it false
  every automatic issue (per-post or digest) is created as a **draft** that waits for **Send**.
  Manual issues are never auto-sent. Changing `mode` or `autoSend` never sends anything by
  itself.
- **Modes.** `manual`: nothing is created automatically. `per_post`: every **first** publish of an
  article creates one issue with that post (republishing or unpublishing creates nothing).
  `digest`: a first publish creates an issue when, since the last digest issue (or since the mode
  was set), either `digestPosts` articles were first-published or `digestDays` days have passed
  with ≥ 1 new article — whichever comes first; `pnpm newsletter:tick` applies the day rule
  without waiting for a publish. An article appears in at most one automatic issue.
- **Issue content** is a snapshot taken at creation: title (per post: the article title; digest:
  "<brand> · N new articles"; manual: as typed), intro (per post: the dek; digest: empty; manual:
  the Markdown typed), and per post: title, dek, excerpt (the first ~60 words of the published
  body's first paragraph), absolute links **Read** always, **TLDR** when a deck is published,
  **Listen** when a recording is published, plus a footer with the **Unsubscribe** link and the
  consent line ("You’re getting this because you subscribed at <brand> on <date> and confirmed on
  <date>."). A draft's title, intro and post order/removal can be edited; the post snapshot is
  refreshed from the current published revision on each preview while the issue is a draft and
  frozen at send.
- **Preview** shows the HTML (as the email) and the text alternative; both are what gets sent.
  Unsubscribe link and consent line are rendered for the previewing admin as sample values.
- **Send test to me** sends the issue to the signed-in admin's address with subject `[Test] <title>`
  through the transactional transport; it never touches the provider or the subscriber list and
  never changes the issue status. Allowed in any status.
- **Send** is one click with an inline confirmation naming the recipient count ("Send to 42
  confirmed subscribers?") — then: `draft` → `sending` (event `send_requested`) → provider campaign
  created with the frozen HTML/text (`provider_created`) → started (`provider_started`) → `sent`
  with `sent_at`, `sent_by`, `recipient_count` (event `sent`). Any step failing → `failed` with
  `last_error` (event `failed`); **Try again** repeats from the failed step (a campaign already
  created is reused, never duplicated). An issue left in `sending` for more than 10 minutes (the
  process died mid-send) can be sent again the same way; a `sending` issue younger than that cannot
  (409 `ISSUE_NOT_DRAFT` — no double send from a double click). A `sent` issue cannot be sent again (409 `ISSUE_NOT_DRAFT`);
  0 confirmed subscribers → 409 `NO_RECIPIENTS`; sender not configured → 503 `SENDER_UNAVAILABLE`.
- **Recipients** are exactly the subscribers with status `confirmed` at send time — never
  pending, legacy, unsubscribed or bounced. With Listmonk the list it sends to is kept equal to
  that set by the live syncs plus `pnpm newsletter:sync` (run before the campaign starts);
  blocklisted addresses are skipped by Listmonk itself.
- **Stats** are fetched from the provider on demand (**Refresh stats**) and by
  `pnpm newsletter:tick`; the stub counts its own rows. Stats never change the issue status.
- **Sender adapter** (`spec/architecture.md` §13.3): `syncSubscriber`, `removeSubscriber`,
  `createIssue`, `sendIssue`, `fetchStats`, `fetchSuppressions`, `healthcheck`. `stub` is the
  default and is what designer mode, unit/integration tests and the E2E suite use; `listmonk`
  requires the four `BLOG0_LISTMONK_*` values. Both are exercised by the gate: the stub everywhere,
  Listmonk in `tests/integration/newsletter-listmonk.test.ts` against a real Listmonk container
  (`docker compose`, Colima) — reported `PENDING DOCKER` when no daemon is reachable, never faked.
- **`pnpm newsletter:sync`** pushes blog0 → provider only: ensures the list and the blog0 template
  exist; upserts every `confirmed` subscriber (consent metadata as attributes, pre-confirmed,
  enabled); blocklists every `unsubscribed`/`bounced` one; never creates, enables or deletes
  anything in blog0; idempotent — a second run reports `0 changed`.
- **Author text is never a template.** Before an issue body goes to Listmonk, every literal `{{` /
  `}}` in it (e.g. a code sample in an intro or excerpt) is escaped so Listmonk prints it verbatim;
  only blog0's own unsubscribe / consent expressions are live (`spec/architecture.md` §13.3).
- **Provider errors are email-free.** Every error blog0 stores or shows from the provider
  (`last_error`, sync `errors[].message`, logs) omits subscriber addresses and credentials.
- **Provider → blog0** happens only as suppressions: `fetchSuppressions` (in `newsletter:tick`)
  and the webhook `POST /api/newsletter/webhook` (shared secret) turn provider blocklists/bounces
  into blog0 suppressions + events (`newsletter-list.md`). Nothing else flows back.
- **Site settings** gain a **Newsletter** section: mode, auto-send, digest thresholds, consent
  text + version (changing the text bumps the version automatically unless typed), plus a
  read-only status card: sender kind, Listmonk list name, SMTP configured or stub, confirmed /
  pending / legacy counts, last sync.
- Out of scope: A/B tests, scheduling for a future time, per-subscriber personalisation beyond
  the consent line, open/click tracking inside blog0 (stats come from the provider), templates
  editable in the admin, multiple lists, Listmonk's own double opt-in (blog0 does it).

> **Assumed:** digest defaults every 7 days or 3 posts, whichever first; the day rule is evaluated
> on publish and by `pnpm newsletter:tick` (the runbook schedules it hourly) — blog0 runs no
> in-process timer, so a container restart can never fire a send.
> **Assumed:** Listmonk ≥ v4 with an **API user** (token auth), one list named `blog0` (id from
> `BLOG0_LISTMONK_LIST_ID`) and a blog0-managed template `blog0-issue` whose body is exactly
> `{{ template "content" . }}` + `{{ TrackView }}` so Listmonk adds no chrome; the unsubscribe link and consent line
> inside the HTML are Listmonk template expressions over subscriber attributes
> (`{{ .Subscriber.Attribs.blog0_unsubscribe_url }}`, `{{ .Subscriber.Attribs.blog0_consent_line }}`)
> that blog0 sets on every sync, so every unsubscribe lands in blog0 first.
> **Assumed (owner, tracking):** open + click tracking via Listmonk, aggregate only (Listmonk's
> individual tracking stays off): the campaign body sent to Listmonk wraps every absolute http(s)
> content link as `{{ TrackLink "<url>" }}` and the `blog0-issue` template ends with
> `{{ TrackView }}` (an existing template with another body is updated on the next send). The
> unsubscribe and privacy links, `mailto:`, List-Unsubscribe headers and the plain-text part are
> never tracked; the stored / previewed issue and the stub sender stay untracked. Views / clicks reach
> the issue page via `fetchStats` (**Refresh stats** and `newsletter:tick`). Opens don't register
> while Listmonk's root URL isn't publicly reachable (e.g. `localhost`): mail clients fetch images
> through their own proxies.
> **Assumed:** issues go only through the sender adapter — blog0 never bulk-sends via SMTP
> (deliverability, rate limits and bounce handling are the provider's job); the stub sender exists
> so the whole admin flow is real without a provider.
> **Assumed:** the issue email is a single-column, inline-styled HTML table (max-width 600 px,
> system/serif stacks, dark-mode-safe colours from the design tokens) with a plain-text alternative
> generated from the issue model, not from the HTML.
> **Assumed:** the excerpt is the first paragraph's first 60 words with an ellipsis; a post with an
> empty body renders the dek only.
> **Assumed:** stats shape across providers is `{ recipients, sent, delivered: number | null, opens, clicks, bounces, unsubscribes, fetchedAt }` — fields the provider does not report are `null`.
> **Assumed (S7.2, verified against Listmonk v5.1.0):** the admin user cannot use Basic/token auth
> (`invalid API credentials`); `scripts/listmonk-dev.sh` logs in through the session form
> (`GET /admin/login` nonce → `POST /admin/login`) and creates the API user with
> `POST /api/users { username: 'blog0', type: 'api', user_role_id: <"Super Admin" from /api/roles/users>, status: 'enabled' }`
> — the token is returned once in `data.password`; a lost `var/listmonk-dev.env` re-creates the user.
> `/api/health` requires auth in v5, so the compose healthcheck probes `/admin/login`.
> `postgres:18` keeps its data at `/var/lib/postgresql/18/docker`, so the compose volume mounts
> `/var/lib/postgresql` (not `…/data`). The adapter looks a subscriber up by email **before** the
> write (one `GET`, then `POST` or compare + `PUT`) instead of `POST` → 409 → `GET` → `PUT`: same
> outcome, no 409 noise; re-enabling a blocklisted subscriber also re-adds the list membership
> (`PUT /api/subscribers/lists { action: 'add', status: 'confirmed' }`) because Listmonk leaves it
> `unsubscribed`. `sendIssue` reads the campaign first (Listmonk answers 400 when starting a
> running campaign); unknown campaign/list ids answer 400, not 404. The §13.4 placeholders
> (`%%BLOG0_UNSUBSCRIBE_URL%%`, `%%BLOG0_CONSENT_LINE%%`) are defined in `sender/types.ts` so the
> adapter and the renderer (S7.3) share one definition. `docker compose` falls back to the
> standalone `docker-compose` binary when the plugin is absent (this host).
> **Assumed (S7.3):** on a publish the digest applies only the **posts** rule; the **days** rule fires
> only from `pnpm newsletter:tick` (this is what the digest success criterion requires — "a third
> publish 8 days later creates nothing until the tick"). A digest takes at most 10 posts (the issue
> limit), oldest first; any further qualifying posts wait for the next digest. The digest anchor is the
> newest digest issue's `created_at`, else `newsletter_mode_set_at`.
> **Assumed (S7.3):** the sync (`syncAll`, and the live `afterConfirm` / `afterSuppress` hooks) skips
> every row with the **stub** sender, so designer mode writes no `provider_synced` events (the
> "Synced" timeline entry of the user walk appears with Listmonk only). Counting: `synced` / `blocklisted`
> = rows the provider changed for, `skipped` = pending / legacy rows, rows already equal at the provider
> count nowhere. The full sync blocklists suppressed addresses through `syncSubscriber({ status:
> 'blocklisted' })`, which also creates a blocklisted entry for an address Listmonk never had (so an
> import there can never mail it) — hence `blocklisted 1` on the first run; the live hook uses
> `removeSubscriber`.
> **Assumed (S7.3):** `SENDER_UNAVAILABLE` (listmonk `healthcheck` failing within 3 s) is answered
> before the send transaction, so the issue is left untouched (still `draft` / `failed`); a failure in
> a later step marks it `failed`. Auto-send with 0 confirmed subscribers leaves the draft waiting
> (logged `outcome: 'skipped'`).
> **Assumed (S7.3):** the stub sender writes its `newsletter_message` rows when built with
> `{ recordToDb: true }` — what `getNewsletterSender()` builds; a bare `new StubNewsletterSender()`
> keeps the in-memory behaviour its unit test pins. Its delivery reads the frozen bodies from the
> issue row, so a retry after a restart still works.
> **Assumed (S7.3):** deleting a draft that already had a test message keeps the `test_issue` row (an
> audit of what was mailed) with `issue_id` cleared — the FK is `on delete restrict`. The `deleted`
> event kind is never stored (the draft's events cascade); the deletion is logged instead.
> **Assumed (S7.3):** a manual post list of 0 or > 10 articles answers 422 `ISSUE_POSTS_INVALID`
> (the routes relax the shared zod count so the service decides); malformed ids / unknown keys stay
> 400 `VALIDATION_FAILED`.
> **Assumed (S7.3):** preview and test messages fill the placeholders with the admin's own subscriber
> link + consent line when the admin's address is a confirmed subscriber, else a sample link
> (`/newsletter/unsubscribe?t=sample`) and a consent line dated today. The excerpt uses the first prose
> paragraph (`kind 'p'`), falling back to the first paragraph of any kind.
> **Assumed (S7.3):** `newsletter:tick` reads provider suppressions from the last 30 days on every run
> (idempotent — already-suppressed addresses are skipped) and applies one only when it is newer than
> the subscriber's latest consent / confirmation, so an old provider blocklist never undoes a
> re-subscription.
> **Assumed (fix — provider-side opt-out wins):** an unsubscribe on Listmonk's side that does not
> blocklist (List-Unsubscribe header / Listmonk's unsubscribe page → the list subscription turns
> `unsubscribed`, the subscriber stays `enabled`) is an opt-out too. `fetchSuppressions` also returns
> those for the configured list (`GET /api/subscribers?list_id=…&subscription_status=unsubscribed`,
> dated by `subscription_updated_at`; verified on v5.1.0), and `newsletter:tick` applies them under the
> rule above (`suppressByEmail`, source `provider`, reason `unsubscribed`). `syncSubscriber` never
> re-enables or re-adds over a provider opt-out (blocklist or list-level unsubscribe) newer than blog0's
> latest consent / confirmation: it writes nothing and hands the opt-out back; the sync records it in
> blog0 the same way and counts the row as `suppressedFromProvider` (new field of the sync response /
> `pnpm newsletter:sync` line, `suppressed_from_provider` in the `newsletter.sync` log; not part of
> `changed`). A blog0 confirmation newer than the opt-out (fresh double opt-in) re-adds as before.
> Equal timestamps → the opt-out wins (an opt-out anywhere wins); an unparseable provider timestamp → the opt-out wins.
> Blocklists blog0 makes itself (suppressed rows, `removeSubscriber`) are one `PUT /api/subscribers/:id`
> with `status: 'blocklisted'` and the attribute `blog0_blocklisted_at`; memberships are passed through
> untouched (a new blocklisted copy gets no membership at all). Such a blocklist mirrors blog0's own
> suppression, so it is neither pulled back by `fetchSuppressions` nor treated as a provider opt-out —
> blog0's later re-confirmation re-enables it without comparing the two hosts' clocks.
> **Assumed (Phase 7 drift review):** the stuck-send threshold is 10 min (`SENDING_STALE_MS`),
> measured from the issue's `updated_at` — far above a normal send (< 2 min, the route's
> `maxDuration`), so a live send is never doubled; Listmonk's `sendIssue` is idempotent for a running
> campaign, so a retry of a send that actually reached the provider only re-reads it. Template
> escaping uses Go template string literals (`{{ "{{" }}`), which Listmonk v5 renders verbatim.
> **Assumed (fix):** the campaign `subject` is escaped the same way as body / altbody (Listmonk
> compiles it as a template too); the campaign `name` is not templated and stays raw.
> `IssueDetailDto` gains `stuckSending: boolean` (`sending` and `updated_at` older than
> `SENDING_STALE_MS`) so the issue page can stop polling and show the failure card "Couldn’t send:
> the send has been stuck in Sending for over 10 minutes (the request was interrupted)" + **Try
> again**; the retry's `send_requested` event carries `retry: true, stuckSince`.
> **Assumed (fix):** every Listmonk adapter error message and `newsletter.provider` line names the
> request path without its query string, and address-shaped text in a provider message (plain or
> `%40`-encoded) is replaced by `[email]` — those messages reach logs, `last_error` and stderr.
> **Assumed (fix):** a stale webhook (parseable `occurredAt` older than the latest consent /
> confirmation) answers `{ accepted: true }`, writes nothing and logs `newsletter.sync` with
> `outcome: 'stale'`; the decision is re-made under the row lock. The webhook's log line carries the
> provider event as `webhook_event` (an `event` field overwrote the log line's own name).

## Success Criteria
- [ ] Integration: with settings `per_post` + `autoSend false`, publishing a new article creates one `draft` issue whose single post snapshot has the article's title, dek, an excerpt, `readUrl` = `<BLOG0_PUBLIC_BASE_URL>/p/<slug>`, `tldrUrl` null; publishing a change to the same article creates no second issue; unpublishing creates nothing.
- [ ] Integration: `digest` with `digestPosts 2`, `digestDays 7`: the first publish creates nothing; the second creates one `draft` issue with both posts; a third publish 8 days later (injected `now`) creates nothing until `pnpm newsletter:tick` (same `now`) creates an issue with that one post.
- [ ] Integration: `manual` mode: two publishes create no issue; `POST /api/admin/newsletter/issues { title, introMd, articleIds: [a, b] }` → 201 draft with posts in that order; `PATCH` reorders and removes one; `DELETE` of a draft → 200; `DELETE` of a sent issue → 409 `ISSUE_NOT_DRAFT`.
- [ ] Integration: `GET /api/admin/newsletter/issues/:id/preview` returns `html` containing each post title, `Read`, the brand, an unsubscribe link and the consent line, and `text` containing the same titles and URLs without tags; a post with a published deck shows a `TLDR` link to `/p/<slug>/tldr`.
- [ ] Integration (stub sender, stub transport): `POST …/test` writes one `newsletter_message` (`kind: 'test_issue'`, to the admin's email, subject `[Test] …`) and the issue stays `draft`; `POST …/send { confirm: true }` with 3 confirmed + 1 pending + 1 legacy + 1 unsubscribed subscribers → `sent`, `recipient_count 3`, exactly 3 `newsletter_message` rows (`kind: 'issue'`) for the confirmed addresses, each HTML containing that subscriber's own unsubscribe link; events in order `send_requested, provider_created, provider_started, sent`; a second send → 409 `ISSUE_NOT_DRAFT`; with 0 confirmed → 409 `NO_RECIPIENTS` and the issue stays `draft`.
- [ ] Integration: with `autoSend true` + `per_post`, a first publish creates **and sends** the issue (status `sent`, stub rows written); with `autoSend false` the same publish leaves it `draft` and writes no message.
- [ ] Integration: a sender whose `createIssue` throws (injected failing adapter) → issue `failed` with `last_error`, event `failed`; retrying with a working adapter → `sent`, and a `providerCampaignId` set before the failure is reused (no second `createIssue` call).
- [ ] Integration (real Listmonk container, `tests/integration/newsletter-listmonk.test.ts`; skips `PENDING DOCKER` when `docker info` fails): `healthcheck` ok; `syncSubscriber` twice for one address → one Listmonk subscriber with `attribs.blog0_subscriber_id`, `consent_version`, `blog0_unsubscribe_url`, status `enabled`, in the list, and the second call reports `changed: false`; `removeSubscriber` → Listmonk status `blocklisted`; a re-sync after re-confirmation → `enabled` again; `createIssue` + `sendIssue` → a campaign in status `running` or `finished` within 60 s whose body contains the issue title; `fetchStats` returns numbers; `fetchSuppressions(since)` lists the blocklisted address with `reason: 'unsubscribed'`.
- [ ] Integration: `pnpm newsletter:sync` against the Listmonk container with 2 confirmed, 1 pending, 1 unsubscribed → prints `synced 2, blocklisted 1, skipped 1`; second run prints `synced 0, blocklisted 0, skipped 1, 0 changed`; no blog0 row changed (checksum of the table before/after equal).
- [ ] Integration: `POST /api/newsletter/webhook` with the right secret and `{ event: 'bounce', email, reason }` → subscriber `bounced` + suppression (`source: 'webhook'`); wrong secret → 401; unknown email → 200 `{ accepted: false }` and no rows.
- [ ] Integration (stuck send): an issue forced to `sending` with `updated_at` = now − 5 min → `POST …/send` → 409 `ISSUE_NOT_DRAFT`, unchanged; with `updated_at` = now − 11 min → `sent`, an existing `provider_campaign_id` reused (no second `createIssue`).
- [ ] Unit (Listmonk body escaping): the body handed to `POST /api/campaigns` for an issue whose intro contains `{{ .Subscriber.Email }}` and `a }} b` carries them as `{{ "{{" }} .Subscriber.Email {{ "}}" }}` and `a {{ "}}" }} b`, while the two blog0 placeholders become exactly `{{ .Subscriber.Attribs.blog0_unsubscribe_url }}` / `{{ .Subscriber.Attribs.blog0_consent_line }}` (unescaped); against the real container (same `PENDING DOCKER` rule) the campaign preview shows the literal `{{ .Subscriber.Email }}` text.
- [ ] Unit (provider error hygiene): a Listmonk adapter fed a 409/500 response whose body echoes `reader@example.test`, and a lookup URL with `?query=subscribers.email='reader@example.test'`, throws a `SenderError` whose message — and every captured `newsletter.provider` line (`path` without query string) — contains no `@`-address and no API token.
- [ ] Unit (`tests/unit/newsletter/opt-out.test.ts`): `providerOptOutWins` — opt-out newer than, equal to, and older than `greatest(consentedAt, confirmedAt)` → true, true, false; unparseable opt-out date → true; neither consent timestamp → true.
- [ ] Unit: the digest rule (`dueDigest(settings, lastDigestAt, newPostCount, now)`, in `tests/unit/newsletter/triggers.test.ts`) over the four cases (posts reached, days reached, neither, no new posts); the text renderer output for a 2-post issue equals the committed fixture; `settingsSchema` rejects `digestDays 0`, `digestPosts 21`, mode `weekly`.
- [ ] E2E (continuation of the `newsletter-list.md` walk): Site → Newsletter: mode **Per post**, auto-send off, Save → publish a new article → Admin → Newsletter lists one **Draft** issue titled like the article → open it → **Preview** shows the HTML with the title and a Read link, **Text** tab shows the URL → **Send test to me** → "Test sent to <email>" → **Send** → confirm "Send to 1 confirmed subscriber?" → status **Sent · 1 recipient**, the send log shows four entries, **Stats** shows `sent 1`; the server log has `newsletter.issue … outcome: 'sent'`; the stub message for the subscriber contains the unsubscribe link used by the list walk.
