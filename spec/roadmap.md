# blog0 — Roadmap

## What

blog0 is smallTech's official blog (brand and wordmark **blog0** — the design's `log0` is
replaced everywhere, the spinning final "0" stays; user decision) — an AI-native, multi-format
publishing platform. Writers author articles in Markdown; every article is consumed by readers in
three formats through one mode capsule:

- **Read** — the Markdown rendered faithfully (headings, emphasis, lists, links, blockquotes,
  rules, syntax-highlighted code, tables, images, footnotes/Notes, interactive figures).
- **TLDR** — a full-viewport, auto-advancing slide deck of the article's most important lines,
  selected **verbatim** by **Jev** (the TLDR agent) and reviewed/edited by the writer.
- **Listen** — a writer-uploaded, word-for-word reading with the text following along (paragraph
  timing estimated from the recording's length and word counts; exact alignment is Phase 6).

Formats are an extensible set (more later), each with its own lifecycle status. The engine is
built tenant-ready (every record belongs to a site) so it can be open-sourced later; v0.1 runs a
single site (blog0 / smallTech).

The visual bar is the design reference in `spec/design/` (`design-app.js`, `design-app.css`) and
`spec/blog0-design-v0.1.html` — port it pixel-close; every deliberate divergence is listed in
`spec/architecture.md` → `## Design divergences (ask user)`.

## Who

| Persona | Count | Needs |
|---|---|---|
| Writer / admin (smallTech team) | a handful | Paste/edit Markdown with an immediate Read preview, get a TLDR deck with one click, hand-edit it, publish; upload audio (no manual syncing); see AI cost. |
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
   problem fails — see `spec/architecture.md` → `## Conventions` → Real-key tests. A separate
   designer-mode gate boots the app from a clean state with no Postgres and no `.env` values
   (embedded engine) and smokes home, one article and its deck.
7. A designer with only Node + pnpm runs `pnpm install && pnpm dev:design` and sees the full site
   (5 articles with decks) at `http://localhost:3410` with hot reload, nothing else installed or
   configured (`spec/capabilities/designer-mode.md`).

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
> **Decided (user):** seeded posts get their decks from the explicit `pnpm seed:tldr` (Jev once per post with a real key; the committed fixture `src/server/seed/decks/*.json` without one); the design's paraphrased TLDR arrays are never seeded.
> **Assumed:** `pnpm seed:tldr -- --write-fixture` (real key) keeps the committed fixture equal to real Jev output; a unit test validates the fixture against the seed articles.
> **Assumed:** Login and newsletter throttling are in-memory per process (single instance); Phase 5 moves them to Postgres.
> **Assumed:** Hand-edited decks allow 1–12 lines and reordering (Jev itself picks 4–8 in document order).
> **Assumed:** A published deck whose lines vanished from the text blocks publishing of new changes until fixed (the old deck keeps serving meanwhile); publishing without any deck is allowed.
> **Assumed:** Admins are all equal (no roles); approve-your-own-article is allowed in v0.1.
> **Decided (user, 2026-10-13):** manual tap-along sync is removed; Listen timing is estimated at read time; accurate alignment is deferred to Phase 6 (local, no paid tokens); Listen never blocks publishing. Phase 4 is **on hold**; revision history is removed from Phase 4 and deferred.
> **Assumed:** Listen estimate constants — 150 words/minute and a 0.6 s pause per paragraph (1.5 word-equivalents); the first paragraph starts at 0 (`spec/capabilities/listen-sync.md`).
> **Assumed:** Phases 5–6 are planned at lower fidelity; their capability files are written spec-first at the start of each phase.
> Further `Assumed:` items: stack (`spec/architecture.md` → `## Stack`), model slug (`spec/agent.md` §3), timezone and up-front schema (`spec/data.md`), and the open design divergences (`spec/architecture.md` → `## Design divergences (ask user)`).

## Phases of Development

Scaffold and Phases 1–3 (with the Phase 3 fix) are **done**; Phase 4 is **on hold**; Phases 5–6
are planned.

### Planning rules (Phase 4 onward)

- All commands run from the repo root `/Users/sai/Workspace/Code/blog0`.
- `.env` holds real values for every key in `.env.example` for the Postgres gates; designer mode
  is the one exception (no `.env`, `spec/architecture.md` §11).
- Integration + E2E tests use the Postgres database `blog0_test` (created and migrated by the test
  harness); the dev server uses `blog0_dev`. Gate builds may use `BLOG0_DIST_DIR=.next-gate` for
  both `pnpm build` and `pnpm test:e2e` so a running dev/start server is never disturbed.
- "Boot check" = start `pnpm start` with the terminal tool's **background mechanism** (never `&`,
  `nohup`, `setsid`, `disown`), then in a separate call run
  `curl -fsS http://localhost:3410/api/health` and expect `"db":"ok"`.
- Slices inside a phase own **disjoint files** (paths per `spec/architecture.md` → `## Layout`);
  a true dependency is named explicitly. A slice that edits a file it does not create says
  "takes over".
- `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` are edited only by the orchestrator,
  in one commit before the phase fans out; a slice that needs a new dependency reports it.
- A new E2E walk is a new Playwright project appended to the `tldr → reader → listen → smoke`
  dependency chain (`spec/architecture.md` → Test wiring).

### package.json scripts (exact names — the README and every gate use these)

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
| `db:seed` | `tsx scripts/db-seed.ts` |
| `db:seed:posts` | `tsx scripts/db-seed-posts.ts` |
| `seed:tldr` | `tsx scripts/seed-tldr.ts` (`pnpm seed:tldr -- --write-fixture`) |
| `admin:create` | `tsx scripts/create-admin.ts` |
| `check:openrouter` | `tsx scripts/check-openrouter.ts` |
| `eval:jev` | `tsx scripts/eval-jev.ts` |
| `spike:pglite` | `tsx scripts/spike-pglite.ts` |
| `dev:design` | `node scripts/dev-design.mjs` |
| `test:unit` | `vitest run --project unit` |
| `test:integration` | `vitest run --project integration` |
| `test` | `vitest run` |
| `test:e2e` | `playwright test` |
| `test:e2e:design` | `playwright test -c playwright.design.config.ts` |

`check:openrouter` prints only booleans/numbers, never the key: key present, `GET {base}/key`
valid, configured model (and the `spec/agent.md` §3 fallback list) listed on `GET {base}/models`,
and one real structured call (`response_format` json_schema `{ ok: boolean }`) → `structured
call: ok · tokens <n> · cost $<x|n/a> · <ms> ms`; exit 1 on any failure.

---

### Scaffold — minimal runnable skeleton + shared contracts

**Goal:** the Next.js app boots on port 3410, `/api/health` proves the DB is reachable, the full
v0.1 schema is migrated with a verify command, the test harness (unit, integration, E2E) runs,
and the OpenRouter key + Jev model slug are proven alive by one real call.

**Done** (commit `5b94402`).

**Final gate:**
```bash
pnpm install && pnpm exec playwright install chromium
pnpm db:create && pnpm db:migrate && pnpm db:verify     # "blog0_dev @ PostgreSQL 18.x — 1 applied (latest 0000_init), 0 pending: OK"
pnpm check:openrouter
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm test:e2e
# Boot check (background tool): pnpm start   then:   curl -fsS http://localhost:3410/api/health
```
Health body: `{"ok":true,"data":{"status":"ok","db":"ok","dbLatencyMs":<n>,"version":"0.1.0","uptimeSec":<n>,"dbEngine":"postgres"}}`.

**How the user tests it:** follow the README setup; open `http://localhost:3410/api/health`
(JSON with `"db":"ok"`).

---

### Phase 1 — TLDR end-to-end (the first win)

**Goal:** a writer signs in, pastes Markdown, sees the live Read preview, clicks **Generate** →
Jev picks lines (real OpenRouter call) with reasons, hand-edits the deck, publishes; the public
article page shows the Read view and the TLDR deck playing exactly like the design. Capabilities:
`admin-auth`, `article-authoring`, `jev-tldr`, `article-reading` (+ the computed-status part of
`format-lifecycle` and the recording part of `ai-cost-ledger`). Jev's full composition is a single
bounded call (`spec/agent.md`) — no agentic-upgrade phase is planned.

**Done** (commits `9f2b481`, `dd9c81c`).

**Final gate:**
```bash
pnpm db:migrate && pnpm db:verify && pnpm db:seed      # "site blog0 ok, admin <masked> ok"
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm test:integration                                   # real blog0_test + real OpenRouter (jev-openrouter, tldr-flow)
pnpm build && pnpm test:e2e                             # tldr walk: one real Generate; asserts api.request + llm.call log lines and the linked CSS
# Boot check (background tool): pnpm start   then:
curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:3410/admin/login   # 200
```

**How the user tests it:**
1. `pnpm db:seed`, then `pnpm build && pnpm start`, open `http://localhost:3410/admin` →
   sign-in page; sign in with `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD`.
2. **New article**: title, dek, topic; paste any smallTech post (e.g.
   `src/server/seed/posts/tech-company-first.md`). The preview renders it as readers will see it,
   including the two interactive figures.
3. **Save** (or Cmd/Ctrl+S) → "Saved · rev 1". **TLDR** tab → **Generate with Jev**: within
   ~5–20 s a deck of 4–8 lines appears, each with Jev's reason and a cost line.
4. Remove a line, add another from the article list, move one up, **Preview deck**, **Save deck**.
5. **Publish** → **View live**; click **TLDR** in the capsule: intro slide with "Lines selected by
   Jev (AI)…", auto-advance, arrows/scroll/swipe, end slide with Read + Share; the address is
   `/p/<slug>/tldr`; reload keeps the deck open; Esc closes it.
6. Change a sentence that is in the deck and Save: the TLDR chip turns **stale**; the live page
   still plays the old deck. Nothing regenerates by itself.
7. The only labelled stub left is the editor **History** tab.

---

### Phase 2 — Reader site + designer mode

**Goal:** the public site is complete and pixel-close to the design under the brand **blog0**:
boot strip, home (typed spinning-nought wordmark, print-in, About, Featured stack, Latest with See
More), Archive with topic filter, admin-editable About, newsletter signup, share for paragraph /
article / deck (LinkedIn, X, WhatsApp, Notes, Notion, Copy link; native sheet on touch), persisted
theme, OG tags, legacy hash-link redirects, TLDR deck from cards, the 5 design articles seeded with
decks, and **designer mode** (embedded PGlite; `pnpm install && pnpm dev:design`). Capabilities:
`reader-site`, `newsletter-signup`, `paragraph-share`, `designer-mode`.

**Done** (commit `1cb95c2`; PGlite spike verdict GO — `spec/spikes/pglite.md`).

**Final gate 1 — real Postgres:**
```bash
pnpm install
pnpm db:migrate && pnpm db:verify
pnpm db:seed && pnpm db:seed:posts        # "5 posts: 5 created" first run; re-run "5 posts: 0 created"
pnpm seed:tldr                            # real key: "decks: 5 seeded (5 calls, $0.0xxx)"; re-run: "decks: 0 seeded (0 calls)"
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm test:integration                     # incl. site-settings, newsletter, public-api, seed-posts, seed-tldr, designer-mode (pglite://memory), health
pnpm build && pnpm test:e2e               # tldr → reader → listen → smoke on 3411 (decks from the fixture)
# Boot check (background tool): pnpm start   then:
curl -fsS http://localhost:3410/api/health                                   # "dbEngine":"postgres"
curl -fsS http://localhost:3410/ | grep -c "Featured Editorial"              # >= 1
curl -fsS http://localhost:3410/ | grep -ow "log0" | wc -l                   # 0
curl -fsS http://localhost:3410/p/humans-are-software/tldr | grep -c "tdeck" # >= 1
```

**Final gate 2 — designer mode, clean state, no Postgres, no `.env` values:**
```bash
rm -rf var/pglite var/storage var/pglite-e2e var/storage-design-e2e var/pglite-e2e.designer-admin.txt var/pglite-session-secret var/designer-admin.txt
pnpm test:e2e:design                      # playwright.design.config.ts (spec/architecture.md → Test wiring)
env -u BLOG0_DATABASE_URL -u BLOG0_SESSION_SECRET -u BLOG0_OPENROUTER_API_KEY pnpm dev:design   # background tool; prints the designer admin ONCE, then the dev server on 3410
curl -fsS http://localhost:3410/api/health                                   # "dbEngine":"pglite"
curl -fsS http://localhost:3410/p/humans-are-software | grep -c "readhead"   # >= 1
# re-run dev:design → "5 posts: 0 created", "decks: 0 seeded (0 calls)", no new password
BLOG0_DATABASE_URL=pglite://./var/pglite pnpm db:verify                      # "… PostgreSQL 17.x (PGlite) … 0 pending: OK"
```

**The designer one-liner (README):** `pnpm install && pnpm dev:design` → `http://localhost:3410`
with the 5 articles + decks; admin at `/admin` (credentials printed once, kept in
`var/designer-admin.txt`). Start over: `rm -rf var/pglite var/storage var/pglite-session-secret var/designer-admin.txt`.

**How the user tests it:**
1. *Designer path* (Node + pnpm only): `pnpm install && pnpm dev:design`, open
   `http://localhost:3410/`. The strip types `> start of blog0`, the wordmark **blog0** types in
   and its nought spins, the page prints in. **Archive** → `> ls archive`; open a card →
   `> open <slug>`. Every article has a working TLDR deck. Sign in at `/admin/login` with the
   printed credentials; the TLDR tab shows "No OpenRouter key configured" (add a key to `.env` and
   restart to see Jev work). Edit a component file → the browser updates without a restart.
2. *Full path* (Postgres + `.env`): `pnpm db:seed && pnpm db:seed:posts && pnpm seed:tldr`, then
   `pnpm build && pnpm start`. Home: About, Featured stack (3 featured posts pile as you scroll),
   Latest with See More / View all; a card's **TLDR** opens the deck over the list. Archive groups
   by month and filters by topic. Click a paragraph → it highlights, the passage + link is copied,
   the menu offers LinkedIn, X, WhatsApp, Notes, Notion, Copy link; the copied link scrolls to
   and highlights that paragraph. On a phone (or device emulation) the native share sheet opens
   instead. **Share article** and the deck's last-slide **Share** open the same menu. Dark mode
   persists across reloads. Subscribe in the footer → "You're in. First issue lands Thursday.";
   the address appears in **Admin → Subscribers** (Export CSV). Edit About in **Admin → Site** →
   home and `/about` change. View source → `<title>… — blog0</title>` and OG tags. `/#<id>/tldr`
   lands on `/p/<id>/tldr`. Footer: no RSS; X/LinkedIn only once their URLs are set.

---

### Phase 3 — Listen + media (with the Phase 3 fix)

**Goal:** writers upload a word-for-word reading (mp3/m4a ≤ 50 MB / ≤ 30 min) and inline images;
files live on local disk behind a storage interface and stream with HTTP range requests; readers
get a Listen view with player + text side by side, the current paragraph softly highlighted on
**estimated** timing, auto-follow with **Follow audio**, click-to-seek; upload ⇒ `ready`, a
paragraph edit after upload shows a non-blocking `text_changed` warning, Listen never blocks
publish. Capabilities: `listen-audio`, `listen-sync`, `media-images`.

**Done** (commits `69d9986` Phase 3; `31de614` fix — tap-along removed, estimated timing).

**Final gate:**
```bash
pnpm db:migrate && pnpm db:verify         # no new migration; "0 pending"
pnpm typecheck && pnpm lint
pnpm test:unit                            # incl. listen/estimate, listen/marks, listen/probe, formats/listen-status, media/range, media/storage-key, admin/insert-image, reader/listen-view
pnpm test:integration                     # media (200/206/304/416, traversal 404, SVG 415), audio-ingest, listen-sync, public-listen, public-queries, public-api — real files under var/storage-test
pnpm build && pnpm test:e2e               # listen walk: upload → chip ready, publish (no block), highlight follows currentTime, wheel pauses follow, Follow audio resumes, click seeks, card overlay, /media 206, image upload
! grep -rnE "needs_sync|LISTEN_STALE|useTapSync|SyncPanel|MarkList|tapbtn|marklist|nudgeMark|listenDiff" src tests
# Boot check (background tool): pnpm start   then:
curl -fsS -o /dev/null -w "%{http_code}\n" "http://localhost:3410/media/..%2F..%2Fetc%2Fpasswd"   # 404
```

**How the user tests it:** in the editor's **Listen** tab upload an mp3/m4a (drop or choose; a
renamed text file is refused with the reason) → the chip reads **Ready** at once; the tab shows
the preview player and the note that readers get estimated timing. **Publish**. On the article
choose **Listen** ("Listen · N min"): press play — the text beside the player scrolls along with a
soft highlight on the current paragraph; scroll yourself → following stops and **Follow audio**
appears; click it → the text jumps back and follows again; click a paragraph → the audio jumps
there; Space / ← / → work; the address is `/p/<slug>/listen` and survives a reload. On a home
card, **Listen** opens the compact player overlay. Back in the editor, change one paragraph's
wording and save → the chip shows **text changed** and the tab warns "The recording may no longer
match the text"; **Publish changes** still works. In the Write tab, **Image** (or drop a PNG on the
textarea), type alt text → `![alt](/media/…)` is inserted at the cursor and renders in the
preview; an SVG is refused. Remaining labelled stub: the History tab (revision history deferred).

---

### Phase 4 — Editorial standards — **ON HOLD**

> **On hold (user decision, 2026-10-13).** Do not start Phase 4 until the user re-opens it. It
> resumes **without revision history** (`spec/capabilities/revision-history.md` is deferred:
> revisions keep being recorded on every save; the History tab stays a labelled stub).

**Goal (when resumed):** public "Published <date> · Updated <date>" and an optional dated
corrections note; TLDR stale detection with an explicit **Regenerate** offer (published content
keeps serving); editor sign-off states (Submit for review / Approve — self-publish still allowed);
AI cost dashboard (per generation and site-wide month-to-date); a small Team page (add admin,
change own password). Capabilities: `publication-record`, `format-lifecycle`, `ai-cost-ledger`
(team accounts are part of `admin-auth`).

| Slice | Owns | Depends on |
|---|---|---|
| **S4.1 Publication record + sign-off** | `src/server/articles/workflow.ts`, `src/app/api/admin/articles/[id]/{submit,approve,corrections}/route.ts`, `src/components/admin/editor/PublishBar.tsx` (takes over), `src/components/reader/ReadHead.tsx` + `ArticleFoot.tsx` (take over: dates, corrections), `src/server/public/articles.ts` (takes over: `updatedLabel`, `correctionsHtml`), `tests/integration/workflow.test.ts` | — |
| **S4.2 Format lifecycle** | `src/server/formats/status.ts` (new), `src/components/admin/FormatChips.tsx` (takes over), `src/components/admin/editor/StaleBanner.tsx`, `src/components/admin/editor/TldrTab.tsx` (takes over: Regenerate offer), `tests/integration/format-lifecycle.test.ts` | — |
| **S4.3 AI cost ledger** | `src/server/ai-usage/**`, `src/app/api/admin/ai-usage/route.ts`, `src/app/admin/(authed)/ai-usage/page.tsx`, `src/components/admin/ai-usage/**`, `src/components/admin/DeskHeader.tsx` (takes over: month-to-date total), `tests/integration/ai-usage.test.ts` | — |
| **S4.4 Team accounts** | `src/app/admin/(authed)/team/page.tsx`, `src/components/admin/team/**`, `src/app/api/admin/users/**`, `src/app/api/auth/password/route.ts`, `tests/integration/team.test.ts` | — |
| **S4.5 Editorial E2E** | `tests/e2e/editorial.spec.ts`, `playwright.config.ts` (takes over: `editorial` project after `smoke`) | S4.1–S4.4 |

> **Assumed:** the editorial walk is a fifth Playwright project depending on `smoke` (so it runs
> last on the shared `blog0_test`), and S4.5 is the only slice that edits `playwright.config.ts`.

**Gate (exact):**
```bash
pnpm db:migrate && pnpm db:verify
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm test:e2e              # editorial: edit → stale chip → Regenerate (real call) → publish → "Updated" shows; corrections note visible; cost page total equals the sum of generation rows
# Boot check (background tool): pnpm start   then:   curl -fsS http://localhost:3410/api/health
```

**How the user tests it (when resumed):** change a deck sentence → TLDR chip **stale**, banner
offers **Regenerate** (nothing happens until clicked); the live page still serves the published
deck. **Publish changes** on another day → the article shows "Published 8 Sep 2026 · Updated
12 Oct 2026". Add a corrections note → it appears dated at the article foot. **Submit for review**
/ **Approve** states show on the desk. **AI usage** lists each generation (model, prompt version,
tokens, $, who, when) and the month-to-date total, also on the desk header. **Team** → add a
second admin; sign in as them; their saves show their name on the desk.

---

### Phase 5 — Production hardening (deploy-ready)

**Goal:** a 12-factor container that runs anywhere: Dockerfile (multi-stage, Next standalone,
non-root, migrations as a release step), production config validation (HTTPS cookie, required
secrets), security headers + CSP, persistent rate limits on login and newsletter, graceful
shutdown, liveness vs readiness endpoints, backup/restore scripts (Postgres dump + storage dir),
and a deploy runbook. Capabilities: `container-image`, `backup-restore`, `abuse-protection`
(capability files written at the start of this phase).

Slices (planned): S5.1 Dockerfile + `.dockerignore` + `scripts/release.ts`, adds
`output: 'standalone'` to `next.config.ts` (the container runs `node .next/standalone/server.js`);
S5.2 backups (`scripts/backup.ts`, `scripts/restore.ts`, docs); S5.3 security headers/CSP in
`next.config.ts` (after S5.1's edit lands) + DB-backed rate limits behind the
`FixedWindowCounter` call sites (migration owned by this slice); S5.4 readiness/liveness +
graceful shutdown (`src/app/api/health/{live,ready}/route.ts`); S5.5 E2E against the container.

**Gate (exact):**
```bash
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
transcribes the uploaded reading with word timestamps and aligns it to the article's paragraphs
and sentences — the path to exact timings. The aligner writes paragraph marks through the
existing aligner-facing `PUT /api/admin/articles/:id/listen` (`ListenPayload.marks`; sentence
marks as an optional `sentenceMarks` beside them), so `resolveMarks` serves them as `synced` with
no reader change; then the highlight goes sentence-level; the writer reviews. Stored marks are
all-or-nothing (PUT requires a complete set), so a run that misses paragraphs must fill the gaps
(e.g. interpolate between aligned neighbours) or leave the estimate — decided in Phase 6's
capability spec. Capabilities: `alignment-worker`, `alignment-jobs`, `sentence-level-listen`.
Introduces a second toolchain (Python 3.12 via `uv`) in `workers/align/`.

Slices (planned): S6.1 `workers/align/` (uv project, faster-whisper `small.en`, CLI that reads a
job and writes word timings); S6.2 `align_job` table (migration owned here) + job runner +
`POST /api/admin/articles/:id/listen/auto-sync`; S6.3 sequence alignment of transcript words to
`Paragraph[]` / `Sentence[]` (`src/server/listen/align.ts`, writing through `saveMarks`) + review
UI; S6.4 reader sentence-level highlight; S6.5 E2E with the committed audio fixture.

**Gate (exact):** `uv --directory workers/align run pytest -q && pnpm test:integration && pnpm build && pnpm test:e2e`.

**How the user tests it:** upload audio, click **Auto-sync**, wait for "Aligned 42/44 sentences",
review, publish; the reader's Listen view now highlights sentence by sentence.
