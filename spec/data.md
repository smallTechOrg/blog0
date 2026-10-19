# blog0 — Data model

PostgreSQL 18 in production and in every gate; the identical schema also runs on embedded PGlite
(PG 17 WASM) in designer mode (`spec/architecture.md` §11). All v0.1 tables are created by
migration `0000_init`; Phase 5 adds `0001_rate_limit_bucket` (slice S5.3); Phase 7 adds
`0002_newsletter` (slice S7.1: new `newsletter_*` tables, new `newsletter_subscriber` columns and
status set, `site` newsletter settings columns, the legacy status backfill) and
`0003_newsletter_prune_fix` (Phase 7 fix, hand-written SQL, no table change: drops
`newsletter_prune_event_ips(uuid)` and creates `newsletter_prune_event_ips(p_subscriber_id uuid,
p_before timestamptz) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path =
public, pg_temp`, which nulls `ip` only on that subscriber's events with `created_at < p_before`
— prune rule in `spec/architecture.md` §13.1); Phase 6 adds its own (Phase 4 needs none). After
Phase 7, `pnpm db:verify` reports `4 applied (latest 0003_newsletter_prune_fix)`.
> **Assumed (fix pass, post-freeze):** `0004_newsletter_erasure` (hand-written SQL + Drizzle
> schema for the new columns) makes it `5 applied (latest 0004_newsletter_erasure)`; it:
> (1) adds `site.privacy_text text not null default '<seeded plain-language draft>'`,
> `site.newsletter_postal_address text not null default ''` and `site.newsletter_erase_salt text not
> null default encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text,
> 'UTF8')), 'hex')` (volatile default → each existing row gets its own random salt; never exposed
> by any DTO); (2) widens the checks: event `kind` += `erased`, suppression `reason` += `erased`;
> (3) adds suppression column `email_hash text null` (+ index `(site_id, email_hash)`); (4) creates
> `newsletter_erase_subscriber(p_subscriber_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY
> DEFINER SET search_path = public, pg_temp` — same pattern as `0003`: under `blog0.newsletter_erase
> = '1'` (set local, so the ledger guard lets it through, only for these columns) it redacts
> `email`, `ip`, `user_agent` (and `details` of the subscriber's events to `'{}'`) in
> `newsletter_subscriber_event`; `email` (to the tombstone) and `email_hash` in
> `newsletter_suppression`; `to_email` → tombstone, `subject`/`html`/`text` → `'[erased]'` in
> `newsletter_message`; on `newsletter_subscriber`: `email` → tombstone, `name`, `signup_ip`,
> `signup_user_agent`, `signup_source_url`, `confirmed_ip`, `confirmed_user_agent`,
> `confirm_token_hash`, `confirm_token_expires_at`, `provider_id` → null, status
> `unsubscribed`; inserts one suppression row (`reason 'erased'`, `source 'admin'`, `email_hash`)
> and appends one `erased` event (`email` = tombstone, no ip/UA, `details {}`). Tombstone =
> `erased+<hash>@erased.invalid`, `hash = encode(sha256(convert_to(salt || ':' || normalizedEmail,
> 'UTF8')), 'hex')`, `salt = site.newsletter_erase_salt`; the app computes the same hash for
> signup matching (`normalizedEmail` = trimmed lower-case), so a re-signup is detected without the
> address ever being stored. Because the tombstone email is a different value, the unique
> `(site_id, email)` slot of the real address is free: a re-signup creates a **new** subscriber
> row whose first `signup` event carries `details.erasedBefore = true`, and the erased row and its
> suppression stay. Returns false when the row is already erased; works on PG 18 and PGlite (plain
> SQL, no extensions). (5) Redacts the token in existing `newsletter_message` rows of kind
> `confirmation` (`regexp_replace(html|text, '(/newsletter/confirm\?t=)[^"&\s<]+', '\1[redacted]',
> 'g')`); new rows are redacted by the app before insert. The salt is per site so rotating any
> secret never breaks erasure matching; losing it (a restore from before `0004`) would — it is
> inside every backup.
> **Owner decision 2026-10-19 — `0005_newsletter_erase_delete`** (Drizzle-generated DDL + hand-written
> SQL; `6 applied (latest 0005_newsletter_erase_delete)`): erasing personal data **deletes** the
> subscriber; the 0004 tombstone is retired (its deterministic address collided on
> `newsletter_subscriber_site_email_unique` when an erased address re-subscribed and was erased again
> → 23505 → a 500). It adds `newsletter_erasure_marker (site_id, email_hash, created_at; pk (site_id,
> email_hash))` — the keyed hash above, "never email this address", the only trace an address leaves;
> `newsletter_erasure_log (id, site_id, email_hash → marker, source 'admin'|'migration', erased_by →
> app_user null, details jsonb {subscribers, events, messages, suppressions}, provider_outcome
> 'pending'|'deleted'|'not_found'|'kept'|'skipped'|'failed', provider_ref text null (the Listmonk
> id, never the address), provider_checked_at, erased_at)` — PII-free proof that a request was
> honoured; both insert-only by trigger (`newsletter_erasure_guard`; only the log's provider columns
> may change) — and `newsletter_issue.erased_message_count int not null default 0`. The ledger guard
> loses the 0004 redaction exceptions and gains one: a DELETE of an event / suppression row whose
> `subscriber_id` is listed in `blog0.newsletter_erase_ids` (set LOCAL by the function). The function
> becomes `newsletter_erase_subscriber(p_subscriber_id uuid, p_erased_by uuid default null, p_source
> text default 'admin') RETURNS jsonb` (SECURITY DEFINER, pinned search_path): ensures the marker
> (idempotent); collects every subscriber row of the person on the site (the id, the same normalized
> address, a 0004 tombstone of the same hash); adds their `kind 'issue'` messages to the issues'
> `erased_message_count`; deletes their messages (and any addressed to them), events, suppressions
> (and any addressed to them) and the rows; writes one audit row; returns `{ erased: true, erasureId,
> subscribers, events, messages, suppressions }` or `{ erased: false }` for an unknown id. A BEFORE
> INSERT trigger on `newsletter_subscriber` (`newsletter_subscriber_erased_guard`) refuses a marked
> address in any status but `pending`, so only a fresh double opt-in signup brings it back. Repair: every
> existing tombstone row is run through the function with `source 'migration'` (marker kept, audit
> row dated by its `erased` event, provider `skipped`). Works identically on PG 18 and PGlite.
> Conventions:
snake_case, singular table names, `id uuid primary key default gen_random_uuid()`, timestamps
`timestamptz not null default now()`, every table has `site_id uuid not null references site(id)`
(except `site` itself) and every query filters by it. Foreign keys `on delete cascade` from child
to article unless stated.

The whole v0.1 schema was created up front so parallel slices never race on migration files;
columns for Phase 4 features (sign-off, corrections, restore) exist and stay unused until then.

## Entities

### site
One row per tenant; v0.1 has one (`slug = BLOG0_SITE_SLUG`, default `blog0`).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| slug | text unique not null | `blog0` |
| brand_name | text not null | `blog0` |
| wordmark | text not null | public wordmark, `blog0` (last char — the nought — spins; user decision: brand is blog0, not the design's log0) |
| publisher_name | text not null | `smallTech` |
| tagline | text not null | `the meaning of life, universe, and everything` |
| contact_email | text not null | `hello@logzero.blog` (design value; divergence #13) |
| about_strap | text not null | `Less noise. More signal.` |
| about_stand | text not null | `A publication from smallTech on the parts of applied AI that are hard to measure and easy to oversell.` |
| about_body_md | text not null | design `ABOUT_BODY_FULL`, paragraphs separated by blank lines |
| social_x_url | text null | footer icon hidden when null |
| social_linkedin_url | text null | footer icon hidden when null |
| timezone | text not null default `Asia/Kolkata` | public date formatting. > **Assumed:** smallTech is India-based (smalltech.in). |
| newsletter_mode | text not null default `manual` | Phase 7 (`0002_newsletter`): check in (`per_post`,`digest`,`manual`) — `spec/capabilities/newsletter-issues.md` |
| newsletter_auto_send | boolean not null default false | Phase 7: automatic issues are sent without a click only when true |
| newsletter_digest_days | integer not null default 7 | Phase 7: check 1–60 |
| newsletter_digest_posts | integer not null default 3 | Phase 7: check 1–20 |
| newsletter_consent_text | text not null default `One issue a week at most. Unsubscribe in one click; we never share the list.` | Phase 7: the line shown under the footer form and copied onto every signup (≤ 300) |
| newsletter_consent_version | text not null default `v1` | Phase 7: ≤ 20; bumped when the text changes |
| newsletter_mode_set_at | timestamptz null | Phase 7: when `newsletter_mode` last changed — the digest window's start when no digest issue exists yet |
| privacy_text | text not null | fix pass (`0004`): body of `/privacy`, seeded draft — **the owner must review it (draft, not legal advice)**; editable in Admin → Site |
| newsletter_postal_address | text not null default `''` | fix pass (`0004`): printed in the issue footer and confirmation email when non-empty |
| newsletter_erase_salt | text not null | fix pass (`0004`): random per-site salt for the erasure hash (`0005`: the marker key); never in a DTO |
| created_at, updated_at | timestamptz | |

### app_user
Admins/writers. No roles in v0.1 — every user is an admin.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| email | text not null | stored lower-cased; unique (site_id, email) |
| display_name | text not null | default byline |
| password_hash | text not null | argon2id PHC string |
| last_login_at | timestamptz null | |
| disabled_at | timestamptz null | disabled users cannot sign in (Phase 4 UI) |
| created_at, updated_at | timestamptz | |

### session
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| user_id | uuid fk → app_user on delete cascade | |
| token_hash | text unique not null | HMAC-SHA256(secret, token) hex |
| created_at, last_seen_at, expires_at | timestamptz | expires 30 days, sliding |
| user_agent | text null | truncated to 200 chars |
| ip | text null | |

### article
The stable identity of a piece; content lives in revisions.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| slug | text not null | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 80; unique (site_id, slug); locked once `first_published_at` is set |
| slug_is_custom | boolean not null default false | true once a writer edits the slug; while false and never published, title changes re-derive the slug |
| status | text not null default `draft` | check in (`draft`,`submitted`,`approved`,`published`) |
| topic | text not null default '' | e.g. Perspectives, Op-Ed, Educational, Analysis; required to publish |
| byline_name | text not null | defaults to creator's display_name |
| created_by | uuid fk → app_user | |
| current_revision_id | uuid null fk → article_revision on delete set null | latest saved revision |
| published_revision_id | uuid null fk → article_revision on delete set null | what readers see |
| is_featured | boolean not null default false | home Featured stack |
| featured_rank | integer null | ascending; ties by first_published_at desc |
| in_progress | boolean not null default false | public "Draft — in progress" badge on a published piece |
| first_published_at | timestamptz null | public "Published" date |
| last_published_at | timestamptz null | |
| content_updated_at | timestamptz null | set when a publish changes the published body fingerprint after first publish — public "Updated" date (Phase 4) |
| submitted_at, approved_at | timestamptz null | sign-off (modelled; UI Frozen — not scheduled) |
| submitted_by, approved_by | uuid null fk → app_user | |
| corrections_note_md | text null | Phase 4 |
| corrections_updated_at | timestamptz null | Phase 4 |
| created_at, updated_at | timestamptz | |

Indexes: (site_id, status, first_published_at desc); (site_id, is_featured, featured_rank).

### article_revision
Every save that changes title, dek or body creates one (immutable).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| article_id | uuid fk → article on delete cascade | |
| number | integer not null | 1-based; unique (article_id, number) |
| title | text not null | ≤ 200 chars |
| dek | text not null default '' | excerpt/standfirst ≤ 400 chars |
| body_md | text not null | ≤ 200 000 chars |
| body_fingerprint | text not null | see architecture §4 |
| paragraphs_fingerprint | text not null | |
| sentences_fingerprint | text not null | |
| word_count | integer not null | |
| eligible_sentence_count | integer not null | |
| created_by | uuid fk → app_user | |
| restored_from_revision_id | uuid null fk → article_revision | set by restore — revision history (deferred); always null today |
| created_at | timestamptz | |

### article_format
One row per (article, kind) once that format has any draft or published content. `kind` is free
text validated against `src/lib/formats/registry.ts` (extensible without migration).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| article_id | uuid fk → article on delete cascade | |
| kind | text not null | `tldr`, `listen` (Read is implied by the revision; no row needed) |
| draft_payload | jsonb null | writer's working copy |
| draft_revision_id | uuid null fk → article_revision | revision the draft was built against |
| draft_fingerprint | text null | sentences fp (tldr) at draft time / for listen the **baseline** paragraphs fp = `draft_payload.uploadFingerprint ?? draft_payload.syncFingerprint` (null for legacy rows that had neither) so the generic chip query reads one column; `PUT …/listen` never changes it |
| draft_updated_by | uuid null fk → app_user | |
| draft_updated_at | timestamptz null | |
| published_payload | jsonb null | what readers get |
| published_revision_id | uuid null fk → article_revision | |
| published_fingerprint | text null | |
| published_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

Unique (article_id, kind).

Payload shapes (validated with zod on write and read):

```ts
// kind = 'tldr'
interface TldrPayload {
  slides: Array<{ sid: string; text: string; source: 'jev' | 'writer' }>; // 1..12, text verbatim from the revision's sentence
  generationId: string | null;   // ai_generation that produced the Jev picks this deck started from
}
// Phase 8: slides no longer carry `reason`; relevance scores are NOT copied into the payload —
// they live only in ai_generation.output.scores. Legacy payloads (slides with `reason: string | null`)
// parse unchanged: zod strips the unknown key. No migration.
// kind = 'listen' — src/server/formats/payload.ts `listenPayloadSchema`
interface ListenPayload {
  audio: {
    assetId: string;                 // media_asset.id (kind 'audio')
    key: string;                     // media_asset.storage_key, copied so the payload is self-describing (served as '/media/' + key)
    mimeType: 'audio/mpeg' | 'audio/mp4';
    bytes: number;
    durationMs: number;              // integer, from the probe
  };
  marks: Array<{ pid: string; tMs: number }>;   // STORED marks — written only by PUT …/listen (Phase 6 aligner; legacy data);
                                                // [] normally (cleared on every upload); when set: exactly one per paragraph of the
                                                // revision they were saved against, document order, integer ≥ 0, strictly increasing, < audio.durationMs
  syncFingerprint: string | null;  // paragraphs fingerprint of the revision the stored marks were saved against; null while marks = []
  uploadFingerprint: string | null; // paragraphs fingerprint of the current revision at upload time — the text the recording is
                                    // assumed to read; drives the `text_changed` warning. zod: optional, default null
                                    // (legacy rows read as null → baseline falls back to syncFingerprint)
}
```

A `listen` row exists from the first upload. `draft_payload` null (after Remove audio) = no draft.
`draft_revision_id` = the revision of the last upload or PUT. Reader marks are **never stored**:
they are resolved per request from the published payload's stored `marks`, the published
revision's paragraphs and `audio.durationMs` (`resolveMarks` — `spec/capabilities/listen-sync.md`),
so the payload needs no change when the text changes. `published_payload` has the same shape and
is a copy of the draft at publish time (any status). `published_fingerprint` mirrors the
published payload's baseline (`uploadFingerprint ?? syncFingerprint`). Phase 6 writes aligned
paragraph marks into `marks` via the existing PUT and may add optional `sentenceMarks` beside
them without a migration (jsonb payload; zod defaults).

### ai_generation
The AI cost ledger and audit trail (one row per explicit Generate click that reaches the model
step; guard failures that make no call create no row).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| article_id | uuid fk → article on delete cascade | |
| revision_id | uuid fk → article_revision | |
| format_kind | text not null | `tldr` |
| task | text not null | `tldr.rank` (Phase 8); legacy rows `tldr.select`. No code filters on it (queries use `format_kind`) |
| status | text not null | check in (`running`,`succeeded`,`failed`) |
| requested_by | uuid fk → app_user | |
| started_at | timestamptz not null default `now()` | |
| finished_at | timestamptz null | |
| model | text not null | slug used |
| prompt_version | text not null | `jev-rank-v1` (Phase 8); legacy `jev-select-v1` |
| input_fingerprint | text not null | revision sentences fingerprint |
| sentence_count | integer not null | N (= number of sentences scored) |
| bound_min, bound_max | integer not null | |
| attempts | integer not null default 0 | Phase 8: decisions requests sent (= batches; 1 for normal articles). Legacy: model calls (≤ 2) |
| prompt_tokens, completion_tokens, total_tokens | integer null | Phase 8: `usage.input_tokens` / `usage.output_tokens` / their sum, summed over batches |
| cost_usd | numeric(12,6) null | `usage.cost` summed over batches; null when the provider omitted cost on every request |
| latency_ms | integer null | |
| provider_generation_ids | text[] not null default '{}' | response `id` per request |
| output | jsonb null | Phase 8 success: `{ scores: Array<{ index: number, sid: string, relevance: number }>, selected: string[], k: number, batches: number }` — `scores` = every eligible sentence in document order, `relevance` = Jev's `noul` in [0,1] as returned; `selected` = the k top-ranked sids in document order. Failure with a response: `{ rawOutputs: string[] }` (raw response bodies, each ≤ 50 000 chars). Legacy success: `{ picks: [{ index, sid, reason }] }` — read as "no scores" |
| error_code, error_message | text null | |
| created_at | timestamptz | |

Index (site_id, started_at desc); (article_id, started_at desc).

**Where relevance scores live (Phase 8).** Only in `ai_generation.output.scores` of a succeeded
`tldr` row. The editor reads the article's latest succeeded row and matches by `sid`
(`spec/architecture.md` §3 "Relevance in the editor"). No column, table or migration is added:
scores are written once per generation and read only by the editor, so jsonb on the row that
produced them is the one place. > **Assumed:** no migration in Phase 8 — every change is jsonb
content or column semantics, and legacy rows/payloads stay readable as they are.

### newsletter_subscriber
The owned list (`spec/capabilities/newsletter-list.md`). Phase 2 created it with `status in
('subscribed','unsubscribed')`; migration `0002_newsletter` widens it as below and backfills
`subscribed` → `legacy_unconfirmed` (existing `unsubscribed` rows keep their status and get one
`newsletter_suppression` row with `source = 'migration'` plus one `unsubscribed` event).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| email | text not null | lower-cased, trimmed; unique (site_id, email) |
| name | text null | ≤ 120 chars |
| status | text not null default `pending` | check in (`pending`,`confirmed`,`unsubscribed`,`bounced`,`legacy_unconfirmed`) — the **current** state; history is in the event table |
| source | text not null default `footer` | `footer` \| `legacy` \| `admin` |
| signup_source_url | text null | relative path the form was on (≤ 500) |
| signup_ip | text null | real client address only (§6 derivation), else null; nulled by the 12-month prune (bar = `coalesce(greatest(confirmed_at, consented_at), created_at)`, `spec/architecture.md` §13.1) |
| signup_user_agent | text null | ≤ 300 chars |
| consent_text | text null | the consent line exactly as shown at (re)signup; null for legacy rows until they confirm via a new signup |
| consent_version | text null | |
| consented_at | timestamptz null | = the (re)signup time that produced the current consent |
| confirm_token_hash | text null | sha256 hex of the one-time token; unique partial index where not null; cleared on confirm |
| confirm_token_expires_at | timestamptz null | signup + 72 h |
| confirmation_sent_count | integer not null default 0 | all-time; the 3-per-24 h cap is computed from `confirmation_sent` events |
| legacy_confirmation_sent_at | timestamptz null | the one admin-triggered email for a legacy row (spent once set) |
| confirmed_at | timestamptz null | latest confirmation |
| confirmed_ip, confirmed_user_agent | text null | at confirmation; IP pruned with `signup_ip` (same bar) |
| unsubscribed_at | timestamptz null | latest suppression that set the status |
| provider_id | text null | Listmonk subscriber id (string) once synced; null for the stub |
| provider_synced_at | timestamptz null | last successful `syncSubscriber`/`removeSubscriber` |
| ip_pruned_at | timestamptz null | |
| created_at, updated_at | timestamptz | `created_at` = first-ever signup |

Indexes: (site_id, status); (site_id, confirmed_at desc); unique (site_id, email) as before.

### newsletter_subscriber_event
Append-only (`spec/capabilities/newsletter-list.md`): a trigger (`newsletter_ledger_guard`,
created by `0002_newsletter`) raises on `UPDATE`/`DELETE` of this table and of
`newsletter_suppression`; the app never tries. Rows reference the subscriber with
`on delete restrict`, so a subscriber row cannot be deleted either (there is no delete path).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| subscriber_id | uuid fk → newsletter_subscriber on delete restrict | |
| email | text not null | copied at write time |
| kind | text not null | check in (`signup`,`confirmation_sent`,`confirmed`,`resubscribed`,`unsubscribed`,`bounced`,`legacy_confirmation_sent`,`provider_synced`,`provider_removed`,`ip_pruned`) |
| source | text not null | check in (`footer`,`email_link`,`one_click`,`admin`,`provider`,`webhook`,`migration`,`system`) |
| actor_user_id | uuid null fk → app_user | admin actions |
| ip, user_agent | text null | of the request that caused it (IP only when real; nulled by the subscriber's prune only once the event itself is older than 12 months) |
| details | jsonb not null default `'{}'` | e.g. `{ resignup: true }`, `{ outcome: 'sent' \| 'failed' \| 'stubbed', transport, error? }`, `{ providerId }`, `{ reason }` |
| created_at | timestamptz | |

Index (subscriber_id, created_at); (site_id, created_at desc).

### newsletter_suppression
Append-only, never deleted — the permanent do-not-send ledger. Status on the subscriber row is the
current state; this table is the proof.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| subscriber_id | uuid fk → newsletter_subscriber on delete restrict | |
| email | text not null | |
| reason | text not null | check in (`unsubscribed`,`bounced`,`complaint`,`admin`) |
| source | text not null | same set as the event `source` |
| details | jsonb not null default `'{}'` | provider payload / bounce reason / admin note |
| created_at | timestamptz | |

Index (site_id, email, created_at desc).

### newsletter_message
Every transactional message blog0 itself composed, plus the stub sender's deliveries. With the
SMTP transport the row records the send (bodies kept, so a confirmation can be audited); with the
stub transport the row **is** the delivery. Ephemeral-ish: kept, backed up, never pruned in v0.1.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| kind | text not null | check in (`confirmation`,`test_issue`,`issue`) |
| subscriber_id | uuid null fk → newsletter_subscriber on delete restrict | null for test messages |
| issue_id | uuid null fk → newsletter_issue on delete restrict | for `test_issue` / `issue` |
| to_email | text not null | |
| subject | text not null | |
| html, text | text not null | as sent |
| transport | text not null | `smtp` \| `stub` \| `stub_sender` |
| status | text not null | check in (`sent`,`failed`,`stubbed`) |
| provider_message_id | text null | SMTP message id |
| error | text null | |
| created_at | timestamptz | |

Index (site_id, created_at desc); (subscriber_id, created_at desc); (issue_id).

### newsletter_issue
One issue (`spec/capabilities/newsletter-issues.md`).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| number | integer not null | per site, 1-based; unique (site_id, number); assigned at creation (`max + 1` under the site row lock) |
| status | text not null default `draft` | check in (`draft`,`sending`,`sent`,`failed`) |
| origin | text not null | check in (`per_post`,`digest`,`manual`) — the mode that created it |
| title | text not null | ≤ 150; the subject |
| intro_md | text not null default '' | ≤ 5 000 |
| posts | jsonb not null | `IssuePost[]` snapshot (shape in `spec/api.md`); 1–10 entries; refreshed on preview while `draft`, frozen at send |
| article_ids | uuid[] not null | the same ids, for the "at most one automatic issue per article" check (`origin <> 'manual'`) |
| rendered_html, rendered_text | text null | frozen at send (the exact bodies given to the sender) |
| provider_campaign_id | text null | set by `createIssue`; reused on retry |
| recipient_count | integer null | confirmed subscribers at send |
| stats | jsonb null | `IssueStatsDto` (last fetch) |
| last_error | text null | |
| created_by | uuid null fk → app_user | null when created by a publish hook / tick |
| sent_by | uuid null fk → app_user | null for auto-send |
| sent_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

Index (site_id, created_at desc); (site_id, status).

### newsletter_issue_event
The send log — append-only (same trigger guard).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| issue_id | uuid fk → newsletter_issue on delete cascade | a draft may be deleted; a sent issue never is (the API refuses) |
| kind | text not null | check in (`created`,`updated`,`test_sent`,`send_requested`,`provider_created`,`provider_started`,`sent`,`failed`,`stats_fetched`,`deleted`) |
| actor_user_id | uuid null fk → app_user | |
| details | jsonb not null default `'{}'` | e.g. `{ recipientCount }`, `{ campaignId }`, `{ error }`, `{ stats }`, `{ toEmail }` |
| created_at | timestamptz | |

Index (issue_id, created_at).

Drizzle (`src/server/db/schema.ts`, slice S7.1): `newsletterSubscriberEvent`,
`newsletterSuppression`, `newsletterMessage`, `newsletterIssue`, `newsletterIssueEvent`;
`ALL_TABLE_NAMES` becomes (children first):
`rate_limit_bucket, newsletter_message, newsletter_issue_event, newsletter_issue, newsletter_subscriber_event, newsletter_suppression, media_asset, newsletter_subscriber, ai_generation, article_format, article_revision, article, session, app_user, site`.
`BACKUP_TABLES` (= `ALL_TABLE_NAMES` minus `rate_limit_bucket`) therefore includes every
newsletter table — the consent ledger is part of every backup.
`rate_limit_bucket.scope` gains `newsletter.link.ip` and `newsletter.link.site` (no migration).
Stage A adds `login.ip` and `login.delay` (no migration; `login.delay` rows use `window_start =
epoch 0`, `count` = attempts since the last success, `expires_at` = last attempt + 15 min —
`spec/architecture.md` §6) and stops writing `login.email`.

### media_asset
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| kind | text not null | check in (`image`,`audio`) |
| storage_key | text unique not null | `<siteSlug>/<kind>/<yyyy>/<mm>/<uuid>.<ext>` (architecture §9); the public URL is `/media/<storage_key>` |
| original_filename | text not null | as uploaded, basename only, ≤ 255 chars (control chars stripped) |
| mime_type | text not null | image/png, image/jpeg, image/webp, image/gif, audio/mpeg, audio/mp4 — detected from bytes, served verbatim |
| byte_size | bigint not null | |
| sha256 | text not null | hex; doubles as the `ETag` |
| duration_sec | numeric(10,3) null | audio only; seconds with millisecond precision, written as `round(durationMs) / 1000`. There is **no** `duration_ms` column: APIs, payloads and tests use integer `durationMs = round(duration_sec × 1000)`. |
| width, height | integer null | images only |
| article_id | uuid null fk → article on delete set null | the article the file was uploaded for (images: optional; audio: always) |
| created_by | uuid fk → app_user | |
| created_at | timestamptz | |

Rules: an `audio` row (and its file) is deleted when the recording is replaced or removed and no
`article_format` draft/published payload references its key; `image` rows are never deleted
automatically (v0.1). Deleting an article leaves its media rows (`article_id` → null) and files
in place (> **Assumed:** acceptable orphan cost for < 100 articles).

### rate_limit_bucket
Phase 5, migration `0001_rate_limit_bucket` (owned by slice S5.3; generated with
`pnpm db:generate --name rate_limit_bucket`). One fixed throttle window per (site, scope, key) —
capability `abuse-protection.md`, logic `spec/architecture.md` §6. Ephemeral: its rows are not
backed up (`backup-restore.md`) and expired rows are pruned.

| Column | Type | Notes |
|---|---|---|
| site_id | uuid fk → site on delete cascade | |
| scope | text not null | `login.pair` \| `login.email` \| `newsletter.ip` \| `newsletter.email` \| `newsletter.site` (no CHECK — new scopes need no migration) |
| key_hash | text not null | sha256 hex of the raw key (email / IP / pair / site id) — never the raw value |
| window_start | timestamptz not null | `floor(now / window) × window` (UTC epoch-aligned) |
| expires_at | timestamptz not null | `window_start + window` |
| count | integer not null default 0 | check `count >= 0` |

Primary key (site_id, scope, key_hash, window_start) — no `id` column (exception to the uuid-pk
convention: the natural key is the upsert target). Index (expires_at) for the prune. Drizzle:
`rateLimitBucket` in `src/server/db/schema.ts`; `ALL_TABLE_NAMES` gains `'rate_limit_bucket'` as
its **first** entry (children first).

## Relationships

```
site 1─* app_user 1─* session
site 1─* article 1─* article_revision
article ─ current_revision_id ─► article_revision ; article ─ published_revision_id ─► article_revision
article 1─* article_format (one per kind)      article 1─* ai_generation ─► article_revision
site 1─* newsletter_subscriber                  site 1─* media_asset ─(0..1)► article
site 1─* rate_limit_bucket                      (Phase 5)
newsletter_subscriber 1─* newsletter_subscriber_event   newsletter_subscriber 1─* newsletter_suppression   (Phase 7, append-only)
newsletter_subscriber 1─* newsletter_message ◄─(0..1) newsletter_issue 1─* newsletter_issue_event         (Phase 7)
site 1─* newsletter_issue                       (article ids snapshotted in newsletter_issue.article_ids — no FK)
```

## Lifecycles

**Article status:** `draft` → (`submitted` → `approved`, Phase 4 UI, optional) → `published`.
Self-publish from any status is allowed in v0.1. Unpublish → `draft` (published pointers kept so
republish is one click; readers get 404 while not `published`). Delete is allowed only while
`first_published_at` is null (cascade removes revisions, formats, generations).

**Revision:** created on save when title/dek/body changed; immutable; restore (revision history —
deferred) would create a new revision copying an old one.

**Format (computed status, never stored)** — rules in `spec/architecture.md` §5:
- read: `missing` → `ready`.
- tldr: `missing` → `generating` → (`ready` | `failed`); `ready` → `stale` when the current
  revision's sentences fingerprint differs from the draft's; `stale` → `ready` after Regenerate
  or a deck save against the current revision. Publishing copies draft → published; the published
  deck is served until the next publish.
- listen: `missing` (no draft audio) → `ready` on upload
  (`uploadFingerprint` = current paragraphs fingerprint) ⇄ `text_changed` while the current
  revision's paragraphs fingerprint ≠ the baseline (`uploadFingerprint ?? syncFingerprint`; a null
  baseline is always `ready`) — back to `ready` when the text is reverted or a new recording is
  uploaded; → `missing` after Remove audio. `text_changed` is a warning only. A PUT of stored
  marks never changes the status. Publishing copies the draft (any status) → published; no draft
  clears the published copy. Listen never blocks publish.

**ai_generation:** `running` → `succeeded` | `failed`; a `running` row older than 3 minutes is
reported as abandoned/failed and no longer blocks a new Generate.

**Session:** created at login, slid on use, deleted at logout or expiry (expired rows purged
lazily at login).

**Newsletter subscriber (Phase 7):** `pending` ─confirm link─► `confirmed` ─unsubscribe link /
one-click / admin / provider─► `unsubscribed` (or ─provider bounce─► `bounced`); any of
`unsubscribed` \| `bounced` \| `legacy_unconfirmed` ─footer signup (fresh consent)─► `pending`
again (history kept; confirming appends `resubscribed`). `legacy_unconfirmed` ─admin **Send
confirmation** (once) → confirm link─► `confirmed`. A `pending` row whose token expired is still
`pending` ("expired" is computed from `confirm_token_expires_at < now`); a new signup refreshes
it. Rows are never deleted; suppression and event rows are never updated or deleted.

**Newsletter issue (Phase 7):** `draft` ─Send─► `sending` ─► `sent` | `failed` ─Try again─►
`sending` ─► `sent`. Only `draft` can be edited or deleted; `sent` is final. Automatic issues are
created `draft` and move on by themselves only when `site.newsletter_auto_send` is true.

## Seed data

- `pnpm db:seed`: upsert `site` with the values above; upsert the admin from
  `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` (password is set only on
  create unless `--reset-admin-password` is passed).
- `pnpm db:seed:posts`: the 5 design articles from `src/server/seed/posts/` as
  `published` articles (slug = design id; topic = design tag; byline `Sai Krishna V`; dek =
  design excerpt; `first_published_at` = design date 09:00 site timezone; `in_progress` for
  `ai-is-expensive`; featured ranks 1–3 for `ai-will-destroy-the-world`, `tech-company-first`,
  `humans-are-software`); `created_by` = the first admin of the site (seed order: `db:seed`
  first); one revision each; no TLDR, no audio. Idempotent by slug (existing slugs are left
  untouched). Prints `5 posts: N created`.
- `pnpm seed:tldr`: for every seeded slug whose `article_format(kind='tldr')` has no
  `published_payload`: with a real OpenRouter key, run the normal Generate path once (an
  `ai_generation` row with `requested_by` = the seeding admin, cost recorded) and publish the
  draft deck (`published_payload` = draft, `published_revision_id` = the article's published
  revision); without a real key, build the deck from the committed fixture
  `src/server/seed/decks/<slug>.json` (`source: 'writer'`, `generationId: null`,
  texts matched by exact string to the published revision's eligible sentences; unmatched lines
  dropped with a warning; < 1 matched line → skip with a warning). Idempotent: a published deck
  is never touched; second run prints `decks: 0 seeded (0 calls)`. `--write-fixture` (real key
  required) rewrites each `<slug>.json` from the deck just generated (or already published).
  Fixture shape (Phase 8): `{ "slug": string, "model": string, "promptVersion": string,
  "capturedAt": ISO, "lines": Array<{ "text": string, "relevance": number }> }` — lines in deck
  (document) order, `relevance` copied from the generation's scores. The loader also accepts the
  legacy line shape `{ "text", "reason" }` (reason ignored, relevance absent), so an old fixture
  still seeds. The committed fixtures are regenerated in the Phase 8 gate (`model`
  `typesafe/jev-1.13`, `promptVersion` `jev-rank-v1`).
- Designer mode (`pglite://`): `pnpm dev:design` seeds **in-process** through
  `runDesignerSetup()` (`src/server/designer/setup.ts`, one PGlite handle — no child scripts):
  site → the generated designer admin `designer@blog0.local` (display name `Designer`), always,
  plus the `BLOG0_ADMIN_*` admin when set → the same `seedPosts` as `db:seed:posts` (author = the
  site's first admin) → the same `seedTldr` as `seed:tldr` with `source: 'auto'` (fixture path
  when no real key). Designer credentials go to `var/designer-admin.txt` for the default dir, or
  `<dir>.designer-admin.txt` for a non-default PGlite dir.
- Seed slug collision: `db:seed:posts` never overwrites an existing article on a seed slug (e.g.
  a writer's own article); it skips it, so that slug keeps its own featured state (divergence 27).
