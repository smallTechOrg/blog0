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
                    │      └─ client islands: Masthead, TldrDeck, ArticleView, figures, PrintIn           │
 Writer browser ──► │ /admin pages (server guard) + client editor ──► /api/admin/* route handlers         │
                    │      route handlers ──► withApi (envelope, auth, origin check, request log)         │
                    │                    ──► services: articles, formats, jev, users, site                │
                    │      jev ──► llm/openrouter adapter ──► https://openrouter.ai/api/v1 (one call/click)│
                    │      services ──► drizzle ──► Postgres (blog0_dev / blog0_test)                      │
                    │      (Phase 3) storage interface ──► local disk BLOG0_STORAGE_DIR                    │
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
| DB | `src/server/db/*` | postgres.js client + drizzle, schema, programmatic migrator. |
| HTTP kit | `src/server/http/api.ts` | `withApi()` wrapper: request id, auth guard, origin check, zod body parsing, envelope, error mapping, request/response log line. |
| Auth | `src/server/auth/*` | Sessions (scaffold), password hashing + login + rate limit (S1.1), guards for route handlers and pages. |
| Site | `src/server/site/*` | Resolve the current site (`BLOG0_SITE_SLUG`), cache it, admin edits (Phase 2). |
| Content pipeline | `src/server/content/*` | Markdown → `RenderedArticle` (blocks, paragraphs, sentences, stats, fingerprints, warnings). Deterministic. |
| Formats | `src/server/formats/*` | One adapter per format kind (`read`, `tldr`, `listen`) implementing status, validation, publish. Registry keyed by `src/lib/formats/registry.ts`. |
| Articles | `src/server/articles/*` | Create, save (revision), publish/unpublish, delete draft, TLDR generate orchestration + deck save. |
| LLM | `src/server/llm/*` | `LlmClient` interface + OpenRouter adapter (retry/backoff/timeout, instrumentation). |
| Jev | `src/server/jev/*` | The TLDR selection agent (see `spec/agent.md`). |
| Public queries | `src/server/public/*` | Published-only reads → view models for reader components. |
| Reader UI | `src/components/{design,site,reader,figures}` | Faithful port of `spec/design/design-app.js` (mapping in `spec/ui.md`). |
| Admin UI | `src/components/admin/*`, `src/app/admin/*` | Desk (dashboard), editor, TLDR panel, later Listen/History/Site/Team/AI usage. |
| Storage (Phase 3) | `src/server/storage/*` | `Storage` interface; `LocalDiskStorage` implementation. |

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

**Publish.** `POST /api/admin/articles/:id/publish` `{revisionId}` (= current) → validates topic and
title present → each registered format adapter `validateForPublish()` (TLDR: every draft slide's
`sid`+text still exists in the revision; missing deck is allowed → TLDR simply not offered) → one
transaction: `published_revision_id`, `status='published'`, `first_published_at ??= now`,
`last_published_at = now`, adapters `publish()` copy draft → published payloads. Readers read
only published payloads, so later edits never disturb what is live.

**Public article.** `/p/[slug]` and `/p/[slug]/tldr` (same component, `initialMode` differs) →
`getPublishedArticle(slug)` → render the **published** revision (cached by revision id +
`RENDER_VERSION`) → `ArticleViewModel` → `<ArticleView>` client component. Opening/closing the
deck calls `history.replaceState` between `/p/<slug>` and `/p/<slug>/tldr` (mirrors the design's
`replaceState` hash behaviour; no remount, no navigation).

View-model contract (`src/lib/view-models.ts`, owned by S1.4, produced by S1.7):

```ts
export interface SiteViewModel { wordmark: string; tagline: string; publisherName: string; contactEmail: string;
  aboutStrap: string; aboutStand: string; aboutBodyParagraphs: string[]; socialXUrl: string | null; socialLinkedinUrl: string | null;
  topics: string[]; year: number }
export interface DeckViewModel { slides: Array<{ text: string }>; disclosure: string; shareUrl: string }   // shareUrl absolute …/p/<slug>/tldr
export interface ArticleViewModel {
  slug: string; title: string; dek: string; topic: string; bylineName: string;
  publishedLabel: string;            // fmtDate(first_published_at, site tz) e.g. "8 Sep 2026"
  updatedLabel: string | null;       // Phase 4
  inProgress: boolean;
  blocks: Block[];                   // from RenderedArticle
  times: { read: number; tldr: number | null; listen: number | null };
  deck: DeckViewModel | null;        // published deck only
  listen: null;                      // Phase 3 widens this type
  correctionsHtml: string | null;    // Phase 4
  next: { slug: string; title: string } | null;
  articleUrl: string;                // absolute
}
export interface PostCardViewModel { slug: string; title: string; dek: string; topic: string; publishedLabel: string;
  inProgress: boolean; times: { tldr: number | null; listen: number | null } }
```
Disclosure text: all slides `source: 'jev'` → "Lines selected by Jev (AI), verbatim from the
article."; mix → "Lines selected by Jev (AI) and the editors, verbatim from the article.";
none from Jev → "Lines selected by the editors, verbatim from the article."

## 4. Content pipeline (deterministic; `src/server/content`)

`renderArticle({ title, dek, bodyMd }): Promise<RenderedArticle>` — types in
`src/lib/content/types.ts` (scaffold contract):

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
staleness compares the `sentences` fingerprint; Listen staleness compares `paragraphs`.

**Stats.** `words` = word count of all paragraph plain text; `readMinutes = max(1, ceil(words / 230))`.

**Cache.** `src/server/content/cache.ts`: LRU (max 200 entries) keyed by
`revisionId + ':' + RENDER_VERSION` (`RENDER_VERSION = 'r1'`, bump on any pipeline change).
Preview renders are not cached.

## 5. Formats model

`src/lib/formats/registry.ts` (scaffold) is the single list of format kinds:

```ts
export const FORMAT_KINDS = ['read', 'tldr', 'listen'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];
export type FormatStatus = 'missing' | 'generating' | 'failed' | 'ready' | 'stale' | 'needs_sync' | 'unavailable';
export const FORMATS: Record<FormatKind, { label: string; icon: 'text' | 'bolt' | 'headphones'; availableFromPhase: number }> = {
  read: { label: 'Read', icon: 'text', availableFromPhase: 1 },
  tldr: { label: 'TLDR', icon: 'bolt', availableFromPhase: 1 },
  listen: { label: 'Listen', icon: 'headphones', availableFromPhase: 3 },
};
```

The DB stores `article_format.kind` as text (no enum/check) so a new kind needs no migration.
Server adapters (`src/server/formats/{read,tldr,listen}.ts`, registered in
`src/server/formats/index.ts`):

```ts
export interface FormatAdapter<P> {
  kind: FormatKind;
  computeStatus(ctx: { row: ArticleFormatRow | null; currentRevision: RevisionRow; latestGeneration?: AiGenerationRow | null; now: Date }): FormatStatus;
  validateForPublish(ctx: { row: ArticleFormatRow | null; revision: RevisionRow; rendered: RenderedArticle }): { ok: true } | { ok: false; code: string; message: string; details?: unknown };
  publish(tx: Tx, ctx: { row: ArticleFormatRow | null; revision: RevisionRow; userId: string; now: Date }): Promise<void>;
}
```

Status rules: **read** → `ready` if the current revision body is non-empty else `missing`.
**tldr** → `generating` if the latest generation is `running` and < 3 min old; else `ready` if a
draft payload exists and its `sentences` fingerprint equals the current revision's; `stale` if it
exists and differs; `failed` if no draft and the latest generation failed; else `missing`.
**listen** (Phase 1 adapter returns `unavailable`; Phase 3) → `missing` (no audio), `needs_sync`
(audio, no cues), `ready` (cues cover every paragraph of the fingerprint), `stale` (paragraph
fingerprint changed). Status is computed, never stored.

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
- Login throttling (Phase 1, in-memory per process): 5 failures per (lower-cased email, client
  IP) per 15 min, and 20 failures per lower-cased email across all IPs per 15 min → 429
  `RATE_LIMITED` with `Retry-After` (even for the right password). Each allowed attempt is
  reserved synchronously at the check, before any `await`, so concurrent attempts cannot overrun
  the limit; a correct password clears the (email, IP) count and refunds its reservation on the
  per-email count. Client IP: `BLOG0_TRUSTED_PROXY_HOPS` = 0 (default, no proxy) ignores
  `X-Forwarded-For` and `X-Real-IP` (client-controlled) and uses the constant `direct`, so the
  limit is effectively per email; N > 0 takes the Nth entry from the right of `X-Forwarded-For`
  (fewer entries → `unknown`); `X-Real-IP` is never trusted. Sessions store the IP only when it
  is a real address. Phase 5 moves limits to Postgres.
- Raw HTML in Markdown is never rendered. Uploaded files (Phase 3) are served with their stored
  MIME type, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline`.
- Tenancy: every table has `site_id`; every query filters by the current site id from
  `getCurrentSite()`; no cross-site reads exist.

## 7. Observability (wired in Phase 1)

`src/server/log.ts` writes one JSON object per line: `ts` (ISO), `level`, `event`, `msg`, plus
context. Destinations: stdout always; `BLOG0_LOG_FILE` (append) when set; an in-memory sink in
tests (`captureLogs()`).

| Event | Emitted by | Fields |
|---|---|---|
| `api.request` | `withApi` (one line per API request, at completion) | `request_id, method, path, status, latency_ms, user_id?, input_summary, output_summary, err_code?` |
| `llm.call` | OpenRouter adapter (one line per HTTP attempt) | `request_id, model, prompt_version, attempt, latency_ms, prompt_tokens, completion_tokens, cost_usd, provider_generation_id, outcome ('ok'|'http_error'|'timeout'|'invalid_json'), http_status?` |
| `jev.run` | `runJev` | `request_id, article_id, revision_id, sentence_count, bounds, picks, attempts, outcome, err_code?` |
| `auth.login` | login route | `outcome ('ok'|'bad_credentials'|'rate_limited'), email_masked` |
| `app.boot` | `instrumentation.ts` | `version, port, node, site_slug` |
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
path (never a blank screen). Public page errors: `src/app/(site)/error.tsx` (client boundary,
inside site chrome).

**Unknown/unpublished slugs (`src/proxy.ts`).** Next 16 proxy, `matcher: ['/p/:slug', '/p/:slug/tldr']`
only. It calls `publishedSlugExists(slug)` (`src/server/public/articles.ts`, same published-only
filter as the page queries); when false it rewrites to an unmatched internal path so the root
`src/app/not-found.tsx` server-renders a 404 **with site chrome**. If the DB check throws, the
proxy logs and falls through to the page, whose own `notFound()` remains the fallback. Reason:
in Next 16.4, `notFound()` thrown from a page segment during SSR returns the bare
`__next_error__` HTML (status 404) and the chrome appears only after hydration. The proxy never
does auth (layouts + route handlers own it). Cost: one indexed query per `/p/*` request.

## 9. Storage interface (Phase 3 contract; written here so S3.2 can code against it)

```ts
// src/server/storage/types.ts
export interface StoredObject { key: string; size: number; mimeType: string; sha256: string }
export interface Storage {
  put(key: string, body: ReadableStream<Uint8Array> | Buffer, opts: { mimeType: string; maxBytes: number }): Promise<StoredObject>;
  stat(key: string): Promise<{ size: number } | null>;
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
}
```
Keys: `<siteSlug>/<kind>/<yyyy>/<mm>/<uuid>.<ext>`. `LocalDiskStorage` roots at
`BLOG0_STORAGE_DIR` (default `./var/storage`, gitignored), writes to a temp file then renames,
rejects `..` and absolute keys.

## 10. Configuration (env → `src/server/config.ts`, documented 1:1 in `.env.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BLOG0_DATABASE_URL` | yes | — | `postgres://sai@localhost:5432/blog0_dev` |
| `BLOG0_TEST_DATABASE_URL` | tests | — | `postgres://sai@localhost:5432/blog0_test`; must differ from the dev URL (tests refuse otherwise) |
| `BLOG0_PORT` | no | `3410` | read by `scripts/serve.mjs` (after loading `.env`) |
| `BLOG0_PUBLIC_BASE_URL` | no | `http://localhost:3410` | absolute links, OG, origin check, `Secure` cookie when https |
| `BLOG0_SITE_SLUG` | no | `blog0` | which `site` row this process serves |
| `BLOG0_TRUSTED_PROXY_HOPS` | no | `0` | integer 0–10: reverse proxies appending to `X-Forwarded-For`; 0 = ignore forwarding headers (§6) |
| `BLOG0_SESSION_SECRET` | yes | — | ≥ 32 chars (`openssl rand -base64 48`) |
| `BLOG0_OPENROUTER_API_KEY` | yes | — | validated at boot for presence; liveness by `pnpm check:openrouter` |
| `BLOG0_OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | |
| `BLOG0_JEV_MODEL` | no | `google/gemini-2.5-flash` | see `spec/agent.md` §3 |
| `BLOG0_JEV_TIMEOUT_MS` | no | `45000` | per model attempt |
| `BLOG0_LOG_LEVEL` | no | `info` | `debug|info|warn|error` |
| `BLOG0_LOG_FILE` | no | — | append JSON lines here too (E2E sets it) |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | seed + E2E | name `Sai Krishna V` | first admin; password ≥ 12 |
| `BLOG0_NEW_ADMIN_PASSWORD` | no | — | non-interactive `pnpm admin:create` |
| `BLOG0_STORAGE_DIR` | no | `./var/storage` | Phase 3 |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | no | `50` / `30` / `8` | Phase 3 |
| `BLOG0_E2E_BASE_URL` | no | — | point Playwright at an already-running server (Phase 5) |

Rules: `loadConfig(env)` is pure (unit-testable) and `getConfig()` caches it; values are trimmed
and, for non-secret fields, a trailing ` # comment` is stripped (dirty `.env` tolerance); missing
or invalid required values throw one error listing every problem and pointing at `.env`; secret
fields are wrapped so `JSON.stringify`/`util.inspect` print `[redacted]`; a secret field
(`BLOG0_SESSION_SECRET`, `BLOG0_OPENROUTER_API_KEY`, `BLOG0_ADMIN_PASSWORD`,
`BLOG0_NEW_ADMIN_PASSWORD`) whose value starts with `replace-with-` (the `.env.example`
placeholder prefix) is rejected at boot as unset, listed in the same aggregated error. Scripts and
tests load `.env` with `@next/env`'s `loadEnvConfig(process.cwd())`.

`/api/health` never returns raw DB driver errors: on DB failure the driver error is logged
server-side (`error` event with `request_id`) and the response is the generic envelope 503
`DB_UNAVAILABLE` with a fixed message (no driver text, host, or connection string).

> **Assumed:** local dev admin credentials may live in the gitignored file `var/dev-admin.env`
> (`BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME`), sourced into the shell when
> `.env` lacks them; values in `.env` take precedence over it.

---

## Stack

User-binding choices: **Next.js (App Router) + TypeScript + Postgres**, **OpenRouter** as LLM
provider, web UI, **pnpm**, Node 22, env prefix `BLOG0_`. Everything else below is derived from
the requirements.

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node 22 LTS (`.nvmrc`, `engines`) | Installed; LTS; bundled ICU makes `Intl.Segmenter` sentence splitting deterministic. |
| Framework | Next.js 16.x App Router, React 19.x (latest stable at scaffold; lockfile pins) | Binding. Server rendering for fast reader pages + OG tags; client islands for the deck/animations. |
| Language | TypeScript 5.x, `strict: true` | Binding. |
| DB | PostgreSQL 18 (local Homebrew, socket `/tmp:5432`, user `sai`) | Binding; production-lite, backup-friendly. |
| DB driver | `postgres` (postgres.js) | Pure JS, no native build, fast, works in Next server runtime and scripts. |
| ORM + migrations | Drizzle ORM + drizzle-kit (generate) + drizzle-orm migrator (apply) | SQL-first migration files reviewable in diffs; no binary engine (lighter Docker image than Prisma); types inferred from the schema. Applying uses `drizzle-orm/postgres-js/migrator` (a main dependency) so deploy needs no dev tooling. |
| Validation | zod 4 | Env, request bodies, LLM output — one library at every trust boundary. |
| Markdown | unified 11, remark-parse, remark-gfm, remark-rehype, rehype-slug, rehype-stringify, custom plugins | GFM tables + footnotes required; AST access needed for stable paragraph ids and the sentence list; deterministic. |
| Syntax highlighting | Shiki via `@shikijs/rehype`, dual theme (CSS variables) | Server-side, zero client JS, VS Code-grade grammars, light/dark switch with the site's `data-theme`. |
| Password hashing | `@node-rs/argon2` (argon2id) | Prebuilt binaries (no node-gyp), OWASP-recommended algorithm. |
| Sessions | Own DB-backed opaque tokens (HMAC'd at rest) | Multi-admin with per-user identity, revocable, tiny code; no auth framework needed for email+password. |
| LLM access | Plain `fetch` to OpenRouter's OpenAI-compatible `/chat/completions` behind `LlmClient` | One call shape, structured outputs, usage/cost in response; no SDK dependency to drift. |
| Fonts | `next/font/google` (Space Grotesk, Source Serif 4, JetBrains Mono) | Same faces as the design, self-hosted at build (no runtime Google request). |
| Logging | In-house JSON-lines logger (~80 lines) | Avoids worker-thread transport issues of pino under Next bundling; fields fully controlled. |
| Unit + integration tests | Vitest 3.x (`projects`: unit, integration) | Fast TS-native runner; integration project runs serially against real Postgres + real OpenRouter. |
| E2E | Playwright (`@playwright/test`, Chromium) | The deck and editor are JS-driven → headless-browser gate required. |
| Script runner | `tsx` (main dependency) | Runs TS scripts (migrate, seed, check) with no build; needed at deploy time → main deps. |
| Media probing (Phase 3) | `music-metadata`, `image-size` | Pure JS duration/format probe for mp3/m4a and dimensions/type for images; no native ffmpeg dependency. |
| Lint | ESLint 9 flat config + `eslint-config-next` (core-web-vitals, typescript) | Standard for Next; `next lint` is not used. |

> **Assumed:** Next.js **16** is current stable in Oct 2026 (Turbopack default; `params`/`searchParams` are Promises; Middleware renamed Proxy). blog0 has exactly **one** proxy file, `src/proxy.ts` (404 pre-check for `/p/:slug` and `/p/:slug/tldr` only; see §8); auth is never enforced there (layouts and route handlers own it). If 16 is unavailable, use 15.5 and rename the file to `src/middleware.ts` (same matcher and logic).
> **Assumed:** Drizzle over Prisma (rationale above).
> **Assumed:** plain `<textarea>` editor (monospace, tab inserts two spaces) instead of CodeMirror — fewer moving parts for v0.1; swap later behind `MarkdownEditor`.
> **Assumed:** pnpm ≥10 blocks dependency build scripts by default; `pnpm-workspace.yaml` lists `onlyBuiltDependencies: [esbuild, sharp]`. If `pnpm install` warns about ignored builds, run `pnpm approve-builds` and commit the result.

Deploy-time dependencies (must be in `dependencies`, not `devDependencies`): `next`, `react`,
`react-dom`, `drizzle-orm`, `postgres`, `tsx`, `zod`, `@node-rs/argon2`, all unified/remark/rehype
packages, `shiki`, `@shikijs/rehype`, `@next/env`. Dev-only: `drizzle-kit`, `vitest`,
`@playwright/test`, `typescript`, `@types/*`, `eslint*`.

`next.config.ts`: `serverExternalPackages: ['@node-rs/argon2', 'shiki', 'postgres']`,
`poweredByHeader: false`, `typedRoutes` off. **No** `output: 'standalone'` before Phase 5: the
documented local run command is `next start` (via `scripts/serve.mjs`), which warns under
standalone output. Phase 5 slice S5.1 (Dockerfile) adds `output: 'standalone'` and the container
runs `node .next/standalone/server.js` (see `spec/roadmap.md` → Phase 5).

## Layout

Single package at the repo root (Next.js convention: root holds config only; **all application
source lives in `src/`**, the one import root, alias `@/*`). Tests live in `tests/` at the root,
tiered. Scripts in `scripts/`. This honors `project-layout.md`: no app code at the root, one
package, tests outside the source package.

```
blog0/
├── README.md  .env.example  .gitignore  .nvmrc  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
├── tsconfig.json  next.config.ts  drizzle.config.ts  vitest.config.ts  playwright.config.ts  eslint.config.mjs
├── spec/                                    # this spec + design reference (never edited by generators)
├── scripts/
│   ├── serve.mjs                # loads .env via @next/env, runs `next <dev|start> -p ${BLOG0_PORT||3410}`, forwards signals
│   ├── db-create.ts  db-migrate.ts  db-verify.ts  check-openrouter.ts          # scaffold
│   ├── db-seed.ts  create-admin.ts                                              # S1.1
│   ├── eval-jev.ts                                                              # S1.3
│   └── db-seed-posts.ts                                                         # S2.6
├── src/
│   ├── instrumentation.ts       # register(): getConfig() (fail fast) + app.boot log
│   ├── proxy.ts                 # Next 16 proxy: /p/:slug(/tldr) unknown/unpublished → rewrite to root 404 (§8); no auth
│   ├── app/
│   │   ├── layout.tsx           # <html data-theme> + theme init script + fonts + global CSS
│   │   ├── not-found.tsx        # root 404 with site chrome (target of the proxy rewrite)
│   │   ├── (site)/              # public, wrapped by Masthead/Footer chrome
│   │   │   ├── layout.tsx  page.tsx  not-found.tsx  error.tsx
│   │   │   ├── p/[slug]/page.tsx   p/[slug]/tldr/page.tsx   p/[slug]/listen/page.tsx (P3)
│   │   │   ├── archive/page.tsx    about/page.tsx
│   │   ├── admin/
│   │   │   ├── login/page.tsx
│   │   │   └── (authed)/        # layout.tsx calls requireAdminPage()
│   │   │       ├── layout.tsx  page.tsx (desk)
│   │   │       ├── articles/new/page.tsx  articles/[id]/page.tsx
│   │   │       └── site/ subscribers/ (P2)  ai-usage/ team/ (P4)
│   │   ├── api/
│   │   │   ├── health/route.ts
│   │   │   ├── auth/{login,logout,me}/route.ts
│   │   │   ├── admin/preview/route.ts
│   │   │   ├── admin/articles/route.ts  admin/articles/[id]/route.ts
│   │   │   ├── admin/articles/[id]/{publish,unpublish}/route.ts
│   │   │   ├── admin/articles/[id]/tldr/route.ts  admin/articles/[id]/tldr/generate/route.ts
│   │   │   ├── public/articles/[slug]/tldr/route.ts (P2)  newsletter/route.ts (P2)  admin/site/route.ts (P2)
│   │   │   └── …later phases per spec/api.md
│   │   ├── media/[...key]/route.ts (P3)
│   │   ├── sitemap.ts  robots.ts (P2)
│   ├── components/
│   │   ├── design/              # Icon, Typewriter, Wordmark, SplitHeadline, Dek, motion.ts
│   │   ├── site/                # Masthead, Footer, NewsletterForm, AsciiHand, Boot, PrintIn, PostCard, home/, archive/, about/
│   │   ├── reader/              # ArticleView, ModeBar, ModeCapsule, ReadHead, ArticleBody, ArticleFoot, TldrDeck, ShareLinkButton, ListenStub
│   │   ├── figures/             # FigSlide47, FigAB, registry.ts
│   │   ├── admin/               # LoginForm, DeskHeader, ArticleTable, FormatChips, editor/*, tldr/*
│   │   └── StubNotice.tsx
│   ├── lib/                     # isomorphic, pure, no I/O
│   │   ├── api/envelope.ts  api/dto.ts
│   │   ├── content/types.ts
│   │   ├── formats/registry.ts
│   │   ├── deck/timing.ts       # tldrDwell, tldrType, tldrMinutes, slide words (ported verbatim)
│   │   ├── view-models.ts       # ArticleViewModel, PostCardViewModel, DeckViewModel
│   │   └── format-date.ts       # fmtDate(iso, timeZone) "8 Sep 2026"
│   ├── server/                  # server-only (each file starts with `import 'server-only'`)
│   │   ├── config.ts  log.ts
│   │   ├── db/{client,schema,migrate}.ts  db/migrations/
│   │   ├── http/api.ts
│   │   ├── auth/{session,guard,password,login,rate-limit}.ts
│   │   ├── users/repo.ts  site/{current,defaults,service}.ts
│   │   ├── content/{markdown,render,sentences,paragraph-ids,fingerprint,stats,highlight,cache}.ts  content/plugins/*
│   │   ├── formats/{index,read,tldr,listen,status}.ts
│   │   ├── articles/{repo,service,slug,tldr}.ts
│   │   ├── llm/{types,openrouter,index}.ts
│   │   ├── jev/{state,bounds,build-input,validate,run,prompt}.ts  jev/prompts/select-v1.md
│   │   ├── public/{articles,home,metadata}.ts
│   │   ├── seed/{site,admin,seed-posts}.ts  seed/posts/{index.ts,*.md}
│   │   └── storage/ media/ listen/ newsletter/ ai-usage/ (later phases)
│   └── styles/
│       ├── index.css            # @import design.css, additions.css (admin.css imported by admin layout)
│       ├── design.css           # VERBATIM copy of spec/design/design-app.css
│       ├── additions.css        # new rules only (see spec/ui.md → CSS additions)
│       └── admin.css
├── tests/
│   ├── setup/global-setup.ts    # vitest integration: create blog0_test if missing, drop+recreate schema, migrate
│   ├── setup/integration-env.ts # loads .env, sets BLOG0_DATABASE_URL = BLOG0_TEST_DATABASE_URL, resets singletons
│   ├── helpers/{db,session,env,logs}.ts   # resetDb() truncates all tables + seeds site; loginAs(); captureLogs()
│   ├── unit/**  integration/**  e2e/**
│   └── fixtures/articles/{hard-cases.md,e2e-article.md}  fixtures/audio/ (P3)
└── var/                         # gitignored runtime data (storage, backups)
```

Test wiring: `vitest.config.ts` defines projects `unit` (`tests/unit/**/*.test.ts(x)`, env node)
and `integration` (`tests/integration/**/*.test.ts`, `globalSetup`, `setupFiles`,
`fileParallelism: false`, `testTimeout: 120_000`); alias `@` → `src`, alias `server-only` → an
empty module (it throws outside the React server condition). `playwright.config.ts`:
`globalSetup: tests/e2e/global-setup.ts` (reset + migrate `blog0_test`, seed site + admin from
`.env` credentials), `webServer: { command: 'pnpm start', port: 3411, env: { BLOG0_PORT: '3411',
BLOG0_DATABASE_URL: <BLOG0_TEST_DATABASE_URL>, BLOG0_PUBLIC_BASE_URL: 'http://localhost:3411',
BLOG0_LOG_FILE: 'test-results/e2e-server.log' }, reuseExistingServer: false, timeout: 120_000 }`,
`use.baseURL` = `BLOG0_E2E_BASE_URL ?? 'http://localhost:3411'`, one project `chromium`,
`workers: 1`. E2E runs the **same** `pnpm start` command as production (test path = run path);
`pnpm build` must have run first (the gate does).

## Conventions

**Naming.** Files: kebab-case for modules (`paragraph-ids.ts`), PascalCase for React components
(`TldrDeck.tsx`). Types/interfaces PascalCase; functions/vars camelCase; constants
SCREAMING_SNAKE (ported design constants keep their design names, e.g. `TDECK_STEP_MS`). DB:
snake_case tables (singular: `article`, `article_revision`) and columns; drizzle field names
camelCase mapped to snake_case. API JSON: camelCase. URL paths: kebab-case. Env: `BLOG0_*`.

**Modules.** `src/lib/**` is pure and isomorphic (no I/O, no `server-only`). `src/server/**` files
begin with `import 'server-only'`. Client components begin with `'use client'` and never import
from `src/server`. Never read config at module top level (keeps `next build` env-free) — call
`getConfig()` inside functions. Singletons (`getConfig`, `getDb`, `getLlmClient`,
`getCurrentSite` cache, render cache) each export a `reset…ForTests()`.

**Next.js specifics.** `params`/`searchParams` are awaited (`const { slug } = await params`).
Every DB-reading page exports `dynamic = 'force-dynamic'`. Route handlers export named
`GET/POST/PATCH/PUT/DELETE` wrapped in `withApi({ auth: 'admin' | 'none', csrf?: boolean, body?: zodSchema }, handler)`; handlers return plain data or throw `ApiError(code, status, message, details?)`.
Long route `tldr/generate` exports `maxDuration = 120`.

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
read; generate → edit → publish → re-read).

**Real-key tests (PENDING KEY rule).** Real-key tests are: `tests/integration/jev-openrouter.test.ts`,
the real Generate step of the tldr-flow integration test, `pnpm eval:jev`, and the Generate step of
the golden-path E2E. When `BLOG0_OPENROUTER_API_KEY` is absent or a placeholder (`replace-with-…`)
**and** `CI` is not `true`, each of these SKIPS with an explicit, visible reason containing
`PENDING KEY` (e.g. `it.skip`/`test.skip` titled or annotated `PENDING KEY: BLOG0_OPENROUTER_API_KEY
unset`; `eval:jev` prints `PENDING KEY …` and exits 0 without scoring). They are never stubbed into
a pass — no stub `LlmClient`, no recorded fixture, no `<stub:jev>` output on these paths. When
`CI=true`, a missing/placeholder key is a FAILURE (not a skip). Whenever a real (non-placeholder)
key is present, an invalid/rejected key (401/403) or any provider error is a FAILURE, never a
skip. A gate run that skipped any `PENDING KEY` test is reported as "pending key", not as passed.

**Formatting.** Prettier (dev dependency, `.prettierrc`: `printWidth: 110, singleQuote: true`)
for editor formatting; it is not part of the gate. `pnpm lint` runs ESLint only.

**Commits.** `phase-N: <what>` (scaffold: `phase-0: scaffold`).

---

## Design divergences (ask user)

Default for everything not listed: port the design exactly (markup, class names, CSS verbatim,
timings, copy). Each item states what we do in v0.1 (the assumption the build proceeds on) and
the question for the user.

1. **Hash routing → real routes.** Design: `#<id>`, `#<id>/tldr`, `#archive`, `#about`,
   `#hl=<sentence>`. v0.1: `/p/<slug>`, `/p/<slug>/tldr` (deck open; open/close uses
   `replaceState` like the design), `/p/<slug>/listen` (Phase 3), `/archive?topic=<Topic>`,
   `/about`, paragraph links `/p/<slug>#p-xxxxxxxx`. Legacy hashes on `/` are redirected
   client-side (Phase 2): `#<id>` → `/p/<id>`, `#<id>/tldr` → `/p/<id>/tldr`, `#hl=<id>-…` →
   `/p/<id>`, `#archive`/`#about` → pages. The `/p/` prefix avoids clashes with `/archive`,
   `/about`, `/admin`. *Ask:* OK with `/p/<slug>`, or prefer `/<slug>`?
2. **Sentence highlight → paragraph highlight.** Design: every sentence is a dotted-underlined
   tappable span; deep link `#hl=<sentence>`. v0.1 (per brief): the paragraph is the unit — hover
   shows a faint accent rule in the left margin, click/tap (not on a link) or a text selection
   inside it highlights the whole paragraph (`.para.is-hl`, same `--accent-soft` fill), copies
   `“text” — log0\n<link>#p-…`, opens the `.hlmenu` popover. *Ask:* confirm paragraph-level and
   the hover affordance (no dotted underline).
3. **Share menu options.** Design: Notes (mailto), Notion, WhatsApp, X. v0.1: **LinkedIn**, **X**,
   **Copy link** (+ the automatic clipboard copy and status line kept). *Ask:* keep WhatsApp /
   Notes / Notion too?
4. **Search removed.** Masthead search icon and search bar are not rendered (search dropped).
   *Ask:* confirm the tools area holds only the theme toggle.
5. **Reactions removed.** The reactions row is dropped; its trailing **Share article** button is
   kept at the top of `.artfoot` (copies the article link). *Ask:* keep that button?
6. **Boot strip.** The design ships `Boot` ("> start of log0", typed commands per route) but its
   App does not render it (`--booth: 0px`, "no strip above the header any more"). The brief lists
   it. v0.1 ports `Boot` behind `SHOW_BOOT_STRIP = false` (pixel-identical to the design) and keeps
   `usePrintIn` + the footer "> end of log0". *Ask:* turn the strip on?
7. **TLDR selection.** Design: client heuristic `tldrPickRepresentative` (6 bands, scoring).
   v0.1: Jev picks 4–8 lines by length (server, one LLM call per click), writer may hand-edit and
   **reorder** (design is document order only). The heuristic is not ported. *Ask:* allow
   reordering or force document order?
8. **AI disclosure (new element).** Intro slide shows a `.tdeck__note` line: "Lines selected by
   Jev (AI), verbatim from the article." / "…by Jev (AI) and the editors…" (hand-edited) /
   "Lines selected by the editors, verbatim from the article." (no Jev picks). *Ask:* wording and
   placement (intro slide only vs every slide).
9. **Listen before Phase 3.** Design shows a mock player with fake durations. v0.1 Phase 1–2:
   capsule Listen shows "—" instead of minutes and opens a labelled stub panel; card Listen
   buttons are hidden when an article has no published audio. *Ask:* hide capsule Listen
   entirely when no audio?
10. **Computed times.** Design hard-codes `readMin`/`audioSec`. v0.1: read = ceil(words/230),
    TLDR = design's `tldrMinutes` formula over the published deck, listen = audio duration.
    *Ask:* 230 wpm OK?
11. **Markdown coverage beyond the design.** Design's `mdToHtml` has no code blocks, tables or
    footnotes. v0.1 adds GFM tables (`.prose table`, styled like the design's `table.data`),
    Shiki code blocks, footnotes rendered as a "Notes" section, strikethrough, task lists — new
    CSS in `additions.css` built only from existing tokens. *Ask:* review the styling of these
    three elements once Phase 1 is up.
12. **Footer links.** Design's X / LinkedIn / RSS icons are dead links. v0.1: X and LinkedIn
    render only when the site record has their URLs; RSS is hidden (no feed in v0.1). *Ask:*
    provide the URLs; want an RSS feed?
13. **Contact mail.** Design `hello@logzero.blog`. v0.1 seeds the site record with that value
    (editable later in Admin → Site). *Ask:* correct address?
14. **About copy.** Design renders a "Placeholder —" paragraph and keeps a fuller
    `ABOUT_BODY_FULL`. v0.1 seeds `ABOUT_BODY_FULL` (no "Placeholder" text in public). *Ask:*
    confirm or send final copy.
15. **Newsletter success copy** "You’re in. First issue lands Thursday." is kept although sending
    is not built. *Ask:* keep the Thursday promise?
16. **Theme persistence.** Design follows the OS each load and does not persist the toggle.
    v0.1 persists the reader's choice in `localStorage['blog0.theme']`; with no stored choice it
    follows the OS like the design. *Ask:* OK?
17. **Admin UI has no design.** Desk, editor, TLDR panel, sign-in, later Listen sync/History/
    Site/Team/AI usage are new screens built from the design's tokens and components
    (`.btn-outline`, `.tag`, `.modes`, `.modebar`, `.sechead`). *Ask:* review after Phase 1.
18. **Draft badge semantics.** Design `draft: true` = published piece with a "Draft — in
    progress" badge. v0.1: true drafts are never public; the badge is a per-article
    `in_progress` flag on published articles (seeded on "AI is Expensive"). *Ask:* OK?
19. **Featured.** Design hard-codes `FEATURED_HITS`, mode `stack`, max 4. v0.1: per-article
    `is_featured` + `featured_rank`, same stack treatment and cap. Seed: `ai-will-destroy-the-world`,
    `tech-company-first`, `humans-are-software` in that order.
20. **Seeded TLDR decks.** Design's per-post `tldr` arrays are paraphrases, not verbatim lines,
    so they are not seeded; seeded posts start with TLDR **missing** until a writer clicks
    Generate (AI only on explicit click). *Ask:* want a one-off "generate for all seeded posts"
    command (≈5 calls, < $0.05)?
21. **In-deck poll.** `DeckPoll` exists in the design but is never rendered; not ported.
22. **Retired design code not ported:** margin notes/threads, `AnnotationLayerLegacy`,
    `TldrPanel` (design already routes TLDR into the deck), `FeaturedRotator`, `SentenceBuilder`,
    `GoDeeper`, `PullQuote`, `WordCloud`, `Tiers`, `ExpandCard`, `Thumb` (`SHOW_IMAGES=false`).
    Their CSS stays in `design.css` untouched (verbatim copy) but is unused.
23. **Fonts self-hosted** via `next/font` with the same three families; the footer canvas reads
    the mono family from the `--font-mono` CSS variable instead of the literal
    `"JetBrains Mono"` name. Pixel-identical intent.
24. **"Next:" link** at the article foot: design cycles the `POSTS` array (oldest → newest,
    wrapping). v0.1: next newer published article by first-published date, wrapping to the oldest.
25. **Brand values from the site record.** `WORDMARK` 'log0', tagline, contact mail, About texts,
    publisher 'smallTech' come from the `site` row (seeded with the design's values), not code
    constants.
26. **TLDR deck stacking order.** Design: `.tdeck { position: fixed; inset: 0; z-index: 40; }`
    (`spec/design/design-app.css` line 1287), below the sticky `.modebar` (mode capsule strip,
    `z-index: 45`) and `.sitehead` (`z-index: 50`). v0.1: `.tdeck { z-index: 46 }` (override in
    `additions.css`) so the open deck sits above the docked mode capsule/modebar chrome instead
    of the capsule showing through it. Default = keep 46. *Ask:* confirm the deck should cover the
    docked mode capsule.
