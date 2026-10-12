# blog0 — Roadmap

## What

blog0 is smallTech's official blog (public wordmark **log0**; engine/product name **blog0**) — an
AI-native, multi-format publishing platform. Writers author articles in Markdown; every article
is consumed by readers in three formats through one mode capsule:

- **Read** — the Markdown rendered faithfully (headings, emphasis, lists, links, blockquotes,
  rules, syntax-highlighted code, tables, images, footnotes/Notes, interactive figures).
- **TLDR** — a full-viewport, auto-advancing slide deck of the article's most important lines,
  selected **verbatim** by **Jev** (the TLDR agent) and reviewed/edited by the writer.
- **Listen** — a writer-uploaded, word-for-word reading with the text highlighted in sync.

Formats are an extensible set (more later), each with its own lifecycle status. The engine is
built tenant-ready (every record belongs to a site) so it can be open-sourced later; v0.1 runs a
single site (blog0 / smallTech).

The visual bar is the design reference in `spec/design/` (`design-app.js`, `design-app.css`) and
`spec/blog0-design-v0.1.html` — port it pixel-close; every deliberate divergence is listed in
`spec/architecture.md` → `## Design divergences (ask user)`.

## Who

| Persona | Count | Needs |
|---|---|---|
| Writer / admin (smallTech team) | a handful | Paste/edit Markdown with an immediate Read preview, get a TLDR deck with one click, hand-edit it, publish; later upload audio and sync it; see AI cost. |
| Reader (public) | open web | Fast server-rendered pages, three ways to take an article in, share a paragraph, good link previews. |

Scale: fewer than 100 articles, a handful of writers. Cost sensitivity: high (AI only on an
explicit click, cached forever, never per reader view).

## Success criteria (v0.1, measurable)

1. A writer signs in, pastes Markdown, and sees the rendered Read preview update within 1 s of
   pausing typing.
2. One click on **Generate** produces a deck of 4–8 lines (scaled to length), every line
   byte-identical to a sentence of the saved article, each with a one-line reason, in under 60 s,
   with model / prompt version / tokens / $ cost / who / when recorded.
3. The published article page renders Read and plays the TLDR deck exactly like the design
   (intro slide, dwell by word count, type scaled by length, progress segments, wheel/touch/keys,
   end slide with Read + Share, deep link `/p/<slug>/tldr`).
4. No reader request ever triggers an LLM call (verified by the cost ledger staying flat across
   the E2E reader walk).
5. Editing text after a deck exists never auto-regenerates; the deck shows **stale** and the
   published deck keeps serving until the writer acts.
6. Every gate runs against real Postgres and the real OpenRouter key from `.env`. Without a key,
   real-key tests skip as `PENDING KEY` (never a pass); in CI or with a real key present a key
   problem fails — see `spec/architecture.md` → `## Conventions` → Real-key tests.

## In scope (whole roadmap) / Out of scope

In scope: everything in `## Phases of Development` below.

Out of scope (dropped or not planned): reader accounts, reactions, margin notes/comments,
search, paid speech-to-text, multi-tenant admin UI, roles/permissions (all admins are equal),
GitHub login (later), Markdown file upload and posts-repo sync (later — the content model is
source-agnostic so they plug in without schema change), newsletter *sending* (signup only),
RSS feed, image thumbnails on cards (design has them switched off), the design's retired
component library (word cloud, tiers, pull quote, go-deeper aside, expand cards, featured
rotator, sentence builder, in-deck poll).

---

## Assumptions (decided without the user; each is reversible)

> **Assumed:** Saving is explicit (Save button / Cmd-Ctrl+S), not autosave — every save is a revision, and autosave would flood history.
> **Assumed:** Generate on an unsaved editor saves first ("Save & generate"), so Jev always reads a stored revision.
> **Assumed:** Slugs lock at first publish (no redirects in v0.1).
> **Assumed:** Paragraph bookmark ids are content-hashes of the paragraph text (stable across edits elsewhere; a link to an edited paragraph falls back to the article).
> **Assumed:** Read time uses 230 words/minute.
> **Assumed:** If Jev fails, the writer hand-picks lines; there is no heuristic fallback (user has not chosen one).
> **Assumed:** Seeded posts have no TLDR deck until a writer clicks Generate (design TLDR arrays are paraphrases, not verbatim).
> **Assumed:** Phase 1 login throttling is in-memory per process (single instance); Phase 5 moves it to Postgres.
> **Assumed:** Hand-edited decks allow 1–12 lines and reordering (Jev itself picks 4–8 in document order).
> **Assumed:** A published deck whose lines vanished from the text blocks publishing of new changes until fixed (the old deck keeps serving meanwhile); publishing without any deck is allowed.
> **Assumed:** Admins are all equal (no roles); approve-your-own-article is allowed in v0.1.
> **Assumed:** Phases 5–6 are planned at lower fidelity; their capability files are written spec-first at the start of each phase.
> Further `Assumed:` items: stack (`spec/architecture.md` → `## Stack`), model slug (`spec/agent.md` §3), timezone and up-front schema (`spec/data.md`), and every design divergence (`spec/architecture.md` → `## Design divergences (ask user)`).

## Phases of Development

Conventions for every phase below:

- All commands run from the repo root `/Users/sai/Workspace/Code/blog0` (written as `.` below).
- `.env` must contain real values for every key in `.env.example` (OpenRouter key, admin
  credentials, session secret, both DB URLs). Gates load it programmatically.
- Integration + E2E tests use the dedicated Postgres database `blog0_test` (created and migrated
  automatically by the test harness); the dev server uses `blog0_dev`.
- "Boot check" = start `pnpm start` with the terminal tool's **background mechanism** (never `&`,
  `nohup`, `setsid`, `disown`), then in a separate call run
  `curl -fsS http://localhost:3410/api/health` and expect `"db":"ok"`.
- Slices inside a phase own **disjoint files** (paths per `spec/architecture.md` → `## Layout`).
  "Wave" = slices that can start together; a later wave depends on the named earlier slices.
- A slice that edits a file owned by an earlier phase takes ownership of that file for this phase
  (listed explicitly as "takes over").
- `package.json` and `pnpm-lock.yaml` are never edited by parallel slices. The scaffold installs
  every Phase 1 dependency (`spec/architecture.md` → `## Stack`) and declares every Phase 1
  script (including `db:seed`, `admin:create`, `eval:jev`, whose target files Phase 1 slices
  create). Before fanning out Phase N ≥ 2, the orchestrator adds that phase's new dependencies and
  scripts in one commit (Phase 2: `db:seed:posts`; Phase 3: `music-metadata`, `image-size`).
  A slice that discovers it needs another dependency reports it instead of installing it.

### Scaffold — minimal runnable skeleton + shared contracts

**Goal:** the Next.js app boots on port 3410 from the documented command, `/api/health` proves
the DB is reachable, the full v0.1 schema is migrated with a working verify command, the test
harness (unit, integration, E2E) runs green with smoke tests, the OpenRouter key + Jev model slug
are proven alive by one real call, and the shared type contracts every Phase 1 slice codes
against exist.

**Single slice (S0)** — owns everything it creates; later phases extend in place.

Key files (see `## Layout` for the full tree):
- Root config: `package.json` (scripts below; `packageManager` pinned to the installed pnpm 11.x;
  `engines.node` `>=22 <23`), `pnpm-lock.yaml`, `pnpm-workspace.yaml` (allowed build scripts),
  `.nvmrc` (`22`), `tsconfig.json` (`@/*` → `src/*`), `next.config.ts`, `drizzle.config.ts`,
  `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`, `.gitignore`, `.env.example`,
  `README.md`.
- `scripts/serve.mjs`, `scripts/db-create.ts`, `scripts/db-migrate.ts`, `scripts/db-verify.ts`,
  `scripts/check-openrouter.ts`.
- `src/instrumentation.ts` (validates config at boot), `src/server/config.ts`,
  `src/server/log.ts`, `src/server/db/{client,schema,migrate}.ts`,
  `src/server/db/migrations/0000_init.sql` (+ drizzle `meta/`), `src/server/http/api.ts`,
  `src/server/auth/{session,guard}.ts`, `src/server/site/{current,defaults}.ts` (`SITE_DEFAULTS`
  = the seed values in `spec/data.md`, shared by the test helper and S1.1's seed).
- Contracts: `src/lib/content/types.ts`, `src/lib/formats/registry.ts`, `src/lib/api/envelope.ts`,
  `src/lib/api/dto.ts` (all Phase 1 DTOs transcribed from `spec/api.md`).
- `src/app/layout.tsx` (minimal), `src/app/(site)/page.tsx` (placeholder "blog0 is running"),
  `src/app/api/health/route.ts`, `src/styles/index.css` (placeholder).
- Seed content (used by tests now, seeding in Phase 2): `src/server/seed/posts/*.md` + `index.ts`
  (the 5 design articles, verbatim from `POSTS` in `spec/design/design-app.js`) and
  `tests/fixtures/articles/hard-cases.md` (see `spec/capabilities/article-authoring.md`).
- Tests: `tests/setup/{global-setup,integration-env}.ts`, `tests/helpers/{db,session,env,logs}.ts`,
  `tests/unit/config.test.ts`, `tests/integration/health.test.ts`, `tests/e2e/smoke.spec.ts`,
  `tests/e2e/global-setup.ts` (reset + migrate `blog0_test`, seed the site row).
- `.gitignore`: `node_modules/ .next/ .env .env.*.local var/ test-results/ playwright-report/ .DS_Store`
  (`.env.example` is committed).
- `README.md` (all commands from the repo root, runner-prefixed, each setup command followed by
  its verify command): prerequisites (Node 22, pnpm 11, Postgres 18 running on `/tmp:5432` as
  `sai`), `cp .env.example .env` + which values to fill, install, `db:create`, `db:migrate` →
  `db:verify`, `check:openrouter`, `build` + `start` → `curl …/api/health`, test commands,
  env-var table (from `spec/architecture.md` §10).

`scripts/check-openrouter.ts` (self-contained; uses `fetch`, not the S1.3 adapter), prints only
booleans/numbers, never the key:
1. `key present: true|false` (exit 1 if false, message points at `.env`).
2. `GET {base}/key` with the bearer key → `key valid: true` on 200 (exit 1 on 401/403).
3. `GET {base}/models` → `model <slug> listed: true|false`, then `fallback availability:` one line
   per slug of the fallback list in `spec/agent.md` §3 (exit 1 if the configured slug is unlisted).
4. `POST {base}/chat/completions` with the configured model, `max_tokens: 20`, `temperature: 0`,
   `provider.require_parameters: true`, `usage.include: true`, `response_format` json_schema
   `{ ok: boolean }` (strict) and the user message "Reply with ok=true." → parse
   `choices[0].message.content` as JSON with `ok === true` → `structured call: ok · tokens <n> ·
   cost $<x|n/a> · <ms> ms` (exit 1 otherwise, printing the HTTP status and OpenRouter error
   message).

package.json scripts (exact names — every later phase and the README use these):

| Script | Command |
|---|---|
| `dev` | `node scripts/serve.mjs dev` |
| `build` | `next build` |
| `start` | `node scripts/serve.mjs start` |
| `typecheck` | `tsc --noEmit` |
| `lint` | `eslint .` |
| `db:create` | `tsx scripts/db-create.ts` |
| `db:generate` | `drizzle-kit generate` |
| `db:migrate` | `tsx scripts/db-migrate.ts` |
| `db:verify` | `tsx scripts/db-verify.ts` |
| `check:openrouter` | `tsx scripts/check-openrouter.ts` |
| `test:unit` | `vitest run --project unit` |
| `test:integration` | `vitest run --project integration` |
| `test` | `vitest run` |
| `test:e2e` | `playwright test` |
| `db:seed` | `tsx scripts/db-seed.ts` (file created by S1.1) |
| `admin:create` | `tsx scripts/create-admin.ts` (file created by S1.1) |
| `eval:jev` | `tsx scripts/eval-jev.ts` (file created by S1.3) |

**Gate (exact commands, in order, all must pass):**
```bash
# cwd: /Users/sai/Workspace/Code/blog0
pnpm install
pnpm exec playwright install chromium
pnpm db:create            # creates blog0_dev and blog0_test if missing; prints "exists"/"created" per DB
pnpm db:migrate           # applies 0000_init to blog0_dev
pnpm db:verify            # prints "blog0_dev @ PostgreSQL 18.x — 1 applied (latest 0000_init), 0 pending: OK"; exit 1 if pending
pnpm check:openrouter     # prints key present/valid, model listed, structured-output call ok + tokens + cost; exit 1 on any failure
pnpm typecheck && pnpm lint
pnpm test:unit && pnpm test:integration   # config unit test + health integration test (real blog0_test)
pnpm build
pnpm test:e2e             # smoke: starts `pnpm start` on 3411 against blog0_test; GET / 200 + "blog0 is running"; /api/health db ok; linked CSS 200 non-empty
# Boot check (background tool): pnpm start   then:   curl -fsS http://localhost:3410/api/health
```
Expected health body: `{"ok":true,"data":{"status":"ok","db":"ok","dbLatencyMs":<n>,"version":"0.1.0","uptimeSec":<n>}}`.
If `check:openrouter` reports the default model slug unlisted, it prints the availability of the
fallback list (see `spec/agent.md` → Model) — set `BLOG0_JEV_MODEL` in `.env` and `.env.example`
to the first available one and record the change in `spec/agent.md`.

**How the user tests it:** run the commands above; open `http://localhost:3410/` (placeholder
page) and `http://localhost:3410/api/health` (JSON with `"db":"ok"`).

---

### Phase 1 — TLDR end-to-end (the first win)

**Goal:** a writer signs in, pastes Markdown, sees the live Read preview, clicks **Generate** →
Jev picks lines (real OpenRouter call) with reasons, hand-edits the deck, publishes; the public
article page shows the Read view and the TLDR deck playing exactly like the design.

Capabilities: `admin-auth`, `article-authoring`, `jev-tldr`, `article-reading`
(see `spec/capabilities/`).

Real vs stubbed in Phase 1:
- **Real:** login/logout, dashboard with format chips, editor + live preview, save (every save a
  revision), Generate (Jev), deck hand-editing + deck preview, publish/unpublish, delete
  never-published draft, public article page (Read + TLDR deck + deep link), home "Latest" list of
  published articles, theme toggle, masthead + footer chrome, structured logging, per-generation
  cost line in the TLDR panel.
- **Labelled stubs** (`StubNotice` component, text "Coming in a later phase — …"): home Featured +
  About sections, Archive page, About page, footer newsletter form (disabled), Listen mode
  (capsule Listen opens a stub panel), editor Listen + History tabs, paragraph share.

**Independent slices**

| Wave | Slice | Owns (files) | Depends on |
|---|---|---|---|
| A | **S1.1 Admin auth** | `src/server/auth/{password,login,rate-limit}.ts`, `src/server/users/repo.ts`, `src/server/seed/{site,admin}.ts`, `scripts/db-seed.ts`, `scripts/create-admin.ts`, `src/app/api/auth/{login,logout,me}/route.ts`, `src/app/admin/login/page.tsx`, `src/components/admin/LoginForm.tsx`, `tests/integration/auth.test.ts`, `tests/unit/auth/*.test.ts` | scaffold |
| A | **S1.2 Content pipeline** | `src/server/content/**` (`markdown.ts`, `render.ts`, `plugins/*.ts`, `sentences.ts`, `paragraph-ids.ts`, `fingerprint.ts`, `stats.ts`, `highlight.ts`, `cache.ts`), `tests/unit/content/**` | scaffold |
| A | **S1.3 LLM adapter + Jev agent** | `src/server/llm/**`, `src/server/jev/**` (incl. `prompts/select-v1.md`), `scripts/eval-jev.ts` (+ `eval:jev` script), `tests/unit/jev/**`, `tests/unit/llm/**`, `tests/integration/jev-openrouter.test.ts` | builds on scaffold only (Jev takes `Sentence[]` from the scaffold contract); its integration test calls S1.2's `renderArticle`, so **gate S1.3 after S1.2 lands** |
| A | **S1.4 Reader design port** | `src/styles/{design,additions,index}.css`, `src/app/layout.tsx` (takes over: fonts, theme script, CSS), `src/app/(site)/layout.tsx`, `src/components/design/**`, `src/components/site/**`, `src/components/reader/**`, `src/components/figures/**`, `src/components/StubNotice.tsx`, `src/lib/deck/timing.ts`, `src/lib/view-models.ts`, `src/lib/format-date.ts`, `tests/unit/deck/*.test.ts`, `tests/unit/format-date.test.ts` | scaffold |
| B | **S1.5 Admin UI** | `src/app/admin/layout.tsx` (imports `admin.css` for all admin pages incl. sign-in), `src/app/admin/(authed)/**`, `src/components/admin/**` (except `LoginForm.tsx`), `src/styles/admin.css` (incl. `.admin-login` styles used by S1.1's page) | S1.4 (`ArticleBody`, `ReadHead`, `TldrDeck`, `StubNotice`); codes against `src/lib/api/dto.ts` |
| B | **S1.6 Articles API + format adapters** | `src/server/articles/**`, `src/server/formats/**`, `src/app/api/admin/**`, `tests/integration/articles-api.test.ts`, `tests/integration/tldr-flow.test.ts`, `tests/integration/logging.test.ts` | S1.2, S1.3 |
| B | **S1.7 Public pages** | `src/app/(site)/page.tsx` (takes over), `src/app/(site)/p/[slug]/page.tsx`, `src/app/(site)/p/[slug]/tldr/page.tsx`, `src/app/(site)/archive/page.tsx`, `src/app/(site)/about/page.tsx`, `src/app/(site)/not-found.tsx`, `src/server/public/**`, `tests/integration/public-queries.test.ts` | S1.2, S1.4 |
| C | **S1.8 Golden-path E2E** | `tests/e2e/phase1-tldr.spec.ts`, `tests/e2e/helpers/*.ts`, `tests/e2e/global-setup.ts` (takes over: also seeds the admin via `src/server/seed/admin.ts`), `tests/fixtures/articles/e2e-article.md` (= `tech-company-first.md` body + a GFM table + a `ts` code block + one footnote) | all of S1.1–S1.7 |

No "Agentic Stack Upgrade" phase is planned: `spec/agent.md` concludes a single bounded call meets
the requirement; Jev's full composition (state, steps, repair, error mapping, logging) is wired in
Phase 1 by S1.3.

**Gate (exact):**
```bash
# cwd: /Users/sai/Workspace/Code/blog0
pnpm db:migrate && pnpm db:verify        # schema unchanged from scaffold unless a slice added a migration; verify prints 0 pending
pnpm db:seed                             # upserts site + admin from .env into blog0_dev; prints "site blog0 ok, admin <masked> ok"
pnpm typecheck && pnpm lint
pnpm test:unit
pnpm test:integration                    # real blog0_test + real OpenRouter (jev-openrouter, tldr-flow)
pnpm build
pnpm test:e2e                            # smoke + phase1-tldr against `pnpm start` on 3411, real OpenRouter
# Boot check (background tool): pnpm start   then:
curl -fsS http://localhost:3410/api/health
curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:3410/admin/login   # 200
```
Gate assertions inside the suites (summary — details in the capability files):
`tldr-flow` drives create → save → generate (real call) → edit deck → publish → public view model
and asserts verbatim lines, bounds, reasons, generation record fields (model, prompt_version,
tokens > 0, cost recorded or explicitly null with a warning log), and that a second save with
changed text yields TLDR status `stale` without any new generation row. `phase1-tldr.spec.ts`
walks the UI journey in Chromium (see "How the user tests it") and finally asserts the server log
file (`BLOG0_LOG_FILE`) contains an `api.request` line for `POST /api/admin/articles/:id/tldr/generate`
and an `llm.call` line with `model`, `prompt_version`, `latency_ms`, `outcome:"ok"`; it also
fetches every `<link rel="stylesheet">` on `/p/<slug>` and asserts 200 + non-empty + contains
`.tdeck__track`.

**How the user tests it:**
1. `pnpm db:seed`, then start the app (`pnpm build && pnpm start`), open
   `http://localhost:3410/admin` → redirected to the sign-in page. Sign in with
   `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD`.
2. Dashboard (empty state) → **New article**. Enter a title, dek, topic; paste the Markdown of any
   smallTech post (e.g. `src/server/seed/posts/tech-company-first.md`). The right-hand preview
   renders it as readers will see it, including the two interactive figures.
3. **Save** (or Cmd/Ctrl+S) → "Saved · rev 1". Open the **TLDR** tab → **Generate with Jev**.
   Within ~5–20 s a deck of 4–8 lines appears, each with Jev's reason and a cost line
   ("… tokens · $0.00xx").
4. Remove a line, add another from the article list, move one up, **Preview deck** (the real deck
   plays), **Save deck**.
5. **Publish** → **View live**. The article page shows Read; click **TLDR** in the bottom capsule:
   the deck plays (intro slide with "Lines selected by Jev (AI)…", auto-advance, arrows/scroll/
   swipe, end slide with Read + Share). The address bar shows `/p/<slug>/tldr`; reload keeps the
   deck open; Esc closes it.
6. Go back to the editor, change a sentence that is in the deck, Save: the TLDR chip turns
   **stale**; the live page still plays the old deck. Nothing regenerates by itself.
7. Labelled stubs (not bugs): Listen in the capsule, Featured/About on the home page, Archive,
   About page, newsletter form, editor Listen and History tabs.

---

### Phase 2 — Reader site

**Goal:** the public site is complete and pixel-close to the design: home (masthead with typed
spinning-nought wordmark, print-in, About, Featured stack, Latest feed with See More), Archive
with topic filter, About page (admin-editable), newsletter signup stored server-side, paragraph
highlight + share (LinkedIn / X / copy link with deep link), light/dark theme (persisted), OG
tags, legacy hash-link redirects, TLDR deck straight from cards, and the 5 design articles seeded
as real published posts.

Capabilities: `reader-site`, `newsletter-signup`, `paragraph-share` (+ seeding inside
`reader-site`).

| Wave | Slice | Owns | Depends on |
|---|---|---|---|
| A | **S2.1 Home + chrome** | `src/app/(site)/page.tsx` (takes over), `src/components/site/home/**`, `src/components/site/Masthead.tsx` (takes over: no search, theme persistence), `src/components/site/Boot.tsx`, `src/components/site/PrintIn.tsx`, `src/server/public/home.ts` | Phase 1 |
| A | **S2.2 Archive, About, site settings** | `src/app/(site)/archive/page.tsx`, `src/app/(site)/about/page.tsx` (take over), `src/components/site/archive/**`, `src/components/site/about/**`, `src/server/site/service.ts`, `src/app/api/admin/site/route.ts`, `src/app/admin/(authed)/site/page.tsx`, `src/components/admin/site/**`, `tests/integration/site-settings.test.ts` | Phase 1 |
| A | **S2.3 Newsletter** | `src/server/newsletter/**`, `src/app/api/newsletter/route.ts`, `src/app/api/admin/subscribers/route.ts`, `src/app/admin/(authed)/subscribers/page.tsx`, `src/components/site/NewsletterForm.tsx` (takes over), `src/components/site/Footer.tsx` (takes over: real topics, social links from site), `tests/integration/newsletter.test.ts` | Phase 1 |
| A | **S2.4 Paragraph share** | `src/components/reader/ParagraphShare.tsx`, `src/components/reader/ShareMenu.tsx`, `src/components/reader/ArticleView.tsx` + `ArticleFoot.tsx` (take over: share provider, "Share article" button), `src/lib/share-links.ts`, `tests/unit/reader/share-links.test.ts` | Phase 1 |
| A | **S2.5 Cards → deck, metadata, redirects** | `src/components/site/PostCard.tsx` (takes over), `src/components/site/SummaryHost.tsx`, `src/components/site/LegacyHashRedirect.tsx`, `src/app/api/public/articles/[slug]/tldr/route.ts`, `src/app/(site)/p/[slug]/page.tsx` + `tldr/page.tsx` (take over: `generateMetadata`), `src/app/sitemap.ts`, `src/app/robots.ts`, `src/server/public/metadata.ts`, `tests/integration/public-api.test.ts` | Phase 1 |
| A | **S2.6 Seed posts** | `scripts/db-seed-posts.ts` (+ `db:seed:posts` script), `src/server/seed/seed-posts.ts`, `tests/integration/seed-posts.test.ts` | Phase 1 |
| B | **S2.7 Reader E2E** | `tests/e2e/phase2-reader.spec.ts` | S2.1–S2.6 |

**Gate (exact):**
```bash
# cwd: /Users/sai/Workspace/Code/blog0
pnpm db:migrate && pnpm db:verify        # no new migration expected (all Phase 2 tables exist since 0000_init); prints 0 pending
pnpm db:seed && pnpm db:seed:posts       # idempotent; first run prints "5 posts: 5 created", re-run "5 posts: 0 created"
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm test:e2e              # smoke + phase1 + phase2 specs; phase2 generates a real deck for one seeded post via the admin API before walking the reader
# Boot check (background tool): pnpm start   then:   curl -fsS http://localhost:3410/api/health
curl -fsS http://localhost:3410/ | grep -c "Featured Editorial"   # >= 1
```

**How the user tests it:** `pnpm db:seed:posts`, open `http://localhost:3410/`: wordmark types
in and its nought spins; About, Featured stack (3 seeded featured posts pile as you scroll; the
pinned head returns to the top), Latest with See More / View all. Archive groups by month and
filters by topic (footer topics land pre-filtered). Click any paragraph in an article → it
highlights, the passage + link is copied, and LinkedIn / X share options appear; open the copied
link → page scrolls to and highlights that paragraph. Toggle dark mode, reload → it persists.
Subscribe in the footer → "You're in…"; the address appears in **Admin → Subscribers**. Edit the
About text in **Admin → Site** → home and `/about` change. Paste an article URL into a link-preview
tool (or view source) → OG title/description present. Generate a TLDR for a seeded post, then on
the home card click **TLDR** → the deck opens over the list. Old links `/#<id>/tldr` redirect to
`/p/<id>/tldr`. Stub still: Listen.

---

### Phase 3 — Listen + media

**Goal:** writers upload a word-for-word reading (mp3/m4a ≤ 50 MB / ≤ 30 min) and inline images;
files live on local disk behind a storage interface and stream with HTTP range requests; the
writer syncs audio by tapping along at each paragraph start; readers get a Listen view with
player + text side by side, the current paragraph highlighted and auto-scrolled.

Capabilities: `listen-audio`, `listen-sync`, `media-images`.

| Wave | Slice | Owns | Depends on |
|---|---|---|---|
| A | **S3.1 Storage + media streaming** | `src/server/storage/**`, `src/server/media/**`, `src/app/media/[...key]/route.ts`, `src/app/api/admin/uploads/images/route.ts`, `tests/integration/media.test.ts` | Phase 2 |
| A | **S3.2 Audio ingest** | `src/server/listen/ingest.ts`, `src/server/listen/probe.ts`, `src/app/api/admin/articles/[id]/audio/route.ts`, `tests/integration/audio-ingest.test.ts`, `tests/fixtures/audio/**` (`sample.m4a`, ~20 s, ≤ 300 KB, generated once on macOS by `scripts/make-audio-fixture.sh` via `say` + `afconvert` and committed; known duration recorded in `tests/fixtures/audio/sample.json`), `scripts/make-audio-fixture.sh` | S3.1 (storage interface — code against `src/server/storage/types.ts` contract in `spec/architecture.md`) |
| A | **S3.3 Listen format + sync API** | `src/server/formats/listen.ts`, `src/server/formats/index.ts` (takes over: register listen), `src/server/listen/sync.ts`, `src/app/api/admin/articles/[id]/listen/route.ts`, `tests/integration/listen-sync.test.ts` | Phase 2 |
| A | **S3.4 Admin Listen + image UI** | `src/components/admin/editor/ListenTab.tsx` (takes over), `src/components/admin/listen/**`, `src/components/admin/editor/ImageUploadButton.tsx`, `src/components/admin/editor/MarkdownEditor.tsx` (takes over: toolbar slot) | Phase 2 |
| A | **S3.5 Reader Listen view** | `src/components/reader/ListenView.tsx`, `src/components/reader/ListenStub.tsx` (deleted), `src/components/reader/ArticleView.tsx` (takes over), `src/components/site/SummaryHost.tsx` (takes over: Listen overlay), `src/app/(site)/p/[slug]/listen/page.tsx`, `src/server/public/articles.ts` (takes over: listen view model) | Phase 2 |
| B | **S3.6 Listen E2E** | `tests/e2e/phase3-listen.spec.ts` | S3.1–S3.5 |

**Gate (exact):**
```bash
# cwd: /Users/sai/Workspace/Code/blog0
pnpm db:migrate && pnpm db:verify
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm test:e2e              # phase3 spec uploads tests/fixtures/audio/sample.m4a, taps sync via keyboard, publishes, asserts reader highlight follows currentTime and that /media/<key> answers 206 to a Range request
# Boot check (background tool): pnpm start   then:   curl -fsS http://localhost:3410/api/health
# (range streaming 200/206/416 is asserted against real files by tests/integration/media.test.ts)
```

**How the user tests it:** in the editor's **Listen** tab upload an mp3/m4a; press **Start
syncing**, the audio plays and the first paragraph is highlighted — press **Space** (or tap the
big button) as each paragraph begins; **Save sync**; Publish. On the article page choose
**Listen**: the player and text sit side by side, the current paragraph highlights and scrolls into
view; seeking jumps the highlight. On a home card, **Listen** opens the compact player overlay.
Drag an image into the editor toolbar's **Image** button → Markdown `![alt](/media/...)` is
inserted and renders in preview.

---

### Phase 4 — Editorial standards

**Goal:** international editorial practice: revision history (view any version, restore), public
"Published <date> · Updated <date>" and an optional dated corrections note, stale detection +
explicit **Regenerate** / **Re-sync** offers across all derived formats (published content keeps
serving), editor sign-off states (Submit for review / Approve — self-publish still allowed), AI
cost dashboard (per generation and site-wide month-to-date), and a small Team page (add admin,
change own password).

Capabilities: `revision-history`, `publication-record`, `format-lifecycle`, `ai-cost-ledger`
(team accounts are part of `admin-auth`).

| Wave | Slice | Owns | Depends on |
|---|---|---|---|
| A | **S4.1 Revision history** | `src/server/articles/revisions.ts`, `src/app/api/admin/articles/[id]/revisions/**`, `src/components/admin/editor/HistoryTab.tsx` (takes over), `src/components/admin/history/**`, `tests/integration/revisions.test.ts` | Phase 3 |
| A | **S4.2 Publication record + sign-off** | `src/server/articles/workflow.ts`, `src/app/api/admin/articles/[id]/{submit,approve,corrections}/route.ts`, `src/components/admin/editor/PublishBar.tsx` (takes over), `src/components/reader/ReadHead.tsx` + `ArticleFoot.tsx` (take over: dates, corrections), `src/server/public/articles.ts` (takes over: updatedAt/corrections), `tests/integration/workflow.test.ts` | Phase 3 |
| A | **S4.3 Format lifecycle** | `src/server/formats/status.ts`, `src/components/admin/FormatChips.tsx` (takes over), `src/components/admin/editor/StaleBanner.tsx`, `src/components/admin/editor/TldrTab.tsx` (takes over: regenerate offer), `tests/integration/format-lifecycle.test.ts` | Phase 3 |
| A | **S4.4 AI cost ledger** | `src/server/ai-usage/**`, `src/app/api/admin/ai-usage/route.ts`, `src/app/admin/(authed)/ai-usage/page.tsx`, `src/components/admin/ai-usage/**`, `src/components/admin/DeskHeader.tsx` (takes over: month-to-date total), `tests/integration/ai-usage.test.ts` | Phase 3 |
| A | **S4.5 Team accounts** | `src/app/admin/(authed)/team/page.tsx`, `src/components/admin/team/**`, `src/app/api/admin/users/**`, `src/app/api/auth/password/route.ts`, `tests/integration/team.test.ts` | Phase 3 |
| B | **S4.6 Editorial E2E** | `tests/e2e/phase4-editorial.spec.ts` | S4.1–S4.5 |

**Gate (exact):**
```bash
# cwd: /Users/sai/Workspace/Code/blog0
pnpm db:migrate && pnpm db:verify
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm test:e2e              # phase4: edit → stale chips → Regenerate (real call) → publish → "Updated" shows; restore rev 1; corrections note visible; cost page totals equal sum of generation rows
# Boot check (background tool): pnpm start   then:   curl -fsS http://localhost:3410/api/health
```

**How the user tests it:** edit a published article and save twice → **History** lists every
version with author/time; open one (rendered) and **Restore** → a new revision with the old
content. Change a deck line → TLDR chip **stale**, banner offers **Regenerate** (nothing happens
until clicked); the live page still serves the published deck. **Publish changes** → article
foot/header shows "Published 8 Sep 2026 · Updated 12 Oct 2026". Add a corrections note → it
appears dated at the article foot. **Submit for review** / **Approve** chips show on the dashboard.
**AI usage** page lists each generation (model, prompt version, tokens, $, who, when) and the
month-to-date total also shown on the dashboard header. **Team** → add a second admin; sign in
as them; their saves show their name in History.

---

### Phase 5 — Production hardening (deploy-ready)

**Goal:** a 12-factor container that runs anywhere: Dockerfile (multi-stage, Next standalone,
non-root, migrations as a release step), production config validation (HTTPS cookie, required
secrets), security headers + CSP, persistent rate limits on login and newsletter, graceful
shutdown, liveness vs readiness endpoints, backup/restore scripts (Postgres dump + storage dir),
and a deploy runbook. Capabilities: `container-image`, `backup-restore`, `abuse-protection`.
Capability files are written at the start of this phase (spec-first) from this paragraph.

Slices (planned): S5.1 Dockerfile + `.dockerignore` + `scripts/release.ts`, and adds
`output: 'standalone'` to `next.config.ts` (absent until now because local `next start` warns
under it); the container runs `node .next/standalone/server.js`; S5.2 backups
(`scripts/backup.ts`, `scripts/restore.ts`, docs); S5.3 security headers/CSP in `next.config.ts`
(depends on S5.1's one-line `next.config.ts` edit landing first)
+ DB-backed rate limits (`src/server/rate-limit/**`, migration owned by this slice); S5.4
readiness/liveness + graceful shutdown (`src/app/api/health/{live,ready}/route.ts`); S5.5 E2E
against the container.

**Gate (exact):**
```bash
# cwd: /Users/sai/Workspace/Code/blog0
docker build -t blog0:local .
pnpm db:migrate && pnpm db:verify
pnpm test:unit && pnpm test:integration
BLOG0_E2E_BASE_URL=http://localhost:3412 pnpm test:e2e   # container started (background tool) with: docker run --rm -p 3412:3410 --env-file .env -e BLOG0_DATABASE_URL=postgres://sai@host.docker.internal:5432/blog0_test blog0:local
pnpm tsx scripts/backup.ts --out var/backups && pnpm tsx scripts/restore.ts --in var/backups/<latest> --db blog0_restore_check   # prints row counts equal
```
**How the user tests it:** build and run the container per the README, open
`http://localhost:3412/`, sign in, run a backup and a restore into a scratch DB.

---

### Phase 6 — Automatic alignment (local faster-whisper)

**Goal:** on an explicit **Auto-sync** click, a local faster-whisper worker (free; no paid STT)
transcribes the uploaded reading with word timestamps and aligns it to the article's sentences,
upgrading Listen from paragraph-level tap sync to sentence-level highlight; the writer reviews and
can fall back to taps. Capabilities: `alignment-worker`, `alignment-jobs`,
`sentence-level-listen`. Introduces a second toolchain (Python 3.12 via `uv`) in `workers/align/`;
capability files and toolchain rules are written at the start of this phase.

Slices (planned): S6.1 `workers/align/` (uv project, faster-whisper `small.en`, CLI that reads a
job and writes word timings); S6.2 `align_job` table (migration owned here) + job runner +
`POST /api/admin/articles/:id/listen/auto-sync`; S6.3 sequence alignment of transcript words to
`Sentence[]` (`src/server/listen/align.ts`) + review UI; S6.4 reader sentence-level highlight;
S6.5 E2E with the committed audio fixture.

**Gate (exact):** `uv --directory workers/align run pytest -q && pnpm test:integration && pnpm build && pnpm test:e2e`.

**How the user tests it:** upload audio, click **Auto-sync**, wait for "Aligned 42/44 sentences",
review, publish; the reader's Listen view now highlights sentence by sentence.
