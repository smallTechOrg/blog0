# blog0 — Data model

PostgreSQL 18 in production and in every gate; the identical schema also runs on embedded PGlite
(PG 17 WASM) in designer mode (`spec/architecture.md` §11). All tables are created by the single
migration `0000_init` (Phase 4 needs no further migration; Phases 5 and 6 add their own, each
owned by one named slice). Conventions:
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
| submitted_at, approved_at | timestamptz null | sign-off (modelled; UI in Phase 4, on hold) |
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
  slides: Array<{ sid: string; text: string; source: 'jev' | 'writer'; reason: string | null }>; // 1..12, text verbatim from the revision's sentence
  generationId: string | null;   // ai_generation that produced the Jev picks this deck started from
}
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
| task | text not null | `tldr.select` |
| status | text not null | check in (`running`,`succeeded`,`failed`) |
| requested_by | uuid fk → app_user | |
| started_at | timestamptz not null default `now()` | |
| finished_at | timestamptz null | |
| model | text not null | slug used |
| prompt_version | text not null | `jev-select-v1` |
| input_fingerprint | text not null | revision sentences fingerprint |
| sentence_count | integer not null | N |
| bound_min, bound_max | integer not null | |
| attempts | integer not null default 0 | model calls (≤ 2) |
| prompt_tokens, completion_tokens, total_tokens | integer null | summed over attempts |
| cost_usd | numeric(12,6) null | summed; null when provider omitted cost |
| latency_ms | integer null | |
| provider_generation_ids | text[] not null default '{}' | OpenRouter ids |
| output | jsonb null | `{ picks: [{ index, sid, reason }] }` on success; `{ rawOutputs: [...] }` on invalid output |
| error_code, error_message | text null | |
| created_at | timestamptz | |

Index (site_id, started_at desc); (article_id, started_at desc).

### newsletter_subscriber
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| site_id | uuid fk | |
| email | text not null | lower-cased, trimmed; unique (site_id, email) |
| name | text null | ≤ 120 chars |
| status | text not null default `subscribed` | check in (`subscribed`,`unsubscribed`) |
| source | text not null default `footer` | |
| created_at, updated_at | timestamptz | |

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

## Relationships

```
site 1─* app_user 1─* session
site 1─* article 1─* article_revision
article ─ current_revision_id ─► article_revision ; article ─ published_revision_id ─► article_revision
article 1─* article_format (one per kind)      article 1─* ai_generation ─► article_revision
site 1─* newsletter_subscriber                  site 1─* media_asset ─(0..1)► article
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
  `src/server/seed/decks/<slug>.json` (`source: 'writer'`, `reason: null`, `generationId: null`,
  texts matched by exact string to the published revision's eligible sentences; unmatched lines
  dropped with a warning; < 1 matched line → skip with a warning). Idempotent: a published deck
  is never touched; second run prints `decks: 0 seeded (0 calls)`. `--write-fixture` (real key
  required) rewrites each `<slug>.json` from the deck just generated (or already published).
  Fixture shape: `{ "slug": string, "model": string, "promptVersion": string, "capturedAt": ISO,
  "lines": Array<{ "text": string, "reason": string }> }`.
- Designer mode (`pglite://`): `pnpm dev:design` seeds **in-process** through
  `runDesignerSetup()` (`src/server/designer/setup.ts`, one PGlite handle — no child scripts):
  site → the generated designer admin `designer@blog0.local` (display name `Designer`), always,
  plus the `BLOG0_ADMIN_*` admin when set → the same `seedPosts` as `db:seed:posts` (author = the
  site's first admin) → the same `seedTldr` as `seed:tldr` with `source: 'auto'` (fixture path
  when no real key). Designer credentials go to `var/designer-admin.txt` for the default dir, or
  `<dir>.designer-admin.txt` for a non-default PGlite dir.
- Seed slug collision: `db:seed:posts` never overwrites an existing article on a seed slug (e.g.
  a writer's own article); it skips it, so that slug keeps its own featured state (divergence 27).
