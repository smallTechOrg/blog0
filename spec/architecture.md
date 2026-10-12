# blog0 — Architecture

Product narrative lives in `spec/roadmap.md` and `spec/capabilities/`. Data model: `spec/data.md`.
HTTP contract: `spec/api.md`. Screens and the design-component mapping: `spec/ui.md`. Jev (the only
AI capability): `spec/agent.md`. This file owns the HOW: system design, stack, layout, conventions,
and the list of deliberate design divergences.

## 1. System overview

One Next.js (App Router) process serves everything on a single origin (default
`http://localhost:3410`):

```
                    ┌──────────────────────────── Next.js process (Node 22) ─────────────────────────────┐
 Reader browser ──► │ (site) server components ──► src/server/public ──► content pipeline (render, cache) │
                    │      └─ client islands: Masthead, TldrDeck, ArticleView, ListenView, figures, PrintIn│
 Writer browser ──► │ /admin pages (server guard) + client editor ──► /api/admin/* route handlers         │
                    │      route handlers ──► withApi (envelope, auth, origin check, request log)         │
                    │                    ──► services: articles, formats, jev, listen, media, users, site │
                    │      jev ──► llm/openrouter adapter ──► https://openrouter.ai/api/v1 (one call/click)│
                    │      services ──► drizzle ──► Postgres (blog0_dev / blog0_test) | PGlite (§11)       │
                    │      storage interface ──► local disk BLOG0_STORAGE_DIR ──► /media/[...key]         │
                    └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Reader pages are server-rendered on every request** (`export const dynamic = 'force-dynamic'`)
  from published data only; interactive parts are client components hydrated on top. With < 100
  articles and an in-memory render cache this is fast and keeps `next build` free of any DB
  access.
- **Admin** is a set of authenticated pages whose client components call JSON route handlers
  under `/api/admin/*` (contract in `spec/api.md`). No Server Actions — one testable HTTP contract.
- **No LLM call ever happens on a reader path.** The only LLM call is Jev, behind
  `POST /api/admin/articles/:id/tldr/generate`.

## 2. Components

| Component | Path | Responsibility |
|---|---|---|
| Config | `src/server/config.ts` | Typed, validated env (`BLOG0_*`), resettable singleton, secrets redacted on serialisation. |
| Logger | `src/server/log.ts` | JSON-lines structured logger to stdout (+ optional `BLOG0_LOG_FILE`); test sink. |
| DB | `src/server/db/*` | Drizzle over either engine (postgres.js for `postgres://`, PGlite for `pglite://` — §11), schema, programmatic migrator. |
| HTTP kit | `src/server/http/api.ts` | `withApi()` wrapper: request id, auth guard, origin check, zod/multipart body parsing, envelope, error mapping, request/response log line. |
| Auth | `src/server/auth/*` | Sessions, password hashing, login + throttle, guards for route handlers and pages. |
| Throttle core | `src/server/rate-window.ts` | `FixedWindowCounter` shared by the login and newsletter limits (§6). |
| Site | `src/server/site/*` | Resolve the current site (`BLOG0_SITE_SLUG`), cache it (§11.4), admin edits. |
| Content pipeline | `src/server/content/*` | Markdown → `RenderedArticle` (blocks, paragraphs, sentences, stats, fingerprints, warnings). Deterministic. |
| Formats | `src/server/formats/*` | One adapter per format kind (`read`, `tldr`, `listen`) implementing status, chip flags, validation, publish (§5). |
| Articles | `src/server/articles/*` | Create, save (revision), publish/unpublish, delete draft, TLDR generate orchestration + deck save. |
| LLM | `src/server/llm/*` | `LlmClient` interface + OpenRouter adapter (retry/backoff/timeout, instrumentation), key presence check. |
| Jev | `src/server/jev/*` | The TLDR selection agent (see `spec/agent.md`). |
| Listen | `src/server/listen/*` | Audio probe + ingest, Listen state, aligner-facing marks save (§9.5). |
| Media | `src/server/media/*`, `src/server/storage/*` | Upload pipeline, image probe, byte ranges, cleanup; `Storage` interface + `LocalDiskStorage` (§9). |
| Newsletter | `src/server/newsletter/*` | Signup service + its throttle. |
| Designer | `src/server/designer/*` | Generated session secret + designer admin, in-process `dev:design` setup (§11). |
| Public queries | `src/server/public/*` | Published-only reads → view models for reader components. |
| Reader UI | `src/components/{design,site,reader,figures}` | Faithful port of `spec/design/design-app.js` (mapping in `spec/ui.md`). |
| Admin UI | `src/components/admin/*`, `src/app/admin/*` | Desk, editor (Write/TLDR/Listen/History), Site, Subscribers. |

## 3. Key flows

**Preview (live Read preview).** Editor textarea → debounced 300 ms → `POST /api/admin/preview`
`{title, dek, bodyMd}` → `renderArticle()` → `{blocks, warnings, stats, sentenceCount}` → the
client renders `<ReadHead>` + `<ArticleBody blocks>` — the very components the public page uses,
so preview == published. In-flight requests are aborted when a newer one starts.

**Save.** `PATCH /api/admin/articles/:id` with `baseRevisionId`. In one transaction: if
`baseRevisionId ≠ article.current_revision_id` → 409 `CONFLICT`. Content fields (title, dek, body)
changed → render, insert `article_revision` (number+1, fingerprints, word count), point
`current_revision_id` at it. Metadata fields (topic, slug, byline, featured, rank, in-progress
badge) update the `article` row directly (not revisioned).

**Generate (Jev).** `POST /api/admin/articles/:id/tldr/generate` `{revisionId}` (must equal
current, else 409) → render the revision (cache) → `computeBounds` + `guardInput` from
`src/server/jev` (0 eligible sentences or input too long → 422, **no row, no call**) → in one
transaction that locks the article row (`SELECT … FOR UPDATE`): refuse if a generation for this
article is `running` and younger than 3 min (409 `GENERATION_IN_PROGRESS`), else insert
`ai_generation` (status `running`) and commit → `runJev()` (outside the transaction) → on success
update the row (succeeded, picks, usage, cost, latency) and replace the TLDR **draft** payload with
slides built **from the server's own sentence list** (never from model text) → return the deck +
generation record. On failure update the row (failed, error_code, error_message, raw outputs) and
return the mapped error; the draft deck is untouched. The row lock makes a double click produce
exactly one row.

**Deck edit.** `PUT /api/admin/articles/:id/tldr` `{revisionId, slides:[{sid, source, reason?}]}`
→ server resolves each `sid` against the revision's sentences (text comes from the server), checks
uniqueness and 1–12 slides → stores draft payload + fingerprint.

**Publish.** `POST /api/admin/articles/:id/publish` `{revisionId}` (= current) → validates title,
topic and body present → each registered format adapter `validateForPublish()` (TLDR: every draft
slide's `sid`+text still exists in the revision; a missing deck is allowed — the TLDR mode is then
disabled for readers; Listen never blocks) → one transaction: `published_revision_id`,
`status='published'`, `first_published_at ??= now`, `last_published_at = now`, adapters
`publish()` copy draft → published payloads. Readers read only published payloads, so later edits
never disturb what is live.

**Public article.** `/p/[slug]`, `/p/[slug]/tldr` and `/p/[slug]/listen` are one page built by the
`articleRoute(initialMode)` factory (`src/app/(site)/p/[slug]/_lib/article-route.tsx`; each
`page.tsx` is `articleRoute('read' | 'tldr' | 'listen')`) → `loadArticlePage(slug)`
(`src/server/public/page-data.ts`) → render the **published** revision (cached by revision id +
`RENDER_VERSION`) → `ArticleViewModel` → `<ArticleView initialMode>`. Without the published format
the page falls back to Read. Opening/closing the deck or Listen calls `history.replaceState`
between `/p/<slug>` and `/p/<slug>/{tldr,listen}` (mirrors the design's `replaceState` hash
behaviour; no remount, no navigation).

View-model contract (`src/lib/view-models.ts`):

```ts
export interface SiteViewModel { wordmark: string; tagline: string; publisherName: string; contactEmail: string;
  aboutStrap: string; aboutStand: string; aboutBodyParagraphs: string[]; socialXUrl: string | null; socialLinkedinUrl: string | null;
  topics: string[]; year: number }
export interface DeckViewModel { slides: Array<{ text: string }>; disclosure: string; shareUrl: string }   // shareUrl absolute …/p/<slug>/tldr
export interface ListenViewModel {
  audioUrl: string;                  // '/media/' + key (same-origin)
  mimeType: 'audio/mpeg' | 'audio/mp4';
  durationMs: number;
  marks: Array<{ pid: string; tMs: number }>;   // resolveMarks over the PUBLISHED revision's paragraphs, per request (§9.4)
  timing: 'synced' | 'estimated';
  shareUrl: string;                  // absolute …/p/<slug>/listen
}
export interface ArticleViewModel {
  slug: string; title: string; dek: string; topic: string; bylineName: string;
  publishedLabel: string;            // fmtDate(first_published_at, site tz) e.g. "8 Sep 2026"
  updatedLabel: string | null;       // Phase 4 (on hold): always null
  inProgress: boolean;
  blocks: Block[];                   // from RenderedArticle
  times: { read: number; tldr: number | null; listen: number | null };
  deck: DeckViewModel | null;        // published deck only
  listen: ListenViewModel | null;    // published Listen only
  correctionsHtml: string | null;    // Phase 4 (on hold): always null
  next: { slug: string; title: string } | null;
  articleUrl: string;                // absolute
}
export interface PostCardViewModel { slug: string; title: string; dek: string; topic: string; publishedLabel: string;
  inProgress: boolean; times: { tldr: number | null; listen: number | null } }
```
Disclosure text (`deckDisclosure()` in the same file): all slides `source: 'jev'` → "Lines
selected by Jev (AI), verbatim from the article."; mix → "Lines selected by Jev (AI) and the
editors, verbatim from the article."; none from Jev → "Lines selected by the editors, verbatim
from the article."

## 4. Content pipeline (deterministic; `src/server/content`)

`renderArticle({ title, dek, bodyMd }): Promise<RenderedArticle>` — types in
`src/lib/content/types.ts`:

```ts
export type Block =
  | { kind: 'html'; html: string }
  | { kind: 'figure'; figureId: string; known: boolean };
export interface Paragraph { pid: string; index: number; text: string; kind: 'p' | 'li' | 'quote'; headingPath: string[] }
export interface Sentence { sid: string; index: number; pid: string; text: string; words: number }
export interface RenderWarning { code: 'UNKNOWN_FIGURE' | 'RAW_HTML_DROPPED' | 'EMPTY_BODY' | 'UNKNOWN_CODE_LANG'; message: string; line?: number }
export interface RenderedArticle {
  blocks: Block[]; paragraphs: Paragraph[]; sentences: Sentence[];   // sentences = eligible only, index 0..N-1
  stats: { words: number; readMinutes: number };
  fingerprints: { body: string; paragraphs: string; sentences: string };
  warnings: RenderWarning[];
}
```

Pipeline (unified): `remark-parse` → `remark-gfm` (tables, footnotes, strikethrough, autolinks,
task lists) → `figureMarkers` (a paragraph whose entire trimmed text matches
`^@@fig:([a-z0-9-]+)@@$` becomes a figure node; `known` = id in the figure registry list
`KNOWN_FIGURES = ['slide47','ab-companies']` exported from `src/lib/content/types.ts`) →
`headingShift` (design rule: the shallowest heading level used becomes h2, others nest, capped at
h4) → `paragraphIds` (below) → `remark-rehype` (raw HTML **not** allowed → dropped, warning
`RAW_HTML_DROPPED`; `footnoteLabel: 'Notes'`, `footnoteLabelTagName: 'h2'`,
`footnoteLabelProperties: { className: ['footnotes-label'] }`) → `rehype-slug` (heading ids) →
`externalLinks` (every `a` gets class `inline`; absolute http(s) links get
`target=_blank rel="noopener noreferrer"`) → `images` (an image alone in a paragraph →
`<figure class="mdfig"><img loading="lazy" alt><figcaption>title</figcaption></figure>`; inline
images → `img.mdimg`) → `@shikijs/rehype` (themes `github-light` / `github-dark`,
`defaultColor: false`; preloaded langs: ts, tsx, js, jsx, json, bash, shell, python, sql, yaml,
markdown, html, css, go, rust, diff; unknown lang → plaintext + warning) → split top-level hast
children into `Block[]` at figure nodes, each html block serialised with `rehype-stringify`.
Plugins live in `src/server/content/plugins/` (also `tables`, `safe-urls`, `raw-html`, `code-langs`).

**Paragraph ids (stable bookmarks).** Every mdast `paragraph` (top level, in list items, in
blockquotes; not in tables or footnote definitions) gets
`pid = 'p-' + sha256(normalize(plainText)).slice(0, 8)`; duplicates in the same article get `-2`,
`-3` in document order. `normalize` = NFC, collapse whitespace, trim. The id + `data-pid` + class
`para` are attached to the rendered `<p>`; for paragraphs inside a **tight** list item they are
attached to the `<li>` instead (remark-rehype unwraps tight paragraphs). Ids depend only on the
paragraph's own text, so editing one paragraph never moves another's bookmark.

**Plain text** of a paragraph: concatenate text, inlineCode values, link/emphasis/strong/delete
children; images and footnote references contribute nothing; `break` → space; collapse
whitespace.

**Sentences.** For each paragraph's plain text: `new Intl.Segmenter('en', { granularity:
'sentence' })`, trim segments, then merge a segment into the next when it ends with an
abbreviation from `ABBREVIATIONS = ['e.g.','i.e.','etc.','vs.','Mr.','Mrs.','Ms.','Dr.','Prof.',
'St.','No.','Fig.','U.S.','U.K.','approx.','cf.','al.']` or with a single capital letter + `.`
(initials). `sid = pid + '-s' + k` (k counts all sentences of the paragraph). A sentence is
**eligible** (sent to Jev, offered to the hand-picker, usable in a deck) when it has ≥ 5
whitespace-separated words (design rule). `Sentence.index` is the position among eligible
sentences. Determinism relies on Node 22's bundled ICU — Node is pinned.

**Fingerprints.** sha256 hex of: `body` = normalized title + dek + bodyMd; `paragraphs` =
`pid + '\u0000' + text` joined by `\n`; `sentences` = `sid + '\u0000' + text` joined by `\n`. TLDR
staleness compares the `sentences` fingerprint; the Listen `text_changed` warning compares
`paragraphs` (against the fingerprint recorded at upload).

**Stats.** `words` = word count of all paragraph plain text; `readMinutes = max(1, ceil(words / 230))`.

**Cache.** `src/server/content/cache.ts`: LRU (max 200 entries) keyed by
`revisionId + ':' + RENDER_VERSION` (`RENDER_VERSION = 'r1'`, bump on any pipeline change).
Preview renders are not cached.

## 5. Formats model

`src/lib/formats/registry.ts` is the single list of format kinds:

```ts
export const FORMAT_KINDS = ['read', 'tldr', 'listen'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];
export type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'text_changed';
export const FORMATS: Record<FormatKind, { label: string; icon: 'text' | 'bolt' | 'headphones' }> = {
  read: { label: 'Read', icon: 'text' },
  tldr: { label: 'TLDR', icon: 'bolt' },
  listen: { label: 'Listen', icon: 'headphones' },
};
```

The DB stores `article_format.kind` as text (no enum/check) so a new kind needs no migration.
Server adapters (`src/server/formats/{read,tldr,listen}.ts`, registered in
`src/server/formats/index.ts`) implement the contract in `src/server/formats/types.ts`:

```ts
export type PublishCheck = { ok: true } | { ok: false; code: string; message: string; details?: unknown };
export interface StatusContext { row: ArticleFormatRow | null; currentRevision: RevisionRow; latestGeneration?: AiGenerationRow | null; now: Date }
export interface ChipContext { article: Pick<ArticleRow, 'status' | 'currentRevisionId' | 'publishedRevisionId'>; row: ArticleFormatRow | null }
export interface FormatAdapter {
  kind: FormatKind;
  computeStatus(ctx: StatusContext): FormatStatus;
  isPublished(ctx: ChipContext): boolean;            // readers currently get this format
  hasUnpublishedChanges(ctx: ChipContext): boolean;  // working copy differs from what readers get
  validateForPublish(ctx: { row: ArticleFormatRow | null; revision: RevisionRow; rendered: RenderedArticle }): PublishCheck;
  publish(tx: Tx, ctx: { row: ArticleFormatRow | null; revision: RevisionRow; userId: string; now: Date }): Promise<void>;
}
export const GENERATION_STALE_MS = 3 * 60 * 1000;   // isGenerationActive(gen, now); publishDraft(tx, row, draft, published) shared helper
```

Status rules: **read** → `ready` if the current revision body is non-empty else `missing`.
**tldr** → `generating` if the latest generation is `running` and < 3 min old; else `ready` if a
draft payload exists and its `sentences` fingerprint equals the current revision's; `stale` if it
exists and differs; `failed` if no draft and the latest generation failed; else `missing`.
**listen** — with `draft = readListenPayload(row?.draftPayload)` and `baseline =
listenBaseline(draft)` (= `uploadFingerprint ?? syncFingerprint`): `missing` if no draft;
`text_changed` if `baseline !== null && baseline !== currentRevision.paragraphsFingerprint`; else
`ready`. Stored marks never affect the status; Listen has no `generating`/`failed` (no background
work until Phase 6). `isPublished` = article published and a published Listen payload exists;
`hasUnpublishedChanges` = draft null vs published non-null (or vice versa), or the draft's
`audio.key` or stored `marks` differ from the published copy. `validateForPublish` always returns
`{ ok: true }`. `publish` copies the draft payload → `published_payload` (any status),
`published_revision_id` = the revision being published, `published_fingerprint` = the baseline,
`published_at = now`; no draft → published columns cleared. Status is computed, never stored.

## 6. Auth & security

- Passwords: argon2id (`@node-rs/argon2`, memoryCost 19456 KiB, timeCost 2, parallelism 1);
  minimum length 12.
- Sessions: 32 random bytes → base64url token in cookie `blog0_session` (httpOnly, SameSite=Lax,
  path `/`, `Secure` when `BLOG0_PUBLIC_BASE_URL` is https, max-age 30 days). DB stores only
  `HMAC-SHA256(BLOG0_SESSION_SECRET, token)` hex. Sliding expiry: `expires_at` and cookie are
  extended when `last_seen_at` is older than 24 h. Logout deletes the row.
- Guards: `requireAdmin(request)` for route handlers (reads the cookie from
  `request.headers.get('cookie')` — never `next/headers` — so handlers are directly testable);
  `requireAdminPage()` for server components (uses `cookies()` from `next/headers`, redirects to
  `/admin/login?next=<path>`).
- CSRF: every mutating `/api/*` route requires an `Origin` header whose origin equals
  `BLOG0_PUBLIC_BASE_URL`'s origin or the request's own `Host` → else 403 `FORBIDDEN_ORIGIN`.
- Throttle core: `src/server/rate-window.ts` `FixedWindowCounter(max, windowMs)` — in-memory per
  process, fixed windows keyed by string, bounded at 10 000 keys (expired windows pruned first,
  then the oldest); `lockedFor(key, now)` (seconds until unlock when at the cap, else null; does
  not count), `add(key, now)`, `refund(key)`, `delete(key)`. Login (`src/server/auth/rate-limit.ts`)
  and newsletter (`src/server/newsletter/rate-limit.ts`) limits are built from it. Phase 5 moves
  limits to Postgres.
- Login throttling: 5 failures per (lower-cased email, client IP) per 15 min, and 20 failures per
  lower-cased email across all IPs per 15 min → 429 `RATE_LIMITED` with `Retry-After` (even for
  the right password). Each allowed attempt is reserved synchronously at the check, before any
  `await`, so concurrent attempts cannot overrun the limit; a correct password clears the
  (email, IP) count and refunds its reservation on the per-email count. Client IP:
  `BLOG0_TRUSTED_PROXY_HOPS` = 0 (default, no proxy) ignores `X-Forwarded-For` and `X-Real-IP`
  (client-controlled) and uses the constant `direct`, so the login limit is effectively per email
  (and the newsletter per-IP bucket is skipped — next bullet); N > 0 takes the Nth entry from the
  right of `X-Forwarded-For` (fewer entries → `unknown`); `X-Real-IP` is never trusted. Sessions
  store the IP only when it is a real address.
- Newsletter throttling (same client-IP derivation): body validated first (invalid → 400, never
  counted); then 3 per lower-cased email per hour and 300 per site per hour, always; plus 10 per
  client IP per hour only when the IP is a real address — with `direct`/`unknown` the per-IP bucket
  is skipped (a shared constant would otherwise let one caller exhaust it for everyone). Any cap →
  429 `RATE_LIMITED` with `Retry-After`. Production behind a reverse proxy MUST set
  `BLOG0_TRUSTED_PROXY_HOPS`, or the per-IP cap is inert.
- Raw HTML in Markdown is never rendered. Uploaded files are validated by content (§9.3), stored
  under unguessable uuid keys, and served with their stored MIME type,
  `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline`; the `/media/` route never
  touches the filesystem for a key that fails `isValidStorageKey` or has no `media_asset` row.
  Draft (unpublished) audio is reachable through `/media/` by anyone holding the key
  (> **Assumed:** acceptable — keys are 122-bit random and never listed publicly).
- Tenancy: every table has `site_id`; every query filters by the current site id from
  `getCurrentSite()`; no cross-site reads exist.

## 7. Observability

`src/server/log.ts` writes one JSON object per line: `ts` (ISO), `level`, `event`, `msg`, plus
context. Destinations: stdout always; `BLOG0_LOG_FILE` (append) when set; an in-memory sink in
tests (`captureLogs()`).

| Event | Emitted by | Fields |
|---|---|---|
| `api.request` | `withApi` (one line per API request, at completion) | `request_id, method, path, status, latency_ms, user_id?, input_summary, output_summary, err_code?` |
| `llm.call` | OpenRouter adapter (one line per HTTP attempt) | `request_id, model, prompt_version, attempt, latency_ms, prompt_tokens, completion_tokens, cost_usd, provider_generation_id, outcome ('ok'|'http_error'|'timeout'|'invalid_json'), http_status?` |
| `jev.run` | `runJev` | `request_id, article_id, revision_id, sentence_count, bounds, picks, attempts, outcome, err_code?` |
| `auth.login` | login route | `outcome ('ok'|'bad_credentials'|'rate_limited'), email_masked` |
| `app.boot` | `instrumentation.ts` | `version, port, node, site_slug, db_engine, openrouter_key ('configured'\|'not configured (Jev disabled)')` (+ `db_dir`, `notice`, `session_secret` source on PGlite) |
| `media.upload` | audio/image ingest (`logMediaUpload`) | `request_id, kind ('audio'\|'image'), mime, bytes, duration_ms?, width?, height?, article_id?, outcome ('ok'\|'rejected'), err_code?` |
| `media.request` | `/media/[...key]` (not `withApi`; one line per request) | `request_id, key, status (200\|206\|304\|404\|416), range?, bytes_sent, latency_ms` |
| `media.remove` / `media.cleanup` / `listen.sync` | `removeAudio` / file cleanup failures (`warn`) / `saveMarks` | ids and counts only |
| `error` | anywhere unexpected | `err_message, err_stack (non-prod only), request_id` |

`input_summary` / `output_summary` are small objects of counts and ids (e.g.
`{ bodyChars: 4231 }`, `{ slides: 6 }`), never article text, passwords, tokens, keys, or full
emails (`s***@smalltech.in`). Every API response carries `x-request-id`.

## 8. Error handling

Envelope at every API boundary (`src/lib/api/envelope.ts`):
`{ ok: true, data: T }` | `{ ok: false, error: { code: string, message: string, details?: unknown, requestId: string } }`.
`message` is written for the writer ("Jev couldn't reach the model — try again in a minute.").
Unexpected exceptions → 500 `INTERNAL` with a generic message and an `error` log line. Codes are
listed in `spec/api.md`. Admin client components render every API error inline with a retry
path (never a blank screen; load pattern in `spec/ui.md` §4). Public page errors:
`src/app/(site)/error.tsx` (client boundary, inside site chrome).

**Unknown/unpublished slugs (`src/proxy.ts`).** Next 16 proxy, `matcher: ['/p/:slug', '/p/:slug/tldr', '/p/:slug/listen']`
only. It calls `publishedSlugExists(slug)` (`src/server/public/articles.ts`, same published-only
filter as the page queries); when false it rewrites to an unmatched internal path so the root
`src/app/not-found.tsx` server-renders a 404 **with site chrome**. If the DB check throws, the
proxy logs and falls through to the page, whose own `notFound()` remains the fallback. Reason:
in Next 16.4, `notFound()` thrown from a page segment during SSR returns the bare
`__next_error__` HTML (status 404) and the chrome appears only after hydration. The proxy never
does auth (layouts + route handlers own it). Cost: one indexed query per `/p/*` request.

## 9. Media: storage interface, `/media/` route, ingest

### 9.1 Storage interface (`src/server/storage/types.ts`)

```ts
export interface StoredObject { key: string; size: number; sha256: string }
export interface ByteRange { start: number; end: number }                 // inclusive, 0-based, start ≤ end < size
export interface StorageStat { size: number; mtime: Date }
export interface StorageStream { stream: ReadableStream<Uint8Array>; size: number; range: ByteRange | null }

export class StorageError extends Error { constructor(public code: 'NOT_FOUND' | 'TOO_LARGE' | 'BAD_KEY' | 'BAD_RANGE' | 'IO', message: string) }

export interface Storage {
  /** Write atomically: temp file in the same dir → fsync → rename. Over `maxBytes` → StorageError TOO_LARGE and nothing left on disk. Returns size + sha256 computed while writing. */
  put(key: string, body: Buffer | ReadableStream<Uint8Array>, opts: { maxBytes: number }): Promise<StoredObject>;
  /** Whole object (probes, tests). null when missing. */
  get(key: string): Promise<Buffer | null>;
  stat(key: string): Promise<StorageStat | null>;
  /** Idempotent: deleting a missing key resolves. */
  delete(key: string): Promise<void>;
  /** Byte stream of the whole object or one range. NOT_FOUND / BAD_RANGE as StorageError. */
  stream(key: string, range?: ByteRange): Promise<StorageStream>;
}

export const STORAGE_EXTENSIONS = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
export type StoredMime = keyof typeof STORAGE_EXTENSIONS;
/** `<siteSlug>/<audio|image>/<yyyy>/<mm>/<uuid v4>.<ext>` — the only accepted shape. */
export const STORAGE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/(?:audio|image)\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp3|m4a|png|jpg|webp|gif)$/;
export function isValidStorageKey(key: string): boolean;                 // STORAGE_KEY_RE.test(key) && key.length <= 160
export function makeStorageKey(siteSlug: string, kind: 'audio' | 'image', mime: StoredMime, now: Date): string;
```

`src/server/storage/local-disk.ts` — `LocalDiskStorage(rootDir)`: `rootDir` =
`path.resolve(process.cwd(), getConfig().storageDir)` (`BLOG0_STORAGE_DIR`, default
`./var/storage`, gitignored); `mkdir -p` of the key's directory on `put`; every method first
asserts `isValidStorageKey(key)` (else `BAD_KEY`) and that `path.resolve(rootDir, key)` starts
with `rootDir + path.sep`; `stream` uses `fs.createReadStream(path, { start, end })` wrapped with
`Readable.toWeb`. `src/server/storage/index.ts` — `getStorage(): Storage` (singleton;
`resetStorageForTests()`). Object storage would implement the same interface later. Designer mode
needs nothing extra: the default dir is created on first write.

### 9.2 `/media/[...key]` route (`src/app/media/[...key]/route.ts`)

`GET` and `HEAD` (`export const dynamic = 'force-dynamic'`; not `withApi` because the body is
not JSON — it still sets `x-request-id` and writes one `media.request` log line). Steps:

1. `key = segments.join('/')` (Next passes decoded segments). `!isValidStorageKey(key)` → 404
   JSON envelope `NOT_FOUND` (no filesystem access, no log at `error`).
2. `mediaAsset` row by `(site_id, storage_key)` via `src/server/media/repo.ts` → none → 404.
3. `getStorage().stat(key)` → null → 404 (row without a file is logged at `warn`).
4. `ETag = '"' + row.sha256 + '"'`. `If-None-Match` matches (any listed tag, `W/` tolerated) →
   304 with `ETag`, `Cache-Control`, no body.
5. `Range` present and (`If-Range` absent or equal to the ETag): parse with
   `parseRange(header, size)` (`src/server/media/range.ts`, pure): exactly one of
   `bytes=a-b` (b clamped to size−1), `bytes=a-`, `bytes=-n` (n ≥ 1, clamped to size); anything
   else (multiple ranges, non-`bytes` unit, malformed) → `null` = ignore the header (200 full);
   `a ≥ size` or `n === 0` → 416 with `Content-Range: bytes */<size>`, empty body.
6. Respond 206 (`Content-Range: bytes a-b/size`, `Content-Length: b-a+1`) or 200
   (`Content-Length: size`) with the stream (`HEAD`: headers only). Common headers:
   `Content-Type: row.mime_type`, `Accept-Ranges: bytes`, `ETag`, `Last-Modified` (row
   `created_at`, RFC 7231), `Cache-Control: public, max-age=31536000, immutable`,
   `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<ascii-safe original filename>"`.
7. Other methods → 405 with `Allow: GET, HEAD`.

### 9.3 Ingest, probing, limits

**Request pre-check** (`src/server/http/api.ts`): upload routes use `withApi({ auth: 'admin',
body: 'multipart', maxBytes })` (`maxBytes` a number or a function read at request time).
`precheckContentLength(request, maxBytes)` refuses a declared `Content-Length` greater than
`maxBytes + MULTIPART_OVERHEAD_BYTES` (64 KiB of form framing) with 413 `PAYLOAD_TOO_LARGE`
(`payloadTooLarge(limit)`) before the body is read; a non-multipart body → 400; the handler then
receives the parsed `FormData`.

**Shared pipeline** (`src/server/media/ingest.ts`, used by images and audio):
- `formFile(form, message): File` — the multipart `file` part, else 400 `VALIDATION_FAILED`.
- `readUpload(file, rules: UploadRules): Promise<Buffer>` with `UploadRules = { maxBytes; tooLarge(): ApiError; empty(): ApiError }`
  — over `maxBytes` (declared `file.size` and again after reading) → `tooLarge()`; 0 bytes →
  `empty()`. Uploads are buffered in memory (> **Assumed:** acceptable — ≤ 50 MB, few writers).
- `storeUpload(input: StoreUploadInput, commit)` with `StoreUploadInput = { siteSlug; kind; mime; buffer; rules; now?; requestId? }`
  — `put()` under a fresh `makeStorageKey` key (put `TOO_LARGE` → `rules.tooLarge()`; any other put
  failure → 500 `INTERNAL` "Couldn't store the file …"), then `commit(stored)` (the DB work); a
  failure in `commit` deletes the file again (a failed delete is logged `media.cleanup` at `warn`).
- `logUploadRejections(kind, context, run)` — runs the upload; a refusal with status 400/413/415/422
  logs exactly one `media.upload … rejected` line (with `err_code`) and rethrows.
  `logMediaUpload(kind, outcome, fields)` writes the line; `cleanOriginalFilename(name, fallback)`
  keeps the basename, strips control chars, ≤ 255 chars.

Order per upload: read → probe → `storeUpload` (put → DB commit).

| Kind | Probe | Accept | Reject |
|---|---|---|---|
| Audio (`src/server/listen/probe.ts`) | `music-metadata` `parseBuffer(buf, undefined, { duration: true, skipCovers: true })` | `format.container` `MPEG` with `codec` `MPEG 1 Layer 3`/`MPEG 2 Layer 3` → `audio/mpeg`; container `M4A`/`isom`/`mp42`/`iso2`/`M4B` with codec `AAC`/`ALAC` and **no** video track → `audio/mp4`; `format.duration` must be a finite number → `durationMs = Math.round(duration * 1000)` | anything else or a parse error → 415 `UNSUPPORTED_MEDIA` ("This file is <detected>; upload an mp3 or m4a."); duration missing → 415 ("Couldn't read the recording's length …"); `durationMs > maxDurationMs` → 422 `AUDIO_TOO_LONG` |
| Image (`src/server/media/image-probe.ts`) | `image-size` `imageSize(buf)` | `type` `png` → `image/png`, `jpg` → `image/jpeg`, `webp` → `image/webp`, `gif` → `image/gif`; `width`/`height` > 0 | any other `type` (incl. `svg`, `bmp`, `tiff`, `avif`, `ico`) or a throw → 415; `width` or `height` > 12 000 → 422 `IMAGE_TOO_LARGE` |

Limits come from `getConfig()` at request time: `maxAudioMb`, `maxAudioMinutes`, `maxImageMb`
(§10). `music-metadata` and `image-size` are pure-JS ESM and need no `serverExternalPackages`
entry.

### 9.4 Listen helpers (pure, isomorphic)

`src/lib/listen/marks.ts`:

```ts
export interface Mark { pid: string; tMs: number }
export type MarkIssueCode = 'UNKNOWN_PID' | 'MISSING_PID' | 'DUPLICATE_PID' | 'OUT_OF_ORDER' | 'NOT_INCREASING' | 'OUT_OF_RANGE';
export type MarkIssue = { code: MarkIssueCode; pid?: string; index?: number };
export const SEEK_STEP_S = 5;
export function validateMarks(marks: readonly Mark[], paragraphPids: readonly string[], durationMs: number): { ok: true } | { ok: false; reasons: MarkIssue[] };
export function activeMarkIndex(marks: readonly Mark[], tMs: number): number;          // greatest index with tMs ≤ t (ties → the last); -1 before the first mark; binary search
export function listenMinutes(durationMs: number): number;                              // max(1, round(durationMs / 60000)) — design audioMinutes
export function fmtClock(ms: number): string;                                          // design fmtClock over seconds: "m:ss"
```

`src/lib/listen/estimate.ts` (rules and edge cases in `spec/capabilities/listen-sync.md`):

```ts
export const ASSUMED_WPM = 150;
export const PARAGRAPH_PAUSE_MS = 600;
export const PAUSE_WORDS = (PARAGRAPH_PAUSE_MS * ASSUMED_WPM) / 60_000;   // 1.5 word-equivalents
export interface TimedParagraph { pid: string; words: number }
export type ListenTiming = 'synced' | 'estimated';
export function countWords(text: string): number;   // whitespace tokens containing ≥ 1 \p{L} or \p{N}
export function toTimedParagraphs(paragraphs: readonly { pid: string; text: string }[]): TimedParagraph[];
export function estimateMarks(paragraphs: readonly TimedParagraph[], durationMs: number): Mark[];   // tMs_i = floor(D × C_i / W); [] when none / D ≤ 0
export function resolveMarks(stored: readonly Mark[], paragraphs: readonly TimedParagraph[], durationMs: number): { marks: Mark[]; timing: ListenTiming };
```

Callers: `src/server/public/articles.ts` (reader view model + `PublicListenDto`, over the
published revision's `rendered.paragraphs` from the render cache) and `src/server/listen/sync.ts`
(`ListenStateDto.timing`, over the current revision). The browser receives resolved marks; the
helpers stay isomorphic for a later review UI.

`src/server/formats/payload.ts` — `listenPayloadSchema` / `readListenPayload` / `listenBaseline`
(shape in `spec/data.md`; `uploadFingerprint` is `nullable().optional().default(null)` so legacy
payloads parse) beside the TLDR schema (`readTldrPayload`, `TLDR_MIN_SLIDES = 1`,
`TLDR_MAX_SLIDES = 12`, `TLDR_REASON_MAX = 200`).

### 9.5 Listen service (`src/server/listen/*`) and media cleanup

- `ingest.ts`:
  - `uploadAudio(articleId: string, file: File, actor: ActorContext, options?: UploadAudioOptions): Promise<ListenStateDto>`
    with `UploadAudioOptions = { limits?: AudioLimits; requestId?: string; now?: Date }`,
    `AudioLimits = { maxBytes: number; maxDurationMs: number }` (default `configuredAudioLimits()`
    from `getConfig()`; tests inject smaller ones). 404 before any byte is read for an unknown
    article; then inside `logUploadRejections('audio', …)`: `readUpload` → `probeAudio` → duration
    check → `storeUpload` whose commit is one transaction: lock the article, insert
    `media_asset(kind='audio', article_id)`, upsert the `listen` draft `{ audio, marks: [],
    syncFingerprint: null, uploadFingerprint: currentRevision.paragraphsFingerprint }` with
    `draft_fingerprint = uploadFingerprint`, `draft_revision_id = currentRevision.id`,
    `draft_updated_*`, and `deleteAssetIfUnreferenced` on the replaced draft asset; after commit
    `deleteStoredFiles([staleKey])`, then `logMediaUpload('audio', 'ok', …)`.
  - `removeAudio(articleId, actor, options?: { requestId?; now? }): Promise<ListenStateDto>` →
    draft payload + draft columns null (row kept), conditional asset delete, file after commit,
    `media.remove` log. Idempotent.
- `sync.ts`:
  - `buildListenState(siteId, row, now?, db?)` / `getListenState(siteId, id)` → `ListenStateDto`
    (renders the current revision through the cache; `timing` = `resolveMarks(draft.marks,
    toTimedParagraphs(rendered.paragraphs), audio.durationMs).timing`; `uploadFingerprint` =
    `listenBaseline(draft)`; `textChangedSinceUpload`; `published.sameAudioAsDraft`).
  - `saveMarks(ctx: ActorContext, id: string, body: ListenSaveBody): Promise<ListenStateDto>` —
    **aligner-facing**; `listenSaveBody` (zod, ≤ 5 000 marks) parses the PUT. In one transaction:
    CONFLICT check, `LISTEN_NO_AUDIO`, `validateMarks` against the revision's paragraph pids and
    `audio.durationMs` (→ 422 `MARKS_INVALID` with `reasons`), writes `marks`, `syncFingerprint =
    revision.paragraphsFingerprint`, `uploadFingerprint = listenBaseline(draft)` (materialises a
    legacy baseline), `draft_revision_id`, `draft_updated_*`; never changes `draft_fingerprint`.
  - `summarizeListen(data)` — the routes' output summary (status, counts, ids).
- `src/server/public/articles.ts`: the published Listen view model / `PublicListenDto` set
  `marks`/`timing` from `resolveMarks(published.marks, toTimedParagraphs(publishedRendered.paragraphs),
  published.audio.durationMs)`; a payload that fails to parse → `listen: null` + `warn` log.
- `src/server/media/cleanup.ts` (two steps, so a rolled-back transaction never loses a file a
  surviving row points at):
  - `deleteAssetIfUnreferenced(siteId, assetId, opts?: { db?: Executor }): Promise<CleanupResult>`
    (`CleanupResult = { outcome: 'deleted' | 'referenced' | 'missing'; key: string | null }`) —
    inside the caller's transaction: `isStorageKeyReferenced(siteId, key, db)` checks every
    `article_format` draft/published payload's `audio.key`; unreferenced → delete the **row** and
    return its key.
  - `deleteStoredFiles(keys, opts?: { requestId? })` — after commit; never throws (a failed delete
    is logged `media.cleanup` at `warn`).
  - `audioRefOf(payload)` reads `{ assetId, key }` from a stored listen payload.
  Publishing a Listen that supersedes an unreferenced recording uses the same two steps.

## 10. Configuration (env → `src/server/config.ts`, documented 1:1 in `.env.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BLOG0_DATABASE_URL` | **yes in production** (`NODE_ENV=production`, i.e. `pnpm start`); no otherwise | non-production only: `pglite://./var/pglite` | `postgres://sai@localhost:5432/blog0_dev` (server engine) or `pglite://<dir>` (embedded, §11). Absent/empty ⇒ in a non-production process (dev, `dev:design`, scripts, tests) PGlite default with an `app.boot` notice; in production a boot error (§11.1). An explicit `pglite://` URL is allowed in production (designer-mode notice logged). |
| `BLOG0_TEST_DATABASE_URL` | tests | — | `postgres://sai@localhost:5432/blog0_test`; must differ from the dev URL (tests refuse otherwise); must be `postgres://` |
| `BLOG0_PORT` | no | `3410` | read by `scripts/serve.mjs` (after loading `.env`) |
| `BLOG0_PUBLIC_BASE_URL` | no | `http://localhost:3410` | absolute links, OG, origin check, `Secure` cookie when https, dev origins |
| `BLOG0_SITE_SLUG` | no | `blog0` | which `site` row this process serves |
| `BLOG0_TRUSTED_PROXY_HOPS` | no | `0` | integer 0–10: reverse proxies appending to `X-Forwarded-For`; 0 = ignore forwarding headers (§6) |
| `BLOG0_SESSION_SECRET` | yes on `postgres://`; no on `pglite://` | — | ≥ 32 chars (`openssl rand -base64 48`). PGlite mode without it: generated once and persisted to `var/pglite-session-secret` (0600) — §11 |
| `BLOG0_OPENROUTER_API_KEY` | yes on `postgres://`; no on `pglite://` | — | presence + placeholder check at boot (below); liveness by `pnpm check:openrouter`. PGlite mode without a real key: Jev disabled with a visible notice (§11) |
| `BLOG0_OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | |
| `BLOG0_JEV_MODEL` | no | `google/gemini-2.5-flash` | see `spec/agent.md` §3 |
| `BLOG0_JEV_TIMEOUT_MS` | no | `45000` | per model attempt |
| `BLOG0_LOG_LEVEL` | no | `info` | `debug|info|warn|error` |
| `BLOG0_LOG_FILE` | no | — | append JSON lines here too (E2E sets it) |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | seed + E2E | name `Sai Krishna V` | first admin; password ≥ 12 |
| `BLOG0_NEW_ADMIN_PASSWORD` | no | — | non-interactive `pnpm admin:create` |
| `BLOG0_STORAGE_DIR` | no | `./var/storage` | uploads root (§9.1) |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | no | `50` / `30` / `8` | upload limits, read at request time |
| `BLOG0_E2E_BASE_URL` | no | — | point Playwright at an already-running server (no `webServer` started) |
| `BLOG0_DIST_DIR` | no | `.next` | not read by `config.ts`: `next.config.ts` `distDir`. A separate build dir (e.g. `.next-gate`) so a gate/CI `pnpm build` never overwrites the `.next` a running `pnpm start` serves; build and start with the same value (`scripts/serve.mjs` and the E2E `webServer` inherit it); `.next-*/` is gitignored |
| `CI` | no | — | not a `BLOG0_*` setting: `CI=true` turns a missing/placeholder OpenRouter key from a `PENDING KEY` skip into a failure (Conventions → Real-key tests) and enables Playwright `forbidOnly` |
| (derived) `dbEngine` | — | — | not an env var: `getConfig().dbEngine` is `'postgres' \| 'pglite'`, from the URL scheme; reported by `app.boot` and `/api/health` |

Rules: `loadConfig(env)` is pure (unit-testable) and `getConfig()` caches it; values are trimmed
and, for non-secret fields, a trailing ` # comment` is stripped (dirty `.env` tolerance); missing
or invalid required values throw one `ConfigError` listing every problem and pointing at `.env`;
secret fields are wrapped so `JSON.stringify`/`util.inspect` print `[redacted]`. **Placeholder
rejection at boot:** a secret field (`BLOG0_SESSION_SECRET`, `BLOG0_OPENROUTER_API_KEY`,
`BLOG0_ADMIN_PASSWORD`, `BLOG0_NEW_ADMIN_PASSWORD`) whose value starts with `replace-with-` (the
`.env.example` placeholder prefix) is reported in the same aggregated error ("… still holds the
.env.example placeholder"). On `pglite://` the key is instead classified by the broader
`openRouterKeyStatus()` (Conventions → Real-key tests) and anything but `'real'` becomes
`openrouterApiKey = null`. Scripts and tests load `.env` with `@next/env`'s
`loadEnvConfig(process.cwd())`. `BLOG0_DATABASE_URL` absent/empty while `NODE_ENV ===
'production'` is a required-value error, worded `BLOG0_DATABASE_URL is required in production;
set postgres://… or explicitly pglite://… to opt in` — never a silent PGlite fallback.

`/api/health` never returns raw DB driver errors: on DB failure the driver error is logged
server-side (`error` event with `request_id`) and the response is the generic envelope 503
`DB_UNAVAILABLE` with a fixed message (no driver text, host, or connection string).

> **Assumed:** local dev admin credentials may live in the gitignored file `var/dev-admin.env`
> (`BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME`), sourced into the shell when
> `.env` lacks them; values in `.env` take precedence over it.

## 11. Designer mode (embedded Postgres via PGlite)

Requirement (`spec/capabilities/designer-mode.md`): the app runs with nothing installed beyond
Node 22 + pnpm — no Postgres, no Docker, no `.env`. Postgres remains the production engine and
the integration/E2E gates run on real Postgres; designer mode is a second engine behind the same
Drizzle API.

### 11.1 Engine selection

`src/server/db/url.ts` → `parseDatabaseUrl(raw: string | undefined): { engine: 'postgres', url }
| { engine: 'pglite', dir }`:
- `postgres://` / `postgresql://` → server engine.
- `pglite://<path>` → embedded; `<path>` is a directory relative to `process.cwd()` (repo root) or
  absolute; `pglite://memory` is in-memory (tests), nothing persisted.
- absent/empty, **non-production process only** (`NODE_ENV !== 'production'`: `pnpm dev`,
  `dev:design`, scripts, tests) → `{ engine: 'pglite', dir: './var/pglite' }` and
  `instrumentation.ts` logs `app.boot` with `db_engine:'pglite', db_dir, notice:'BLOG0_DATABASE_URL not set — using embedded PGlite at ./var/pglite'`.
- absent/empty with `NODE_ENV === 'production'` (`pnpm start`) → `ConfigError` (§10); the process
  does not boot — a production host with a leftover `var/pglite` must never silently serve
  designer data (including the designer admin). The check lives in `loadConfig`, so
  `parseDatabaseUrl` stays a pure scheme parser.
- explicit `pglite://<path>` in production → allowed (deliberate opt-in); `app.boot` carries the
  designer-mode notice.
- anything else → `ConfigError` ("must be postgres:// or pglite://").

`loadConfig` relaxes two requirements **only when** `dbEngine === 'pglite'`:
`BLOG0_SESSION_SECRET` may be absent (→ `src/server/designer/secret.ts` generates 48 random bytes
base64url, writes `var/pglite-session-secret` with mode `0o600`, reads it back on later boots) and
`BLOG0_OPENROUTER_API_KEY` may be absent/placeholder (→ `config.openrouterApiKey = null`;
`getLlmClient()` throws `ApiError('LLM_NOT_CONFIGURED', 503, 'No OpenRouter key configured — add BLOG0_OPENROUTER_API_KEY to .env to generate with Jev.')`;
`TldrStateDto.jevAvailable` is false so the TLDR tab shows the notice and disables Generate).
`BLOG0_TEST_DATABASE_URL` must stay `postgres://`.

`pnpm dev:design` (`scripts/dev-design.mjs`) always forces PGlite: a `postgres://`
`BLOG0_DATABASE_URL` from `.env` is ignored (only a `pglite://` value is honoured for the dir). It
runs `runDesignerSetup()` (`src/server/designer/setup.ts`) **in-process** — ensure dir → migrate →
seed site + designer admin `designer@blog0.local` (+ `BLOG0_ADMIN_*` when set) → seed posts → seed
decks (`source: 'auto'`: Jev with a real key, else the fixture) → `seedSampleListen()` (designer
mode only: `tests/fixtures/audio/sample.mp3` through `uploadAudio()` + `publishArticle()` on
`humans-are-software`, estimated timing; idempotent per Listen row; restores the file under the same
key when it vanished from storage) → `closeDb()` (single opener per dir) — then spawns the
hot-reload dev server. Before setup it refuses a taken port (exit 1, before PGlite opens); during
setup `BLOG0_LOG_LEVEL` is `warn` unless the user set it. It prints one progress line per step
(`database: … (new — first boot runs initdb | existing)`, …, `listen: …`), then — after
`/api/health` answers and `/` has compiled — the ready banner (`site:`, `admin:`, one `designer
admin:` line carrying `<email> / <password> … (new|rotated — shown once …)` only when a password was
just created or rotated, else where it is kept; edit locations; rotate; start over:
`rm -rf var/pglite var/storage var/pglite-session-secret var/designer-admin.txt`). Credentials file
(`designerAdminFileFor(dir)`): `var/designer-admin.txt` for the default dir,
`<dir>.designer-admin.txt` for any other PGlite dir (mode 0600). Hot reload: `next.config.ts` sets
`allowedDevOrigins` = loopback + every LAN IPv4 of the machine + the `BLOG0_PUBLIC_BASE_URL` host,
and `experimental.turbopackFileSystemCacheForDev: false` (avoids an HMR-hash-mismatch reload
loop); the README says `rm -rf .next/dev` if the loop recurs.

### 11.2 DB abstraction (`src/server/db/client.ts`)

```ts
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;     // engine-neutral drizzle type (both drivers extend it)
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;                                    // every repo function takes one
export interface DbHandle { db: Db; engine: 'postgres' | 'pglite'; ping(): Promise<void>; close(): Promise<void> }
export function getDb(): Db;                                        // the app's handle (globalThis-cached, one per process)
export function getDbHandle(): DbHandle;                            // health check, scripts
export async function initDb(): Promise<DbHandle>;                  // open + wait ready (instrumentation, designer setup)
export async function createDbHandle(target: ParsedDatabaseUrl, opts?: { max?: number }): Promise<DbHandle>;  // standalone; caller closes
export function rowsOf<T>(result: unknown): T[];                    // db.execute rows on either driver
export async function closeDb(): Promise<void>;                     // + resetDbForTests()
```
- `src/server/db/postgres.ts`: postgres.js + `drizzle(sql, { schema })`.
- `src/server/db/pglite.ts`: dynamic `import('@electric-sql/pglite')` (the Postgres path never
  loads the WASM), `new PGlite(dir)` / `new PGlite()` for `memory` + `drizzle-orm/pglite`. One
  PGlite instance per process (no dir lock — two openers can corrupt a dir).
- `src/server/db/migrate.ts`: `runMigrations(target)` uses `drizzle-orm/postgres-js/migrator` or
  `drizzle-orm/pglite/migrator` per engine, same folder, `migrationsSchema: 'drizzle'`,
  `migrationsTable: '__drizzle_migrations'`; `getMigrationStatus` runs through `db.execute(sql…)`
  + `sql.identifier()` and `rowsOf()`; `db:verify` composes `PostgreSQL 17.x (PGlite)` from the
  engine.
- `scripts/db-create.ts` on `pglite://`: `mkdir -p <dir>` and print `created`/`exists`.
- `tests/helpers/db.ts` stays Postgres-only (`create database`); the designer-mode integration
  test uses `pglite://memory`.

### 11.3 PGlite compatibility

The schema and every query run unchanged on PGlite 0.3.x (PG 17): `gen_random_uuid()`, `now()`,
`jsonb`, `numeric(12,6)` (as JS number), `text[]`, CHECKs, `DESC NULLS LAST` indexes, FK actions,
`ON CONFLICT … DO UPDATE … WHERE`, `SELECT … FOR UPDATE`. PGlite has one session and
`db.transaction()` holds an in-process mutex for the whole callback, so `FOR UPDATE` is a no-op
whose exclusion comes from the mutex (the Generate double-click guard still holds via the
`running` row) and **a query on the outer `getDb()` inside a transaction callback deadlocks** —
every DB call inside `transaction(async (tx) => …)` must receive `tx`, and no transaction is held
across the LLM call. `drizzle-kit` commands need Postgres. Adding `CREATE EXTENSION`, advisory
locks, listen/notify or `COPY` requires re-running `pnpm spike:pglite`. Spike verdict: **GO**
(25/25 probes, `spec/spikes/pglite.md`).

### 11.4 Current-site cache (`src/server/site/current.ts`)

`next build` duplicates server modules across server bundles (route handlers, server components,
`instrumentation.ts`), so a module-level cache would exist once per bundle and an admin site-settings
save in one bundle would leave stale copies in the others. The site-row cache therefore lives on
`globalThis[Symbol.for('blog0.currentSiteCache')]` (one per process, shared by every bundle) and
holds `{ row, expiresAt, generation }`, TTL **60 s**. Every save (and `resetCurrentSiteCacheForTests()`)
increments `generation` and clears/replaces `row`; a read captures `generation` before its DB query
and stores its result only if `generation` is unchanged afterwards — so a read racing a save never
re-stores the old row.

---

## Stack

User-binding choices: **Next.js (App Router) + TypeScript + Postgres**, **OpenRouter** as LLM
provider, web UI, **pnpm**, Node 22, env prefix `BLOG0_`. Everything else below is derived from
the requirements.

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node 22 LTS (`.nvmrc`, `engines` `>=22 <23`, `devEngines` pin) | LTS; bundled ICU makes `Intl.Segmenter` sentence splitting deterministic. |
| Framework | Next.js 16.4 App Router, React 19.3 (lockfile pins) | Binding. Server rendering for fast reader pages + OG tags; client islands for the deck/animations. Turbopack default; `params`/`searchParams` are Promises; the one proxy file is `src/proxy.ts` (§8). |
| Language | TypeScript 5.9, `strict: true` | Binding. |
| Package manager | pnpm 11 (`packageManager` pinned) | Binding. |
| DB | PostgreSQL 18 (local Homebrew, socket `/tmp:5432`, user `sai`) | Binding; production-lite, backup-friendly. |
| DB driver | `postgres` (postgres.js) | Pure JS, no native build, works in the Next server runtime and scripts. |
| Embedded DB (designer mode) | `@electric-sql/pglite` 0.3.x + `drizzle-orm/pglite` | Run with nothing beyond Node + pnpm. Real Postgres compiled to WASM, so the same SQL migrations, queries and seeds run unchanged; persisted to `var/pglite`. Never the production engine (§11). |
| ORM + migrations | Drizzle ORM 0.45 + drizzle-kit (generate) + drizzle-orm migrator (apply) | SQL-first migration files reviewable in diffs; no binary engine (lighter Docker image than Prisma); types inferred from the schema. Applying uses the runtime migrator (main dependency) so deploy needs no dev tooling. |
| Validation | zod 4 | Env, request bodies, LLM output — one library at every trust boundary. |
| Markdown | unified 11, remark-parse, remark-gfm, remark-rehype, rehype-slug, rehype-stringify, custom plugins | GFM tables + footnotes required; AST access needed for stable paragraph ids and the sentence list; deterministic. |
| Syntax highlighting | Shiki via `@shikijs/rehype`, dual theme (CSS variables) | Server-side, zero client JS, light/dark switch with the site's `data-theme`. |
| Password hashing | `@node-rs/argon2` (argon2id) | Prebuilt binaries (no node-gyp), OWASP-recommended algorithm. |
| Sessions | Own DB-backed opaque tokens (HMAC'd at rest) | Multi-admin with per-user identity, revocable, tiny code. |
| LLM access | Plain `fetch` to OpenRouter's `/chat/completions` behind `LlmClient` | One call shape, structured outputs, usage/cost in response; no SDK dependency to drift. |
| Media probing | `music-metadata` 12, `image-size` 2 | Pure-JS duration/format probe for mp3/m4a and dimensions/type for images; no native ffmpeg dependency. |
| Fonts | `next/font/google` (Space Grotesk, Source Serif 4, JetBrains Mono) | Same faces as the design, self-hosted at build. |
| Logging | In-house JSON-lines logger | Avoids worker-thread transport issues of pino under Next bundling; fields fully controlled. |
| Unit + integration tests | Vitest 3.2 (`projects`: unit, integration) | Fast TS-native runner; integration runs serially against real Postgres + real OpenRouter. |
| E2E | Playwright 1.64 (`@playwright/test`, Chromium) | The deck, Listen view and editor are JS-driven → headless-browser gate required. |
| Script runner | `tsx` (main dependency) | Runs TS scripts (migrate, seed, check) with no build; needed at deploy time. |
| Lint / format | ESLint 9 flat config + `eslint-config-next`; Prettier (`printWidth: 110, singleQuote: true`, not gated) | Standard for Next; `next lint` is not used. |

> **Assumed:** Drizzle over Prisma (rationale above).
> **Assumed:** plain `<textarea>` editor (monospace, Tab inserts two spaces) instead of CodeMirror — fewer moving parts for v0.1; swap later behind `MarkdownEditor`.

`pnpm-workspace.yaml`: pnpm ≥ 10 blocks dependency build scripts unless allowed —
`allowBuilds: { esbuild: true, sharp: true, unrs-resolver: true }` (plus a
`minimumReleaseAgeExclude` entry for the pinned zod). A new dependency with a build script is
added there in the same commit.

Deploy-time dependencies (`dependencies`, not `devDependencies`): `next`, `react`, `react-dom`,
`drizzle-orm`, `postgres`, `@electric-sql/pglite` (so `pnpm dev:design` works on a plain
`pnpm install`), `tsx`, `zod`, `@node-rs/argon2`, all unified/remark/rehype packages, `shiki`,
`@shikijs/rehype`, `@next/env`, `music-metadata`, `image-size`, `server-only`. Dev-only:
`drizzle-kit`, `vitest`, `@playwright/test`, `typescript`, `@types/*`, `eslint*`, `prettier`.

`next.config.ts`: `distDir: process.env.BLOG0_DIST_DIR?.trim() || '.next'` (§10),
`serverExternalPackages: ['@node-rs/argon2', 'shiki', 'postgres', '@electric-sql/pglite']`
(PGlite loads a WASM binary from its package dir and must not be bundled), `allowedDevOrigins`
and `experimental.turbopackFileSystemCacheForDev: false` (§11.1), `poweredByHeader: false`,
`typedRoutes: false`. **No** `output: 'standalone'` before Phase 5: the documented local run
command is `next start` (via `scripts/serve.mjs`), which warns under standalone output; Phase 5
adds it for the container.

## Layout

Single package at the repo root (Next.js convention: root holds config only; **all application
source lives in `src/`**, the one import root, alias `@/*`). Tests live in `tests/` at the root,
tiered. Scripts in `scripts/`. This honors `project-layout.md`: no app code at the root, one
package, tests outside the source package.

```
blog0/
├── README.md  .env.example  .gitignore  .nvmrc  .prettierrc  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
├── tsconfig.json  next.config.ts  drizzle.config.ts  vitest.config.ts  eslint.config.mjs
├── playwright.config.ts  playwright.design.config.ts          # main E2E (3411) / designer-mode E2E (3413)
├── spec/                                    # this spec + design reference (never edited by generators); spikes/pglite.md = spike verdict
├── scripts/
│   ├── serve.mjs                # loads .env via @next/env, runs `next <dev|start> -p ${BLOG0_PORT||3410}`, forwards signals; inherits BLOG0_DIST_DIR
│   ├── db-create.ts  db-migrate.ts  db-verify.ts  db-seed.ts  db-seed-posts.ts  create-admin.ts
│   ├── check-openrouter.ts  eval-jev.ts  seed-tldr.ts  spike-pglite.ts
│   ├── dev-design.mjs           # `dev:design`: runDesignerSetup() in-process, then the hot-reload dev server
│   ├── make-image-fixtures.ts  make-audio-fixture.sh     # regenerate tests/fixtures/{images,audio}
│   └── lib/{cli,allow-server-only}.ts                    # shared CLI helpers; lets scripts import server-only modules
├── src/
│   ├── instrumentation.ts       # register(): getConfig() (fail fast, exit 1) + initDb() on PGlite + app.boot log; skipped during next build
│   ├── proxy.ts                 # Next 16 proxy: /p/:slug, /p/:slug/tldr, /p/:slug/listen unknown/unpublished → rewrite to root 404 (§8); no auth
│   ├── app/
│   │   ├── layout.tsx           # <html data-theme> + theme init script + fonts + global CSS
│   │   ├── not-found.tsx        # root 404 with site chrome (target of the proxy rewrite)
│   │   ├── sitemap.ts  robots.ts
│   │   ├── (site)/              # public, wrapped by Boot/Masthead/Footer chrome
│   │   │   ├── layout.tsx  page.tsx  not-found.tsx  error.tsx  archive/page.tsx  about/page.tsx
│   │   │   └── p/[slug]/{page.tsx, tldr/page.tsx, listen/page.tsx, _lib/article-route.tsx}   # articleRoute(initialMode) factory
│   │   ├── admin/
│   │   │   ├── layout.tsx  login/page.tsx
│   │   │   └── (authed)/        # layout.tsx calls requireAdminPage()
│   │   │       ├── page.tsx (desk)  articles/new/page.tsx  articles/[id]/page.tsx  site/page.tsx  subscribers/page.tsx
│   │   │       └── ai-usage/  team/                       # Phase 4 (on hold) — not yet created
│   │   ├── media/[...key]/route.ts                        # GET/HEAD, 200/206/304/416 (§9.2)
│   │   └── api/
│   │       ├── health/route.ts  newsletter/route.ts  auth/{login,logout,me}/route.ts
│   │       ├── public/articles/[slug]/{tldr,listen}/route.ts
│   │       └── admin/{preview,site,subscribers}/route.ts  admin/uploads/images/route.ts
│   │           admin/articles/route.ts  admin/articles/[id]/{route.ts, publish/, unpublish/, tldr/, tldr/generate/, audio/, listen/}
│   ├── components/
│   │   ├── StubNotice.tsx
│   │   ├── design/              # Icon, Typewriter, Wordmark, SplitHeadline, Dek, motion.ts, overlay.ts
│   │   ├── site/                # Masthead, Footer, NewsletterForm, AsciiHand, Boot, PrintIn, PostCard, SummaryHost, ListenOverlay, LegacyHashRedirect, home/, archive/, about/
│   │   ├── reader/              # ArticleView, ModeBar, ModeCapsule, ReadHead, ArticleBody, ArticleFoot, TldrDeck, ShareLinkButton, ShareMenu, ParagraphShare, share-scroll.ts, clipboard.ts, ListenView, AudioPlayer, listen-sync.ts
│   │   ├── figures/             # FigSlide47, FigAB, registry.ts
│   │   └── admin/               # api.ts, AdminLoad.tsx (useAdminLoad/AdminLoadError), LoginForm, DeskHeader, DeskView, ArticleTable, FormatChips, NewArticleForm, labels.ts, relative-time.ts,
│   │                            #   editor/ (ArticleEditor, PublishBar, WriteTab, MarkdownEditor, LivePreview, ImageUploadButton, insert-image.ts, TldrTab, tldr-generate.ts, ListenTab, HistoryTab, fields.ts, use-article-doc.ts),
│   │                            #   tldr/ (DeckList, SentencePicker, DeckPreview, deck-edit.ts), listen/ (AudioUploader, listen-api.ts), site/, subscribers/
│   ├── lib/                     # isomorphic, pure, no I/O
│   │   ├── api/envelope.ts  api/dto.ts   # ALL API DTOs, one file grouped by domain sections
│   │   ├── articles/limits.ts   # ARTICLE_LIMITS (spec/api.md PATCH)
│   │   ├── content/types.ts  formats/registry.ts  view-models.ts  format-date.ts
│   │   ├── deck/timing.ts       # tldrDwell, tldrType, tldrMinutes, slide words (ported verbatim)
│   │   ├── listen/marks.ts  listen/estimate.ts                 # §9.4
│   │   ├── media/image-markdown.ts                             # image snippet builder
│   │   └── share-links.ts  share-surface.ts                    # share texts/URLs; native-sheet decision
│   ├── server/                  # server-only (each file starts with `import 'server-only'`)
│   │   ├── config.ts  log.ts  rate-window.ts
│   │   ├── db/{client,schema,migrate,url,postgres,pglite}.ts  db/migrations/ (0000_init.sql + meta/)
│   │   ├── designer/{secret,admin,setup}.ts
│   │   ├── http/api.ts
│   │   ├── auth/{session,guard,password,login,rate-limit}.ts
│   │   ├── users/repo.ts  site/{current,defaults,service}.ts  newsletter/{service,rate-limit}.ts
│   │   ├── content/{index,ast,markdown,render,sentences,paragraph-ids,fingerprint,stats,highlight,cache}.ts
│   │   │   content/plugins/{figure-markers,heading-shift,raw-html,code-langs,external-links,images,tables,safe-urls}.ts
│   │   ├── formats/{types,payload,index,read,tldr,listen}.ts      # formats/status.ts: Phase 4 (on hold), future
│   │   ├── articles/{repo,service,schemas,slug,tldr,views,http}.ts
│   │   ├── llm/{types,openrouter,index,key}.ts
│   │   ├── jev/{state,bounds,build-input,validate,run,prompt,articles}.ts  jev/prompts/select-v1.md
│   │   ├── listen/{probe,ingest,sync}.ts
│   │   ├── media/{repo,ingest,image-probe,range,cleanup}.ts  storage/{types,local-disk,index}.ts
│   │   ├── public/{articles,home,metadata,page-data}.ts
│   │   └── seed/{site,admin,seed-posts,seed-tldr}.ts  seed/posts/{index.ts,*.md}  seed/decks/{index.ts,<slug>.json}
│   └── styles/
│       ├── index.css            # @import design.css, additions.css (admin.css imported by the admin layout)
│       ├── design.css           # ported from spec/design/design-app.css minus dropped-feature rules (spec/ui.md §1 rule 1)
│       ├── additions.css        # new rules only (spec/ui.md §5)
│       └── admin.css
├── tests/
│   ├── setup/{global-setup,integration-env}.ts   # vitest integration: create/reset + migrate blog0_test; env + singleton resets, BLOG0_STORAGE_DIR=var/storage-test
│   ├── helpers/{db,session,env,logs,storage,api,seed-articles}.ts
│   ├── unit/<domain>/**         # admin, auth, content, db, deck, formats, helpers, jev, listen, llm, media, reader, site, … — no catch-all folder
│   ├── integration/*.test.ts
│   ├── e2e/{tldr,reader,listen,smoke,designer-mode}.spec.ts  e2e/{global-setup,designer.global-setup}.ts
│   │   e2e/helpers/{admin,article-text,db,jev-key,logs,share,upload}.ts
│   └── fixtures/articles/{hard-cases,e2e-article}.md  fixtures/audio/{sample.mp3,sample.m4a,sample.json,not-audio.wav}
│       fixtures/images/{sample.png,sample.jpg,sample.webp,tiny.gif,sample.svg,sample.json}
└── var/                         # gitignored runtime data (storage*, pglite*, pglite-session-secret, designer-admin.txt, backups)
```

Test wiring:
- `vitest.config.ts`: alias `@` → `src`, alias `server-only` → its empty module. Project `unit`
  (`tests/unit/**/*.test.ts(x)`, env node). Project `integration` (`tests/integration/**/*.test.ts`,
  `globalSetup: tests/setup/global-setup.ts`, `setupFiles: tests/setup/integration-env.ts`,
  `pool: 'forks'` with `poolOptions.forks.singleFork: true` — files run one at a time, since
  Vitest 3.2 does not accept `fileParallelism` per project — `testTimeout`/`hookTimeout` 120 s).
- `playwright.config.ts` (`pnpm test:e2e`): loads `.env`; `testDir: tests/e2e`,
  `testIgnore: '**/designer-mode.spec.ts'`; `globalSetup: tests/e2e/global-setup.ts` (wipe
  `var/storage-e2e`, reset + migrate `blog0_test`, seed site + admin — `BLOG0_ADMIN_*` when set,
  else a generated test-only admin, handed to workers as `BLOG0_E2E_ADMIN_*` — then `seedPosts` +
  `seedTldr(…, { source: 'fixture' })`, asserting 5 decks and 0 calls); `workers: 1`, `fullyParallel: false`, `forbidOnly` when `CI=true`.
  **Four projects run in a fixed order via `dependencies`: `tldr` → `reader` → `listen` → `smoke`**
  (they share one database and each needs the state the previous leaves); a new walk is added as a
  project at the end of that chain. `webServer` (skipped when `BLOG0_E2E_BASE_URL` is set):
  `pnpm start` on 3411 with `env: { BLOG0_PORT: '3411', BLOG0_DATABASE_URL: <BLOG0_TEST_DATABASE_URL>,
  BLOG0_PUBLIC_BASE_URL: 'http://localhost:3411', BLOG0_LOG_FILE: 'test-results/e2e-server.log',
  BLOG0_STORAGE_DIR: 'var/storage-e2e' }` merged over the inherited environment (so
  `BLOG0_DIST_DIR` reaches it), `reuseExistingServer: false`, 120 s. E2E runs the **same**
  `pnpm start` as production (test path = run path); `pnpm build` (same `BLOG0_DIST_DIR`) must have
  run first.
- `playwright.design.config.ts` (`pnpm test:e2e:design`; does **not** load `.env`):
  `testMatch: 'designer-mode.spec.ts'`, one project `designer`, port 3413. Playwright starts the
  web server **before** `globalSetup`, so the clean-state wipe is the first step of the web-server
  command: `node -e` removes `var/pglite-e2e` and `var/pglite-e2e.designer-admin.txt` and creates
  `test-results/`, then `pnpm dev:design > test-results/design-e2e-server.log 2>&1`; readiness
  `url: http://localhost:3413/api/health`, timeout 240 s, `reuseExistingServer: false`. `env`:
  `BLOG0_PORT: '3413'`, `BLOG0_DATABASE_URL: 'pglite://./var/pglite-e2e'`,
  `BLOG0_PUBLIC_BASE_URL: 'http://localhost:3413'`, and **empty** `BLOG0_SESSION_SECRET`,
  `BLOG0_OPENROUTER_API_KEY`, `BLOG0_ADMIN_EMAIL/PASSWORD/NAME`, `BLOG0_LOG_FILE` (an already-set
  variable is never overridden by `.env`, and the app treats empty as absent — this proves the
  generated-secret and no-key paths). `tests/e2e/designer.global-setup.ts` never deletes anything:
  it asserts the server console shows a first boot (`database: … (new — first boot runs initdb)`)
  and exactly one `designer admin: … (shown once …)` line, that
  `var/pglite-e2e.designer-admin.txt` exists with mode 0600, names `designer@blog0.local` and
  matches the printed password, then exports `BLOG0_E2E_DESIGNER_EMAIL` /
  `BLOG0_E2E_DESIGNER_PASSWORD` to the workers (the password is never printed).

## Conventions

**Naming.** Files: kebab-case for modules (`paragraph-ids.ts`), PascalCase for React components
(`TldrDeck.tsx`). Types/interfaces PascalCase; functions/vars camelCase; constants
SCREAMING_SNAKE (ported design constants keep their design names, e.g. `TDECK_STEP_MS`). DB:
snake_case tables (singular: `article`, `article_revision`) and columns; drizzle field names
camelCase mapped to snake_case. API JSON: camelCase. URL paths: kebab-case. Env: `BLOG0_*`.
No phase-suffixed file names (DTOs live in `dto.ts` sections; E2E specs are named by feature).

**Modules.** `src/lib/**` is pure and isomorphic (no I/O, no `server-only`). `src/server/**` files
begin with `import 'server-only'`. Client components begin with `'use client'` and never import
from `src/server`. Never read config at module top level (keeps `next build` env-free) — call
`getConfig()` inside functions. Singletons (`getConfig`, `getDb`, `getLlmClient`,
`getCurrentSite` cache, render cache, `getStorage`) each export a `reset…ForTests()`.

**Next.js specifics.** `params`/`searchParams` are awaited (`const { slug } = await params`).
Every DB-reading page exports `dynamic = 'force-dynamic'`. Route handlers export named
`GET/POST/PATCH/PUT/DELETE` wrapped in `withApi({ auth: 'admin' | 'none', csrf?, body?: zodSchema | 'multipart', maxBytes?, summarizeInput?, summarizeOutput?, cacheControl? }, handler)`;
handlers return plain data or throw `ApiError(code, status, message, details?)`. Long routes
(`tldr/generate`, `audio`) export `maxDuration = 120`.

**Errors.** Throw `ApiError` for expected failures; let unexpected errors bubble to `withApi`
(logs + 500 INTERNAL). Never return a stack trace. Error messages include the failing identifier
("Article 3f2c… not found"), never secrets.

**Logging.** Use `log.info('api.request', {...})` style (event first). Required fields per event
in §7. No `console.log` in `src/` (lint rule `no-console` except in `scripts/`).

**Testing.** Test names are sentences (`it('rejects a deck slide whose sentence no longer exists')`).
Arrange/Act/Assert separated by blank lines. Unit tests are deterministic (inject `now`, no
network; the LLM boundary may use a stub `LlmClient` whose outputs are tagged `<stub:jev>`).
Integration tests hit real `blog0_test` and the real OpenRouter key from `.env`; they assert
structural properties (bounds, verbatim, fields present), never exact prose. Each integration
test calls `resetDb()` in `beforeEach`. Stateful flows have a second interaction (save → save →
read; generate → edit → publish → re-read). Unit tests live in domain folders; E2E specs are
named by feature.

**Real-key tests (PENDING KEY rule).** Real-key tests are: `tests/integration/jev-openrouter.test.ts`,
the real Generate step of the tldr-flow integration test, the real-key paths of `seed-tldr` and
`designer-mode` integration tests, `pnpm eval:jev`, and the Generate step of the tldr E2E. Their
key check is `openRouterKeyStatus(raw)` (`src/server/llm/key.ts`): `'missing'` when empty,
`'placeholder'` when the value matches `PLACEHOLDER_RE` (starts with `replace`, `pending`,
`placeholder`, `changeme`, `change-me`, `your`, `xxx`, `todo` or `<`, or contains `placeholder` /
`replace-with`), else `'real'` — broader than the boot check in §10 (which rejects only the
`replace-with-` prefix, and only on `postgres://`). When the status is not `'real'` **and** `CI` is
not `true`, each test SKIPS with a visible reason containing `PENDING KEY`
(`PENDING_KEY_REASON = 'PENDING KEY: BLOG0_OPENROUTER_API_KEY not set'`; `eval:jev` prints it and
exits 0 without scoring). They are never stubbed into a pass — no stub `LlmClient`, no recorded
fixture, no `<stub:jev>` output on these paths. When `CI=true`, a missing/placeholder key is a
FAILURE. Whenever a real key is present, an invalid/rejected key (401/403) or any provider error
is a FAILURE, never a skip. A gate run that skipped any `PENDING KEY` test is reported as
"pending key", not as passed.

**Commits.** `phase-N: <what>`; fixes `phase-N fix: <what>`; spec-only `spec: <what>`; refactors
`refactor: <what>`.

---

## Design divergences (ask user)

Default for everything not listed: port the design exactly (markup, class names, CSS verbatim,
timings, copy). Numbers are stable (other files cite them).

### Decided

1. **Real routes**: `/p/<slug>`, `/p/<slug>/tldr`, `/p/<slug>/listen`, `/archive?topic=`, `/about`, paragraph links `/p/<slug>#p-…`; legacy design hashes on `/` redirect client-side (`LegacyHashRedirect`).
3. **Share targets** (user): LinkedIn, X, WhatsApp, Notes (mailto), Notion, Copy link everywhere a share exists; native sheet on touch/narrow (`spec/capabilities/paragraph-share.md`).
4. **Search removed**: masthead tools hold only the theme toggle.
6. **Boot strip on** (user): `SHOW_BOOT_STRIP = true`, `--booth: 28px`, design `bootCommand` lines and timings verbatim (`spec/capabilities/reader-site.md`).
7. **TLDR selection** (user): Jev picks 4–8 lines server-side; writers may hand-edit and reorder; the design heuristic is not ported.
9. **Listen without a recording**: the capsule's Listen (and the deck's mode-switcher Listen) stays visible but **disabled** with `title="No recording yet"` / `aria-label="Listen — no recording yet"` (same treatment as TLDR without a deck); card Listen buttons are hidden.
12. **Footer links**: X/LinkedIn only when the site has their URLs; no RSS (user).
13. **Contact mail**: `hello@logzero.blog` (seeded, editable in Admin → Site).
14. **About copy**: the design's full `ABOUT_BODY_FULL` is seeded.
15. **Newsletter success copy**: "You’re in. First issue lands Thursday."
19. **Featured**: per-article `is_featured` + `featured_rank`, stack treatment, max 4; seeded `ai-will-destroy-the-world`, `tech-company-first`, `humans-are-software`.
20. **Seeded decks** (user): `pnpm seed:tldr` (Jev with a real key, committed fixture without); the design's paraphrased arrays are never seeded.
21. **In-deck poll** (`DeckPoll`) not ported.
22. **Retired design code not ported** (margin notes, `AnnotationLayerLegacy`, `TldrPanel`, `FeaturedRotator`, `SentenceBuilder`, `GoDeeper`, `PullQuote`, `WordCloud`, `Tiers`, `ExpandCard`, `Thumb`); their CSS is pruned from `design.css` (`spec/ui.md` §1 rule 1).
23. **Fonts self-hosted** via `next/font`; the footer canvas reads `--font-mono`.
24. **"Next:" link**: next newer published article by first-published date, wrapping to the oldest.
25. **Brand is `blog0`** (user): replaces the design's `log0` everywhere `BRAND` is used (wordmark with the spinning nought, boot/footer lines, titles, share copy, admin header); brand values come from the `site` row; `spec/design/*` stays untouched.

### Open (current default in force; ask the user)

2. **Sentence highlight → paragraph highlight.** Default: the paragraph is the share unit — hover
   shows a faint accent rule in the left margin; click/tap (not on a link) or a selection inside
   it highlights the paragraph (`.para.is-hl`), copies `“text” — blog0\n<link>#p-…`, opens the
   menu. *Ask:* confirm paragraph-level and the hover affordance (no dotted underline).
5. **Reactions removed.** Default: the row is dropped; its **Share article** button stays at the
   top of `.artfoot`. *Ask:* keep that button?
8. **AI disclosure (new element).** Default: the intro slide shows a `.tdeck__note` line (§3
   disclosure texts). *Ask:* wording and placement (intro slide only vs every slide).
10. **Computed times.** Default: read = ceil(words/230), TLDR = the design's `tldrMinutes` over the
    published deck, listen = recording duration. *Ask:* 230 wpm OK?
11. **Markdown coverage beyond the design.** Default: GFM tables, Shiki code blocks, footnotes as
    "Notes", strikethrough, task lists — styled in `additions.css` from existing tokens. *Ask:*
    review their styling.
16. **Theme persistence.** Default: the reader's choice persists in
    `localStorage['blog0.theme']`; with none stored the OS preference applies. *Ask:* OK?
17. **Admin UI has no design.** Default: desk, editor, TLDR/Listen tabs, sign-in, Site,
    Subscribers are built from the design's tokens and components. *Ask:* review.
18. **Draft badge semantics.** Default: true drafts are never public; "Draft — in progress" is a
    per-article `in_progress` flag on published articles (seeded on "AI is Expensive"). *Ask:* OK?
26. **TLDR deck stacking order.** Default: `.tdeck { z-index: 46 }` in `additions.css` so the open
    deck covers the docked capsule/modebar (design: 40, below `.modebar` 45). *Ask:* confirm.
27. **Seed slug collision.** Default: `db:seed:posts` never overwrites an existing article on a
    seed slug (a dev DB may then show 2 featured instead of 3). *Ask:* OK, or take over the slug?
28. **Listen view shows the text.** The design's listen branch shows only tag, title and a mock
    player. Default: the article's Listen view keeps the **player primary** with the full text
    beside it, auto-following with a **soft** highlight, pausing on manual scroll with **Follow
    audio** to resume, click-to-seek (`spec/ui.md` §3 *Listen*); the card overlay stays
    player-only. `AudioPanel` is bound to a real `<audio>`; `.audio__note` reads
    "Read by <byline> · N min". *Ask:* OK?
29. **Listen timing is estimated, not exact.** Default: paragraph start times are estimated at
    read time from the recording's duration and word counts (150 wpm, ~0.6 s pause per
    paragraph; `spec/capabilities/listen-sync.md`), unlabelled for readers; stored aligner marks
    replace the estimate when they cover every paragraph. The highlight can drift from the
    voice. *Ask:* OK without an "approximate timing" note, and are 150 wpm / 0.6 s right?
