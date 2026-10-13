# blog0 — Architecture

Product narrative lives in `spec/roadmap.md` and `spec/capabilities/`. Data model: `spec/data.md`.
HTTP contract: `spec/api.md`. Screens and the design-component mapping: `spec/ui.md`. Jev (the only
AI capability): `spec/agent.md`. This file owns the HOW: system design, stack, layout, conventions,
and the list of deliberate design divergences.

## 1. System overview

One Next.js (App Router) process serves everything on a single origin (default
`http://localhost:3410`; in production the same process runs from the container image, §12):

```
                    ┌──────────────────────────── Next.js process (Node 22) ─────────────────────────────┐
 Reader browser ──► │ (site) server components ──► src/server/public ──► content pipeline (render, cache) │
                    │      └─ client islands: Masthead, TldrDeck, ArticleView, ListenView, figures, PrintIn│
 Writer browser ──► │ /admin pages (server guard) + client editor ──► /api/admin/* route handlers         │
                    │      route handlers ──► withApi (envelope, auth, origin check, request log)         │
                    │                    ──► services: articles, formats, jev, listen, media, users, site │
                    │      jev ──► llm decisions adapter ──► openrouter.ai/api/alpha/decisions (1 req/click) │
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
| Throttle core | `src/server/rate-window.ts`, `src/server/rate-window-store.ts` | `FixedWindowCounter`, `RateLimitStore` (memory + Postgres-backed) shared by the login and newsletter limits (§6). |
| Ops | `src/server/ops/*` | Release step, readiness check, graceful-shutdown lifecycle, backup/restore (§12). |
| Site | `src/server/site/*` | Resolve the current site (`BLOG0_SITE_SLUG`), cache it (§11.4), admin edits. |
| Content pipeline | `src/server/content/*` | Markdown → `RenderedArticle` (blocks, paragraphs, sentences, stats, fingerprints, warnings). Deterministic. |
| Formats | `src/server/formats/*` | One adapter per format kind (`read`, `tldr`, `listen`) implementing status, chip flags, validation, publish (§5). |
| Articles | `src/server/articles/*` | Create, save (revision), publish/unpublish, delete draft, TLDR generate orchestration + deck save. |
| LLM | `src/server/llm/*` | `LlmClient` (one method, `decide`) + the OpenRouter **decisions** adapter (retry/backoff/timeout, instrumentation), key presence check. Phase 8 removed the chat-completions client (Jev was its only user). |
| Jev | `src/server/jev/*` | The TLDR relevance ranker (see `spec/agent.md`). |
| Listen | `src/server/listen/*` | Audio probe + ingest, Listen state, aligner-facing marks save (§9.5). |
| Media | `src/server/media/*`, `src/server/storage/*` | Upload pipeline, image probe, byte ranges, cleanup; `Storage` interface + `LocalDiskStorage` (§9). |
| Newsletter | `src/server/newsletter/*` | Phase 7 (§13): owned list (signup → pending, tokens, confirm/unsubscribe, events + suppression, legacy, prune), transactional mail (`mail/`: nodemailer SMTP or recording stub), sender adapter (`sender/`: Listmonk REST or stub), issues (`issues/`: snapshot, render, triggers, send, stats), throttles. |
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
`ai_generation` (status `running`, task `tldr.rank`) and commit → `runJev()` (outside the
transaction; one decisions request, batched only past the context budget — `spec/agent.md` §2) →
on success update the row (succeeded, `output = { scores, selected, k, batches }`, usage, cost,
latency, `attempts` = requests sent) and replace the TLDR **draft** payload with the top-k slides
built **from the server's own sentence list** (never from model text), in document order → return
the deck + generation record. On failure update the row (failed, error_code, error_message, raw
response bodies) and return the mapped error; the draft deck is untouched. The row lock makes a
double click produce exactly one row.

**Relevance in the editor.** `buildTldrState` loads the article's **latest succeeded** `tldr`
generation (`latestSucceededGeneration` in `src/server/articles/repo.ts`) and reads
`output.scores` into a `sid → relevance` map (`readScores(output)` in `src/server/articles/tldr.ts`: legacy `{ picks: [{ index, sid,
reason }] }` outputs and malformed outputs give an empty map). `SentenceDto.relevance`,
`DeckSlideDto.relevance` and `GenerationDto.picks[].relevance` come from that map (null when the
sid is absent). Sids are content-derived (paragraph hash + position), so a sentence in an unchanged
paragraph keeps its score across edits — editing one sentence clears the scores of its whole paragraph;
scores are never stored in the format payload (one fact, one place).

**Deck edit.** `PUT /api/admin/articles/:id/tldr` `{revisionId, slides:[{sid, source}]}` (an extra
legacy `reason` key is stripped, not refused) → server resolves each `sid` against the revision's
sentences (text comes from the server), checks uniqueness and 1–12 slides → stores draft payload +
fingerprint.

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
  topics: string[]; year: number;
  newsletterConsentText: string }   // Phase 7: the line under the footer form (site.newsletter_consent_text)
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
- Throttle core (`src/server/rate-window.ts`): `FixedWindowCounter(max, windowMs)` stays as is
  (in-memory, first-hit windows keyed by string, bounded at 10 000 keys; `lockedFor`, `add`,
  `refund`, `delete`, `prune`). Phase 5 puts an async **store** in front of it (capability
  `abuse-protection.md`):

  ```ts
  export type RateScope = 'login.pair' | 'login.email' | 'newsletter.ip' | 'newsletter.email' | 'newsletter.site'
    | 'newsletter.link.ip' | 'newsletter.link.site';   // Phase 7: confirm + unsubscribe links
  export interface RateBucket { scope: RateScope; key: string; max: number; windowMs: number }
  export type RateCheck = { limited: false } | { limited: true; retryAfterSec: number; scope: RateScope };
  export interface RateLimitStore {
    readonly kind: 'memory' | 'db';
    /** Atomic: any bucket at its cap → limited (nothing counted; the longest wait is reported); else +1 in every bucket. */
    attempt(siteId: string, buckets: readonly RateBucket[], now: number): Promise<RateCheck>;
    /** −1 in the window containing `now` (never below 0; missing → no-op). */
    refund(siteId: string, bucket: RateBucket, now: number): Promise<void>;
    /** Removes the bucket's count for the window containing `now`. */
    clear(siteId: string, bucket: RateBucket, now: number): Promise<void>;
    /** Deletes expired windows; returns how many. */
    prune(now: number): Promise<number>;
  }
  export class MemoryRateLimitStore implements RateLimitStore {}   // one FixedWindowCounter per (scope, max, windowMs); keys siteId\0key
  ```
  `src/server/rate-window-store.ts`: `DbRateLimitStore(db?: Db)` (default `getDb()`), and the
  selection `getRateLimitStore()` (globalThis singleton) / `resetRateLimitStoreForTests(store?)`:
  `BLOG0_RATE_LIMIT_STORE` `auto` → `DbRateLimitStore` when `dbEngine === 'postgres'`, else
  `MemoryRateLimitStore`; `db`/`memory` force one. `DbRateLimitStore.attempt` = one
  `db.transaction(async (tx) => …)` (every statement on `tx` — §11.3): compute
  `window_start = floor(now / windowMs) × windowMs` and `key_hash = sha256hex(key)` per bucket →
  `insert … (count 0, expires_at = window_start + windowMs) on conflict do nothing` →
  `select … for update` of those rows ordered by `(scope, key_hash)` (deadlock-free) → any
  `count >= max` → return limited with `retryAfterSec = max(1, ceil((expires_at − now)/1000))`
  → else `update … set count = count + 1`. After the transaction, at most once per 10 min per
  process (`globalThis` timestamp), `prune(now)` = `delete from rate_limit_bucket where expires_at
  <= now` (failure → `warn` `rate_limit.prune_failed`, swallowed). DB errors in `attempt` propagate
  (fail closed → 500). Login (`src/server/auth/rate-limit.ts`) and newsletter
  (`src/server/newsletter/rate-limit.ts`) are thin async wrappers that build their buckets and call
  `getRateLimitStore()` per call (no state of their own; `resetLoginRateLimiterForTests()` /
  `resetNewsletterRateLimiterForTests(limits?)` keep their names and reset the store / limits).
- Login throttling: 5 failures per (lower-cased email, client IP) per 15 min, and 20 failures per
  lower-cased email across all IPs per 15 min → 429 `RATE_LIMITED` with `Retry-After` (even for
  the right password). Each allowed attempt is reserved atomically by `store.attempt()` (buckets
  `login.pair` + `login.email`) **before** the password is verified, so concurrent attempts — on
  any instance — cannot overrun the limit; a correct password `clear`s the pair bucket and
  `refund`s the email bucket at the attempt's `now`. Client IP:
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
- **Newsletter link throttling (Phase 7)** — `src/server/newsletter/rate-limit.ts`
  `getNewsletterLinkThrottle()`: the confirm and unsubscribe routes (pages and JSON, one shared
  pair of buckets) count 30 per known client IP per hour (`newsletter.link.ip`, skipped for
  `direct`/`unknown` exactly like signup) and 1 000 per site per hour (`newsletter.link.site`).
  The token is parsed and shape-checked first (a malformed token → 404 without counting); a
  well-formed token counts whether or not it turns out valid. The pages render the rate-limited
  copy in site chrome at HTTP 200 (a page cannot emit 429); the JSON routes answer `RATE_LIMITED`
  (429) + `Retry-After`. `GET /api/newsletter/unsubscribe` (the 303 to the page) does not count —
  the page it redirects to does. Known gap (Frozen — not scheduled, `spec/roadmap.md`): a flood
  of well-formed garbage unsubscribe tokens can exhaust the shared site bucket and block real
  unsubscribes for up to an hour; the decided fix is to exempt unsubscribe requests from
  `newsletter.link.site` (keeping the per-IP cap) — not implemented. The webhook route is not
  throttled (secret-gated). The admin routes are session-gated and not throttled.
- **Security headers (Phase 5).** Static, env-independent headers come from `next.config.ts`
  `headers()` for `source: '/:path*'` (every response: pages, API, `/media`, `/_next/static`):
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`.
  Runtime headers come from the proxy (`src/proxy.ts`) and only when `NODE_ENV === 'production'`:
  per request `nonce = randomBytes(16).toString('base64')`, then the request headers
  `x-nonce` + `content-security-policy` (Next 16 reads the nonce from the request CSP and stamps
  its own scripts) and the same `Content-Security-Policy` response header, plus
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` when
  `getConfig().publicBaseUrl` is https. The policy is built by the pure
  `buildContentSecurityPolicy({ nonce, https })` in `src/lib/http/csp.ts`; for
  `{ nonce: 'abc', https: false }` it is exactly:
  `default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'`
  and `https: true` appends `; upgrade-insecure-requests`. The same file exports
  `runtimeSecurityHeaders({ nonce, https }): Record<string, string>` (`content-security-policy`,
  plus `strict-transport-security` when `https`) — the proxy only adds the production gate and
  the nonce. Proxy matcher: the three article
  paths (always, as before — §8) plus
  `{ source: '/((?!api/|_next/|media/|favicon.ico|robots.txt|sitemap.xml).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] }`;
  the article 404 rewrite passes the same request headers (`NextResponse.rewrite(url, { request: { headers } })`)
  and sets the same response headers. The root layout becomes `async`, reads
  `(await headers()).get('x-nonce') ?? undefined` and renders the theme script as
  `<script nonce={nonce} dangerouslySetInnerHTML=…>` (every HTML route is already dynamic, so
  this costs nothing). `/media/[...key]` keeps its own headers (§9.2); `nosniff` from both sources
  is the same value.
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
| `api.request` | `withApi` (one line per API request, at completion; `withApi({ logLevel: 'debug' })` — used only by `/api/health/live` and `/api/health/ready` — logs 2xx at `debug`, anything else at the normal level) | `request_id, method, path, status, latency_ms, user_id?, input_summary, output_summary, err_code?` |
| `llm.call` | OpenRouter decisions adapter (one line per HTTP attempt) | `request_id, model, prompt_version, batch, batches, questions, attempt, latency_ms, input_tokens, output_tokens, cost_usd, provider_generation_id, provider, outcome ('ok'\|'http_error'\|'timeout'\|'invalid_body'), http_status?, provider_status?, err_message?` — `batch` 1-based of `batches`; `provider_status` = the code of an error embedded in a 200 body (`{ error: { code, message } }`; 502 when the code is not a number), present only then — `http_status` stays 200 and `provider_status` drives retry and classification; `questions` = count in this request; `attempt` = transport attempt 1–3; `provider_generation_id` = response `id`; `err_message` = provider message ≤ 300 chars, never article text |
| `llm.cost_missing` | decisions adapter (`warn`) | `request_id, model, provider_generation_id` |
| `jev.run` | `runJev` | `request_id, article_id, revision_id, sentence_count, k, batches, model, prompt_version, latency_ms, outcome ('ok'\|'error'), err_code?, missing_answers?, invalid_answers?, extra_answers?, top_relevance?, kth_relevance?` — `batches` = requests sent; counts and numbers only |
| `jev.deadline` | `runJev` (`warn`) | `request_id, article_id, batches, deadline_ms` |
| `auth.login` | login route | `outcome ('ok'|'bad_credentials'|'rate_limited'), email_masked` |
| `app.boot` | `instrumentation.ts` | `version, port, node, site_slug, db_engine, openrouter_key ('configured'\|'not configured (Jev disabled)')` (+ `db_dir`, `notice`, `session_secret` source on PGlite) |
| `media.upload` | audio/image ingest (`logMediaUpload`) | `request_id, kind ('audio'\|'image'), mime, bytes, duration_ms?, width?, height?, article_id?, outcome ('ok'\|'rejected'), err_code?` |
| `media.request` | `/media/[...key]` (not `withApi`; one line per request) | `request_id, key, status (200\|206\|304\|404\|416), range?, bytes_sent, latency_ms` |
| `media.remove` / `media.cleanup` / `listen.sync` | `removeAudio` / file cleanup failures (`warn`) / `saveMarks` | ids and counts only |
| `app.shutdown` | `src/server/ops/lifecycle.ts` (production only) | `signal, phase ('draining'\|'closed'), timeout_ms` (draining); `outcome ('drained'\|'timeout'), duration_ms, exit_code` (closed) |
| `rate_limit.prune_failed` | `DbRateLimitStore` (`warn`) | `err_code` |
| `newsletter.signup` | signup service (Phase 7) | `request_id, email_masked, outcome ('pending_created'\|'pending_renewed'\|'noop_confirmed'\|'noop_capped'\|'resignup'), source_url, consent_version` |
| `newsletter.mail` | transactional transport (`mail/transport.ts`) | `request_id?, kind ('confirmation'\|'test_issue'), to_masked, transport ('smtp'\|'stub'), outcome ('sent'\|'failed'\|'stubbed'), latency_ms, message_id?, err_code?` — **stub only** adds `confirm_url` (the full link) so designer mode and E2E can follow it; the SMTP transport never logs a token |
| `newsletter.link` | confirm/unsubscribe pages and JSON routes | `request_id?` (**API routes only** — the pages are not `withApi` and have no request id), `kind ('confirm'\|'unsubscribe'\|'one_click'), outcome ('ok'\|'already'\|'expired'\|'invalid'\|'rate_limited'), subscriber_id?` |
| `newsletter.provider` | listmonk adapter (one line per HTTP attempt) | `provider ('listmonk'), method, path` (**query string stripped** — Listmonk lookups carry the email in `?query=`), `status` (HTTP status, absent on network error/timeout), `attempt` (1-based), `ms`, `outcome ('ok'\|'retry'\|'failed'\|'invalid')` (`retry` = this attempt failed and another follows; `invalid` = 2xx with an unparseable/unexpected body), `error?` (message; never contains a subscriber email, a token or the API token) |
| `newsletter.sync` | `pnpm newsletter:sync` / admin sync / live sync after confirm-unsubscribe / before a listmonk send | `trigger ('script'\|'admin'\|'confirm'\|'unsubscribe'\|'webhook'\|'tick'\|'send'), synced, blocklisted, skipped, suppressed_from_provider, changed, errors, latency_ms` (`warn` when `errors > 0`); per-row opt-out-wins lines add `email_masked, subscriber_id`; the webhook line (`trigger 'webhook'`) carries `request_id, webhook_event ('unsubscribe'\|'bounce'\|'complaint'), email_masked, subscriber_id?, accepted` (`webhook_event`, never `event` — that key is the line's own name) plus `outcome: 'stale'` + `msg` when the event's `occurredAt` is older than the subscriber's latest consent/confirmation (ignored, §13.3) |
| `newsletter.issue` | issues service | `issue_id, number, origin, action ('created'\|'updated'\|'deleted'\|'test_sent'\|'send'\|'stats'), outcome ('ok'\|'sent'\|'failed'\|'skipped'), recipient_count?, campaign_id?, user_id?, err_code?` |
| `newsletter.tick` | `pnpm newsletter:tick` | `digest_created (bool), suppressions_pulled, stats_refreshed, ips_pruned, latency_ms` |
| `newsletter.mail_not_configured` | first transactional send in a production process without `BLOG0_SMTP_HOST` (`warn`, once per process) | `hint` |
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
`TLDR_MAX_SLIDES = 12`; Phase 8 drops the slide `reason` and `TLDR_REASON_MAX` — zod strips the key,
so legacy payloads parse).

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

## 10. Configuration (env → `src/server/config.ts`; every row documented 1:1 in `.env.example` except the build-only `BLOG0_STANDALONE` and `CI`)

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
| `BLOG0_OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | only `pnpm check:openrouter`'s `GET {base}/key` (Phase 8: no app code calls it) |
| `BLOG0_OPENROUTER_DECISIONS_URL` | no | `https://openrouter.ai/api/alpha/decisions` | Phase 8: the Jev endpoint (alpha path, hence its own variable) |
| `BLOG0_JEV_MODEL` | no | `typesafe/jev-1.13` | must be an OpenRouter **decisions** model; no fallback chain (`spec/agent.md` §3) |
| `BLOG0_JEV_TIMEOUT_MS` | no | `45000` | per decisions request |
| `BLOG0_LOG_LEVEL` | no | `info` | `debug|info|warn|error` |
| `BLOG0_LOG_FILE` | no | — | append JSON lines here too (E2E sets it) |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | seed + E2E | name `Sai Krishna V` | first admin; password ≥ 12 |
| `BLOG0_NEW_ADMIN_PASSWORD` | no | — | non-interactive `pnpm admin:create` |
| `BLOG0_STORAGE_DIR` | no | `./var/storage` | uploads root (§9.1) |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | no | `50` / `30` / `8` | upload limits, read at request time |
| `BLOG0_RATE_LIMIT_STORE` | no | `auto` | `auto` \| `db` \| `memory` (§6): `auto` = Postgres-backed on `postgres://`, in-memory on `pglite://`. `tests/setup/integration-env.ts` sets `memory` |
| `BLOG0_SHUTDOWN_TIMEOUT_MS` | no | `8000` | integer 1000–120000: drain deadline after SIGTERM/SIGINT (§12.2); also read by `scripts/serve.mjs` (kills the child after timeout + 5 s) |
| `BLOG0_STANDALONE` | no | — | not read by `config.ts`: `next.config.ts` sets `output: 'standalone'` only when it is `1` (the Dockerfile build stage sets it; local `pnpm build`/`pnpm start` never do) |
| `BLOG0_E2E_BASE_URL` | no | — | point Playwright at an already-running server (no `webServer` started) |
| `BLOG0_E2E_LOG_FILE` | no | — | test harness only: host path of the external server's JSON log (the container writes it through a bind mount); with `BLOG0_E2E_BASE_URL` set, the log-asserting E2E tests run only when this is set (else they skip with a reason) |
| `BLOG0_REQUIRE_REAL_KEY` | no | — | test harness/scripts only: `1` → a missing/placeholder OpenRouter key FAILS the real-key tests; `0` → it SKIPS as `PENDING KEY`; unset → `CI === 'true'` decides (Conventions → Real-key tests). CI sets it from secret presence |
| `BLOG0_CONTAINER_BUILD` | no | `auto` | read only by `scripts/container-e2e.sh` (§12.5 step 2): `auto` = rebuild `blog0:local` only when it is missing or a build-context file is newer than the image; `always` = always `docker build`; `never` = reuse the existing image (fail when it does not exist) |
| `BLOG0_SMTP_HOST` | no | — | Phase 7 (§13.2). Set ⇒ the transactional transport is nodemailer SMTP; unset/empty ⇒ the **stub** transport (designer mode, tests, E2E; also a production process, with one `newsletter.mail_not_configured` warning). Config field `newsletter.smtp: { host, port, user, pass, from } \| null` |
| `BLOG0_SMTP_PORT` | no | `587` | integer 1–65535; 465 ⇒ implicit TLS (`secure: true`), otherwise STARTTLS (`requireTLS: true`) |
| `BLOG0_SMTP_USER` / `BLOG0_SMTP_PASS` | with `BLOG0_SMTP_HOST` | — | SMTP credentials; `PASS` is a secret field (redacted, placeholder-rejected). Both empty ⇒ unauthenticated relay (allowed — Google Workspace IP-allowlisted relay) |
| `BLOG0_SMTP_FROM` | with `BLOG0_SMTP_HOST` | — | `Name <address>` or bare address; the From of every confirmation / test message. Must be set when `BLOG0_SMTP_HOST` is (ConfigError otherwise). Stub transport uses `blog0 <newsletter@localhost>` |
| `BLOG0_NEWSLETTER_SENDER` | no | `stub` | `listmonk` \| `stub` (§13.3). `listmonk` requires the four `BLOG0_LISTMONK_*` values (aggregated ConfigError) |
| `BLOG0_LISTMONK_URL` | with sender `listmonk` | — | Listmonk base URL, e.g. `http://localhost:9000` (compose) or `http://listmonk:9000` (same network); no trailing slash |
| `BLOG0_LISTMONK_API_USER` / `BLOG0_LISTMONK_API_TOKEN` | with sender `listmonk` | — | a Listmonk **API user** + its token (Listmonk ≥ v4, Settings → Users); `TOKEN` is a secret field |
| `BLOG0_LISTMONK_LIST_ID` | with sender `listmonk` | — | integer id of the list blog0 mirrors into (created once by hand or by `pnpm newsletter:sync --create-list`); blog0 never sends to any other list |
| `BLOG0_NEWSLETTER_WEBHOOK_SECRET` | no | — | ≥ 24 chars; secret field. Unset ⇒ `POST /api/newsletter/webhook` answers 404 |
| `BLOG0_DIST_DIR` | no | `.next` | not read by `config.ts`: `next.config.ts` `distDir`. A separate build dir (e.g. `.next-gate`) so a gate/CI `pnpm build` never overwrites the `.next` a running `pnpm start` serves; build and start with the same value (`scripts/serve.mjs` and the E2E `webServer` inherit it); `.next-*/` is gitignored |
| `CI` | no | — | not a `BLOG0_*` setting: enables Playwright `forbidOnly`; when `BLOG0_REQUIRE_REAL_KEY` is unset, `CI=true` turns a missing/placeholder OpenRouter key from a `PENDING KEY` skip into a failure (Conventions → Real-key tests) |
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

## 12. Deployment (Phase 5)

Product rules: `spec/capabilities/{container-image,backup-restore,abuse-protection}.md`. Runbook:
`docs/deploy.md`.

### 12.1 Image (`Dockerfile`, `.dockerignore`)

Three stages, `ARG NODE_VERSION=22.23.1` (must equal `package.json` `devEngines.runtime.version`):

1. **deps** — `FROM node:${NODE_VERSION}-slim`; `npm install -g pnpm@11.7.0` (= `packageManager`;
   not corepack — no signature-key drift); `WORKDIR /app`; `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./`;
   `RUN pnpm fetch --frozen-lockfile` (cache layer keyed only by the lockfile).
2. **build** — `FROM deps`; `COPY . .`; `RUN pnpm install --offline --frozen-lockfile`;
   `ENV NEXT_TELEMETRY_DISABLED=1 BLOG0_STANDALONE=1`; `RUN pnpm build && pnpm build:release && mkdir -p public`
   (so the runtime stage's `COPY public/` is unconditional even when the repo has no `public/`).
   No `BLOG0_*` runtime value exists at build time (the build is env-free — Conventions → Modules).
3. **runtime** — `FROM node:${NODE_VERSION}-slim`; `WORKDIR /app`;
   `ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3410 BLOG0_PORT=3410 HOSTNAME=0.0.0.0 BLOG0_STORAGE_DIR=/data/storage`;
   copy from build: `.next/standalone/` → `/app/`, `.next/static/` → `/app/.next/static/`,
   `public/` → `/app/public/` (always exists — created in the build stage), `src/server/db/migrations/` → same path,
   `src/server/jev/prompts/` → same path (both are read via `process.cwd()` paths — §11.2 migrator,
   `jev/prompt.ts`), `dist/release.mjs` → `/app/release.mjs`. Files stay root-owned;
   `mkdir -p /data/storage /app/.next/cache && chown node:node /data/storage /app/.next/cache`;
   `VOLUME /data/storage`; `USER node`; `EXPOSE 3410`; `STOPSIGNAL SIGTERM`;
   `HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3410)+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`;
   `CMD ["node","server.js"]`.

`.dockerignore`: `.git`, `node_modules`, `.next`, `.next-*`, `dist`, `var`, `test-results`,
`playwright-report`, `blob-report`, `coverage`, `.env`, `.env.*` then `!.env.example`, `spec`,
`docs`, `tests`, `workers`, `.github`, `playwright.config.ts`, `playwright.design.config.ts`,
`vitest.config.ts`, `*.tsbuildinfo`, `.DS_Store`, `Dockerfile`, `.dockerignore` (the build's type-check must not see a config
that imports the excluded `tests/`).

`next.config.ts` additions: `output: process.env.BLOG0_STANDALONE === '1' ? 'standalone' : undefined`
(so local `next start` never warns), and the static `headers()` block of §6. Native/external
packages (`serverExternalPackages`) are copied into `.next/standalone/node_modules` by Next's
tracing; if a runtime `Cannot find module` appears inside the container, the fix is an
`outputFileTracingIncludes` entry for that package (never a full `node_modules` copy).

**Release step.** `src/server/ops/release.ts` — `runRelease({ env, slug, out }: { env: Record<string, string | undefined>; slug: string; out: (line: string) => void }): Promise<void>`:
`loadDatabaseTarget(env)` (a `pglite://` target → `ReleaseUsageError`, exit 2) → `createDbHandle(target, { max: 1 })`
→ `runMigrations` → `getMigrationStatus` (pending > 0 → throw) → `out('release: ' + <db:verify line>)`
→ `seedSite(db, slug)` → when `BLOG0_ADMIN_EMAIL` and `BLOG0_ADMIN_PASSWORD` are both
non-empty: `seedAdmin(db, siteId, adminCredentialsFromEnv(env), { resetPassword: false })` → one
`site … , admin …` line in `db:seed`'s format (else `site <slug> <status>, admin skipped (BLOG0_ADMIN_* not set)`)
→ close. `scripts/release.ts` (`pnpm release` locally) loads `.env` with `@next/env`, validates
`BLOG0_SITE_SLUG` with the same rule as `siteSlugFromEnv`, prints `release failed: <message>` and
exits 1 (2 for `ReleaseUsageError`); it must **not** import `scripts/lib/cli.ts` (that pulls the
content pipeline in through `seed-posts`, which would bloat the bundle with Shiki).
`scripts/build-release.mjs` (`pnpm build:release`) bundles `scripts/release.ts` with esbuild into
`dist/release.mjs`: `platform: 'node'`, `format: 'esm'`, `target: 'node22'`, `bundle: true`,
tsconfig paths honoured (`@/*`), `alias: { 'server-only': './scripts/lib/empty-module.mjs' }`,
`external: ['@node-rs/argon2', 'next']`, `legalComments: 'none'`. Why: Next's standalone output
under pnpm exposes only a few packages at `/app/node_modules` — `@node-rs/argon2` is one of them
(native binary, stays external), but `postgres` and `@electric-sql/pglite` live only under
`node_modules/.pnpm`, reached by the server through hashed `.next/node_modules` links, so a bare
import from `/app/release.mjs` cannot resolve them. Hence `postgres` (pure JS) is **bundled**;
`@electric-sql/pglite` (and any subpath) is replaced by a plugin-supplied stub whose `PGlite`
constructor / `PGlite.create()` throw (the release step refuses `pglite://` before opening a DB,
so the Postgres path never needs PGlite); `next` stays external (only reached through
type-level/tree-shaken imports of the request guard). A second plugin resolves any
`…/allow-server-only` import (the tsx-only `server-only` shim, which resolves `server-only` from
disk) to `scripts/lib/empty-module.mjs`. Banner (bundled CommonJS such as `@next/env` needs
`require`/`__dirname`; the alias avoids clashing with `src/server/db/pglite.ts`'s own
`createRequire` import, since esbuild does not rename banner bindings), joined with spaces:
`import { createRequire as __blog0CreateRequire } from 'node:module'; const require = __blog0CreateRequire(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;`.
The container runs it as `node release.mjs` with the same env as the web server.
Product-level note: `spec/capabilities/container-image.md` (Assumed S5.1).

### 12.2 Probes and graceful shutdown

- `src/server/ops/lifecycle.ts`: `isShuttingDown(): boolean`, `installShutdownHandlers(opts?: { timeoutMs?: number; exit?: (code: number) => never; closeDb?: () => Promise<void>; now?: () => number }): void`
  (idempotent via `globalThis[Symbol.for('blog0.shutdown')]`; the options exist for unit tests).
  `src/instrumentation.ts` calls it after `app.boot` **only when `NODE_ENV === 'production'`**.
  On the first SIGTERM/SIGINT: set the shutting-down flag; log `app.shutdown` `phase:'draining'`;
  wrap `process.exit` once so that Next's own exit — Next's built-in handler (`next start` and the
  standalone server alike) stops accepting connections and waits for in-flight requests, then
  calls `process.exit(143 | 130)` — first runs `closeDb()` (capped at 3 s), logs
  `app.shutdown` `phase:'closed', outcome:'drained'`, then exits with Next's code; start an
  unref'd deadline timer of `getConfig().shutdownTimeoutMs` that, if it fires first, logs
  `outcome:'timeout'`, closes the DB (3 s cap) and exits 1. Further signals are ignored.
  > **Assumed:** wrapping `process.exit` is the hook point — Next 16 exposes no post-drain
  > callback, and `NEXT_MANUAL_SIG_HANDLE` would remove the server-close/drain we want to keep.
- `scripts/serve.mjs` (local `pnpm start`/`pnpm dev`): keeps forwarding SIGINT/SIGTERM/SIGHUP; on
  the first SIGTERM/SIGINT it also arms a kill timer of `BLOG0_SHUTDOWN_TIMEOUT_MS` (default
  8000) + 5000 ms that `SIGKILL`s the child, prints `blog0: server did not exit within <n> ms —
  killed`, and exits 1; the child's exit code is mirrored as today.
- `src/server/ops/readiness.ts`: `checkReadiness(): Promise<ReadinessResult>` — shutting down →
  `{ ready: false, reason: 'SHUTTING_DOWN' }`; `getDbHandle().ping()` raced with 3 s (failure →
  driver error logged as `/api/health` does, `reason: 'DB_UNAVAILABLE'`); then
  `getMigrationStatus(getDbHandle())` (the open app handle, left open) → `pending.length > 0` →
  `reason: 'MIGRATIONS_PENDING', pending`; else ready with latency, engine, applied count, latest
  tag. Routes (`withApi({ auth: 'none', logLevel: 'debug' })`, `dynamic = 'force-dynamic'`,
  `Cache-Control: no-store`): `src/app/api/health/live/route.ts` (never touches the DB or config
  beyond `APP_VERSION`), `src/app/api/health/ready/route.ts`. Contract: `spec/api.md` → health.
  `/api/health` is unchanged.

### 12.3 Backup / restore (`src/server/ops/{pg-tools,backup-manifest,backup,restore}.ts`)

- `pg-tools.ts`: `findPgTool('pg_dump' | 'pg_restore')` (spawn `<tool> --version` on `PATH`;
  ENOENT → `BackupError` with the install hint from the capability), major-version check against
  the server's `server_version`; `pgEnv(url)` → `{ PGPASSWORD }` + a password-less `--dbname` URI.
  `tar` is spawned the same way (`tar -czf` / `tar -xzf`, `-C <dir> .`).
- `backup-manifest.ts` (pure): zod `backupManifestSchema` (`format: 'blog0-backup/1'`, shape in the
  capability), `BACKUP_TABLES = ALL_TABLE_NAMES` minus `rate_limit_bucket`,
  `compareRestore(manifest, observed): { ok: boolean; lines: string[] }`, `backupDirName(now)`.
- `backup.ts` — `createBackup({ databaseUrl, outDir, storageDir, now?, out })`: one postgres.js
  connection (`max: 1`), `begin isolation level repeatable read read only` → `select
  pg_export_snapshot()` → `count(*)` per `BACKUP_TABLES` + migration status → spawn
  `pg_dump --format=custom --no-owner --no-acl --snapshot=<id> --exclude-table-data=public.rate_limit_bucket --file=<dir>/db.dump`
  while the transaction is open → commit → walk the storage dir (regular files only) → tar it →
  sha256 both files → write `manifest.json` last. Any failure removes the new backup dir.
- `restore.ts` — `restoreBackup({ inDir, target, storageDir, force, checkOnly, out })`: parse +
  checksum-verify → `ensurePostgresDatabase(target)` → emptiness check (tables in `public` or a
  `drizzle` schema) → `--force` wipe (`drop schema if exists drizzle cascade; drop schema public
  cascade; create schema public`) → `pg_restore --no-owner --no-acl --single-transaction --exit-on-error`
  → storage (refuse/empty with guards, extract) → restore-check (`compareRestore`).
- `scripts/backup.ts`, `scripts/restore.ts`: `runCli` + flag parsing (a leading `--` from
  `pnpm <script> -- …` is ignored); usage errors exit 2.

### 12.4 CI (`.github/workflows/ci.yml`)

Triggers: `push` (all branches) and `pull_request`; `permissions: contents: read`; concurrency
per ref with cancel-in-progress. Workflow-level env:
`BLOG0_OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY || 'pending-placeholder' }}` (a
placeholder passes the boot check, is classified `placeholder` by `openRouterKeyStatus`),
`BLOG0_REQUIRE_REAL_KEY: ${{ secrets.OPENROUTER_API_KEY != '' && '1' || '0' }}`,
`HAS_OPENROUTER_KEY: ${{ secrets.OPENROUTER_API_KEY != '' }}`,
`BLOG0_DATABASE_URL: postgres://postgres:postgres@localhost:5432/blog0_dev`,
`BLOG0_TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/blog0_test`,
`BLOG0_ADMIN_EMAIL: ci-admin@example.test`, `BLOG0_ADMIN_PASSWORD: ci-admin-password-0001`,
`NEXT_TELEMETRY_DISABLED: 1`. Every job: `actions/checkout@v4`, `pnpm/action-setup@v4` (version from
`packageManager`), `actions/setup-node@v4` with `node-version: 22.23.1` and `cache: pnpm`,
`pnpm install --frozen-lockfile`, and a step writing `BLOG0_SESSION_SECRET=$(openssl rand -base64 48)`
to `$GITHUB_ENV`. Jobs:
- `check`: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`.
- `integration`: service `postgres:18` (`POSTGRES_PASSWORD: postgres`, port 5432, `pg_isready`
  health options); install `postgresql-client-18` from the PGDG apt repo (backup test);
  `pnpm db:create && pnpm db:migrate && pnpm db:verify`; `pnpm test:integration`.
- `e2e`: same service; `pnpm exec playwright install --with-deps chromium`; `pnpm db:create`; `pnpm build`;
  `pnpm test:e2e`; `pnpm test:e2e:design`; on failure upload `playwright-report/` and
  `test-results/` as artifacts.
- `image`: `docker build -t blog0:ci .`; `docker run --rm blog0:ci id -u` = `1000`; run detached
  with an unreachable DB URL (`postgres://nobody@127.0.0.1:1/none`), a random session secret and
  the placeholder key; poll `/api/health/live` → 200 and `/api/health/ready` → 503 `NOT_READY`;
  `docker stop` → exit code 143 and an `app.shutdown` `closed` log line.
- Each of `integration` and `e2e` ends with a step `if: env.HAS_OPENROUTER_KEY != 'true'` that
  prints `::warning::PENDING KEY — real-key tests were skipped (no OPENROUTER_API_KEY secret)`.
No deploy job, no registry push.

### 12.5 Container E2E (`scripts/container-e2e.sh`, `pnpm test:container`)

`set -euo pipefail`, run from the repo root, image `blog0:local`, container `blog0-e2e`, host port
3412. Steps, each echoing `container-e2e: <step>`; any failure prints `container-e2e: FAIL <step>`
and exits 1; a `trap` always runs `docker rm -f blog0-e2e`:
1. `docker info` fails → print `PENDING DOCKER: docker daemon not reachable (start it: colima start)` and **exit 3** (a gate reports this as pending, never as passed).
2. `docker build -t blog0:local .` — subject to `BLOG0_CONTAINER_BUILD` (§10; default `auto`
   reuses an image no older than every build-context file).
3. `node scripts/lib/container-env.mjs` writes `var/container-e2e.env` (mode 0600) — the
   `BLOG0_*` values from `.env` + shell (via `@next/env`), minus `BLOG0_DATABASE_URL`,
   `BLOG0_TEST_DATABASE_URL`, `BLOG0_PORT`, `BLOG0_PUBLIC_BASE_URL`, `BLOG0_STORAGE_DIR`,
   `BLOG0_LOG_FILE`, `BLOG0_DIST_DIR`, `BLOG0_E2E_*`, `BLOG0_ADMIN_*`, `BLOG0_NEW_ADMIN_PASSWORD`,
   `BLOG0_REQUIRE_REAL_KEY`, values unquoted, one `KEY=value` per line — and prints the container
   DB URL: `BLOG0_TEST_DATABASE_URL` with host `localhost`/`127.0.0.1` replaced by
   `host.docker.internal`.
4. `node scripts/lib/container-env.mjs reset-db` (creates `blog0_test` if missing, then empties its schemas; `db:create` refuses when the test and dev URLs match), then the release step:
   `docker run --rm --add-host=host.docker.internal:host-gateway --env-file var/container-e2e.env -e BLOG0_DATABASE_URL=<container url> blog0:local node release.mjs`
   → output contains `0 pending: OK`.
5. `mkdir -p var/storage-e2e test-results`, then
   `docker run -d --name blog0-e2e --add-host=host.docker.internal:host-gateway -p 3412:3410 --env-file var/container-e2e.env -e BLOG0_DATABASE_URL=<container url> -e BLOG0_PUBLIC_BASE_URL=http://localhost:3412 -e BLOG0_LOG_FILE=/logs/e2e-server.log -v "$PWD/var/storage-e2e:/data/storage" -v "$PWD/test-results:/logs" blog0:local`.
6. Poll `curl -fsS http://localhost:3412/api/health/live` (≤ 60 s), then
   `docker inspect -f '{{.State.Health.Status}}' blog0-e2e` = `healthy` (≤ 60 s), then
   `/api/health/ready` contains `"status":"ready"`.
7. `docker exec blog0-e2e id -u` = `1000`. **No page request before step 8**: a page would cache
   the site row (§11.4, 60 s) that global setup is about to replace.
8. `BLOG0_E2E_BASE_URL=http://localhost:3412 BLOG0_E2E_LOG_FILE=test-results/e2e-server.log pnpm test:e2e`
   (global setup resets `blog0_test` and empties — never removes — the bind-mounted
   `var/storage-e2e`).
9. At least one `var/storage-e2e/blog0/audio/*/*/*.mp3` exists on the host (written by the
   container through the volume); `curl -sI http://localhost:3412/` has `content-security-policy`
   with `'nonce-` and `x-frame-options: DENY`.
10. `docker stop -t 20 blog0-e2e` finishes in < 12 s; exit code (`docker inspect -f '{{.State.ExitCode}}'`)
    is 143; `docker logs blog0-e2e` has an `app.shutdown` line with `"outcome":"drained"`.
11. Print `container-e2e: PASS`, exit 0.

> **Assumed:** Colima's bind mounts accept writes from the container's uid 1000 into the host
> user's directories (Colima maps them to the host user); a Linux host with a different uid must
> `chmod`/`chown` `var/storage-e2e` and `test-results` first (the runbook notes it).

### 12.6 docker-compose: Listmonk beside blog0 (Phase 7)

`docker-compose.yml` at the repo root (slice S7.2) — the local Listmonk for the adapter
integration test and the reference shape for a production deploy where Listmonk shares the
Postgres **instance** with blog0 but has its **own database**:

```yaml
name: blog0
services:
  postgres:                     # one instance, two databases (blog0 + listmonk)
    image: postgres:18
    environment: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: postgres }
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/compose/init-db.sh:/docker-entrypoint-initdb.d/10-init-db.sh:ro   # creates blog0, blog0_test, listmonk (+ role listmonk)
    ports: ["127.0.0.1:5433:5432"]            # 5433: never clashes with the Homebrew Postgres on 5432
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, timeout: 3s, retries: 20 }
  listmonk:
    image: listmonk/listmonk:v5.1.0          # pinned; bump deliberately (the adapter test pins the API shape)
    depends_on: { postgres: { condition: service_healthy } }
    command: [sh, -c, "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"]
    environment:
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_app__root_url: http://localhost:9000
      LISTMONK_db__host: postgres
      LISTMONK_db__port: "5432"
      LISTMONK_db__user: listmonk
      LISTMONK_db__password: listmonk
      LISTMONK_db__database: listmonk
      LISTMONK_db__ssl_mode: disable
      LISTMONK_ADMIN_USER: ${LISTMONK_ADMIN_USER:-admin}
      LISTMONK_ADMIN_PASSWORD: ${LISTMONK_ADMIN_PASSWORD:-listmonk-admin-dev-password}
      TZ: Etc/UTC
    ports: ["127.0.0.1:9000:9000"]
    volumes: [listmonk-uploads:/listmonk/uploads]
    healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:9000/api/health >/dev/null || exit 1"], interval: 5s, timeout: 3s, retries: 30 }
  blog0:                                      # optional — `docker compose --profile app up`
    profiles: [app]
    build: .
    image: blog0:local
    depends_on: { postgres: { condition: service_healthy } }
    env_file: [blog0.env]                     # the runbook's env file (never committed)
    environment:
      BLOG0_DATABASE_URL: postgres://postgres:postgres@postgres:5432/blog0
      BLOG0_NEWSLETTER_SENDER: listmonk
      BLOG0_LISTMONK_URL: http://listmonk:9000
    ports: ["127.0.0.1:3410:3410"]
    volumes: [blog0-storage:/data/storage]
volumes: { pgdata: {}, listmonk-uploads: {}, blog0-storage: {} }
```

`scripts/listmonk-dev.sh up|down|reset|token` (`pnpm listmonk:up` = `up`): `up` runs
`docker compose up -d --wait postgres listmonk` (exit 3 + `PENDING DOCKER` when `docker info`
fails, same contract as `container-e2e.sh`), then — idempotently, through the admin
basic-auth API — ensures an API user `blog0` with a token stored in `var/listmonk-dev.env`
(`BLOG0_LISTMONK_URL`, `BLOG0_LISTMONK_API_USER`, `BLOG0_LISTMONK_API_TOKEN`,
`BLOG0_LISTMONK_LIST_ID` of a list named `blog0-test`, mode 0600) which the integration test and
the gate source; `reset` drops and recreates the `listmonk` database (fresh state for the test);
`token` prints the env file. Listmonk's own SMTP is left unconfigured in compose: `sendIssue`
starts a campaign that Listmonk "sends" to its (unconfigured) default messenger, which is
enough to observe `running`/`finished` and stats; a real deploy configures Listmonk's SMTP in
its UI (runbook).

> **Assumed:** Listmonk `v5.1.0` image tag; the orchestrator verifies the tag exists before the
> before-fan-out commit and pins the newest v5 patch if not. API-user auth (`Authorization: token
> user:token`) is used throughout; the admin password is used only by `listmonk-dev.sh` to create
> that API user.
> **Assumed:** host port 5433 for the compose Postgres so the local Homebrew instance (5432,
> `blog0_dev`/`blog0_test`) stays the gate database; the compose `blog0`/`blog0_test` databases
> exist only for the `--profile app` path.

## 13. Newsletter (Phase 7)

Product rules: `spec/capabilities/newsletter-list.md`, `spec/capabilities/newsletter-issues.md`;
tables `spec/data.md`; HTTP `spec/api.md` → newsletter; screens `spec/ui.md` §4.

### 13.1 List service (`src/server/newsletter/{constants,tokens,service,links,legacy,prune,audit,repo,schemas,sender-hook}.ts`)

- `constants.ts`: `CONFIRM_TOKEN_TTL_MS = 72 h`, `CONFIRMATION_SENDS_PER_DAY = 3`,
  `IP_RETENTION_MS = 365 d`, `SIGNUP_SOURCE_URL_MAX = 500`, `USER_AGENT_MAX = 300`,
  `CONSENT_TEXT_MAX = 300`, `LINK_CAP_PER_IP = 30`, `LINK_CAP_PER_SITE = 1000`.
- `tokens.ts` (pure): `newConfirmToken(): { token, hash }` (32 random bytes → base64url;
  `hash = sha256hex(token)`), `hashConfirmToken(token)`, `signUnsubscribeToken(subscriberId, secret)`
  → `<uuid-as-base64url>.<base64url(HMAC-SHA256(secret, 'blog0.newsletter.unsubscribe:' + id))>`,
  `verifyUnsubscribeToken(token, secret): string | null` (constant-time compare), `isWellFormed*`.
  The secret is `getConfig().sessionSecret` (one secret, domain-separated).
- `schemas.ts` (zod): `subscribeBody` gains `sourceUrl` (string, trimmed, must start with `/`, no
  `//`, ≤ 500, default `/`); `settingsPatch`, `issueCreate`, `issueUpdate`, `webhookBody`.
- `service.ts` — `subscribe(ctx: SignupContext, input)` in **one transaction** (lock the
  subscriber row if it exists): decide the outcome (`newsletter.signup` outcomes in §7) → upsert
  the row (status `pending`, new token + expiry, signup metadata, consent copied from the current
  site row, `consented_at = now`; a `confirmed` row is untouched) → append `signup` (+
  `details.resignup` when the previous status was suppressed/legacy) → commit → **after commit**
  send the confirmation (`mail/`) and append `confirmation_sent` with the outcome (a failed send
  never rolls back the signup). `confirmByToken(token, ctx)`: hash → row by `(site_id, hash)`
  (none → `TOKEN_INVALID`; expiry passed → `TOKEN_EXPIRED`; the row is `pending` by construction
  since confirmation clears the hash) → one transaction: status `confirmed`, `confirmed_*`, clear
  token, append `confirmed` or `resubscribed` (when a suppression exists for the row) → after
  commit `afterConfirm(subscriber)` (`sender-hook.ts`, below; failure logged, never surfaced to
  the reader) → `{ alreadyConfirmed: false }`. `unsubscribeByToken(token, source)`: verify → row
  by id → already `unsubscribed`/`bounced` → `{ alreadyUnsubscribed: true }` (no rows written) →
  else `suppress(row, { reason: 'unsubscribed', source })`. `suppress(row, { reason, source,
  details, actor })` = one transaction that first **re-reads the subscriber row under
  `SELECT … FOR UPDATE`** and decides from that locked copy (already `unsubscribed`/`bounced` →
  no rows written, `already: true`) — so two concurrent unsubscribes (link + one-click, webhook +
  tick) write exactly one suppression row; then status (`bounced` for reason `bounced`, else
  `unsubscribed`), `unsubscribed_at`, append suppression + event → after commit
  `afterSuppress(subscriber)`. Every write path appends its event in the same transaction as the
  row change.
- `sender-hook.ts`: `afterConfirm(subscriber)` / `afterSuppress(subscriber)` — the list
  service's only link to the provider. Slice S7.1 ships them as no-ops logging at `debug`; S7.3
  wires them to `sender/sync.ts` (`syncOne` / `removeOne`, 13.3). Both swallow and log
  (`newsletter.sync` at `warn`) — a provider outage never fails a reader's click.
- `legacy.ts`: `sendLegacyConfirmation(id)` (one-time rule), `sendAllLegacyConfirmations()`
  (batches of 20, 200 ms pause, continues on mail failure). The one-time check is re-done on the
  row read under `SELECT … FOR UPDATE` (status still `legacy_unconfirmed`,
  `legacy_confirmation_sent_at` still null); the lock is held until the send result is recorded
  (success → `legacy_confirmation_sent_at` + token + event in that transaction; mail failure →
  rollback, nothing changes, `MAIL_FAILED`), so a double click or the bulk button racing a per-row
  click sends one email and the loser gets `CONFIRMATION_ALREADY_SENT` (bulk: counts the row as skipped). A legacy row that gets its email
  receives a **token** like a pending row but keeps status `legacy_unconfirmed` (so the admin list
  still shows it as legacy) until the click flips it to `confirmed`.
- `prune.ts`: `pruneIps(now)` with `before = now − 365 d` (`IP_RETENTION_MS`). A subscriber's
  **prune bar** (`retentionAnchor`) is `coalesce(greatest(confirmed_at, consented_at), created_at)`
  (`greatest` ignores nulls) — the latest act of consent, so a re-signup or re-confirmation
  restarts the 12 months. Per row (`rowIpsDue`): `signup_ip` is nulled when the bar `< before`;
  `confirmed_ip` is nulled when `coalesce(confirmed_at, bar) < before` — it also expires 12 months
  after **its own** `confirmed_at`, so an old confirmation's IP never outlives it through a newer
  pending re-signup. Candidates (`repo.pruneCandidates`, the SQL twin) are rows with either row IP
  due **or** any event with a non-null `ip` and `created_at < before`; each is re-read under its
  row lock in its own transaction. Event IPs older than `before` are nulled **even when the
  subscriber row itself is too recent** for its own IPs to go (newer events keep theirs until they
  too are 12 months old). When anything was nulled: set `ip_pruned_at` (only if a row IP was
  nulled) and append `ip_pruned` with details
  `{ retentionDays, hadSignupIp, hadConfirmedIp, eventRows, before }` (`had*` = that row IP was
  nulled by this run; `eventRows` = event rows nulled; `before` = the ISO cutoff). Event IPs are
  nulled by the `SECURITY DEFINER` function
  `newsletter_prune_event_ips(p_subscriber_id uuid, p_before timestamptz) RETURNS integer`
  (`SET search_path = public, pg_temp`; it bypasses the ledger guard — the only sanctioned
  update of an event row; it touches `ip` only, and only where `created_at < p_before`; returns
  the row count). Migration `0003_newsletter_prune_fix` replaces the one-argument version of
  `0002_newsletter` (drop + create; hand-written SQL, no schema change) — `spec/data.md`.
- `audit.ts`: `buildAuditBundle(siteId, actor)` → `NewsletterAuditBundle` (streams nothing —
  < 10 k subscribers assumed); `subscribersToCsv` grows the columns of `spec/api.md`.
- `links.ts`: `confirmUrl(token)` / `unsubscribeUrl(subscriberId)` → absolute under
  `getConfig().publicBaseUrl`; `consentLine(subscriber, site)` → "You’re getting this because
  you subscribed at <brand> on <date> and confirmed on <date>." (site timezone; legacy-confirmed
  rows read "…subscribed at <brand> and confirmed on <date>"). `oneClickUnsubscribeUrl(subscriberId)`
  → `<publicBaseUrl>/api/newsletter/unsubscribe?t=<same signed token>` — used **only** in the
  `List-Unsubscribe` header (13.2), never as a visible link. `unsubscribePageUrl(token)` →
  `<publicBaseUrl>/newsletter/unsubscribe?t=<token>` for a token already in hand — the 303 target
  of a GET on the one-click route. `unsubscribeToken(subscriberId)` signs with the session secret.

### 13.2 Transactional mail (`src/server/newsletter/mail/{transport,templates,index}.ts`)

```ts
export interface MailMessage { to: string; subject: string; html: string; text: string; kind: 'confirmation' | 'test_issue'; subscriberId?: string; issueId?: string; confirmUrl?: string; listUnsubscribeUrl?: string; requestId?: string }
// listUnsubscribeUrl (renamed from unsubscribeUrl): the List-Unsubscribe header target = links.oneClickUnsubscribeUrl(id), never the page
export interface MailResult { outcome: 'sent' | 'stubbed'; transport: 'smtp' | 'stub'; messageId: string; messageRowId: string }
export interface MailTransport { readonly kind: 'smtp' | 'stub'; send(msg: MailMessage): Promise<MailResult> }   // throws MailError on failure
export function getMailTransport(): MailTransport;          // globalThis singleton from getConfig().newsletter.smtp; resetMailTransportForTests(t?)
```

`SmtpTransport` wraps `nodemailer.createTransport({ host, port, secure: port === 465, requireTLS: port !== 465, auth?, connectionTimeout: 10_000, socketTimeout: 20_000 })`,
`from = BLOG0_SMTP_FROM`, `List-Unsubscribe: <origin/api/newsletter/unsubscribe?t=<token>>` +
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers on every message whose
`listUnsubscribeUrl` is set (`listUnsubscribeHeaders(url)` — none without one; the confirmation
mail sets it) (RFC 8058: the header URL is the **POST-able JSON route**, not the page —
`links.ts` `oneClickUnsubscribeUrl(subscriberId)`; a client that GETs it is 303'd to the page via
`unsubscribePageUrl`).
The **visible** unsubscribe link in every body stays the page (`unsubscribeUrl`). It inserts the
`newsletter_message` row (`transport 'smtp'`, `status 'sent' | 'failed'`, provider message id /
error) **after** the SMTP result. `StubTransport` inserts the row with `transport 'stub'`,
`status 'stubbed'` and logs `newsletter.mail` with `confirm_url` (when present). Both log
`newsletter.mail`. `nodemailer` is a main dependency and goes in `serverExternalPackages`
(it `require`s optional peer modules at runtime). `templates.ts` (pure, no I/O):
`confirmationEmail({ brand, confirmUrl, unsubscribeUrl, consentText, expiresHours, publicBaseUrl })`
→ `{ subject: 'Confirm your subscription to <brand>', html, text }` — single-column table, inline
styles, a button + the raw link, the expiry note, "If you didn’t ask for this, ignore this
email.", the consent line; `issueEmail(IssueRenderInput)` (13.4). HTML is built with a tiny
escaping helper (`esc()`), never with the Markdown pipeline except `intro_md` (rendered through
`renderArticle`'s inline subset: paragraphs, emphasis, links; figures/code stripped).

### 13.3 Sender adapter (`src/server/newsletter/sender/{types,listmonk,stub,index}.ts`)

```ts
export interface SenderSubscriber {
  subscriberId: string; email: string; name: string | null;
  status: 'enabled' | 'blocklisted';
  attribs: { blog0_subscriber_id: string; blog0_unsubscribe_url: string; blog0_consent_line: string;
             consent_version: string | null; consented_at: string | null; confirmed_at: string | null; signup_source_url: string | null };
}
export interface SenderIssue { issueId: string; number: number; subject: string; html: string; text: string }   // html already contains the provider placeholders (13.4)
export interface SenderStats { recipients: number; sent: number; delivered: number | null; opens: number | null; clicks: number | null; bounces: number | null; unsubscribes: number | null }
export interface SenderSuppression { email: string; reason: 'unsubscribed' | 'bounced' | 'complaint'; at: Date; details: Record<string, unknown> }
export interface NewsletterSender {
  readonly kind: 'listmonk' | 'stub';
  healthcheck(): Promise<{ ok: boolean; message: string; listName?: string }>;
  syncSubscriber(s: SenderSubscriber): Promise<{ providerId: string; changed: boolean }>;   // upsert, idempotent
  removeSubscriber(email: string): Promise<{ changed: boolean }>;                          // blocklist — never delete
  createIssue(i: SenderIssue): Promise<{ campaignId: string }>;
  sendIssue(campaignId: string): Promise<void>;                                            // start; idempotent for a running/finished campaign
  fetchStats(campaignId: string): Promise<SenderStats>;
  fetchSuppressions(since: Date): Promise<SenderSuppression[]>;
}
export class SenderError extends Error { constructor(public code: 'UNAVAILABLE' | 'HTTP' | 'TIMEOUT' | 'INVALID', message: string, public httpStatus?: number) }
export function getNewsletterSender(): NewsletterSender;   // from getConfig().newsletter.sender; resetNewsletterSenderForTests(s?)
```

**Listmonk adapter** (`listmonk.ts`, plain `fetch`, 15 s timeout per call, one retry on
network error/5xx with 500 ms backoff, every attempt logged `newsletter.provider` — §7 fields):
`Authorization: token <apiUser>:<apiToken>`, JSON. **Error hygiene:** a `SenderError` message (and
therefore `last_error`, `newsletter.provider.error`, `newsletter.sync` and the sync response's
`errors[].message`) never contains a subscriber email — Listmonk error bodies and request paths
that may echo one (`?query=subscribers.email='…'`, 409 "E-mail already exists" texts) are reduced
to method, query-stripped path, HTTP status and a fixed description; nor the API token. Mapping:

| Method | Listmonk REST |
|---|---|
| `healthcheck` | `GET /api/health`, then `GET /api/lists/<listId>` → `listName` (404 → `ok: false`, "list <id> not found") |
| `syncSubscriber` | `POST /api/subscribers { email, name, status: 'enabled', lists: [listId], attribs, preconfirm_subscriptions: true }`; on 409 (exists) → `GET /api/subscribers?query=subscribers.email='<escaped>'` → `PUT /api/subscribers/<id>` with the same body (status `enabled` lifts a blocklist) → `changed` = any field differed (compare `name`, `status`, `attribs`, list membership); for `status: 'blocklisted'` input → the blocklist call below |
| `removeSubscriber` | lookup by email → `PUT /api/subscribers/blocklist { ids: [id] }` (unknown email → `changed: false`) |
| `createIssue` | ensure template `blog0-issue` exists (`GET /api/templates` by name, else `POST /api/templates { name, type: 'campaign', body: '{{ template "content" . }}' }`) → `POST /api/campaigns { name: 'blog0 #<number> — <subject>', subject, lists: [listId], type: 'regular', content_type: 'html', body: html, altbody: text, template_id, tags: ['blog0', 'issue:<issueId>'] }` → `campaignId = String(data.id)`; before the POST, `html`/`text` are first **template-escaped** (in **one pass** over `/\{\{|\}\}/g` — sequential replaces would re-escape their own output — every literal `{{` → `{{ "{{" }}` and `}}` → `{{ "}}" }}`, so author text such as a code sample can never execute as a Listmonk/Go template expression) and **only then** have the blog0 placeholders replaced with Listmonk expressions (13.4) — that order keeps the two expressions live |
| `sendIssue` | `PUT /api/campaigns/<id>/status { status: 'running' }` (a campaign already `running`/`finished` → no-op) |
| `fetchStats` | `GET /api/campaigns/<id>` → `{ recipients: to_send, sent, delivered: null, opens: views, clicks, bounces, unsubscribes: null }` |
| `fetchSuppressions` | `GET /api/subscribers?query=subscribers.status='blocklisted' AND subscribers.updated_at > '<since ISO>'&per_page=all` → `unsubscribed`; **list-level unsubscribes**: `GET /api/subscribers?list_id=<listId>&subscription_status=unsubscribed&per_page=all`, keeping rows whose `lists[]` entry for `listId` has `subscription_updated_at > since` → `unsubscribed` with `at = subscription_updated_at`, `details.scope = 'list'`; `GET /api/bounces?...` (rows with `created_at > since`, `type = 'hard'`) → `bounced`; `complaint` type → `complaint` |

**Stub adapter** (`stub.ts`): keeps subscribers in a `Map` (`providerId = 'stub-' + subscriberId`),
`createIssue` returns `'stub-' + issueId`, `sendIssue` inserts one `newsletter_message` row per
**currently confirmed** subscriber (`kind 'issue'`, `transport 'stub_sender'`, `status 'stubbed'`,
placeholders filled per recipient with blog0's own links) and logs `newsletter.issue`,
`fetchStats` counts those rows, `fetchSuppressions` returns `[]`. It is the default sender and
what designer mode, integration tests and E2E use; `resetNewsletterSenderForTests()` clears it.

**Sync** (`src/server/newsletter/sender/sync.ts`): `syncOne(subscriber)` (after confirm) /
`removeOne(subscriber)` (after suppress) / `syncAll(trigger)` (script, admin button, before a
listmonk send): for every `confirmed` row → `syncSubscriber` (sets `provider_id`,
`provider_synced_at`, appends `provider_synced` only when `changed`); every
`unsubscribed`/`bounced` row → `removeSubscriber` (appends `provider_removed` when `changed`);
`pending`/`legacy_unconfirmed` → skipped; stub → everything skipped (the stub sender has no
provider to copy to, so it never appends `provider_synced` / `provider_removed` and the "Synced to
Listmonk" timeline entry appears only with `listmonk`). blog0 → provider only, with one
exception: a confirmed row whose provider copy holds an opt-out newer than (or equal to) its latest
consent / confirmation is not re-added and is suppressed in blog0 (`source 'provider'`), counted
`suppressedFromProvider` (opt-out-wins rule 2 below); otherwise the sync reads nothing back except
`provider_id`. `syncAll` triggers: `script`, `admin`, `send` (before a listmonk campaign);
`syncOne`/`removeOne`: `confirm`, `unsubscribe`, `webhook`, `tick`. `scripts/newsletter-sync.ts`
(`pnpm newsletter:sync [--create-list]`) prints `synced N, blocklisted N, skipped N, N changed`
(+ `, N suppressed from provider` when > 0) and exits 1 on any error. `scripts/newsletter-tick.ts` (`pnpm newsletter:tick`): digest-due
check (13.5) → `fetchSuppressions(lastTickAt)` (blocklist, **list-level unsubscribes** and hard
bounces) → `suppress()` each suppression blog0 does not already hold, applied only when it is newer
than the subscriber's latest consent / confirmation (`source 'provider'`) → `fetchStats` for issues
sent in the last 30 days → `pruneIps(now)` → one `newsletter.tick` line. Scheduling is external
(runbook: hourly cron / platform scheduler); the app has no timer.

**An opt-out anywhere wins** (Listmonk list-level unsubscribe). A reader can leave the `blog0` list
inside Listmonk (its own unsubscribe page / `{{ UnsubscribeURL }}` in the `List-Unsubscribe` header)
without being blocklisted; the subscriber stays `enabled` there with the list membership
`unsubscribed`. Rules:
1. `newsletter:tick` pulls those list-level unsubscribes exactly like blocklists and bounces → blog0
   `unsubscribed` + suppression (`source 'provider'`, `details.scope 'list'`).
2. `syncSubscriber` / `syncAll` **never re-add** a list membership whose provider unsubscribe
   (`subscription_updated_at` of the `unsubscribed` membership) is newer than (or equal to) blog0's
   latest consent / confirmation (`greatest(consented_at, confirmed_at)` — `sender/opt-out.ts`
   `providerOptOutWins`, shared by sync, tick and webhook): the membership is left `unsubscribed` (no `provider_synced`
   event), so a sync run between the reader's opt-out and the next tick cannot undo it; the sync
   itself records the opt-out in blog0 (`suppressedFromProvider`), else the next tick does.
3. A fresh double opt-in **after** that unsubscribe (new `confirmed_at` newer than it) may re-add
   the membership (`PUT /api/subscribers/lists { action: 'add', status: 'confirmed' }`), exactly as
   a re-confirmation re-enables a blocklisted address.

> **Assumed:** the comparison uses Listmonk's `subscription_updated_at` for the `blog0` list against
> blog0's `greatest(consented_at, confirmed_at)` (both UTC); equal timestamps count as "unsubscribe
> newer" — the opt-out wins a tie; an unparseable provider timestamp also lets the opt-out win.

**Webhook** (`src/app/api/newsletter/webhook/route.ts`): bearer secret (constant-time compare),
`csrf: false`, body `NewsletterWebhookRequest` → `suppress(row, { reason, source: 'webhook',
details: { providerRef, reason, occurredAt } })`. When `occurredAt` parses as a date, the
**opt-out-wins timestamp rule** applies exactly as in the tick: the event is applied only if
`occurredAt >= greatest(confirmed_at, consented_at)` of the row (`providerOptOutWins`; an opt-out older than a fresh
re-confirmation is stale → `accepted: true`, nothing written, logged); a tie counts as the opt-out
(rule 2's tie-break). Absent or unparseable `occurredAt` → applied unconditionally (receipt time
is the opt-out time).

> **Assumed:** the `List-Unsubscribe` header of a **Listmonk-sent** campaign is Listmonk's own (it
> sets the header per message; blog0 does not override campaign headers); that opt-out reaches
> blog0 through the tick's list-level pull (rule 1). blog0's one-click route is the header of
> every message blog0 itself sends through its transactional transport (13.2).

### 13.4 Issue rendering (`src/server/newsletter/issues/render.ts`, pure)

```ts
export interface IssueRenderInput { brand: string; publisherName: string; publicBaseUrl: string; title: string; introHtml: string; introText: string; posts: IssuePost[]; number: number; year: number }
export const UNSUBSCRIBE_PLACEHOLDER = '%%BLOG0_UNSUBSCRIBE_URL%%';
export const CONSENT_PLACEHOLDER = '%%BLOG0_CONSENT_LINE%%';
export function renderIssueHtml(input: IssueRenderInput): string;   // contains both placeholders exactly once each
export function renderIssueText(input: IssueRenderInput): string;   // same, from the model (not from the HTML)
export function fillPlaceholders(body: string, values: { unsubscribeUrl: string; consentLine: string }): string;   // stub sender, test message, preview
export function toListmonkExpressions(body: string): string;        // placeholders → {{ .Subscriber.Attribs.blog0_unsubscribe_url }} / {{ .Subscriber.Attribs.blog0_consent_line }}
```

HTML: `<table role="presentation" width="100%">` wrapper, inner table max-width 600, wordmark
line "blog0" (the brand, last character in `--accent`-equivalent `#d64545`), the title, intro,
then per post: topic + date eyebrow, title linked to `readUrl`, dek, excerpt, a link row
`Read · TLDR · Listen` (only those present), hairline; footer: unsubscribe link, consent line,
`© <year> <brand> | <publisher>`. Fonts: `'Space Grotesk', 'Helvetica Neue', Arial` for heads,
`'Source Serif 4', Georgia, serif` for body (system fallbacks — no web fonts in email). Dark mode
via `@media (prefers-color-scheme: dark)` in a `<style>` block plus explicit light colours inline.
`excerpt` = `renderArticle(published)` → first `Paragraph.text` → first 60 words + `…`.

### 13.5 Issues service and triggers (`src/server/newsletter/issues/{repo,service,snapshot,triggers,digest,send}.ts`)

- `snapshot.ts`: `snapshotPosts(siteId, articleIds)` → `IssuePost[]` from the **published**
  revisions (404-style `ISSUE_POSTS_INVALID` for an unpublished id), `tldrUrl`/`listenUrl` from
  the published format payloads, `publishedLabel` via `fmtDate`.
- `service.ts`: `createIssue(ctx, { origin, title, introMd, articleIds, createdBy })` (site row
  lock → `number = max + 1`; event `created`), `updateIssue` (draft only; event `updated`),
  `deleteIssue` (draft only), `previewIssue` (draft → re-snapshot + persist; render + fill sample
  values), `sendTest(ctx, id)` (render, fill the admin's sample values, `getMailTransport().send`,
  event `test_sent`).
- `send.ts`: `sendIssue(ctx, id)` — one transaction: lock the issue, require `draft`, `failed`, or
  **`sending` for more than 10 min** (`SENDING_STALE_MS = 10 * 60_000` in `constants.ts`, measured
  from `updated_at`, which the flip to `sending` sets; covers a process that died mid-send — the reused
  `provider_campaign_id` and the idempotent `sendIssue` keep the retry from duplicating a campaign;
  a `sending` issue younger than that → `ISSUE_NOT_DRAFT`, so a double click cannot start two sends),
  count confirmed subscribers (0 → `NO_RECIPIENTS`), freeze `rendered_html/text` (re-snapshot
  first when draft), status `sending`, event `send_requested` → commit → outside the transaction:
  listmonk only: `syncAll('send')`; `provider_campaign_id ?? createIssue()` (persist at once, event
  `provider_created`) → `sendIssue(campaignId)` (event `provider_started`) → status `sent`,
  `sent_at/by`, `recipient_count`, event `sent`, log `newsletter.issue action 'send' outcome 'sent'`.
  Any throw → status `failed`, `last_error`, event `failed`, rethrown as `SENDER_FAILED` (or
  `SENDER_UNAVAILABLE` when `healthcheck` failed before any step). `refreshStats(id)` → event
  `stats_fetched`.
- `triggers.ts`: `onArticleFirstPublished({ siteId, articleId, now, requestId })` — called by
  `publishArticle` **after** its transaction commits and only when `first_publish` is true (the
  hook never runs inside the article transaction and never throws into the publish: errors are
  logged `newsletter.issue outcome 'failed'`; the publish is already done). Reads the site
  settings: `manual` → nothing; `per_post` → `createIssue({ origin: 'per_post', title: article
  title, introMd: dek, articleIds: [id] })`; `digest` → `digest.ts` `dueDigest(settings,
  lastDigestIssueAt ?? modeSetAt, newPostIdsSince, now)` → when due, one issue with every
  first-published article since the anchor that is not yet in an automatic issue (`article_ids`
  overlap check). Then, **only if `newsletter_auto_send`** is true → `sendIssue` with a system
  actor (`sent_by null`). `digest.ts` is pure: `dueDigest({ digestDays, digestPosts }, anchorAt,
  newPostCount, now): { due: boolean; reason: 'posts' | 'days' | null; dueAt: Date | null }`.
- `src/server/articles/service.ts` (takes over, S7.3): after `deleteStoredFiles(...)` in
  `publishArticle`, `await onArticleFirstPublished(...)` guarded by `firstPublish` (captured from
  `row.firstPublishedAt === null` inside the transaction).

> **Assumed:** the publish hook runs synchronously after commit (no queue): creating a draft is
> one insert; an auto-send with Listmonk is 2–4 HTTP calls (< 5 s) inside the publish request —
> acceptable for a handful of writers; the publish response is not delayed by the stub.
> **Assumed:** one secret (`BLOG0_SESSION_SECRET`) signs unsubscribe tokens; rotating it (runbook)
> invalidates unsubscribe links in already-sent issues — the runbook says to re-sync
> (`pnpm newsletter:sync`) after a rotation so the Listmonk attribute carries fresh links, and
> Listmonk's own `{{ UnsubscribeURL }}` remains in the `List-Unsubscribe` header it sets.

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
| LLM access | Plain `fetch` to OpenRouter's **decisions** endpoint (`POST /api/alpha/decisions`) behind `LlmClient.decide()` in `src/server/llm`; model `typesafe/jev-1.13` (Phase 8; the chat-completions client is removed — Jev was its only user) | User decision: Jev *is* this decisions model. One request returns a calibrated probability per sentence question plus `usage.cost`; no SDK covers the alpha endpoint, and plain `fetch` has nothing to drift. |
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
`@shikijs/rehype`, `@next/env`, `music-metadata`, `image-size`, `server-only`, `nodemailer`
(Phase 7). Dev-only: `drizzle-kit`, `vitest`, `@playwright/test`, `typescript`, `@types/*`
(incl. `@types/nodemailer`, Phase 7), `eslint*`, `prettier`, `esbuild` (Phase 5:
`pnpm build:release`; already allowed in `allowBuilds`). Phase 7 `next.config.ts`:
`serverExternalPackages` gains `'nodemailer'`.

`next.config.ts`: `distDir: process.env.BLOG0_DIST_DIR?.trim() || '.next'` (§10),
`serverExternalPackages: ['@node-rs/argon2', 'shiki', 'postgres', '@electric-sql/pglite']`
(PGlite loads a WASM binary from its package dir and must not be bundled), `allowedDevOrigins`
and `experimental.turbopackFileSystemCacheForDev: false` (§11.1), `poweredByHeader: false`,
`typedRoutes: false`. `output: 'standalone'` only when `BLOG0_STANDALONE=1` (the image build,
§12.1): the documented local run command stays `next start` (via `scripts/serve.mjs`), which warns
under standalone output. Phase 5 adds the static security `headers()` (§6).

**Deploy (Phase 5, §12).**

| Concern | Choice | Rationale |
|---|---|---|
| Container base | `node:22.23.1-slim` (Debian, glibc), multi-stage | Exact Node pin of `devEngines`; glibc prebuilds for argon2/SWC; full ICU keeps sentence splitting identical. Alpine rejected (musl prebuild variance, no gain for one image). |
| App packaging | Next `output: 'standalone'` (image build only) | Traced minimal `node_modules`; `node server.js` keeps Next's built-in graceful drain. |
| Release step | esbuild bundle `dist/release.mjs` (esbuild devDependency, pinned to the lockfile's version) | Migrations run from the same image without `tsx`, dev deps or the full `node_modules`. |
| Backups | system `pg_dump`/`pg_restore` (PostgreSQL 18 client) + `tar` | Custom-format dumps are the Postgres-native, version-checked path; no new npm dependency. |
| CI | GitHub Actions, `postgres:18` service | Repo host; gates run on the production engine; no deploy job. |
| Container runtime (local gate) | Docker via Colima | Already on the dev machine; gate step reports `PENDING DOCKER` when the daemon is down. |

**Newsletter (Phase 7, §13).**

| Concern | Choice | Rationale |
|---|---|---|
| Transactional email | `nodemailer` 7 over env-configured SMTP (`BLOG0_SMTP_*`) + an in-DB stub transport | Confirmation/test mail is a handful of messages; any SMTP relay works (Google Workspace relay or Brevo are the documented options — the runbook never picks one); no vendor SDK. The stub keeps designer mode and every test SMTP-free. |
| Bulk sending | Listmonk (self-hosted, own DB in the shared Postgres instance) behind `NewsletterSender`; REST via `fetch` | User decision ("Listmonk sends"); deliverability, bounces, throttling and campaign stats belong to a mailer, not to blog0; the adapter keeps blog0 the record and makes the provider swappable; the stub adapter makes the full admin flow testable without it. |
| Consent proof | blog0 tables with append-only ledgers enforced by a DB trigger | A list you can prove is the point of owning it; the trigger makes "never deleted" a property of the database, not of code review. |
| Compose | `docker-compose.yml` with `postgres:18` + `listmonk/listmonk:v5.1.0` | One command for the adapter integration test and the reference production shape (one Postgres instance, separate databases). |

> **Assumed:** nodemailer over `@sendgrid/mail`/`resend`-style SDKs — SMTP is the one interface
> both documented providers and any future one share.

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
├── Dockerfile  .dockerignore                                  # Phase 5 image (§12.1)
├── docker-compose.yml                                         # Phase 7: postgres + listmonk (+ blog0 under --profile app) (§12.6)
├── .github/workflows/ci.yml                                   # Phase 5 CI (§12.4); Phase 7 adds the listmonk compose step to `integration`
├── docs/deploy.md                                             # Phase 5 runbook; Phase 7 adds Newsletter (SMTP options, Listmonk, cron for newsletter:tick)
├── dist/                        # gitignored build output: release.mjs (pnpm build:release)
├── spec/                                    # this spec + design reference (never edited by generators); spikes/pglite.md = spike verdict
├── scripts/
│   ├── serve.mjs                # loads .env via @next/env, runs `next <dev|start> -p ${BLOG0_PORT||3410}`, forwards signals + kill timer (§12.2); inherits BLOG0_DIST_DIR
│   ├── db-create.ts  db-migrate.ts  db-verify.ts  db-seed.ts  db-seed-posts.ts  create-admin.ts
│   ├── check-openrouter.ts  eval-jev.ts  seed-tldr.ts  spike-pglite.ts
│   ├── release.ts  build-release.mjs  backup.ts  restore.ts  container-e2e.sh    # Phase 5 (§12)
│   ├── newsletter-sync.ts  newsletter-tick.ts  listmonk-dev.sh  compose/init-db.sh   # Phase 7 (§12.6, §13.3)
│   ├── dev-design.mjs           # `dev:design`: runDesignerSetup() in-process, then the hot-reload dev server
│   ├── make-image-fixtures.ts  make-audio-fixture.sh     # regenerate tests/fixtures/{images,audio}
│   └── lib/{cli,allow-server-only}.ts  lib/empty-module.mjs  lib/container-env.mjs   # CLI helpers; server-only shim; esbuild alias target; container env file
├── src/
│   ├── instrumentation.ts       # register(): getConfig() (fail fast, exit 1) + initDb() on PGlite + app.boot log; skipped during next build
│   ├── proxy.ts                 # Next 16 proxy: /p/:slug, /p/:slug/tldr, /p/:slug/listen unknown/unpublished → rewrite to root 404 (§8); no auth
│   ├── app/
│   │   ├── layout.tsx           # <html data-theme> + theme init script + fonts + global CSS
│   │   ├── not-found.tsx        # root 404 with site chrome (target of the proxy rewrite)
│   │   ├── sitemap.ts  robots.ts
│   │   ├── (site)/              # public, wrapped by Boot/Masthead/Footer chrome
│   │   │   ├── layout.tsx  page.tsx  not-found.tsx  error.tsx  archive/page.tsx  about/page.tsx
│   │   │   ├── newsletter/{confirm,unsubscribe}/page.tsx   # Phase 7 link pages (site chrome, force-dynamic)
│   │   │   └── p/[slug]/{page.tsx, tldr/page.tsx, listen/page.tsx, _lib/article-route.tsx}   # articleRoute(initialMode) factory
│   │   ├── admin/
│   │   │   ├── layout.tsx  login/page.tsx
│   │   │   └── (authed)/        # layout.tsx calls requireAdminPage()
│   │   │       ├── page.tsx (desk)  articles/new/page.tsx  articles/[id]/page.tsx  site/page.tsx  subscribers/page.tsx
│   │   │       ├── subscribers/[id]/page.tsx  newsletter/page.tsx  newsletter/new/page.tsx  newsletter/[id]/page.tsx   # Phase 7
│   │   │       └── ai-usage/  team/                       # Phase 4 (on hold) — not yet created
│   │   ├── media/[...key]/route.ts                        # GET/HEAD, 200/206/304/416 (§9.2)
│   │   └── api/
│   │       ├── health/route.ts  health/{live,ready}/route.ts  newsletter/route.ts  auth/{login,logout,me}/route.ts
│   │       ├── newsletter/{confirm,unsubscribe,webhook}/route.ts          # Phase 7
│   │       ├── public/articles/[slug]/{tldr,listen}/route.ts
│   │       ├── admin/{preview,site,subscribers}/route.ts  admin/uploads/images/route.ts
│   │       │   admin/articles/route.ts  admin/articles/[id]/{route.ts, publish/, unpublish/, tldr/, tldr/generate/, audio/, listen/}
│   │       └── admin/subscribers/[id]/{route.ts, send-confirmation/, unsubscribe/}  admin/subscribers/send-legacy-confirmations/route.ts   # Phase 7
│   │           admin/newsletter/{settings,sync,issues}/route.ts  admin/newsletter/issues/[id]/{route.ts, preview/, test/, send/, stats/}
│   │                                # preview/ answers JSON IssuePreviewDto; the admin renders it in a sandboxed iframe srcdoc (no HTML preview page route)
│   ├── components/
│   │   ├── StubNotice.tsx
│   │   ├── design/              # Icon, Typewriter, Wordmark, SplitHeadline, Dek, motion.ts, overlay.ts
│   │   ├── site/                # Masthead, Footer, NewsletterForm, AsciiHand, Boot, PrintIn, PostCard, SummaryHost, ListenOverlay, LegacyHashRedirect, home/, archive/, about/
│   │   ├── reader/              # ArticleView, ModeBar, ModeCapsule, ReadHead, ArticleBody, ArticleFoot, TldrDeck, ShareLinkButton, ShareMenu, ParagraphShare, share-scroll.ts, clipboard.ts, ListenView, AudioPlayer, listen-sync.ts
│   │   ├── figures/             # FigSlide47, FigAB, registry.ts
│   │   └── admin/               # api.ts, AdminLoad.tsx (useAdminLoad/AdminLoadError), LoginForm, DeskHeader, DeskView, ArticleTable, FormatChips, NewArticleForm, labels.ts, relative-time.ts,
│   │                            #   editor/ (ArticleEditor, PublishBar, WriteTab, MarkdownEditor, LivePreview, ImageUploadButton, insert-image.ts, TldrTab, tldr-generate.ts, ListenTab, HistoryTab, fields.ts, use-article-doc.ts),
│   │                            #   tldr/ (DeckList, SentencePicker, DeckPreview, deck-edit.ts), listen/ (AudioUploader, listen-api.ts), site/ (+ NewsletterSettings.tsx, Phase 7),
│   │                            #   subscribers/ (SubscribersView, StatusFilter, SubscriberDetail, SubscriberTimeline, subscribers-api.ts — Phase 7),
│   │                            #   newsletter/ (IssueList, IssueDetail, IssuePreview, IssueCompose, SendDialog, SendLog, IssueStats, issues-api.ts — Phase 7)
│   ├── lib/                     # isomorphic, pure, no I/O
│   │   ├── api/envelope.ts  api/dto.ts   # ALL API DTOs, one file grouped by domain sections
│   │   ├── articles/limits.ts   # ARTICLE_LIMITS (spec/api.md PATCH)
│   │   ├── http/csp.ts          # buildContentSecurityPolicy (§6)
│   │   ├── content/types.ts  formats/registry.ts  view-models.ts  format-date.ts
│   │   ├── deck/timing.ts       # tldrDwell, tldrType, tldrMinutes, slide words (ported verbatim)
│   │   ├── listen/marks.ts  listen/estimate.ts                 # §9.4
│   │   ├── media/image-markdown.ts                             # image snippet builder
│   │   └── share-links.ts  share-surface.ts                    # share texts/URLs; native-sheet decision
│   ├── server/                  # server-only (each file starts with `import 'server-only'`)
│   │   ├── config.ts  log.ts  rate-window.ts  rate-window-store.ts
│   │   ├── db/{client,schema,migrate,url,postgres,pglite}.ts  db/migrations/ (0000_init.sql, 0001_rate_limit_bucket.sql, 0002_newsletter.sql, 0003_newsletter_prune_fix.sql + meta/)
│   │   ├── ops/{release,readiness,lifecycle,pg-tools,backup-manifest,backup,restore}.ts   # Phase 5 (§12)
│   │   ├── designer/{secret,admin,setup}.ts
│   │   ├── http/api.ts
│   │   ├── auth/{session,guard,password,login,rate-limit}.ts
│   │   ├── users/repo.ts  site/{current,defaults,service}.ts
│   │   ├── newsletter/{constants,tokens,schemas,repo,service,links,legacy,prune,audit,rate-limit,settings,sender-hook}.ts   # Phase 7 list (§13.1)
│   │   │   newsletter/mail/{transport,templates,index}.ts                          # §13.2 (nodemailer SMTP | stub)
│   │   │   newsletter/sender/{types,listmonk,stub,sync,opt-out,index}.ts           # §13.3
│   │   │   newsletter/issues/{repo,service,snapshot,render,excerpt,intro,triggers,digest,send,status,http,tick}.ts   # §13.4–13.5
│   │   ├── content/{index,ast,markdown,render,sentences,paragraph-ids,fingerprint,stats,highlight,cache}.ts
│   │   │   content/plugins/{figure-markers,heading-shift,raw-html,code-langs,external-links,images,tables,safe-urls}.ts
│   │   ├── formats/{types,payload,index,read,tldr,listen}.ts      # formats/status.ts: Phase 4 (on hold), future
│   │   ├── articles/{repo,service,schemas,slug,tldr,views,http}.ts
│   │   ├── llm/{types,openrouter,index,key}.ts          # openrouter.ts = the decisions adapter (Phase 8)
│   │   ├── jev/{state,bounds,build-input,batches,validate,rank,run,prompt,articles}.ts  jev/prompts/rank-v1.md (+ select-v1.md, audit only)
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
│   ├── setup/{global-setup,integration-env}.ts   # vitest integration: create/reset + migrate blog0_test; env + singleton resets, BLOG0_STORAGE_DIR=var/storage-test, BLOG0_RATE_LIMIT_STORE=memory
│   ├── helpers/{db,session,env,logs,storage,api,seed-articles}.ts
│   ├── unit/<domain>/**         # admin, auth, content, db, deck, formats, helpers, jev, listen, llm, media, reader, site, … — no catch-all folder
│   ├── integration/*.test.ts    # incl. rate-limit-db, release, health-probes, backup-restore (§12)
│   ├── unit/ops/{lifecycle,backup-manifest}.test.ts  unit/http/csp.test.ts  unit/proxy.test.ts (nonce/CSP)
│   │   unit/auth/rate-limit-store.test.ts  unit/llm/key.test.ts
│   ├── e2e/{tldr,reader,listen,smoke,newsletter,designer-mode}.spec.ts  e2e/{global-setup,designer.global-setup}.ts   # newsletter: Phase 7, after smoke
│   │   e2e/helpers/{admin,article-text,db,jev-key,logs,share,upload,newsletter}.ts
│   ├── integration/newsletter{,-links,-admin,-issues,-sync,-listmonk,-webhook}.test.ts   # Phase 7 (listmonk: real container or PENDING DOCKER)
│   ├── unit/newsletter/{tokens,templates,render,digest,schemas,sender-stub}.test.ts  fixtures/newsletter/issue-2-posts.{html,txt}   # Phase 7
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
  **Five projects run in a fixed order via `dependencies`: `tldr` → `reader` → `listen` → `smoke`
  → `newsletter`** (Phase 7, `newsletter.spec.ts`, depends on `smoke`; they share one database and
  each needs the state the previous leaves); a new walk is added as a project at the end of that
  chain. `webServer` (skipped when `BLOG0_E2E_BASE_URL` is set):
  `pnpm start` on 3411 with `env: { BLOG0_PORT: '3411', BLOG0_DATABASE_URL: <BLOG0_TEST_DATABASE_URL>,
  BLOG0_PUBLIC_BASE_URL: 'http://localhost:3411', BLOG0_LOG_FILE: 'test-results/e2e-server.log',
  BLOG0_STORAGE_DIR: 'var/storage-e2e', BLOG0_SMTP_HOST: '', BLOG0_NEWSLETTER_SENDER: 'stub' }`
  merged over the inherited environment (so `BLOG0_DIST_DIR` reaches it; the two newsletter values
  force the recording stubs even when `.env` configures an SMTP relay or Listmonk — an already-set,
  even empty, variable is never overridden by `.env`), `reuseExistingServer: false`, 120 s. The
  newsletter walk reads its confirm / unsubscribe links from the `newsletter_message` rows the stub
  transport and stub sender write (`tests/e2e/helpers/newsletter.ts` over `helpers/db.ts`) — exact per
  address, independent of log timing, and it works against the external container too. E2E runs the **same**
  `pnpm start` as production (test path = run path); `pnpm build` (same `BLOG0_DIST_DIR`) must have
  run first. **Against the container** (Phase 5, §12.5): `BLOG0_E2E_BASE_URL=http://localhost:3412`
  + `BLOG0_E2E_LOG_FILE=test-results/e2e-server.log`; global setup still resets `blog0_test` (the
  container connects lazily) and **empties** `var/storage-e2e` without removing the directory (it
  is the container's bind-mounted `/data/storage`); the log-asserting tests read
  `BLOG0_E2E_LOG_FILE` (default `test-results/e2e-server.log`) and skip — with the reason "log file
  not wired for the external server" — only when the base URL is external and that variable is
  unset; the smoke boot-line assertion expects `port: 3411` locally and any number externally.
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
  generated-secret and no-key paths), plus Phase 7's `BLOG0_SMTP_HOST: ''` and
  `BLOG0_NEWSLETTER_SENDER: 'stub'`. The designer newsletter walk (signup → confirm → **Confirmed**)
  reads the confirm link from the stub's `newsletter.mail` line (`kind 'confirmation'`,
  `confirm_url`) in `test-results/design-e2e-server.log`, after a line-count cursor taken before the
  signup — PGlite is single-process, so the test cannot open a second database client. `tests/e2e/designer.global-setup.ts` never deletes anything:
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
`replace-with-` prefix, and only on `postgres://`). Whether a non-real key fails or skips is
decided by `realKeyRequired(env)` in the same file (Phase 5): `BLOG0_REQUIRE_REAL_KEY === '1'` →
true; `=== '0'` → false; unset/other → `env.CI === 'true'`. It is the **only** place that reads
`CI` for this rule — `tests/helpers/env.ts` (`shouldSkipRealKeyTests`),
`tests/e2e/helpers/jev-key.ts` (`jevKeyPlan`), `scripts/eval-jev.ts` and the integration tests
`jev-openrouter`, `tldr-flow`, `seed-tldr`, `designer-mode` call it. When the status is not
`'real'` **and** `realKeyRequired` is false, each test SKIPS with a visible reason containing
`PENDING KEY` (`PENDING_KEY_REASON = 'PENDING KEY: BLOG0_OPENROUTER_API_KEY not set'`; `eval:jev`
prints it and exits 0 without scoring). They are never stubbed into a pass — no stub `LlmClient`,
no recorded fixture, no `<stub:jev>` output on these paths. When `realKeyRequired` is true, a
missing/placeholder key is a FAILURE. Whenever a real key is present, an invalid/rejected key
(401/403) or any provider error is a FAILURE, never a skip. CI sets `BLOG0_REQUIRE_REAL_KEY` from
the secret's presence (§12.4), so a fork PR without the secret skips visibly instead of failing.
A gate run that skipped any `PENDING KEY` test is reported as "pending key", not as passed.

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
7. **TLDR selection** (user): Jev picks 4–8 lines server-side; writers may hand-edit and reorder; the design heuristic is not ported. **Phase 8 (user):** Jev is the OpenRouter decisions model `typesafe/jev-1.13`; it scores every eligible sentence and the top k (k = 4–8 by length) form the deck in document order; per-line reasons are removed — the editor shows each line's relevance score instead and sorts the sentence picker by it. The reader-facing disclosure copy (divergence 8) is unchanged: "Lines selected by Jev (AI), verbatim from the article."
9. **Listen without a recording**: the capsule's Listen (and the deck's mode-switcher Listen) stays visible but **disabled** with `title="No recording yet"` / `aria-label="Listen — no recording yet"` (same treatment as TLDR without a deck); card Listen buttons are hidden.
12. **Footer links**: X/LinkedIn only when the site has their URLs; no RSS (user).
13. **Contact mail**: `hello@logzero.blog` (seeded, editable in Admin → Site).
14. **About copy**: the design's full `ABOUT_BODY_FULL` is seeded.
15. **Newsletter success copy**: Phase 2 used the design's "You’re in. First issue lands Thursday."; **Phase 7 amends it** to "Almost there — check your inbox and confirm." (double opt-in makes the old line false), and the line under the form becomes the site's editable consent text (default "One issue a week at most. Unsubscribe in one click; we never share the list.").
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
   disclosure texts). *Ask:* wording and placement (intro slide only vs every slide). Phase 8 keeps
   the copy as is (user): ranking by a decisions model is still "selected by Jev (AI)".
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
