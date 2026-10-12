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
| PUBLISH_BLOCKED | 422 | Publish validation failed; `details: { reasons: Array<{ code, message, sids? }> }` (codes: `TITLE_REQUIRED`, `TOPIC_REQUIRED`, `BODY_REQUIRED`, `TLDR_DECK_STALE`, `LISTEN_STALE`) |
| DECK_INVALID | 422 | Deck save: unknown/duplicate sid or count outside 1–12; `details.sids` |
| JEV_NO_SENTENCES / JEV_INPUT_TOO_LONG | 422 | Guard failures (no LLM call) |
| LLM_AUTH / LLM_INSUFFICIENT_CREDITS / LLM_MODEL_NOT_FOUND | 502 | Provider config problems (message points at `.env`) |
| LLM_RATE_LIMITED / LLM_UNAVAILABLE / LLM_TIMEOUT | 503 | Transient provider failure |
| LLM_INVALID_OUTPUT | 502 | Model output invalid twice |
| RATE_LIMITED | 429 | Login/newsletter throttle; `Retry-After` header |
| PAYLOAD_TOO_LARGE / UNSUPPORTED_MEDIA | 413 / 415 | Uploads (Phase 3) |
| DB_UNAVAILABLE | 503 | Health check only |
| INTERNAL | 500 | Unexpected |

## Shared DTOs

```ts
type FormatKind = 'read' | 'tldr' | 'listen';
type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'needs_sync' | 'unavailable';
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
}
```

## Endpoints — Scaffold

| Method & path | Auth | Request | Response `data` |
|---|---|---|---|
| GET `/api/health` | none | — | `{ status: 'ok', db: 'ok', dbLatencyMs: number, version: string, uptimeSec: number }`; DB down → 503 `DB_UNAVAILABLE` (generic envelope; fixed message, no `details`, never the raw driver error — that is logged server-side) |

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
| GET `/api/public/articles/:slug/tldr` | none | — | `{ slug, title, topic, dek, meta: string, slides: Array<{ text: string }>, disclosure: string, times: { read: number, tldr: number, listen: number \| null }, shareUrl: string }` — published only, else 404. `Cache-Control: public, max-age=60`. |
| POST `/api/newsletter` | none | `{ email: string, name?: string }` | `{ subscribed: true }` (also for an already-subscribed address — no enumeration). `RATE_LIMITED` (10 per IP per hour). |
| GET `/api/admin/subscribers` | admin | `?format=csv` optional | `{ subscribers: Array<{ email, name, createdAt, status }>, total }` or CSV download |
| GET `/api/admin/site` | admin | — | `{ site: { tagline, contactEmail, aboutStrap, aboutStand, aboutBodyMd, socialXUrl, socialLinkedinUrl } }` |
| PATCH `/api/admin/site` | admin | any subset of the above | `{ site: … }` |

## Endpoints — Phase 3

| Method & path | Auth | Request | Response |
|---|---|---|---|
| POST `/api/admin/uploads/images` | admin | multipart `file` (png/jpeg/webp/gif ≤ `BLOG0_MAX_IMAGE_MB`), `articleId?`, `alt?` | `{ asset: { id, url: '/media/<key>', width, height }, markdown: '![alt](/media/<key>)' }` |
| POST `/api/admin/articles/:id/audio` | admin | multipart `file` (audio/mpeg or audio/mp4, ≤ `BLOG0_MAX_AUDIO_MB`, ≤ `BLOG0_MAX_AUDIO_MINUTES`) | `{ listen: ListenStateDto }` (replaces the draft audio; cues cleared) |
| DELETE `/api/admin/articles/:id/audio` | admin | — | `{ listen: ListenStateDto }` |
| GET `/api/admin/articles/:id/listen` | admin | — | `ListenStateDto = { status, audio: { url, durationSec, mimeType } \| null, paragraphs: Array<{ pid, text, index }>, draftCues: Array<{ pid, startSec }> \| null, missingPids: string[], published: boolean }` |
| PUT `/api/admin/articles/:id/listen` | admin | `{ revisionId, cues: Array<{ pid, startSec }> }` | `{ listen: ListenStateDto }`; 422 `CUES_INVALID` (pid unknown, not strictly increasing, ≥ duration, first cue > 0 allowed) |
| GET `/media/:key*` | none | `Range` optional | 200 full or 206 partial (`Accept-Ranges: bytes`, `Content-Range`), 416 on bad range; `Cache-Control: public, max-age=31536000, immutable` |

## Endpoints — Phase 4

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
