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
| LLM_INVALID_OUTPUT | 502 | Model output invalid twice |
| LLM_RATE_LIMITED / LLM_UNAVAILABLE / LLM_TIMEOUT | 503 | Transient provider failure |
| LLM_NOT_CONFIGURED | 503 | Designer mode without an OpenRouter key; Generate refused before any row is written |
| RATE_LIMITED | 429 | Login/newsletter throttle; `Retry-After` header (Phase 5: counted in Postgres — `spec/capabilities/abuse-protection.md`) |
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
interface SentenceDto { sid: string; index: number; pid: string; text: string; words: number; headingPath: string[] }
interface DeckSlideDto { sid: string; text: string; source: 'jev' | 'writer'; reason: string | null; missing: boolean } // missing = sid/text no longer in current revision
interface GenerationDto {
  id: string; status: 'running' | 'succeeded' | 'failed'; model: string; promptVersion: string;
  requestedBy: string; startedAt: string; finishedAt: string | null; latencyMs: number | null; attempts: number;
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; costUsd: number | null;
  picks: Array<{ index: number; sid: string; reason: string }> | null;
  errorCode: string | null; errorMessage: string | null;
}
interface TldrStateDto {
  status: FormatStatus;
  bounds: { min: number; max: number; target: number } | null;   // null when 0 eligible sentences
  sentences: SentenceDto[];                                       // current revision, eligible only
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

> **Assumed:** `dbEngine` is part of the contract (the route always sets it); the optional `?` on
> `HealthDto.dbEngine` in `src/lib/api/dto.ts` is a leftover to tighten, not a behaviour.

## Endpoints — auth, articles, TLDR

| Method & path | Auth | Request | Response `data` / notes |
|---|---|---|---|
| POST `/api/auth/login` | none | `{ email: string, password: string }` | `{ user: UserDto }` + `Set-Cookie: blog0_session`. Errors: `BAD_CREDENTIALS`, `RATE_LIMITED`. |
| POST `/api/auth/logout` | admin | — | `{ signedOut: true }`, cookie cleared (also succeeds with no session). |
| GET `/api/auth/me` | admin | — | `{ user: UserDto }` |
| POST `/api/admin/preview` | admin | `{ title: string, dek: string, bodyMd: string }` (body ≤ 200 000 chars) | `PreviewResultDto` |
| GET `/api/admin/articles` | admin | — | `{ articles: ArticleListItemDto[] }` newest `updatedAt` first |
| POST `/api/admin/articles` | admin | `{ title, dek?, topic?, bodyMd? }` (limits above) | 201 `{ article: ArticleDetailDto }` — revision 1 created; slug derived from title (`slugify`, suffix `-2`… on collision) |
| GET `/api/admin/articles/:id` | admin | — | `{ article: ArticleDetailDto }` |
| PATCH `/api/admin/articles/:id` | admin | `{ baseRevisionId: string, title?, dek?, bodyMd?, topic?, slug?, bylineName?, isFeatured?, featuredRank?: number \| null, inProgress? }` (limits above) | `{ article: ArticleDetailDto, revisionCreated: boolean }`. `CONFLICT` if base ≠ current. Content unchanged → no new revision. `SLUG_TAKEN`, `SLUG_LOCKED`. While never published and slug never manually set, a title change re-derives the slug. |
| DELETE `/api/admin/articles/:id` | admin | — | `{ deleted: true }`; `NOT_DELETABLE` if ever published |
| GET `/api/admin/articles/:id/tldr` | admin | — | `TldrStateDto` |
| POST `/api/admin/articles/:id/tldr/generate` | admin | `{ revisionId: string }` (must be current) | `{ tldr: TldrStateDto, generation: GenerationDto }`. Errors: `CONFLICT`, `GENERATION_IN_PROGRESS`, `JEV_*`, `LLM_*` (the failed `GenerationDto` is in `error.details.generation`). Replaces the draft deck with Jev's picks on success. `maxDuration = 120`. |
| PUT `/api/admin/articles/:id/tldr` | admin | `{ revisionId: string, slides: Array<{ sid: string, source: 'jev' \| 'writer', reason?: string \| null }> }` | `{ tldr: TldrStateDto }`. Text is resolved server-side from `sid`. `DECK_INVALID`, `CONFLICT`. Empty `slides` array is not allowed — use DELETE. |
| DELETE `/api/admin/articles/:id/tldr` | admin | — | `{ tldr: TldrStateDto }` (draft deck cleared; published deck untouched) |
| POST `/api/admin/articles/:id/publish` | admin | `{ revisionId: string }` | `{ article: ArticleDetailDto }`; `PUBLISH_BLOCKED` with reasons; `CONFLICT`. Copies each format's draft to its published copy (Listen: any status; no draft clears the published Listen — `spec/capabilities/listen-audio.md`). |
| POST `/api/admin/articles/:id/unpublish` | admin | — | `{ article: ArticleDetailDto }` |

## Endpoints — public reads, site, newsletter

| Method & path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/api/public/articles/:slug/tldr` | none | — | `PublicTldrDto = { slug, title, topic, dek, meta: string, slides: Array<{ text: string }>, disclosure: string, times: { read: number, tldr: number, listen: number \| null }, shareUrl: string }` — published deck only, else 404. `times.listen` = the published recording's minutes or null. `Cache-Control: public, max-age=60`. |
| POST `/api/newsletter` | none | `{ email: string, name?: string }` | `{ subscribed: true }` (also for an already-subscribed address — no enumeration). Invalid bodies → 400 `VALIDATION_FAILED` before any rate-limit counting. `RATE_LIMITED` (429 + `Retry-After`) per the caps in `spec/architecture.md` §6. |
| GET `/api/admin/subscribers` | admin | `?format=csv` optional | `{ subscribers: Array<{ email, name, createdAt, status }>, total }` or CSV download |
| GET `/api/admin/site` | admin | — | `{ site: { tagline, contactEmail, aboutStrap, aboutStand, aboutBodyMd, socialXUrl, socialLinkedinUrl } }` |
| PATCH `/api/admin/site` | admin | any subset of the above | `{ site: … }` |

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

## Endpoints — Phase 4 (on hold)

Phase 4 is on hold (user decision, 2026-10-13). The three `revisions` endpoints belong to
`revision-history`, which is **deferred**; they stay here as its contract.

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
