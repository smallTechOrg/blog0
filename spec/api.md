# blog0 — HTTP API contract

Single origin. JSON in/out (`Content-Type: application/json`) except uploads (multipart) and
media streaming. Every JSON response uses the envelope (`src/lib/api/envelope.ts`):

```ts
type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: { code: string; message: string; details?: unknown; requestId: string } };
```

Every response has header `x-request-id`. Auth column: **admin** = valid `blog0_session` cookie
(else 401 `UNAUTHENTICATED`); **none** = public. All mutating routes (POST/PUT/PATCH/DELETE)
require a same-origin `Origin` header (else 403 `FORBIDDEN_ORIGIN`). Bodies are validated with
zod (else 400 `VALIDATION_FAILED`, `details` = flattened zod issues). Ids are uuids (malformed →
404 `NOT_FOUND`). The shared DTOs and Phase 1 types below are transcribed verbatim into
`src/lib/api/dto.ts` by the scaffold; DTOs introduced in Phase N ≥ 2 go into
`src/lib/api/dto-phase<N>.ts`, owned by that phase's first-listed backend slice (S2.2, S3.3,
S4.1), and other slices of that phase code against the shapes written here.

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
| PUBLISH_BLOCKED | 422 | Publish validation failed; `details: { reasons: Array<{ code, message, sids? }> }` (codes: `TITLE_REQUIRED`, `TOPIC_REQUIRED`, `BODY_REQUIRED`, `TLDR_DECK_STALE`; `LISTEN_STALE` was removed by the Phase 3 fix — Listen never blocks publish) |
| DECK_INVALID | 422 | Deck save: unknown/duplicate sid or count outside 1–12; `details.sids` |
| MARKS_INVALID | 422 | Listen sync save (Phase 3; aligner-facing `PUT …/listen`): `details: { reasons: Array<{ code: 'UNKNOWN_PID' \| 'MISSING_PID' \| 'DUPLICATE_PID' \| 'OUT_OF_ORDER' \| 'NOT_INCREASING' \| 'OUT_OF_RANGE', pid?: string, index?: number }> }` |
| LISTEN_NO_AUDIO | 409 | Listen sync save without an uploaded draft recording (Phase 3) |
| AUDIO_TOO_LONG | 422 | Recording longer than `BLOG0_MAX_AUDIO_MINUTES` (Phase 3); message carries both values |
| IMAGE_TOO_LARGE | 422 | Image wider or taller than 12 000 px (Phase 3) |
| JEV_NO_SENTENCES / JEV_INPUT_TOO_LONG | 422 | Guard failures (no LLM call) |
| LLM_AUTH / LLM_INSUFFICIENT_CREDITS / LLM_MODEL_NOT_FOUND | 502 | Provider config problems (message points at `.env`) |
| LLM_RATE_LIMITED / LLM_UNAVAILABLE / LLM_TIMEOUT | 503 | Transient provider failure |
| LLM_INVALID_OUTPUT | 502 | Model output invalid twice |
| LLM_NOT_CONFIGURED | 503 | Phase 2, designer mode only: no OpenRouter key; Generate refused before any row is written |
| RATE_LIMITED | 429 | Login/newsletter throttle; `Retry-After` header |
| PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA | 413 / 415 | Uploads (Phase 3): over `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_IMAGE_MB` (checked on `Content-Length` and while reading) / content not in the allowlist (detected from bytes; message names the detected type) |
| DB_UNAVAILABLE | 503 | Health check only |
| INTERNAL | 500 | Unexpected |

## Shared DTOs

```ts
type FormatKind = 'read' | 'tldr' | 'listen';
type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'text_changed' | 'unavailable';
// Phase 3 fix: 'needs_sync' removed (unreachable — upload ⇒ ready); 'text_changed' added (Listen only, non-blocking warning)
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
  jevAvailable: boolean;                                          // Phase 2: false only when no OpenRouter key is configured (designer mode)
}
```

## Endpoints — Scaffold

| Method & path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/api/health` | none | — | `{ status: 'ok', db: 'ok', dbLatencyMs: number, version: string, uptimeSec: number, dbEngine?: 'postgres' \| 'pglite' }` (`dbEngine` added in Phase 2, S2.8); DB down → 503 `DB_UNAVAILABLE` (generic envelope; fixed message, no `details`, never the raw driver error — that is logged server-side) |

## Endpoints — Phase 1

| Method & path | Auth | Request | Response `data` / notes |
|---|---|---|---|
| POST `/api/auth/login` | none | `{ email: string, password: string }` | `{ user: UserDto }` + `Set-Cookie: blog0_session`. Errors: `BAD_CREDENTIALS`, `RATE_LIMITED`. |
| POST `/api/auth/logout` | admin | — | `{ signedOut: true }`, cookie cleared (also succeeds with no session). |
| GET `/api/auth/me` | admin | — | `{ user: UserDto }` |
| POST `/api/admin/preview` | admin | `{ title: string, dek: string, bodyMd: string }` (body ≤ 200 000 chars) | `PreviewResultDto` |
| GET `/api/admin/articles` | admin | — | `{ articles: ArticleListItemDto[] }` newest `updatedAt` first |
| POST `/api/admin/articles` | admin | `{ title: string (1–200), dek?: string, topic?: string, bodyMd?: string }` | 201 `{ article: ArticleDetailDto }` — revision 1 created; slug derived from title (`slugify`, suffix `-2`… on collision) |
| GET `/api/admin/articles/:id` | admin | — | `{ article: ArticleDetailDto }` |
| PATCH `/api/admin/articles/:id` | admin | `{ baseRevisionId: string, title?, dek?, bodyMd?, topic?, slug?, bylineName?, isFeatured?, featuredRank?: number \| null, inProgress? }` | `{ article: ArticleDetailDto, revisionCreated: boolean }`. `CONFLICT` if base ≠ current. Content unchanged → no new revision. `SLUG_TAKEN`, `SLUG_LOCKED`. While never published and slug never manually set, a title change re-derives the slug. |
| DELETE `/api/admin/articles/:id` | admin | — | `{ deleted: true }`; `NOT_DELETABLE` if ever published |
| GET `/api/admin/articles/:id/tldr` | admin | — | `TldrStateDto` |
| POST `/api/admin/articles/:id/tldr/generate` | admin | `{ revisionId: string }` (must be current) | `{ tldr: TldrStateDto, generation: GenerationDto }`. Errors: `CONFLICT`, `GENERATION_IN_PROGRESS`, `JEV_*`, `LLM_*` (the failed `GenerationDto` is in `error.details.generation`). Replaces the draft deck with Jev's picks on success. |
| PUT `/api/admin/articles/:id/tldr` | admin | `{ revisionId: string, slides: Array<{ sid: string, source: 'jev' \| 'writer', reason?: string \| null }> }` | `{ tldr: TldrStateDto }`. Text is resolved server-side from `sid`. `DECK_INVALID`, `CONFLICT`. Empty `slides` array is not allowed — use DELETE. |
| DELETE `/api/admin/articles/:id/tldr` | admin | — | `{ tldr: TldrStateDto }` (draft deck cleared; published deck untouched) |
| POST `/api/admin/articles/:id/publish` | admin | `{ revisionId: string }` | `{ article: ArticleDetailDto }`; `PUBLISH_BLOCKED` with reasons; `CONFLICT` |
| POST `/api/admin/articles/:id/unpublish` | admin | — | `{ article: ArticleDetailDto }` |

## Endpoints — Phase 2

| Method & path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/api/public/articles/:slug/tldr` | none | — | `{ slug, title, topic, dek, meta: string, slides: Array<{ text: string }>, disclosure: string, times: { read: number, tldr: number, listen: number \| null }, shareUrl: string }` — published only, else 404. `Cache-Control: public, max-age=60`. (`times.listen` becomes real in Phase 3: the published recording's minutes, else null.) |
| POST `/api/newsletter` | none | `{ email: string, name?: string }` | `{ subscribed: true }` (also for an already-subscribed address — no enumeration). Invalid bodies → 400 `VALIDATION_FAILED` before any rate-limit counting. `RATE_LIMITED` (429 + `Retry-After`) when any cap is hit: 3 per lower-cased email per hour, 300 per site per hour, and 10 per client IP per hour — the per-IP cap applies only when a real client IP is derived (`BLOG0_TRUSTED_PROXY_HOPS` > 0); with `direct`/`unknown` it is skipped (`spec/architecture.md` §6). Production behind a proxy must set `BLOG0_TRUSTED_PROXY_HOPS`. |
| GET `/api/admin/subscribers` | admin | `?format=csv` optional | `{ subscribers: Array<{ email, name, createdAt, status }>, total }` or CSV download |
| GET `/api/admin/site` | admin | — | `{ site: { tagline, contactEmail, aboutStrap, aboutStand, aboutBodyMd, socialXUrl, socialLinkedinUrl } }` |
| PATCH `/api/admin/site` | admin | any subset of the above | `{ site: … }` |

## Phase 3 DTOs (`src/lib/api/dto-phase3.ts`, owned by S3.3)

```ts
// Phase 3 fix: missing = no draft audio; ready = audio uploaded and the paragraph text unchanged since;
// text_changed = the current paragraphs fingerprint ≠ the draft's uploadFingerprint (warning only, never blocks).
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
  marks: ListenMarkDto[];                                                // STORED draft marks (aligner / legacy tap data; [] normally) — not what readers get
  timing: ListenTiming | null;                                           // what readers would get over the CURRENT text (resolveMarks); null without audio
  uploadFingerprint: string | null;                                      // paragraphs fingerprint at upload (legacy rows: syncFingerprint)
  textChangedSinceUpload: boolean;                                       // === (status === 'text_changed')
  syncFingerprint: string | null; syncedAt: string | null; syncedBy: string | null;   // set by PUT only
  published: { durationMs: number; publishedAt: string; sameAudioAsDraft: boolean } | null;   // sameAudioAsDraft: published audio.key === draft audio.key
  limits: { maxAudioMb: number; maxAudioMinutes: number };
}
// Phase 3 fix: missingPids / orphanPids and published.markCount / matchesCurrentText are removed.
interface ListenSaveRequest { revisionId: string; marks: ListenMarkDto[] }   // aligner-facing (Phase 6) — no admin UI caller
interface ListenResponse { listen: ListenStateDto }

interface ImageUploadResponse {
  asset: { id: string; key: string; url: string; mimeType: ImageMime; bytes: number; width: number; height: number };
  markdown: string;                                                      // '![alt](/media/<key>)' or '![alt](/media/<key> "caption")'
}

// Public (reader) — the Listen view model (also in src/lib/view-models.ts as ListenViewModel)
interface PublicListenDto {
  slug: string; title: string; topic: string; dek: string; meta: string;  // meta = "<date> · <read> min read" as the deck's
  audio: { url: string; mimeType: AudioMime; durationMs: number };
  marks: ListenMarkDto[];                                                // resolveMarks(published stored marks, published revision's paragraphs, durationMs) — computed per request, one per published paragraph
  timing: ListenTiming;
  bylineName: string;
  times: { read: number; tldr: number | null; listen: number };
  shareUrl: string;                                                      // absolute …/p/<slug>/listen
}
```

`FormatChipDto` and `ArticleListItemDto` are unchanged in shape: the `listen` chip's `status` is
`missing | ready | text_changed` from the Phase 3 fix (`spec/architecture.md` §5).

## Endpoints — Phase 3

Uploads are `multipart/form-data` (`withApi({ auth: 'admin', csrf: true, body: 'multipart' })`
— the wrapper enforces `Origin`, parses the form with the Web `request.formData()`, and
applies the declared `Content-Length` pre-check). All other rules of the envelope apply.

| Method & path | Auth | Request | Response `data` / notes |
|---|---|---|---|
| POST `/api/admin/uploads/images` | admin | multipart: `file` (required), `alt` (string ≤ 200, default `''`), `caption?` (≤ 200), `articleId?` (uuid of an article in this site, else 404) | 201 `ImageUploadResponse`. Errors: `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA` (incl. SVG), `IMAGE_TOO_LARGE`, `VALIDATION_FAILED`. |
| POST `/api/admin/articles/:id/audio` | admin | multipart: `file` (required) | 200 `ListenResponse` with `status 'ready'`, `marks []`, `timing 'estimated'` (stored marks are cleared on upload), `uploadFingerprint` = the current revision's paragraphs fingerprint. Replaces the draft recording (old unpublished file + row deleted). Errors: `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA`, `AUDIO_TOO_LONG`. Exports `maxDuration = 120`. |
| DELETE `/api/admin/articles/:id/audio` | admin | — | 200 `ListenResponse` with `status 'missing'`, `audio null`, `marks []` (draft cleared; published Listen untouched; unpublished file + row deleted). Idempotent. |
| GET `/api/admin/articles/:id/listen` | admin | — | `ListenStateDto` |
| PUT `/api/admin/articles/:id/listen` | admin | `ListenSaveRequest` — `revisionId` must be current | **Internal / aligner-facing** (Phase 6 writes aligned marks here; tests use it; no admin UI calls it). 200 `ListenResponse` (status computed as usual — a PUT never changes it). Errors: `CONFLICT`, `LISTEN_NO_AUDIO`, `MARKS_INVALID` (rules: `spec/capabilities/listen-sync.md`). Stores `marks`, sets `syncFingerprint` = the revision's paragraphs fingerprint, `syncedAt`/`syncedBy`, `draft_revision_id`; never touches `uploadFingerprint`. |
| GET `/api/public/articles/:slug/listen` | none | — | `PublicListenDto` — only when the article is published **and** has a published Listen, else 404. `Cache-Control: public, max-age=60`. |
| GET / HEAD `/media/[...key]` | none | `Range`, `If-None-Match`, `If-Range` optional | Not JSON. 200 full body / 206 one range (`Content-Range: bytes a-b/size`) / 304 (`If-None-Match` equal) / 416 (`Content-Range: bytes */size`, empty body). Always: `Content-Type` (stored mime), `Accept-Ranges: bytes`, `ETag: "<sha256>"`, `Last-Modified`, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `x-request-id`. Invalid key, unknown key, or file missing on disk → 404 `NOT_FOUND` as a JSON envelope. Methods other than GET/HEAD → 405. |

`POST /api/admin/articles/:id/publish` (Phase 1): **Listen never blocks publishing** (Phase 3
fix — the Phase 3 `LISTEN_STALE` reason and the `missingPids?`/`orphanPids?` fields are removed;
the reasons array is back to `Array<{ code, message, sids? }>`). Publishing copies the Listen
draft (any status) to the published copy, or clears the published copy when there is no draft
(`spec/capabilities/listen-audio.md`).

## Endpoints — Phase 4 (on hold)

Phase 4 is on hold (user decision, 2026-10-13). The three `revisions` endpoints below belong to
`revision-history`, which is **deferred** (not part of Phase 4 any more); they stay here as its
contract.

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
