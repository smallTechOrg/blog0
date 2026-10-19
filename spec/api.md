# blog0 — HTTP API contract

Single origin. JSON in/out (`Content-Type: application/json`) except uploads (multipart) and
media streaming. Every JSON response uses the envelope (`src/lib/api/envelope.ts`):

```ts
type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: { code: string; message: string; details?: unknown; requestId: string } };
```

Every response has header `x-request-id` (and, from Phase 5, the static security headers of
`spec/architecture.md` §6). Auth column: **admin** = valid `blog0_session` cookie
(else 401 `UNAUTHENTICATED`); **none** = public. All mutating routes (POST/PUT/PATCH/DELETE)
require a same-origin `Origin` header (else 403 `FORBIDDEN_ORIGIN`). Bodies are validated with
zod (else 400 `VALIDATION_FAILED`, `details` = flattened zod issues). Ids are uuids (malformed →
404 `NOT_FOUND`). Every API DTO below lives in **one file, `src/lib/api/dto.ts`**, grouped by
domain sections (shared/formats, articles, TLDR, listen, media, public, site/newsletter, …); a
new DTO goes into the matching section.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| VALIDATION_FAILED | 400 | Body/query invalid |
| UNAUTHENTICATED | 401 | No/expired session |
| BAD_CREDENTIALS | 401 | Login failed (generic message) |
| FORBIDDEN_ORIGIN | 403 | Cross-origin mutation |
| NOT_FOUND | 404 | Unknown id/slug (or not in this site) |
| CONFLICT | 409 | `baseRevisionId`/`revisionId` is not the current revision |
| SLUG_TAKEN | 409 | Slug already used in this site |
| SLUG_LOCKED | 409 | Slug change after first publish |
| GENERATION_IN_PROGRESS | 409 | A Jev run for this article is already running |
| NOT_DELETABLE | 409 | Delete of an article that was ever published |
| LISTEN_NO_AUDIO | 409 | Marks save without an uploaded draft recording |
| PUBLISH_BLOCKED | 422 | Publish validation failed; `details: { reasons: Array<{ code: 'TITLE_REQUIRED' \| 'TOPIC_REQUIRED' \| 'BODY_REQUIRED' \| 'TLDR_DECK_STALE', message, sids? }> }` — Listen never blocks |
| DECK_INVALID | 422 | Deck save: unknown/duplicate sid or count outside 1–12; `details.sids` |
| MARKS_INVALID | 422 | Aligner-facing `PUT …/listen`: `details: { reasons: Array<{ code: 'UNKNOWN_PID' \| 'MISSING_PID' \| 'DUPLICATE_PID' \| 'OUT_OF_ORDER' \| 'NOT_INCREASING' \| 'OUT_OF_RANGE', pid?, index? }> }` |
| AUDIO_TOO_LONG | 422 | Recording longer than `BLOG0_MAX_AUDIO_MINUTES`; message carries both values |
| IMAGE_TOO_LARGE | 422 | Image wider or taller than 12 000 px |
| JEV_NO_SENTENCES / JEV_INPUT_TOO_LONG | 422 | Guard failures (no LLM call) |
| LLM_AUTH / LLM_INSUFFICIENT_CREDITS / LLM_MODEL_NOT_FOUND | 502 | Provider config problems (message points at `.env`) |
| LLM_INVALID_OUTPUT | 502 | Phase 8: Jev's answers were incomplete or out of range (a sentence missing or a score outside [0,1]); no retry. Legacy: model output invalid twice |
| LLM_RATE_LIMITED / LLM_UNAVAILABLE / LLM_TIMEOUT | 503 | Transient provider failure |
| LLM_NOT_CONFIGURED | 503 | Designer mode without an OpenRouter key; Generate refused before any row is written |
| RATE_LIMITED | 429 | Login/newsletter throttle; `Retry-After` header (Phase 5: counted in Postgres — `spec/capabilities/abuse-protection.md`; Phase 7 adds the confirm/unsubscribe link caps) |
| TOKEN_INVALID | 404 | Phase 7: confirm/unsubscribe token malformed, unknown or tampered (never says which) |
| TOKEN_EXPIRED | 410 | Phase 7: confirm token past 72 h or already used |
| CONFIRMATION_ALREADY_SENT | 409 | Phase 7: legacy row already got its one email, or the 3-per-24 h cap for a pending row is reached (`details.retryAt`) |
| SUBSCRIBER_NOT_ELIGIBLE | 409 | Phase 7: send-confirmation on a `confirmed`/`unsubscribed`/`bounced` row; admin unsubscribe on an already suppressed row |
| ISSUE_NOT_DRAFT | 409 | Phase 7: edit/delete/send of an issue that is not `draft` (send also refuses `sent` and a `sending` issue younger than 10 min; `failed` and a `sending` issue stuck > 10 min may be retried) |
| NO_RECIPIENTS | 409 | Phase 7: send with 0 confirmed subscribers |
| ISSUE_POSTS_INVALID | 422 | Phase 7: manual issue with 0 or > 10 articles, an unpublished/unknown article, or duplicates; `details.articleIds` |
| SENDER_UNAVAILABLE | 503 | Phase 7: `BLOG0_NEWSLETTER_SENDER=listmonk` but Listmonk unreachable / misconfigured (`healthcheck` failed); message names the URL host only |
| SENDER_FAILED | 502 | Phase 7: a provider call failed mid-send (the issue is `failed`, `last_error` holds the provider text, never the token) |
| MAIL_FAILED | 502 | Phase 7: the SMTP transport rejected a test/confirmation message (resend path); the stub transport never fails |
| WEBHOOK_UNAUTHORIZED | 401 | Phase 7: `/api/newsletter/webhook` secret missing/wrong |
| PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA | 413 / 415 | Uploads: over `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_IMAGE_MB` (declared `Content-Length` and actual bytes) / content not in the allowlist (detected from bytes; message names the detected type) |
| DB_UNAVAILABLE | 503 | Health check only |
| NOT_READY | 503 | `/api/health/ready` only; `details.reason` = `SHUTTING_DOWN` \| `DB_UNAVAILABLE` \| `MIGRATIONS_PENDING` |
| INTERNAL | 500 | Unexpected |

## Shared DTOs

```ts
type FormatKind = 'read' | 'tldr' | 'listen';
type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'text_changed';   // text_changed: Listen only, non-blocking
type ArticleStatus = 'draft' | 'submitted' | 'approved' | 'published';

interface UserDto { id: string; email: string; displayName: string }
interface FormatChipDto { kind: FormatKind; status: FormatStatus; published: boolean; hasUnpublishedChanges: boolean }
interface ArticleListItemDto {
  id: string; slug: string; title: string; topic: string; status: ArticleStatus;
  formats: FormatChipDto[];                     // always all registered kinds, in registry order
  hasUnpublishedChanges: boolean;               // current_revision_id !== published_revision_id (when published)
  updatedAt: string; updatedBy: string;        // display name of the last revision author
  firstPublishedAt: string | null;
}
interface RevisionRefDto { id: string; number: number; createdAt: string; createdBy: string }
interface ArticleDetailDto {
  id: string; slug: string; slugLocked: boolean; status: ArticleStatus;
  topic: string; bylineName: string; isFeatured: boolean; featuredRank: number | null; inProgress: boolean;
  firstPublishedAt: string | null; lastPublishedAt: string | null;
  currentRevision: RevisionRefDto & { title: string; dek: string; bodyMd: string; wordCount: number; eligibleSentenceCount: number };
  publishedRevisionId: string | null;
  revisionCount: number;
  formats: FormatChipDto[];
  topics: string[];                              // existing topics in the site, for the datalist
  publicUrl: string | null;                      // absolute, when published
}
interface PreviewResultDto {
  blocks: Array<{ kind: 'html'; html: string } | { kind: 'figure'; figureId: string; known: boolean }>;
  warnings: Array<{ code: string; message: string; line?: number }>;
  stats: { words: number; readMinutes: number };
  sentenceCount: number;                         // eligible
}
// Phase 8: `reason` is gone from every TLDR DTO; `relevance` (Jev's score in [0,1], or null when the sentence
// has no score in the article's latest succeeded generation — never scored, changed since, or a pre-Phase-8 generation)
// takes its place. Source of every relevance value: spec/architecture.md §3 "Relevance in the editor".
interface SentenceDto { sid: string; index: number; pid: string; text: string; words: number; headingPath: string[]; relevance: number | null }
interface DeckSlideDto { sid: string; text: string; source: 'jev' | 'writer'; relevance: number | null; missing: boolean } // missing = sid/text no longer in current revision
interface GenerationDto {
  id: string; status: 'running' | 'succeeded' | 'failed'; model: string; promptVersion: string;
  requestedBy: string; startedAt: string; finishedAt: string | null; latencyMs: number | null;
  attempts: number;                              // decisions requests sent (1 unless the article was batched)
  sentenceCount: number;                         // sentences sent to Jev (= scored on success)
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; costUsd: number | null;   // input / output / sum
  picks: Array<{ index: number; sid: string; relevance: number | null }> | null;   // the k selected sentences, document order; null unless succeeded
                                                                                    // (legacy generations: their picks with relevance null)
  errorCode: string | null; errorMessage: string | null;
}
interface TldrStateDto {
  status: FormatStatus;
  bounds: { min: number; max: number; target: number } | null;   // null when 0 eligible sentences
  sentences: SentenceDto[];                                       // current revision, eligible only, DOCUMENT order (the client sorts by relevance)
  draft: { slides: DeckSlideDto[]; revisionId: string; updatedAt: string; updatedBy: string } | null;
  published: { slides: Array<{ text: string }>; publishedAt: string } | null;
  latestGeneration: GenerationDto | null;
  jevAvailable: boolean;                                          // false only when no OpenRouter key is configured (designer mode)
}
```

Article field limits (`ARTICLE_LIMITS` in `src/lib/articles/limits.ts`, shared by the server
schemas and the editor forms): title 1–200, dek ≤ 400, topic ≤ 40, slug ≤ 80
(`^[a-z0-9]+(?:-[a-z0-9]+)*$`), byline 1–80, body ≤ 200 000 chars; `featuredRank` integer
0–10 000 or null. Strings are trimmed (body is not).

## Endpoints — health

| Method & path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/api/health` | none | — | `{ status: 'ok', db: 'ok', dbLatencyMs: number, version: string, uptimeSec: number, dbEngine: 'postgres' \| 'pglite' }` (`dbEngine` always present); DB down → 503 `DB_UNAVAILABLE` (generic envelope; fixed message, no `details`, never the raw driver error — that is logged server-side). **Unchanged in Phase 5.** |
| GET `/api/health/live` | none | — | `HealthLiveDto = { status: 'live', version: string, uptimeSec: number, shuttingDown: boolean }` — always 200 while the process serves (also during the shutdown drain); never touches the DB. `Cache-Control: no-store`. Liveness probe + Docker `HEALTHCHECK`. |
| GET `/api/health/ready` | none | — | `HealthReadyDto = { status: 'ready', db: 'ok', dbLatencyMs: number, dbEngine: 'postgres' \| 'pglite', migrations: { applied: number, pending: 0, latest: string \| null }, version: string }`. Not ready → 503 `NOT_READY` with `details: { reason: 'SHUTTING_DOWN' \| 'DB_UNAVAILABLE' \| 'MIGRATIONS_PENDING', pending?: string[] }` (fixed messages; never driver text). DB ping and migration check share a 3 s budget. `Cache-Control: no-store`. Readiness probe. |

Both probe routes log their `api.request` line at `debug` when 2xx (probe noise), at the normal
level otherwise (`spec/architecture.md` §7); DTOs live in the health section of `src/lib/api/dto.ts`.

## Endpoints — auth, articles, TLDR

| Method & path | Auth | Request | Response `data` / notes |
|---|---|---|---|
| POST `/api/auth/login` | none | `{ email: string, password: string }` | `{ user: UserDto }` + `Set-Cookie: blog0_session` and (Stage C) `Set-Cookie: blog0_device` (known device — a valid one sent with the request skips the shared per-email delay; `spec/architecture.md` §6). Errors: `BAD_CREDENTIALS`, `RATE_LIMITED` (429 + `Retry-After` seconds; Stage A: also the progressive per-email delay — `spec/architecture.md` §6; the body's `error.details.retryAfterSec` equals the header). |
| POST `/api/auth/logout` | admin | — | `{ signedOut: true }`, cookie cleared (also succeeds with no session). |
| GET `/api/auth/me` | admin | — | `{ user: UserDto }` |
| POST `/api/admin/preview` | admin | `{ title: string, dek: string, bodyMd: string }` (body ≤ 200 000 chars) | `PreviewResultDto` |
| GET `/api/admin/articles` | admin | — | `{ articles: ArticleListItemDto[] }` newest `updatedAt` first |
| POST `/api/admin/articles` | admin | `{ title, dek?, topic?, bodyMd? }` (limits above) | 201 `{ article: ArticleDetailDto }` — revision 1 created; slug derived from title (`slugify`, suffix `-2`… on collision) |
| GET `/api/admin/articles/:id` | admin | — | `{ article: ArticleDetailDto }` |
| PATCH `/api/admin/articles/:id` | admin | `{ baseRevisionId: string, title?, dek?, bodyMd?, topic?, slug?, bylineName?, isFeatured?, featuredRank?: number \| null, inProgress? }` (limits above) | `{ article: ArticleDetailDto, revisionCreated: boolean }`. `CONFLICT` if base ≠ current. Content unchanged → no new revision. `SLUG_TAKEN`, `SLUG_LOCKED`. While never published and slug never manually set, a title change re-derives the slug. |
| DELETE `/api/admin/articles/:id` | admin | — | `{ deleted: true }`; `NOT_DELETABLE` if ever published |
| GET `/api/admin/articles/:id/tldr` | admin | — | `TldrStateDto` |
| POST `/api/admin/articles/:id/tldr/generate` | admin | `{ revisionId: string }` (must be current) | `{ tldr: TldrStateDto, generation: GenerationDto }`. Errors: `CONFLICT`, `GENERATION_IN_PROGRESS`, `JEV_*`, `LLM_*` (the failed `GenerationDto` is in `error.details.generation`). Ranks every eligible sentence and replaces the draft deck with the top k (document order) on success. `maxDuration = 120`. |
| PUT `/api/admin/articles/:id/tldr` | admin | `{ revisionId: string, slides: Array<{ sid: string, source: 'jev' \| 'writer' }> }` (a legacy `reason` key is stripped, not refused; relevance is never accepted from the client) | `{ tldr: TldrStateDto }`. Text is resolved server-side from `sid`. `DECK_INVALID`, `CONFLICT`. Empty `slides` array is not allowed — use DELETE. |
| DELETE `/api/admin/articles/:id/tldr` | admin | — | `{ tldr: TldrStateDto }` (draft deck cleared; published deck untouched) |
| POST `/api/admin/articles/:id/publish` | admin | `{ revisionId: string }` | `{ article: ArticleDetailDto }`; `PUBLISH_BLOCKED` with reasons; `CONFLICT`. Copies each format's draft to its published copy (Listen: any status; no draft clears the published Listen — `spec/capabilities/listen-audio.md`). |
| POST `/api/admin/articles/:id/unpublish` | admin | — | `{ article: ArticleDetailDto }` |

## Endpoints — public reads, site, newsletter

| Method & path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/api/public/articles/:slug/tldr` | none | — | `PublicTldrDto = { slug, title, topic, dek, meta: string, slides: Array<{ text: string }>, disclosure: string, times: { read: number, tldr: number, listen: number \| null }, shareUrl: string }` — published deck only, else 404. `times.listen` = the published recording's minutes or null. `Cache-Control: public, max-age=60`. |
| POST `/api/newsletter` | none | `{ email: string, name?: string, sourceUrl?: string, website?: string, fillMs?: number }` (Phase 7 adds `sourceUrl`: a relative path ≤ 500, default `/`. Stage A adds the honeypot `website` (string ≤ 200) and `fillMs` (integer 0–86 400 000: ms from form mount to submit); wrong types → 400) | `NewsletterSubscribeResponse` = `{ subscribed: true, delivery }` (the same for a new, pending, confirmed or suppressed address — no enumeration). **Stage A `delivery`:** `'failed'` only when this request's confirmation email was attempted over SMTP and the transport rejected it; otherwise the environment's success value — `'sent'` with the SMTP transport, `'recorded'` with the stub — including every no-send outcome (confirmed, capped, suppressed) so it never enumerates. **Stage A bot drop:** after body validation and **before** any rate-limit counting, a non-empty trimmed `website` (reason `honeypot`) or a missing / < 2 000 `fillMs` (reason `too_fast`) → 200 with the environment's success `delivery`, no DB write of any kind, log `newsletter.signup_dropped`. Phase 7: creates/re-opens a `pending` subscriber and sends the confirmation email (`spec/capabilities/newsletter-list.md`). Invalid bodies → 400 `VALIDATION_FAILED` before any rate-limit counting. `RATE_LIMITED` (429 + `Retry-After`) per the caps in `spec/architecture.md` §6. |
| GET `/api/admin/subscribers` | admin | see the Phase 7 newsletter section | `SubscriberListResponse` or CSV / audit-JSON download |
| GET `/api/admin/site` | admin | — | `{ site: SiteSettingsDto }` — Phase 7 adds `newsletter: NewsletterSettingsDto` inside `SiteSettingsDto` (read-only here; edited via `/api/admin/newsletter/settings`) |
| PATCH `/api/admin/site` | admin | any subset of the editable site fields (never `newsletter`; unknown keys → 400) | `{ site: … }` |

> **Assumed (fix pass):** `SiteSettingsDto` and the PATCH gain two editable text fields,
> `privacyText` (≤ 8 000, Markdown paragraphs like About) and `newsletterPostalAddress` (≤ 300,
> empty allowed). `/privacy` is a public HTML page (no JSON route). The send dialog reads
> `newsletterPostalAddress` from `GET /api/admin/site` to warn when it is empty; `POST …/send` is
> unchanged (never blocks).

The newsletter confirm/unsubscribe links, the one-click POST, the webhook and every
`/api/admin/newsletter/*` route are in **Endpoints — newsletter (Phase 7)** below.

## Listen + media DTOs (listen and media sections of `src/lib/api/dto.ts`)

```ts
// missing = no draft audio; ready = audio uploaded and the paragraph text unchanged since;
// text_changed = the current paragraphs fingerprint ≠ the draft's baseline (warning only, never blocks).
type ListenStatus = Extract<FormatStatus, 'missing' | 'ready' | 'text_changed'>;
type ListenTiming = 'synced' | 'estimated';                               // resolveMarks (spec/capabilities/listen-sync.md)
type AudioMime = 'audio/mpeg' | 'audio/mp4';
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

interface ListenMarkDto { pid: string; tMs: number }                      // integer ms into the recording
interface ListenParagraphDto { pid: string; index: number; text: string; kind: 'p' | 'li' | 'quote'; headingPath: string[] }
interface ListenAudioDto {
  assetId: string; key: string; url: string;                             // url = '/media/' + key (same-origin, relative)
  mimeType: AudioMime; bytes: number; durationMs: number;
  originalFilename: string; uploadedAt: string; uploadedBy: string;      // display name
}
interface ListenStateDto {
  status: ListenStatus;
  revisionId: string;                                                    // the current revision the paragraphs come from
  paragraphs: ListenParagraphDto[];                                      // current revision, document order (all of them) — for the aligner / PUT
  audio: ListenAudioDto | null;                                          // draft recording
  marks: ListenMarkDto[];                                                // STORED draft marks ([] normally) — not what readers get
  timing: ListenTiming | null;                                           // what readers would get over the CURRENT text; null without audio
  uploadFingerprint: string | null;                                      // the baseline: uploadFingerprint ?? syncFingerprint
  textChangedSinceUpload: boolean;                                       // === (status === 'text_changed')
  syncFingerprint: string | null; syncedAt: string | null; syncedBy: string | null;   // set by PUT only
  published: { durationMs: number; publishedAt: string; sameAudioAsDraft: boolean } | null;   // sameAudioAsDraft: published audio.key === draft audio.key
  limits: { maxAudioMb: number; maxAudioMinutes: number };
}
interface ListenSaveRequest { revisionId: string; marks: ListenMarkDto[] }   // aligner-facing (Phase 6) — no admin UI caller
interface ListenResponse { listen: ListenStateDto }

interface ImageUploadResponse {
  asset: { id: string; key: string; url: string; mimeType: ImageMime; bytes: number; width: number; height: number };
  markdown: string;                                                      // '![alt](/media/<key>)' or '![alt](/media/<key> "caption")'
}

// Public (reader) — mirrors ListenViewModel (src/lib/view-models.ts)
interface PublicListenDto {
  slug: string; title: string; topic: string; dek: string; meta: string;  // meta = "<date> · <read> min read" as the deck's
  audio: { url: string; mimeType: AudioMime; durationMs: number };
  marks: ListenMarkDto[];                                                // resolveMarks(published stored marks, published paragraphs, durationMs) — per request, one per published paragraph
  timing: ListenTiming;
  bylineName: string;
  times: { read: number; tldr: number | null; listen: number };
  shareUrl: string;                                                      // absolute …/p/<slug>/listen
}
```

## Endpoints — Listen + media

Uploads are `multipart/form-data` (`withApi({ auth: 'admin', body: 'multipart', maxBytes })` —
`Origin` enforced, declared `Content-Length` pre-checked against `maxBytes + 64 KiB`, then the
form parsed; `spec/architecture.md` §9.3).

| Method & path | Auth | Request | Response `data` / notes |
|---|---|---|---|
| POST `/api/admin/uploads/images` | admin | multipart: `file` (required), `alt` (string ≤ 200, default `''`), `caption?` (≤ 200), `articleId?` (uuid of an article in this site, else 404) | 201 `ImageUploadResponse`. Errors: `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA` (incl. SVG), `IMAGE_TOO_LARGE`, `VALIDATION_FAILED`. |
| POST `/api/admin/articles/:id/audio` | admin | multipart: `file` (required) | 200 `ListenResponse` with `status 'ready'`, `marks []`, `timing 'estimated'`, `uploadFingerprint` = the current revision's paragraphs fingerprint. Replaces the draft recording (old unreferenced file + row deleted). Errors: `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA`, `AUDIO_TOO_LONG`. `maxDuration = 120`. |
| DELETE `/api/admin/articles/:id/audio` | admin | — | 200 `ListenResponse` with `status 'missing'`, `audio null`, `marks []` (draft cleared; published Listen untouched; unreferenced file + row deleted). Idempotent. |
| GET `/api/admin/articles/:id/listen` | admin | — | `ListenStateDto` |
| PUT `/api/admin/articles/:id/listen` | admin | `ListenSaveRequest` — `revisionId` must be current | **Aligner-facing** (Phase 6 writes aligned marks here; tests use it; no admin UI calls it). 200 `ListenResponse` (a PUT never changes the status). Errors: `CONFLICT`, `LISTEN_NO_AUDIO`, `MARKS_INVALID` (rules: `spec/capabilities/listen-sync.md`). Stores `marks`, `syncFingerprint` = the revision's paragraphs fingerprint, `syncedAt`/`syncedBy`, `draft_revision_id`; never changes the baseline. |
| GET `/api/public/articles/:slug/listen` | none | — | `PublicListenDto` — only when the article is published **and** has a published Listen, else 404. `Cache-Control: public, max-age=60`. |
| GET / HEAD `/media/[...key]` | none | `Range`, `If-None-Match`, `If-Range` optional | Not JSON. 200 / 206 / 304 / 416 per `spec/architecture.md` §9.2. Invalid key, unknown key, or file missing on disk → 404 `NOT_FOUND` as a JSON envelope. Other methods → 405. |

## Newsletter DTOs (Phase 7 — `newsletter` section of `src/lib/api/dto.ts`, owned by slice S7.1)

```ts
type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed' | 'bounced' | 'legacy_unconfirmed';
type SubscriberEventKind = 'signup' | 'confirmation_sent' | 'confirmed' | 'resubscribed' | 'unsubscribed' | 'bounced'
  | 'legacy_confirmation_sent' | 'provider_synced' | 'provider_removed' | 'ip_pruned';
type NewsletterSource = 'footer' | 'email_link' | 'one_click' | 'admin' | 'provider' | 'webhook' | 'migration' | 'system';
type SuppressionReason = 'unsubscribed' | 'bounced' | 'complaint' | 'admin';

/** POST /api/newsletter — no enumeration. Stage A adds `delivery` (rules: endpoint row above). */
type NewsletterDelivery = 'sent' | 'recorded' | 'failed';
interface NewsletterSubscribeResponse { subscribed: true; delivery: NewsletterDelivery }

interface SubscriberDto {                       // list rows (replaces the Phase 2 shape; CSV uses the same fields)
  id: string; email: string; name: string | null; status: SubscriberStatus; source: string;
  createdAt: string; consentedAt: string | null; confirmedAt: string | null; unsubscribedAt: string | null;
  pendingExpired: boolean;                      // status === 'pending' && confirm_token_expires_at < now
  consentVersion: string | null; sourceUrl: string | null;
  providerSyncedAt: string | null;
  canSendConfirmation: boolean;                 // legacy: not yet sent; pending: under the 3-per-24 h cap
}
interface SubscriberCounts { all: number; pending: number; confirmed: number; unsubscribed: number; bounced: number; legacy_unconfirmed: number }
interface SubscriberListResponse { subscribers: SubscriberDto[]; total: number; counts: SubscriberCounts; now: string }

interface SubscriberEventDto { id: string; kind: SubscriberEventKind; source: NewsletterSource; actor: string | null; ip: string | null; userAgent: string | null; details: Record<string, unknown>; createdAt: string }
interface SuppressionDto { id: string; reason: SuppressionReason; source: NewsletterSource; details: Record<string, unknown>; createdAt: string }
interface SubscriberDetailDto extends SubscriberDto {
  signupIp: string | null; signupUserAgent: string | null; consentText: string | null;
  confirmedIp: string | null; confirmedUserAgent: string | null; confirmTokenExpiresAt: string | null;
  confirmationSentCount: number; legacyConfirmationSentAt: string | null; providerId: string | null; ipPrunedAt: string | null;
  events: SubscriberEventDto[];                 // oldest first
  suppressions: SuppressionDto[];               // for this email, oldest first
  messages: Array<{ id: string; kind: 'confirmation' | 'issue'; subject: string; transport: string; status: string; createdAt: string }>;
}
interface SubscriberDetailResponse { subscriber: SubscriberDetailDto }

/** GET …?format=audit — the whole proof bundle. */
interface NewsletterAuditBundle {
  format: 'blog0-newsletter-audit/1'; exportedAt: string; exportedBy: string; site: { slug: string; brandName: string };
  settings: NewsletterSettingsDto;
  subscribers: Array<Omit<SubscriberDetailDto, 'messages' | 'canSendConfirmation' | 'pendingExpired'>>;
  suppressions: Array<SuppressionDto & { email: string; subscriberId: string }>;
}

type NewsletterMode = 'per_post' | 'digest' | 'manual';
interface NewsletterSettingsDto { mode: NewsletterMode; autoSend: boolean; digestDays: number; digestPosts: number; consentText: string; consentVersion: string; modeSetAt: string | null }
type NewsletterSettingsPatch = Partial<NewsletterSettingsDto>;   // modeSetAt is server-set and rejected in a PATCH
interface NewsletterStatusDto {
  sender: { kind: 'listmonk' | 'stub'; configured: boolean; listId: string | null; listName: string | null; lastSyncAt: string | null; healthy: boolean | null; message: string | null;
    trackingPublic: boolean };                  // Stage A: false when Listmonk's root URL host is not public (spec/architecture.md §13.3); always true for the stub
  mail: { transport: 'smtp' | 'stub'; from: string | null };
  counts: SubscriberCounts;
  digest: { lastIssueAt: string | null; newPostsSince: number; dueAt: string | null } | null;   // only in digest mode
}
interface NewsletterSettingsResponse { settings: NewsletterSettingsDto; status: NewsletterStatusDto }
const NEWSLETTER_SETTINGS_LIMITS = { consentText: 300, consentVersion: 20, digestDays: [1, 60], digestPosts: [1, 20], issueTitle: 150, issueIntroMd: 5_000, issuePosts: [1, 10] } as const;

type IssueStatus = 'draft' | 'sending' | 'sent' | 'failed';
type IssueOrigin = NewsletterMode;
type IssueEventKind = 'created' | 'updated' | 'test_sent' | 'send_requested' | 'provider_created' | 'provider_started' | 'sent' | 'failed' | 'stats_fetched' | 'deleted';
interface IssuePost { articleId: string; slug: string; title: string; dek: string; excerpt: string; topic: string; publishedLabel: string; readUrl: string; tldrUrl: string | null; listenUrl: string | null }
interface IssueStatsDto { recipients: number; sent: number; delivered: number | null; opens: number | null; clicks: number | null; bounces: number | null; unsubscribes: number | null; fetchedAt: string }
interface IssueListItemDto { id: string; number: number; status: IssueStatus; origin: IssueOrigin; title: string; postCount: number; recipientCount: number | null; createdAt: string; sentAt: string | null; lastError: string | null }
interface IssueListResponse { issues: IssueListItemDto[]; total: number; confirmedCount: number }
interface IssueEventDto { id: string; kind: IssueEventKind; actor: string | null; details: Record<string, unknown>; createdAt: string }
interface IssueDetailDto extends IssueListItemDto {
  introMd: string; posts: IssuePost[]; providerCampaignId: string | null; stats: IssueStatsDto | null;
  createdBy: string | null; sentBy: string | null; events: IssueEventDto[];   // oldest first
  editable: boolean;                            // status === 'draft'
  stuckSending: boolean;                        // status === 'sending' and updated_at older than SENDING_STALE_MS (10 min) — Try again allowed (spec/architecture.md §13.5)
  trackingPublic: boolean;                      // Stage A: same value as NewsletterStatusDto.sender.trackingPublic
}
interface IssueDetailResponse { issue: IssueDetailDto }
interface IssueCreateRequest { title: string; introMd?: string; articleIds: string[] }
interface IssueUpdateRequest { title?: string; introMd?: string; articleIds?: string[] }   // articleIds = new order / subset (manual + automatic drafts alike)
interface IssuePreviewDto { subject: string; html: string; text: string; sampleRecipient: { email: string; consentLine: string } }
interface IssueSendRequest { confirm: true }
interface IssueTestResponse { sentTo: string; transport: 'smtp' | 'stub'; messageId: string }
interface NewsletterWebhookRequest { event: 'unsubscribe' | 'bounce' | 'complaint'; email: string; reason?: string; occurredAt?: string; providerRef?: string }
interface NewsletterWebhookResponse { accepted: boolean }
```

## Endpoints — newsletter (Phase 7)

Public link pages are **HTML in the site chrome**, not JSON (they are what readers land on from an
email); their outcomes also exist as JSON routes for RFC 8058 and tests. Rate caps:
`spec/architecture.md` §6 (link caps). Every link route sends `Cache-Control: no-store` and is
`noindex` (JSON routes: `X-Robots-Tag: noindex`; pages: `robots: noindex` metadata —
`newsletter-list.md` Assumed S7.1). Status codes: the **pages** can only answer 200 or a true 404
(`notFound()`), so expired / used / rate-limited outcomes render their copy at 200; the **JSON
routes** carry the exact 410 / 429 (+ `Retry-After`).

| Method & path | Auth | Request | Response / notes |
|---|---|---|---|
| GET `/newsletter/confirm?t=<token>` | none | token in the query | **Owner decision (2026-10-19) — confirm on open** (supersedes the scanner-safe button): a route handler (`src/app/(site)/newsletter/confirm/route.ts`, same path as the old page) that does what `POST /api/newsletter/confirm` does — shape check (malformed/missing → `invalid`, never counted), the shared link cap, `confirmByToken` recording IP + user agent + the consent metadata, plus `details.via: 'link_open'` on the `confirmed`/`resubscribed` event (jsonb, no migration) — then **303** (`Cache-Control: no-store`, `X-Robots-Tag: noindex`, relative `Location`) to `/newsletter/confirmed?status=ok|already|expired|invalid|limited` (`limited` adds `&m=<minutes>`). A spent token whose subscriber is still `confirmed` → `already` (success, nothing written); spent with the subscriber since suppressed, or past 72 h → `expired`; unknown → `invalid`. Trade-off: a link scanner that prefetches the link can confirm; the audit records the IP/UA of the confirming fetch. |
| GET `/newsletter/confirmed?status=…` | none | `status`, `m` | Result page in site chrome, noindex, reads no token and changes nothing (`spec/ui.md` §3): `ok` "You’re confirmed — welcome to <brand>.", `already` "You’re already confirmed.", `expired` the 410 copy, `limited` the 429 copy at 200; `invalid` or a missing/unknown status → a true 404 "That link isn’t valid." |
| GET `/newsletter/unsubscribe?t=<token>` | none | signed token | > **Assumed (fix pass):** the GET changes nothing and counts toward no cap (404 on a malformed token or bad signature); it renders **Yes, unsubscribe me**, which POSTs `{ token, source: 'email_link' }` to `/api/newsletter/unsubscribe`; the 200 copy below is the post-click result. Page: 200 "You’re unsubscribed. Sorry to see you go." (idempotent — the same page for an already-unsubscribed address, no new suppression row; source `email_link`); 404 on a bad signature; rate-limited copy at 200 as above. This page is the **visible** unsubscribe link in every email body. |
| POST `/api/newsletter/confirm` | none (`csrf: false` — the token is the authority) | `{ token: string }` | `{ confirmed: true, alreadyConfirmed: boolean }`; 410 `TOKEN_EXPIRED` (also for a spent token — unchanged; only the GET link maps that to `already`), 404 `TOKEN_INVALID`, 429 `RATE_LIMITED` (+ `Retry-After`). Kept for API callers; since 2026-10-19 the emailed link no longer uses it (confirm on open). |
| POST `/api/newsletter/unsubscribe` | none (`csrf: false`) | JSON `{ token }` **or** the RFC 8058 one-click form: body `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded` **or** `multipart/form-data`, token as `t` in the query | `{ unsubscribed: true, alreadyUnsubscribed: boolean }`; 404 `TOKEN_INVALID`, 429 `RATE_LIMITED` (+ `Retry-After`). Source `one_click` (fix pass: a JSON body may add `source: 'email_link'`, sent by the page button, which records `email_link`; any other value → 400). This URL (`<origin>/api/newsletter/unsubscribe?t=<token>`) is what every `List-Unsubscribe` header points at, with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (`spec/architecture.md` §13.2). |
| GET `/api/newsletter/unsubscribe?t=<token>` | none | token in the query | 303 `Location: /newsletter/unsubscribe?t=<token>` — a client that opens the header URL with GET lands on the page (which shows the **Yes, unsubscribe me** button — fix pass); the GET itself changes nothing and is not throttled. |
| POST `/api/newsletter/webhook` | shared secret: `Authorization: Bearer <BLOG0_NEWSLETTER_WEBHOOK_SECRET>` (`csrf: false`; 401 `WEBHOOK_UNAUTHORIZED`; 404 when the secret is unset) | `NewsletterWebhookRequest` | `NewsletterWebhookResponse` — `accepted: true` when the email is a known subscriber of this site (suppression + event written, status set, `removeSubscriber` called); `false` otherwise (nothing written). Idempotent for an already-suppressed address. A parseable `occurredAt` older than the subscriber's latest consent / confirmation → `accepted: true`, nothing written (opt-out-wins timestamp rule, `spec/architecture.md` §13.3). |
| GET `/api/admin/subscribers` | admin | `?status=<SubscriberStatus>` (default all) `&q=<email substring, ≤ 100>` `&format=csv` \| `audit` | `SubscriberListResponse` newest first (`createdAt` desc). `format=csv` → `text/csv`, header `email,name,status,subscribed_at,confirmed_at,unsubscribed_at,source,source_url,consent_version` (the filter applies; formula-neutralised as before), filename `<slug>-subscribers-<yyyy-mm-dd>.csv`. `format=audit` → `application/json` download `<slug>-newsletter-audit-<yyyy-mm-dd>.json` (`NewsletterAuditBundle`; filters ignored — always everything). |
| GET `/api/admin/subscribers/:id` | admin | — | `SubscriberDetailResponse` |
| POST `/api/admin/subscribers/:id/send-confirmation` | admin | — | `{ subscriber: SubscriberDetailDto, sentTo: string, transport: 'smtp' \| 'stub' }`. Legacy: one-time (`legacy_confirmation_sent_at` set; event `legacy_confirmation_sent`; the row stays `legacy_unconfirmed` until the click). Pending: new token + email under the 3-per-24 h cap (`CONFIRMATION_ALREADY_SENT` with `details.retryAt` beyond it). Other statuses → `SUBSCRIBER_NOT_ELIGIBLE`. `MAIL_FAILED` if SMTP rejects (nothing else changes). |
| POST `/api/admin/subscribers/send-legacy-confirmations` | admin | `{ confirm: true }` | `{ sent: number, skipped: number }` — one email per `legacy_unconfirmed` row not yet mailed (each row's one-time rule), in batches of 20 with a 200 ms pause; a mail failure skips that row (logged) and continues. Nothing happens without `confirm: true` (400). |
| POST `/api/admin/subscribers/:id/unsubscribe` | admin | `{ note?: string ≤ 300 }` | `{ subscriber }` — suppression `reason: 'admin'`, `source: 'admin'`, status `unsubscribed`, `removeSubscriber`; already suppressed → `SUBSCRIBER_NOT_ELIGIBLE`. |
| POST `/api/admin/subscribers/:id/erase` | admin | `{ confirmEmail: string }` (must equal the subscriber's current email, case-insensitive; else 400 `VALIDATION_FAILED`) | `{ deleted: true, erasureId, provider: 'deleted'\|'not_found'\|'skipped'\|'failed', providerError: string\|null, providerRetry: boolean }` — owner decision 2026-10-19: reads the Listmonk id, then `newsletter_erase_subscriber(id, actor)` (`spec/data.md` `0005`) deletes the subscriber and every row of its data (hashed marker + PII-free audit row stay), then `sender.deleteSubscriber` deletes the Listmonk record (not found / 404 = done; failure → `provider: 'failed'` with the reason, `warn`, blog0 stays deleted, retried by `pnpm newsletter:tick` when the id is known). Unknown or already deleted → 404 `NOT_FOUND`; the database refusing → 500 `ERASE_FAILED` naming the reason (nothing deleted). |
| GET `/api/admin/newsletter/settings` | admin | — | `NewsletterSettingsResponse` (`status.sender.healthy` is from a 3 s `healthcheck` on the listmonk adapter, `null` for the stub) |
| PATCH `/api/admin/newsletter/settings` | admin | `NewsletterSettingsPatch` | `NewsletterSettingsResponse`. Changing `mode` sets `modeSetAt = now`. Changing `consentText` without `consentVersion` bumps the version (`v1` → `v2`; a non-`vN` version gets `-2` appended). Never sends anything. |
| POST `/api/admin/newsletter/sync` | admin | `{ confirm: true }` | `{ synced: number, blocklisted: number, skipped: number, changed: number, suppressedFromProvider: number, errors: Array<{ email: string, message: string }> }` (`suppressedFromProvider` = confirmed rows suppressed in blog0 (source `provider`) because the provider holds an opt-out newer than their latest confirmation — never re-added; the opt-out-wins rule of `newsletter-list.md`; `changed = synced + blocklisted`; `errors[].message` never contains a subscriber email — the address is only in `errors[].email`) — the same operation as `pnpm newsletter:sync`. With the stub sender every row is `skipped` and `changed` is 0 (the button is harmless in designer mode); with listmonk unreachable → `SENDER_UNAVAILABLE`. `maxDuration = 120`. |
| GET `/api/admin/newsletter/issues` | admin | `?status=` optional | `IssueListResponse`, newest first |
| POST `/api/admin/newsletter/issues` | admin | `IssueCreateRequest` | 201 `IssueDetailResponse` (`origin: 'manual'`, `status: 'draft'`, event `created`); `ISSUE_POSTS_INVALID` |
| GET `/api/admin/newsletter/issues/:id` | admin | — | `IssueDetailResponse` |
| PATCH `/api/admin/newsletter/issues/:id` | admin | `IssueUpdateRequest` | `IssueDetailResponse` (event `updated`); `ISSUE_NOT_DRAFT`; `ISSUE_POSTS_INVALID` |
| DELETE `/api/admin/newsletter/issues/:id` | admin | — | `{ deleted: true }` (draft only, else `ISSUE_NOT_DRAFT`; events cascade) |
| GET `/api/admin/newsletter/issues/:id/preview` | admin | — | `IssuePreviewDto` — for a `draft`, re-snapshots the posts from their current published revisions first (persisted); for other statuses returns the frozen bodies. |
| POST `/api/admin/newsletter/issues/:id/test` | admin | — | `IssueTestResponse` — to the signed-in admin's email through the transactional transport; event `test_sent`; status unchanged; `MAIL_FAILED`. |
| POST `/api/admin/newsletter/issues/:id/send` | admin | `IssueSendRequest` | `IssueDetailResponse` with status `sent` (or `failed` + `lastError`, HTTP 502 `SENDER_FAILED` with the detail in `error.details.issue`). `ISSUE_NOT_DRAFT` unless `draft`, `failed`, or `sending` for more than 10 min (stuck — `spec/architecture.md` §13.5); `NO_RECIPIENTS`; `SENDER_UNAVAILABLE`. Runs the blog0→provider sync for confirmed subscribers first (listmonk only). `maxDuration = 120`. |
| POST `/api/admin/newsletter/issues/:id/stats` | admin | — | `IssueDetailResponse` with fresh `stats` (event `stats_fetched` — Stage A: appended only when a counter differs from the stored stats, so the issue page's 60 s auto-refresh never floods the send log; `fetchedAt` is always updated); `ISSUE_NOT_DRAFT` for drafts; `SENDER_FAILED` on a provider error (status unchanged). |

## Endpoints — Frozen — not scheduled (was Phase 4)

These endpoints are **Frozen — not scheduled** (user decision, 2026-10-13; never built). The three
`revisions` endpoints belong to `revision-history`, also **Frozen — not scheduled**; they stay here
as its contract.

| Method & path | Auth | Request | Response |
|---|---|---|---|
| GET `/api/admin/articles/:id/revisions` | admin | — | `{ revisions: Array<RevisionRefDto & { title, wordCount, isPublished, isCurrent }> }` newest first |
| GET `/api/admin/articles/:id/revisions/:revId` | admin | — | `{ revision: { …, title, dek, bodyMd }, preview: PreviewResultDto }` |
| POST `/api/admin/articles/:id/revisions/:revId/restore` | admin | `{ baseRevisionId }` | `{ article: ArticleDetailDto }` (new revision, `restoredFromRevisionId` set) |
| POST `/api/admin/articles/:id/submit` | admin | — | `{ article }` status `submitted` |
| POST `/api/admin/articles/:id/approve` | admin | — | `{ article }` status `approved` (approver may be the author in v0.1) |
| PUT `/api/admin/articles/:id/corrections` | admin | `{ noteMd: string \| null }` | `{ article }` (sets `corrections_updated_at`; shown publicly immediately on published articles) |
| GET `/api/admin/ai-usage` | admin | `?month=YYYY-MM` (default current, site timezone) | `{ month, totalUsd, generationCount, rows: Array<GenerationDto & { articleId, articleTitle }> }` |
| GET/POST `/api/admin/users` | admin | POST `{ email, displayName, password }` | `{ users: UserDto[] }` / `{ user }` |
| POST `/api/auth/password` | admin | `{ currentPassword, newPassword }` | `{ changed: true }` (other sessions of the user revoked) |
