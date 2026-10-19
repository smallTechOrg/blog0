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
  timing estimated from the recording's length and word counts; exact alignment is frozen — not
  scheduled).

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
   byte-identical to a sentence of the saved article, in under 60 s, with model / prompt version /
   tokens / $ cost / who / when recorded. Phase 8: the lines are the top-ranked of a relevance
   score Jev (`typesafe/jev-1.13`) gives **every** sentence; the editor shows each score
   ("relevance 0.82") instead of a reason.
3. The published article page renders Read and plays the TLDR deck exactly like the design
   (intro slide, dwell by word count, type scaled by length, progress segments, wheel/touch/keys,
   end slide with Read + Share, deep link `/p/<slug>/tldr`).
4. No reader request ever triggers an LLM call (verified by the cost ledger staying flat across
   the E2E reader walk).
5. Editing text after a deck exists never auto-regenerates; the deck shows **stale** and the
   published deck keeps serving until the writer acts.
6. Every gate runs against real Postgres and the real OpenRouter key from `.env`. Without a key,
   real-key tests skip as `PENDING KEY` (never a pass); when a real key is required
   (`BLOG0_REQUIRE_REAL_KEY=1`, or `CI=true` when that is unset) or a real key is present, a key
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
source-agnostic so they plug in without schema change), newsletter A/B tests, scheduled sends,
in-app open/click tracking and admin-editable email templates (Phase 7 ships owned list +
issues via Listmonk; see `spec/capabilities/newsletter-issues.md` → Out of scope),
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
> **Assumed:** Login and newsletter throttling are in-memory per process (single instance) before Phase 5; Phase 5 counts them in Postgres (`spec/capabilities/abuse-protection.md`; in-memory remains for designer mode and tests).
> **Assumed:** Hand-edited decks allow 1–12 lines and reordering (Jev itself picks 4–8 in document order).
> **Assumed:** A published deck whose lines vanished from the text blocks publishing of new changes until fixed (the old deck keeps serving meanwhile); publishing without any deck is allowed.
> **Assumed:** Admins are all equal (no roles); approve-your-own-article is allowed in v0.1.
> **Decided (user, 2026-10-13):** manual tap-along sync is removed; Listen timing is estimated at read time; accurate alignment is deferred to Phase 6 (local, no paid tokens); Listen never blocks publishing. Phase 4 is **on hold**; revision history is removed from Phase 4 and deferred. (Superseded by the freeze: Phase 4, Phase 6 and revision history are Frozen — not scheduled.)
> **Assumed:** Listen estimate constants — 150 words/minute and a 0.6 s pause per paragraph (1.5 word-equivalents); the first paragraph starts at 0 (`spec/capabilities/listen-sync.md`).
> **Decided (user, 2026-10-13):** Phase 8 (Jev ranking) was the last development; the project is **frozen** — no further phases or feature work (`## Phases of Development` → Frozen — not scheduled).
> **Decided (user, 2026-10-13):** Phase 7 — Newsletter: blog0 owns the list (double opt-in, proof of consent, append-only suppression); Listmonk sends; it is built before Phase 6. Everything else about it is `Assumed:` in `spec/capabilities/newsletter-{list,issues}.md` and `spec/architecture.md` §12.6/§13.
> **Decided (user, 2026-10-13):** "Jev" is the OpenRouter decisions model `typesafe/jev-1.13`; Jev ranks all sentences by relevance and the top ones form the TLDR deck (Phase 8); reasons are removed; the reader disclosure copy stays.
> Further `Assumed:` items: stack (`spec/architecture.md` → `## Stack`), model call shape (`spec/agent.md` §3), timezone and up-front schema (`spec/data.md`), and the open design divergences (`spec/architecture.md` → `## Design divergences (ask user)`).

## Phases of Development

**Status: Frozen — development complete (Scaffold, Phases 1–3, 5, 7, 8 done).** No further
phases or feature work (user decision). The sections below are the record of what was built and
the gates that proved it; Phases 4 and 6 and every other unbuilt item are listed under
**Frozen — not scheduled** at the end. Anywhere else in `spec/` that says "Phase 4", "Phase 6",
"on hold" or "deferred" for unbuilt work means **Frozen — not scheduled**. The open design
divergences (`spec/architecture.md` → `## Design divergences (ask user)` → Open) remain open user
decisions with their defaults in force — they are decisions, not features.

### Planning rules (as used by the built phases)

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
| `release` | `tsx scripts/release.ts` (Phase 5: migrate + verify + seed site/admin) |
| `build:release` | `node scripts/build-release.mjs` (Phase 5: `dist/release.mjs` for the image) |
| `backup` | `tsx scripts/backup.ts` (`pnpm backup -- --out <dir>`) |
| `restore` | `tsx scripts/restore.ts` (`pnpm restore -- --in <dir> --db <name> --storage <dir> [--force] [--check-only]`) |
| `test:container` | `bash scripts/container-e2e.sh` (exit 3 = `PENDING DOCKER`) |
| `newsletter:sync` | `tsx scripts/newsletter-sync.ts` (Phase 7: blog0 → Listmonk, idempotent; `-- --create-list` creates the list named `blog0` and prints its id) |
| `newsletter:tick` | `tsx scripts/newsletter-tick.ts` (Phase 7: digest-due check, pull provider suppressions, refresh stats, prune IPs; run hourly by cron in production) |
| `listmonk:up` | `bash scripts/listmonk-dev.sh up` (Phase 7: compose `postgres` + `listmonk`, ensures the API user + test list, writes `var/listmonk-dev.env`; exit 3 = `PENDING DOCKER`) |
| `listmonk:down` | `bash scripts/listmonk-dev.sh down` |
| `listmonk:reset` | `bash scripts/listmonk-dev.sh reset` (fresh `listmonk` database) |

`check:openrouter` prints only booleans/numbers, never the key. Phase 8 (decisions models are not
in the `/models` catalog, and there is no fallback chain): `key present: true`, `key valid: true`
(`GET {BLOG0_OPENROUTER_BASE_URL}/key`), then **one real 1-question decisions call** to
`BLOG0_OPENROUTER_DECISIONS_URL` with `BLOG0_JEV_MODEL` — `state: { title: 'check', dek: '',
article: 'The sky is blue. Grass is green.' }`, question `check` `{ type: 'noul', instructions:
'Is this sentence about colour? Sentence: "The sky is blue."', criteria: { true: 'It names a
colour.', false: 'It does not name a colour.' } }` — and asserts `answers.check.type === 'noul'`
with a number in [0,1] → `decisions call: ok · model <slug> · noul <0.xx> · tokens <in>/<out> ·
cost $<x|n/a> · <ms> ms`. A 400/404 prints "BLOG0_JEV_MODEL=<slug> is not an available decisions
model — the default is typesafe/jev-1.13". Exit 1 on any failure.

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
Jev picks lines (real OpenRouter call) with reasons (Phase 8 replaced reasons with relevance scores), hand-edits the deck, publishes; the public
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
   ~5–20 s a deck of 4–8 lines appears, each with Jev's reason and a cost line (Phase 8 replaced reasons with relevance scores).
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
preview; an SVG is refused. Remaining labelled stub: the History tab (revision history — Frozen,
not scheduled).

---

### Phase 4 — Editorial standards — **Frozen — not scheduled**

Never built (on hold, then frozen). Its items are listed under **Frozen — not scheduled** below;
the up-front schema columns for them exist unused (`spec/data.md`).

---

### Phase 5 — Production hardening (deploy-ready, target-agnostic)

**Done** (commits 51aad2f, e72ed9d, 7923781 + a follow-up drift-fix commit). Container E2E passed
locally (`pnpm test:container` 51/51 with the real key); the CI workflow ran on GitHub (`check`,
`e2e`, `image` jobs green; `integration` fixed in the follow-up commit).

**Goal:** one non-root container image that runs on any platform: the web server plus a separate
release step (migrate + verify + seed site/admin), liveness vs readiness probes, graceful
shutdown, uploads on a volume; login/newsletter caps counted in Postgres (survive restarts, shared
across instances); nonce CSP + security headers; snapshot-consistent backup/restore with a
count check; GitHub Actions CI; a deploy runbook. Capabilities: `container-image`,
`backup-restore`, `abuse-protection` (`spec/capabilities/`). HOW: `spec/architecture.md` §6, §10,
§12. No user-visible feature changes; no deploy target is chosen (no deploy job).

**Before fan-out (orchestrator, one commit):** `package.json` scripts `release`,
`build:release`, `backup`, `restore`, `test:container` (table above) + devDependency `esbuild`
pinned to the version tsx already resolves in `pnpm-lock.yaml` (no new runtime dependency);
`pnpm install` to refresh the lockfile.

**Slices** — at most **2 code-generators run concurrently**, in three waves. Within a wave the
two slices own disjoint files; "takes over" = edits an existing file; a later wave may take over a
file an earlier wave touched.

| Wave | Slice | Owns (exclusive within its wave) | Depends on |
|---|---|---|---|
| 1 | **S5.1 Container image + release step** (`container-image`) | `Dockerfile`, `.dockerignore`, `.gitignore` (takes over: `dist/`), `next.config.ts` (takes over: `output` when `BLOG0_STANDALONE=1`, static security `headers()` — exact values §6), `scripts/release.ts`, `scripts/build-release.mjs`, `scripts/lib/empty-module.mjs`, `src/server/ops/release.ts`, `tests/integration/release.test.ts` | — |
| 1 | **S5.3 Abuse protection** (`abuse-protection`) | `src/server/db/schema.ts` (takes over: `rateLimitBucket`, `ALL_TABLE_NAMES`), `src/server/db/migrations/0001_rate_limit_bucket.sql` + `meta/_journal.json` + `meta/0001_snapshot.json` (generated: `pnpm db:generate --name rate_limit_bucket`), `src/server/rate-window.ts` (takes over), `src/server/rate-window-store.ts`, `src/server/auth/{rate-limit,login}.ts` (take over), `src/server/newsletter/rate-limit.ts` + `src/app/api/newsletter/route.ts` (take over), `src/server/config.ts` (takes over: `rateLimitStore`), `.env.example` (takes over: `BLOG0_RATE_LIMIT_STORE`), `tests/setup/integration-env.ts` (takes over: `memory`), `src/lib/http/csp.ts`, `src/proxy.ts` (takes over), `src/app/layout.tsx` (takes over: async + nonce), `tests/unit/http/csp.test.ts`, `tests/unit/proxy.test.ts` (takes over), `tests/unit/auth/rate-limit.test.ts` (takes over: async API on `MemoryRateLimitStore`), `tests/integration/rate-limit-db.test.ts`, `tests/integration/{auth,newsletter}.test.ts` (take over: `await` the new API only) | — |
| 2 | **S5.4 Probes + graceful shutdown** (`container-image`) | `src/app/api/health/live/route.ts`, `src/app/api/health/ready/route.ts`, `src/server/ops/{readiness,lifecycle}.ts`, `src/instrumentation.ts` (takes over), `scripts/serve.mjs` (takes over), `src/server/http/api.ts` (takes over: `logLevel`), `src/lib/api/dto.ts` (takes over: health section), `src/server/config.ts` + `.env.example` (take over: `BLOG0_SHUTDOWN_TIMEOUT_MS`), `tests/integration/health-probes.test.ts`, `tests/unit/ops/lifecycle.test.ts` | S5.3 (sequential edits of `config.ts` / `.env.example`) |
| 2 | **S5.2 Backup + restore** (`backup-restore`) | `src/server/ops/{pg-tools,backup-manifest,backup,restore}.ts`, `scripts/backup.ts`, `scripts/restore.ts`, `tests/unit/ops/backup-manifest.test.ts`, `tests/integration/backup-restore.test.ts` | S5.3 (`rate_limit_bucket` in `ALL_TABLE_NAMES`) |
| 3 | **S5.5 Container E2E + runbook** (`container-image`) | `scripts/container-e2e.sh`, `scripts/lib/container-env.mjs`, `tests/e2e/global-setup.ts` (takes over: empty `var/storage-e2e`, never remove it), `tests/e2e/helpers/logs.ts` (takes over: `BLOG0_E2E_LOG_FILE`), `tests/e2e/smoke.spec.ts` (takes over: header + CSP-console assertions, log-test skip rule, boot port), `tests/e2e/tldr.spec.ts` (takes over: log-test skip rule only), `docs/deploy.md`, `README.md` (takes over: Deploy section), `.env.example` (takes over: `BLOG0_E2E_LOG_FILE`, `BLOG0_REQUIRE_REAL_KEY`) | S5.1–S5.4 |
| 3 | **S5.6 CI + real-key switch** | `.github/workflows/ci.yml`, `src/server/llm/key.ts` (takes over: `realKeyRequired`), `tests/helpers/env.ts`, `tests/e2e/helpers/jev-key.ts`, `scripts/eval-jev.ts`, `tests/integration/{jev-openrouter,tldr-flow,seed-tldr,designer-mode}.test.ts` (take over: replace `process.env.CI` checks with `realKeyRequired` only), `tests/unit/helpers/env-helper.test.ts` (takes over), `tests/unit/llm/key.test.ts` | S5.1–S5.4 (CI runs their tests and builds the image) |

Slice notes (rules live in the capability files and architecture; these are only the hand-offs):
- S5.1's `docker build` self-check needs S5.4's `/api/health/live` for the `HEALTHCHECK` to pass;
  in wave 1 S5.1 verifies only `docker build`, `id -u` = 1000, the file checks and
  `docker run … node release.mjs` against `blog0_test` (`PENDING DOCKER` when Colima is down).
- S5.3 keeps every existing login/newsletter behaviour test green on the memory store, and proves
  the DB store in `rate-limit-db.test.ts` (opt-in via `resetRateLimitStoreForTests(new DbRateLimitStore())`).
- S5.4's lifecycle unit test injects `exit`, `closeDb`, timers; the real signal path is proven by
  S5.5 step 10 and the boot check below.
- `release.test.ts` (S5.1) and `backup-restore.test.ts` (S5.2) work in their own databases —
  `BLOG0_TEST_DATABASE_URL` with the name suffixed `_release` / `_restore`, created with
  `ensurePostgresDatabase` and dropped-schema'd by the test itself — and never drop `blog0_test`'s
  schema (other integration files share it).
- S5.2's integration test needs `pg_dump`/`pg_restore` 18 on `PATH` (Homebrew `postgresql@18`
  locally, PGDG `postgresql-client-18` in CI); it is not skipped when they are missing — it fails
  with the install hint.

> **Assumed:** three waves of two (S5.1‖S5.3, S5.4‖S5.2, S5.5‖S5.6) — the pairs are disjoint and
> the only shared files (`config.ts`, `.env.example`, `next.config.ts`) are edited in different
> waves; S5.3 owns the only migration.
> **Assumed:** `pnpm start` stays `node scripts/serve.mjs start` → `next start`; standalone output is
> produced only by the image build (`BLOG0_STANDALONE=1`), so the local run command never prints
> the standalone warning and the existing E2E path (`pnpm start` on 3411) is untouched.

**Gate (exact)** — `.env` as in the planning rules; Colima running for the container step:
```bash
pnpm install --frozen-lockfile
pnpm db:migrate && pnpm db:verify            # "blog0_dev @ PostgreSQL 18.x — 2 applied (latest 0001_rate_limit_bucket), 0 pending: OK"
pnpm release                                 # "release: blog0_dev @ PostgreSQL 18.x — 2 applied (latest 0001_rate_limit_bucket), 0 pending: OK" then "site blog0 ok, admin <masked> ok"
pnpm typecheck && pnpm lint && pnpm test:unit
pnpm test:integration                        # + rate-limit-db, release, health-probes, backup-restore — real blog0_test + real OpenRouter (PENDING KEY rule)
BLOG0_DIST_DIR=.next-gate pnpm build && BLOG0_DIST_DIR=.next-gate pnpm test:e2e      # production server: CSP enforced, 0 CSP console messages, security headers
test ! -e .next-gate/standalone              # local builds are not standalone
pnpm test:e2e:design                         # designer mode unaffected (no CSP/HSTS in dev)
pnpm test:container                          # exit 0 → "container-e2e: PASS"; exit 3 → report "PENDING DOCKER" (never a pass); anything else → fail
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color   # CI syntax; no Docker → "PENDING DOCKER"
pnpm backup -- --out var/backups             # last line = the backup dir
pnpm restore -- --in "$(ls -td var/backups/blog0-* | head -1)" --db blog0_restore_check --storage var/restore-check/storage --force   # "restore-check: OK (…)"
BLOG0_DATABASE_URL=postgres://sai@localhost:5432/blog0_restore_check pnpm db:verify   # "… 2 applied (latest 0001_rate_limit_bucket), 0 pending: OK"
# Boot check (background tool): pnpm start   then:
curl -fsS http://localhost:3410/api/health/live      # "status":"live"
curl -fsS http://localhost:3410/api/health/ready     # "status":"ready" … "pending":0
curl -fsS http://localhost:3410/api/health           # unchanged body, "db":"ok"
curl -sI http://localhost:3410/ | grep -ci "content-security-policy: default-src 'self'; script-src 'self' 'nonce-"   # 1
# stop that background server with SIGTERM → its output has app.shutdown "phase":"closed","outcome":"drained" and it exits within 10 s
```
The CI workflow itself is proven by its first run on push (`gh run watch`); until the branch is
pushed that line is reported `PENDING CI`, never as passed.

**How the user tests it:**
1. `colima start`, then `pnpm test:container` → ends with `container-e2e: PASS` (builds
   `blog0:local`, runs the release step, starts the container on 3412, runs the whole E2E suite
   against it, stops it gracefully).
2. Follow `docs/deploy.md` → First deploy with your `.env` values against a scratch database:
   release step, `docker run -p 3412:3410 -v $PWD/var/storage-deploy:/data/storage …`; open
   `http://localhost:3412/`, sign in, upload an image in an article — the file appears under
   `var/storage-deploy/`. `curl localhost:3412/api/health/ready` → ready; `docker stop` → stops in
   a couple of seconds with an `app.shutdown … drained` log line.
3. Type a wrong password 6 times → "Too many attempts…"; restart the container → still locked
   (the count lives in Postgres).
4. View source / devtools on any page: `Content-Security-Policy` with a nonce, no console
   violations, dark mode still applied before paint.
5. `pnpm backup -- --out var/backups`, then `pnpm restore -- --in <printed dir> --db
   blog0_restore_check --storage var/restore-check/storage` → `restore-check: OK`.
6. Push the branch: the **ci** workflow runs check, integration, e2e and image jobs; without an
   `OPENROUTER_API_KEY` secret the real-key tests skip with a visible `PENDING KEY` warning; with
   it they run and must pass.

---

### Phase 6 — Automatic alignment (local Whisper) — **Frozen — not scheduled**

Never built. Listed under **Frozen — not scheduled** below.

---

### Phase 7 — Newsletter ("own the list, Listmonk sends")

**Goal:** blog0 owns the subscriber list with proof of consent — footer signup → confirmation
email → click → `confirmed`; every subscriber carries signup/confirmation timestamps, IP, user
agent, source page, the consent text + version shown, an append-only event timeline and an
append-only suppression ledger; existing Phase 2 subscribers become `legacy_unconfirmed` and get
one confirmation email only on an admin click. Issues are built from published posts (per post /
digest / manual, never auto-sent unless the setting says so), previewed as HTML + text, tested to
the admin, and sent with one click through a sender adapter — Listmonk over REST in production
(its own database in the same Postgres instance, `docker-compose.yml`), a recording stub in
designer mode and tests. Capabilities: `newsletter-list`, `newsletter-issues` (supersede
`newsletter-signup`). HOW: `spec/architecture.md` §6 (link caps), §7 (events), §10 (env), §12.6
(compose), §13 (list, mail, sender, issues); tables `spec/data.md` (`0002_newsletter`, `0003_newsletter_prune_fix`); HTTP
`spec/api.md` → newsletter; screens `spec/ui.md` §3 (form, link pages) and §4 (Site → Newsletter,
Subscribers, Subscriber, Newsletter issues). `spec/agent.md` §1: no AI in this phase (two
opportunities considered and rejected). Built **before Phase 6** (user decision).

**Before fan-out (orchestrator, one commit `phase-7: deps, scripts, config rows`):**
- `package.json`: dependency `nodemailer` (latest 7.x, exact pin), devDependency
  `@types/nodemailer` (matching major); scripts `newsletter:sync`, `newsletter:tick`,
  `listmonk:up`, `listmonk:down`, `listmonk:reset` (table above); `pnpm install` to refresh the
  lockfile. Nothing else new (Listmonk is reached with `fetch`; Markdown intro uses the existing
  pipeline).
- `next.config.ts`: `serverExternalPackages` gains `'nodemailer'`.
- `src/server/config.ts` + `.env.example`: **every** Phase 7 variable of `spec/architecture.md`
  §10 (`BLOG0_SMTP_HOST/PORT/USER/PASS/FROM`, `BLOG0_NEWSLETTER_SENDER`, `BLOG0_LISTMONK_URL/API_USER/API_TOKEN/LIST_ID`,
  `BLOG0_NEWSLETTER_WEBHOOK_SECRET`) as the typed `config.newsletter = { smtp: {…} | null, sender: 'listmonk' | 'stub', listmonk: {…} | null, webhookSecret: string | null }`
  with the validation rules of §10 (aggregated `ConfigError`, secret redaction, placeholder
  rejection) and unit tests in `tests/unit/config.test.ts` (takes over) — behaviour-free, so no
  slice touches `config.ts` / `.env.example` / `next.config.ts` / `package.json` afterwards.
- Verify the Listmonk image tag of §12.6 exists (`docker manifest inspect listmonk/listmonk:v5.1.0`
  or the registry page); pin the newest v5 patch if not, updating §12.6.
- `git rm spec/capabilities/newsletter-signup.md` (tombstone) in the same commit.

**Slices** — at most **2 code-generators run concurrently**, three waves. Within a wave the two
slices own disjoint files; "takes over" = edits an existing file; a later wave may take over a
file an earlier wave touched. `src/lib/api/dto.ts` is edited **only** by S7.1 (it writes the whole
`newsletter` section of `spec/api.md` up front, so S7.3/S7.4 only import). The schema + migration
are owned **only** by S7.1 (all Phase 7 tables and columns, including the issue tables and the
`site` settings columns, so S7.3 needs no migration).

| Wave | Slice | Owns (exclusive within its wave) | Depends on |
|---|---|---|---|
| 1 | **S7.1 Owned list** (`newsletter-list`) | `src/server/db/schema.ts` (takes over: widened `newsletterSubscriber`, new `newsletterSubscriberEvent`, `newsletterSuppression`, `newsletterMessage`, `newsletterIssue`, `newsletterIssueEvent`, `site` newsletter columns, `ALL_TABLE_NAMES`), `src/server/db/migrations/0002_newsletter.sql` + `meta/_journal.json` + `meta/0002_snapshot.json` (generated with `pnpm db:generate --name newsletter`, then hand-appended: the ledger-guard trigger, `newsletter_prune_event_ips`, the legacy backfill — Drizzle generates DDL only), `src/lib/api/dto.ts` (takes over: the whole `newsletter` section incl. `SiteSettingsDto.newsletter`), `src/server/newsletter/{constants,tokens,schemas,repo,service,links,legacy,prune,audit,settings}.ts` (`service.ts`, `rate-limit.ts` take over), `src/server/newsletter/mail/{transport,templates,index}.ts`, `src/server/newsletter/sender-hook.ts` (new: the no-op `afterConfirm`/`afterSuppress` hook that S7.3 wires to `sync.ts` in wave 2 — S7.1 never imports from `sender/`, which is S7.2's), `src/app/api/newsletter/route.ts` (takes over), `src/app/api/newsletter/{confirm,unsubscribe}/route.ts`, `src/app/(site)/newsletter/{confirm,unsubscribe}/page.tsx`, `src/app/api/admin/subscribers/route.ts` (takes over), `src/app/api/admin/subscribers/[id]/{route.ts, send-confirmation/route.ts, unsubscribe/route.ts}`, `src/app/api/admin/subscribers/send-legacy-confirmations/route.ts`, `src/server/site/service.ts` + `src/server/site/defaults.ts` + `src/server/seed/site.ts` (take over: newsletter columns in the site DTO/seed), `src/lib/view-models.ts` + `src/server/public/page-data.ts` (take over: `newsletterConsentText`), `src/components/site/NewsletterForm.tsx` (takes over: consent line, `sourceUrl`, new success copy), `src/components/site/Footer.tsx` (takes over: passes the consent text), `src/styles/additions.css` (takes over: `.nl-page`), `src/server/rate-window.ts` (takes over: `RateScope`), `tests/setup/integration-env.ts` (takes over: `BLOG0_NEWSLETTER_SENDER=stub`, empty `BLOG0_SMTP_HOST`), `tests/integration/newsletter.test.ts` (takes over), `tests/integration/{newsletter-links,newsletter-admin,site-settings}.test.ts` (site-settings takes over), `tests/unit/newsletter/{tokens,templates,schemas}.test.ts`, `tests/unit/db/*` (takes over: `ALL_TABLE_NAMES` expectations), `tests/e2e/reader.spec.ts` + `tests/e2e/smoke.spec.ts` (take over: the footer success copy assertion only) | — |
| 1 | **S7.2 Sender adapter + Listmonk infra** (`newsletter-issues`, adapter half) | `src/server/newsletter/sender/{types,listmonk,stub,index}.ts`, `docker-compose.yml`, `scripts/listmonk-dev.sh`, `scripts/compose/init-db.sh`, `.gitignore` (takes over: `var/listmonk-dev.env` is under `var/` already — verify, else add), `tests/integration/newsletter-listmonk.test.ts` (real container; `PENDING DOCKER` skip rule — adapter-only: no blog0 tables), `tests/unit/newsletter/sender-stub.test.ts` (the stub's in-memory half; its DB writes are covered in wave 2), `tests/helpers/listmonk.ts` (reads `var/listmonk-dev.env`, `docker info` probe) | — (interface from `spec/architecture.md` §13.3; no blog0 schema access in wave 1 — the stub's `sendIssue` DB write lands in wave 2 via S7.3's call signature) |
| 2 | **S7.3 Issues + sync + triggers** (`newsletter-issues`, issues half) | `src/server/newsletter/issues/{repo,service,snapshot,render,triggers,digest,send}.ts`, `src/server/newsletter/sender/sync.ts`, `src/server/newsletter/sender/stub.ts` (takes over: `sendIssue` writes `newsletter_message` rows per confirmed subscriber), `src/server/newsletter/sender-hook.ts` (takes over → delegates to `sync.ts`; or deleted if S7.1 called `sync.ts` directly through a lazy import — S7.3 decides and leaves no dead file), `src/app/api/newsletter/webhook/route.ts`, `src/app/api/admin/newsletter/{settings,sync,issues}/route.ts`, `src/app/api/admin/newsletter/issues/[id]/{route.ts, preview/, test/, send/, stats/}` (`preview/` answers the JSON `IssuePreviewDto` that S7.4 renders into a sandboxed iframe `srcdoc` + Text tab — no HTML preview page route), `src/server/articles/service.ts` (takes over: the after-commit publish hook), `scripts/newsletter-sync.ts`, `scripts/newsletter-tick.ts`, `tests/integration/{newsletter-issues,newsletter-sync,newsletter-webhook}.test.ts`, `tests/unit/newsletter/{render,triggers,excerpt,opt-out}.test.ts` (the pure digest rule `dueDigest` is covered in `triggers.test.ts`; there is no `digest.test.ts`), `tests/fixtures/newsletter/issue-2-posts.{html,txt}` | S7.1 (schema, DTOs, list service), S7.2 (adapter) |
| 2 | **S7.4 Admin UI** | `src/components/admin/DeskHeader.tsx` (takes over: **Newsletter** link), `src/components/admin/subscribers/**` (`SubscribersView.tsx` takes over; new `StatusFilter`, `SubscriberDetail`, `SubscriberTimeline`, `subscribers-api.ts`), `src/app/admin/(authed)/subscribers/page.tsx` (takes over) + `subscribers/[id]/page.tsx`, `src/components/admin/site/NewsletterSettings.tsx` + the site page/components that mount it (take over), `src/components/admin/newsletter/**`, `src/app/admin/(authed)/newsletter/{page.tsx, new/page.tsx, [id]/page.tsx}`, `src/styles/admin.css` (takes over), `tests/unit/admin/newsletter-*.test.tsx` (pure component tests with mocked `apiRequest`) | S7.1 (DTOs — builds against the contract); S7.3's routes are only needed at runtime (verified by S7.5) |
| 3 | **S7.5 Newsletter E2E + designer** | `tests/e2e/newsletter.spec.ts`, `tests/e2e/helpers/newsletter.ts` (main walk: confirm / unsubscribe links read from `newsletter_message` via `helpers/db.ts`; designer walk: `confirm_url` read from the stub's `newsletter.mail` line in `test-results/design-e2e-server.log`), `playwright.config.ts` (takes over: project `newsletter` with `dependencies: ['smoke']`; `webServer.env` forces `BLOG0_NEWSLETTER_SENDER: 'stub'`, `BLOG0_SMTP_HOST: ''`), `playwright.design.config.ts` (takes over: `env` forces the same two values), `tests/e2e/designer-mode.spec.ts` (takes over: signup → confirm via the logged URL → admin shows Confirmed), `tests/e2e/global-setup.ts` (takes over only if the newsletter walk needs seeded subscribers — prefer creating them in the spec) | S7.1–S7.4 |
| 3 | **S7.6 CI, runbook, README** | `.github/workflows/ci.yml` (takes over: `integration` job runs `pnpm listmonk:up` before `pnpm test:integration` — Docker is available on `ubuntu-latest` — and `pnpm listmonk:down` after; `e2e` unchanged), `docs/deploy.md` (takes over: **Newsletter** section — SMTP with the two documented options as placeholders, Google Workspace relay `smtp-relay.gmail.com:587` and Brevo `smtp-relay.brevo.com:587`, never picking one; Listmonk beside blog0 via `docker-compose.yml`, its SMTP in its own UI, API user + list id; the hourly `pnpm newsletter:tick` cron line; webhook secret; `pnpm newsletter:sync` after a `BLOG0_SESSION_SECRET` rotation; new env rows in the Environment table), `README.md` (takes over: scripts, env vars, the designer-mode note that confirmation links are printed in the server log), `scripts/lib/container-env.mjs` (takes over only if `BLOG0_SMTP_*`/`BLOG0_LISTMONK_*` need excluding from the container env — they do not; verify and leave), `tests/integration/release.test.ts` + `backup-restore.test.ts` (take over: expectations for `4 applied (latest 0003_newsletter_prune_fix)` and the new tables in the manifest) | S7.1–S7.4 |

Slice notes (rules live in the capability files and architecture; these are only the hand-offs):
- S7.1 and S7.2 are disjoint by construction: S7.1 never imports from `sender/` (it calls
  `sender-hook.ts`, a 10-line file exporting `afterConfirm(subscriber)` / `afterSuppress(subscriber)`
  that no-op and log at `debug` until S7.3 wires them to `sync.ts`). S7.2 never touches the
  schema or any route.
- S7.1's migration backfill is SQL appended to the generated `0002_newsletter.sql` after a
  `--> statement-breakpoint`; `pnpm db:verify` must still report `0 pending` and the designer
  path (`pglite://`) must run the same file — the trigger function uses plain PL/pgSQL (no
  extensions; PGlite verdict stands, re-run `pnpm spike:pglite` only if a probe is added).
- S7.2's Listmonk test sources `var/listmonk-dev.env` (written by `pnpm listmonk:up`); when
  `docker info` fails it skips with the reason `PENDING DOCKER: start it with colima start, then pnpm listmonk:up`;
  when Docker runs but the env file is missing it **fails** with "run pnpm listmonk:up".
- S7.3's publish hook must never make `publishArticle` throw and must run after
  `deleteStoredFiles`; `tldr-flow`/`articles-api` tests stay green (manual mode default).
- S7.4 builds against `spec/api.md` DTOs with mocked requests; its first real run is S7.5.
- S7.5's E2E spec is the brief's walk in one Playwright project: signup → confirm → confirmed →
  export audit → Site → Newsletter per_post → publish → draft issue → preview HTML + text → send
  test → send (stub) → send log + stats → unsubscribe link from the stub message → suppression in
  the subscriber view; the designer spec adds only signup → confirm → Confirmed. Both run with the
  stub mail transport and stub sender (forced in each Playwright config), so neither walk expects a
  `provider_synced` / `provider_removed` event or a sync timeline entry.

> **Assumed:** three waves of two (S7.1‖S7.2, S7.3‖S7.4, S7.5‖S7.6); the only shared files
> (`schema.ts`, `dto.ts`, `stub.ts`, `sender-hook.ts`, `articles/service.ts`, `playwright.config.ts`,
> `ci.yml`) are each edited in different waves.
> **Assumed:** Listmonk in CI through `docker compose` on the GitHub runner (~40 s to healthy);
> if the runner cannot pull the image the adapter test reports `PENDING DOCKER` and the job
> prints a `::warning::`, mirroring the real-key rule — never a silent pass.

**Phase 7 fixes (post-review, recorded as rules — no new slice; one code-generator pass owns them):**
RFC 8058 one-click (`List-Unsubscribe` → `POST /api/newsletter/unsubscribe?t=…`, GET → 303 to the
page; `spec/api.md`, `spec/architecture.md` §13.2); IP prune bar + per-event cutoff and migration
`0003_newsletter_prune_fix` (§13.1, `spec/data.md`); Listmonk body template-escaping (§13.3);
retry of an issue stuck in `sending` > 10 min (§13.5; `IssueDetailDto.stuckSending` drives the
Issue screen's failure card + **Try again**, `spec/ui.md`); row-locked re-check in `suppress` and the
legacy send (§13.1); webhook opt-out-wins timestamp rule (§13.3); provider errors without subscriber
emails (§13.3, §7 `newsletter.provider`). Unit tests: `tests/unit/newsletter/opt-out.test.ts`;
the integration criteria live in the two capability files.

**Known gap:** unsubscribe exemption from the site-wide link bucket — Frozen, not scheduled (see
**Frozen — not scheduled** below; detail in `spec/architecture.md` §6).

**Done** (commits `161fd00`, `a6a3edf`, `459613a`).

**Gate (exact)** — `.env` as in the planning rules; `BLOG0_NEWSLETTER_SENDER` unset or `stub` and
no `BLOG0_SMTP_HOST` in `.env` (the stub paths are what the gate proves; the Listmonk adapter is
proven by its own test against the compose container):
```bash
pnpm install --frozen-lockfile
pnpm db:migrate && pnpm db:verify            # "blog0_dev @ PostgreSQL 18.x — 4 applied (latest 0003_newsletter_prune_fix), 0 pending: OK"
pnpm release                                 # "… 4 applied (latest 0003_newsletter_prune_fix), 0 pending: OK" then "site blog0 ok, admin <masked> ok"
pnpm typecheck && pnpm lint && pnpm test:unit            # + newsletter/{tokens,templates,render,triggers,excerpt,opt-out,schemas,sender-stub}, admin/newsletter-*
pnpm listmonk:up                             # exit 0 → var/listmonk-dev.env; exit 3 → report "PENDING DOCKER" for the two Listmonk lines below (never a pass)
set -a && . var/listmonk-dev.env && set +a    # only when listmonk:up exited 0
pnpm test:integration                        # + newsletter, newsletter-links, newsletter-admin, newsletter-issues, newsletter-sync, newsletter-webhook, newsletter-listmonk (real container) — real blog0_test; real OpenRouter where already required (PENDING KEY rule)
BLOG0_NEWSLETTER_SENDER=listmonk pnpm newsletter:sync    # against blog0_dev + the compose Listmonk: "synced N, blocklisted N, skipped N, N changed"; second run "… 0 changed"
pnpm listmonk:down
BLOG0_DIST_DIR=.next-gate pnpm build && BLOG0_DIST_DIR=.next-gate pnpm test:e2e      # tldr → reader → listen → smoke → newsletter (stub sender + stub mail)
pnpm test:e2e:design                         # designer mode: signup → confirm via logged URL → Confirmed; no SMTP, no Listmonk, no .env
pnpm test:container                          # exit 0 → "container-e2e: PASS" (the newsletter E2E now runs inside it; the container gets no SMTP → stub); exit 3 → "PENDING DOCKER"
pnpm backup -- --out var/backups && pnpm restore -- --in "$(ls -td var/backups/blog0-* | head -1)" --db blog0_restore_check --storage var/restore-check/storage --force   # "restore-check: OK" — manifest lists the 6 newsletter tables
# Boot check (background tool): pnpm start   then:
curl -fsS http://localhost:3410/api/health/ready                                       # "pending":0
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" "http://localhost:3410/newsletter/confirm?t=not-a-token"   # 303 …/newsletter/confirmed?status=invalid (that page is a 404) — confirm-on-open, owner decision 2026-10-19
curl -fsS -X POST -H 'content-type: application/json' -H 'origin: http://localhost:3410' -d '{"email":"gate@example.test","sourceUrl":"/"}' http://localhost:3410/api/newsletter   # {"ok":true,"data":{"subscribed":true}}
# the server output has one newsletter.mail line with "transport":"stub" and a confirm_url; opening that URL confirms (303 → /newsletter/confirmed?status=ok, "You’re confirmed — welcome to <brand>.")
```
Lines that depend on Docker are reported `PENDING DOCKER` when the daemon is down — the gate is
then "pending docker", not passed. The CI workflow change is proven by its first run on push
(`gh run watch`); until then that line is `PENDING CI`.

**How the user tests it:**
1. *Designer path* (no `.env`): `pnpm dev:design`, open `http://localhost:3410/`, scroll to the
   footer: the line under the form is the consent text; subscribe → "Almost there — check your
   inbox and confirm." The terminal shows a `newsletter.mail` line with `transport: 'stub'` and a
   `confirm_url` — open it → "You’re confirmed — welcome to blog0." Sign in at `/admin`, **Subscribers** → the
   address is **Confirmed**; open it → proof of consent (source `/`, consent v1, your browser's
   user agent, IP "not recorded — no trusted proxy") and the timeline (Signed up, Confirmation
   email sent (stub), Confirmed — no sync entry: the stub sender skips sync; "Synced to Listmonk"
   appears only on the Listmonk path, step 4). **Export audit (JSON)** → a file naming the address with
   its events. **Site → Newsletter** shows "Sender: Stub".
2. *Issues* (designer or full path): **Site → Newsletter** → mode **Per post**, auto-send off,
   **Save**. Publish any article → **Newsletter** lists one **Draft** issue titled like it; open it:
   HTML preview (title, dek, excerpt, **Read**, plus **TLDR**/**Listen** when published), **Text**
   tab; **Send test to me** → "Test sent to <your email> (stub)"; **Send** → "Send to 1 confirmed
   subscriber?" → **Send now** → **Sent · 1 recipient**, the send log shows Send requested →
   Campaign created → Campaign started → Sent; **Stats**: sent 1. In the subscriber's view the
   **Messages** card lists the issue; its unsubscribe link → "You’re unsubscribed." → the
   subscriber is **Unsubscribed** with one suppression entry; a second click on the same link
   shows the same page and adds nothing. Sign up again from the footer with the same address →
   **Pending** with a new signup event, the suppression entry still there; confirm → **Confirmed**
   with a "Re-subscribed" event.
3. *Legacy*: in a database with Phase 2 subscribers (or after `psql … -c "insert into
   newsletter_subscriber (site_id,email,status) …"` before migrating), they appear as **Legacy**;
   nothing is sent until **Send the one-time confirmation** (per row) or **Send confirmation to
   all legacy** (Site → Newsletter); the button is spent afterwards; the click confirms them.
4. *Full path with Listmonk* (Colima): `pnpm listmonk:up`, then with `BLOG0_NEWSLETTER_SENDER=listmonk`
   and the four values from `var/listmonk-dev.env` in `.env`, `pnpm build && pnpm start`:
   **Site → Newsletter** reads "Sender: Listmonk · list blog0-test · healthy"; **Sync to
   Listmonk** → "Synced N"; open `http://localhost:9000` (admin / the compose password) →
   Subscribers shows the confirmed addresses with `blog0_consent_line` and `blog0_unsubscribe_url`
   attributes and the unsubscribed ones blocklisted. **Send** an issue → Listmonk → Campaigns
   shows "blog0 #N — <title>" running/finished (no SMTP configured in Listmonk, so nothing leaves
   the machine); **Refresh stats** fills the tiles. Blocklist an address in Listmonk's UI, run
   `pnpm newsletter:tick` → the subscriber is **Unsubscribed** in blog0 with a provider-sourced
   suppression. Same for a list-level opt-out: in Listmonk remove another confirmed subscriber's
   `blog0` subscription (status **Unsubscribed**, not blocklisted), click **Sync to Listmonk** first
   → the membership stays unsubscribed; `pnpm newsletter:tick` → **Unsubscribed** in blog0
   (provider). Signing that address up again and confirming → **Sync** re-adds it to the list.
5. *Real mail* (optional, needs an SMTP relay): set `BLOG0_SMTP_*` per `docs/deploy.md` (Google
   Workspace relay or Brevo — placeholders, your choice), restart, subscribe with a real address
   → the confirmation arrives; **Send test to me** arrives with `[Test]` in the subject. No
   labelled stubs remain in this phase; the only non-delivering surface is the explicitly
   labelled **Stub** sender/mail in the Site → Newsletter status strip.

**Fix pass (post-freeze):** > **Assumed:** the one approved exception to the freeze — scanner-safe
link pages (GET renders a button, POST changes state; *the confirm link confirms on open since the
owner decision of 2026-10-19 — `newsletter-list.md`*), optional `BLOG0_UNSUBSCRIBE_SECRET`,
`/privacy` + `privacyText` + `newsletterPostalAddress` + `newsletter_erase_subscriber` /
`POST /api/admin/subscribers/:id/erase`, and redacted confirmation tokens (migration
`0004_newsletter_erasure`; `pnpm db:verify` → `5 applied (latest 0004_newsletter_erasure)`) —
specified in `newsletter-list.md` (Assumed fix pass + criteria). **Tests first:** write the
fix-pass criteria as failing integration/unit/E2E tests (PG 18 and PGlite for the erasure
function) before any code; gate = the Phase 7 gate commands above, with the E2E and designer E2E
pressing the link-page buttons. Wherever the how-to-test steps above say "open the link", read "open
the link and press the button". Everything else stays frozen.

---

### Phase 8 — Jev ranking (typesafe/jev-1.13)

**Done** (commit `75f6a2e`) — the last development phase; the project is frozen after it.

**Goal:** the last development phase before the freeze. "Jev" becomes what the user means by it —
the OpenRouter **decisions** model `typesafe/jev-1.13` — and the TLDR deck is chosen by ranking:
one Generate click sends the article (state) and one relevance question per eligible sentence in
one decisions request, Jev returns a probability per sentence, the server keeps every score and
puts the top k (4–8 by length) into the draft deck in document order. Reasons disappear
everywhere; the editor shows "relevance 0.82" on each line and sorts the sentence picker by
relevance; hand-editing, staleness, publish and the reader disclosure are unchanged. Capabilities
touched: `jev-tldr` (rewritten), `ai-cost-ledger` (token/cost semantics), `article-reading`
(disclosure — no change). HOW: `spec/agent.md` (whole file), `spec/architecture.md` §3
(Generate, Relevance in the editor, Deck edit), §7 (`llm.call`, `jev.run`), §10
(`BLOG0_JEV_MODEL`, `BLOG0_OPENROUTER_DECISIONS_URL`), `## Stack` (LLM access), divergences 7–8;
data `spec/data.md` (`ai_generation.output`, `TldrPayload`, fixture shape — **no migration**);
HTTP `spec/api.md` (TLDR DTOs); screen `spec/ui.md` §4 TLDR tab.

**Before fan-out (orchestrator, one commit `phase-8: tldr dto contract, jev config rows`):**
- `src/lib/api/dto.ts`: the TLDR section exactly as `spec/api.md` (`SentenceDto.relevance`,
  `DeckSlideDto.relevance` replacing `reason`, `GenerationDto.sentenceCount`,
  `GenerationDto.picks[].relevance` replacing `reason`). Contract only — both slices build
  against it.
- `src/server/config.ts` + `.env.example` + `tests/unit/config.test.ts` (takes over):
  `jevModel` default `typesafe/jev-1.13`; new `openrouterDecisionsUrl` from
  `BLOG0_OPENROUTER_DECISIONS_URL` (default `https://openrouter.ai/api/alpha/decisions`, absolute
  http(s) URL, trailing `/` trimmed); `.env.example` comments name the decisions model and drop
  the fallback list.
- Local `.env` (gitignored): if it sets `BLOG0_JEV_MODEL` to anything other than
  `typesafe/jev-1.13`, change that one line (an explicit value would otherwise keep the chat model
  and every real-key test would fail with `LLM_MODEL_NOT_FOUND`); report the change, never print
  the key.
- No new dependencies; no migration.

**Slices** — two code-generators, concurrent; disjoint files. Neither edits `dto.ts`,
`config.ts`, `.env.example` or `package.json` after the contract commit.

| Slice | Owns | Depends on |
|---|---|---|
| **S8.1 Backend — decisions client + Jev ranker + seeds + scripts** | `src/server/llm/{types,openrouter,index}.ts` (take over: the decisions client replaces `completeJson`; `key.ts` untouched), `src/server/jev/{state,build-input,validate,run,prompt}.ts` (take over), `src/server/jev/{batches,rank}.ts` + `src/server/jev/prompts/rank-v1.md` (new; `select-v1.md` stays, unreferenced; `bounds.ts`, `articles.ts` unchanged), `src/server/articles/{tldr,schemas,repo}.ts` (take over: row `task`/`output`/usage mapping, `latestSucceededGeneration`, `readScores`, relevance on sentence/slide/pick DTOs, PUT body without `reason`), `src/server/formats/payload.ts` (takes over: drop `reason` + `TLDR_REASON_MAX`), `src/server/seed/seed-tldr.ts` + `src/server/seed/decks/index.ts` (take over: fixture shape with `relevance`, legacy `reason` lines accepted) + `src/server/seed/decks/*.json` (regenerated in the gate), `scripts/check-openrouter.ts` (takes over: `/key` + one 1-question decisions call; no catalog, no fallback list), `scripts/eval-jev.ts` (takes over: ranking table per `spec/agent.md` §7), `.github/workflows/ci.yml` (takes over: the container step's `test -f …/rank-v1.md`), `README.md` + `docs/deploy.md` (take over: env rows, `check:openrouter` sample output, "Jev = typesafe/jev-1.13"), `tests/unit/jev/**` (take over `stub.ts`, `run`, `deadline`, `build-input`, `validate`; new `batches`, `rank`, `prompt`), `tests/unit/llm/{openrouter,index}.test.ts` (take over), `tests/unit/seed/decks-fixture.test.ts` (takes over), `tests/integration/{jev-openrouter,tldr-flow,logging,seed-tldr,articles-api,designer-mode}.test.ts` and any other integration test or `tests/helpers/*` that asserts `reason`, `picks`, `jev-select-v1`, `completeJson` or the old model (take over those expectations only) | contract commit |
| **S8.2 Frontend — TLDR tab + DTO consumers + E2E Generate step** | `src/components/admin/editor/{TldrTab.tsx,tldr-generate.ts}`, `src/components/admin/tldr/{DeckList.tsx,SentencePicker.tsx,deck-edit.ts}`, `src/components/admin/labels.ts` (`relevanceLabel`, `boundsHint` "top k", `generationMeta` "ranked N sentences"), `src/styles/admin.css` (`.tldr-rel`, the picker's segmented switch and section caption; drop `.deck__reason` styling if unused), `tests/unit/admin/{labels,deck-edit,tldr-generate,components,api}.test.ts(x)` (take over the TLDR expectations), `tests/e2e/tldr.spec.ts` (takes over the Generate step: k deck lines each matching `relevance [01]\.\d\d`; picker in **By relevance** order — the first row's score ≥ every other row's; switching to **In article order** shows the heading groups; add a writer line → "Added by you · relevance …"; publish → intro slide disclosure "Lines selected by Jev (AI), verbatim from the article."; `llm.call` log line with `"model":"typesafe/jev-1.13"` and `"outcome":"ok"`), `tests/e2e/helpers/*` only if the Generate step needs a helper change | contract commit (builds against `dto.ts`); S8.1 only at runtime (the E2E run in the gate) |

Slice notes (rules live in `spec/agent.md` and the capability; these are hand-offs):
- S8.1 runs one real call first (`pnpm check:openrouter`, then one `runJev` on
  `tech-company-first`) to settle the two `Assumed:` call-shape items of `spec/agent.md` §3
  (sid ids, `criteria` key shape) and the wrong-slug error body; it records the outcome in
  `spec/agent.md` §3 in the same commit.
- S8.1's unit stub returns decisions responses with `provider: '<stub:jev>'`; real-key paths
  never use it (`spec/architecture.md` → Real-key tests).
- S8.2 never computes or rounds a score beyond display (`toFixed(2)`); sorting uses the raw
  number.

> **Assumed:** two concurrent slices after a contract commit (the phase is one capability across
> two layers; the DTO is the only shared surface, so the orchestrator writes it first).
> **Assumed:** k = the existing `target` bound (4–8); `min`/`max` survive only as the hand-edit
> hint, so no bounds change.
> **Decided (user: keep pure ranking):** pure top-k can cluster at the end of an article
> (observed on real output); the "one line per third" coverage guard is Frozen — not scheduled
> (below; `spec/agent.md` §6). `eval:jev` prints coverage and per-third counts.

**Gate (exact)** — `.env` as in the planning rules, with a real `BLOG0_OPENROUTER_API_KEY` and
`BLOG0_JEV_MODEL` unset or `typesafe/jev-1.13`. Real-key commands carry `BLOG0_REQUIRE_REAL_KEY=1`
so a missing key fails instead of skipping. The fixture step touches **only `blog0_test`** —
never `blog0_dev` (writers' articles):
```bash
pnpm install --frozen-lockfile
pnpm check:openrouter                         # "key valid: true" · "decisions call: ok · model typesafe/jev-1.13 · noul 0.xx · tokens n/n · cost $… · … ms"
pnpm db:migrate && pnpm db:verify             # "blog0_dev @ PostgreSQL 18.x — 4 applied (latest 0003_newsletter_prune_fix), 0 pending: OK" (no Phase 8 migration)
pnpm typecheck && pnpm lint && pnpm test:unit             # + jev/{batches,rank,validate,run,deadline,build-input,prompt}, llm/openrouter, seed/decks-fixture, admin TLDR tests
BLOG0_REQUIRE_REAL_KEY=1 pnpm eval:jev        # 6 articles: each prints N, k, batches, the top-k lines with scores, coverage, picks per third, tokens, cost, latency; then totals; exit 0; total cost < $0.005
BLOG0_REQUIRE_REAL_KEY=1 pnpm test:integration            # real blog0_test + real Jev: jev-openrouter (incl. forced batching + wrong slug), tldr-flow, seed-tldr, logging, articles-api, designer-mode …
# Regenerate the committed seed deck fixtures with real Jev — blog0_test only (≈5 calls, < $0.002):
dropdb --if-exists -h localhost -U sai blog0_test && pnpm db:create                          # "blog0_test: created"
BLOG0_DATABASE_URL=postgres://sai@localhost:5432/blog0_test pnpm db:migrate
BLOG0_DATABASE_URL=postgres://sai@localhost:5432/blog0_test pnpm db:seed                      # "site blog0 ok, admin <masked> ok"
BLOG0_DATABASE_URL=postgres://sai@localhost:5432/blog0_test pnpm db:seed:posts                # "5 posts: 5 created"
BLOG0_DATABASE_URL=postgres://sai@localhost:5432/blog0_test pnpm seed:tldr -- --source jev --write-fixture   # "decks: 5 seeded (5 calls, $0.00xx)" with the $ figure < 0.0020; 5 fixture files written
grep -L '"promptVersion": "jev-rank-v1"' src/server/seed/decks/*.json                       # prints nothing
grep -L '"model": "typesafe/jev-1.13"' src/server/seed/decks/*.json                         # prints nothing
grep -l '"reason"' src/server/seed/decks/*.json                                             # prints nothing
pnpm test:unit tests/unit/seed                # the regenerated fixtures match the seed posts' sentences
BLOG0_DIST_DIR=.next-gate pnpm build && BLOG0_REQUIRE_REAL_KEY=1 BLOG0_DIST_DIR=.next-gate pnpm test:e2e   # tldr (one real Generate) → reader → listen → smoke → newsletter
pnpm test:e2e:design                          # designer mode seeds decks from the NEW fixtures (no key) and smokes the deck
pnpm test:container                           # exit 0 → "container-e2e: PASS" (image ships rank-v1.md); exit 3 → "PENDING DOCKER"
# Boot check (background tool): pnpm start   then:
curl -fsS http://localhost:3410/api/health/ready                                            # "pending":0
```
The `ci.yml` change is proven by its first run on push (`gh run watch`); until then that line is
`PENDING CI`. A `PENDING DOCKER` container line makes the gate "pending docker", not passed.

**How the user tests it:**
1. `pnpm check:openrouter` → "decisions call: ok · model typesafe/jev-1.13 …".
2. `pnpm build && pnpm start`, sign in at `http://localhost:3410/admin`, open any article (or
   paste `src/server/seed/posts/tech-company-first.md` into a new one and **Save**) → **TLDR** tab:
   the hint says "Jev will pick the top N lines for this length".
3. **Generate with Jev** (or **Regenerate** → confirm): within a few seconds "Jev ranked 31
   sentences and picked the top 5 — saved as your draft deck." Each deck line reads
   "Jev · relevance 0.xx"; the meta line shows `typesafe/jev-1.13 · jev-rank-v1 · ranked 31
   sentences · … tokens · $0.000x`. There is no reason text anywhere.
4. **Article lines** list every sentence by relevance, highest first, with its score and
   section; switch to **In article order** → the heading groups, scores still shown. Check a
   high-scoring line from another part of the article → it joins the deck as "Added by you ·
   relevance 0.xx" in document position; move it, remove another, **Save deck**, reload → same
   deck.
5. Edit one sentence in **Write**, **Save**, back to **TLDR**: the chip is **stale**;
   sentences in unchanged paragraphs keep their scores; editing a sentence clears the scores of
   its paragraph (every sentence of that paragraph shows no score); nothing regenerated.
6. **Publish** → **View live** → **TLDR**: intro slide "Lines selected by Jev (AI), verbatim from
   the article." (or the editors' variant if you added lines) and the deck plays as before.
7. An article whose deck was made before this phase still opens: its lines show "Jev" without a
   score until you regenerate. No labelled stubs are introduced by this phase.

**Known gap (R1):** in-flight decisions requests and their retries are not aborted at the run
deadline — Frozen, not scheduled (below).

---

## Frozen — not scheduled

Nothing below is planned, specified for building, or assigned to a phase. Each item is recorded
so the gap is known; reopening any of them is a new user decision.

| Item | Was | One line |
|---|---|---|
| Publication record | Phase 4 | Public "Published · Updated" date, optional dated corrections note (`spec/capabilities/publication-record.md`; columns exist unused). |
| Editor sign-off | Phase 4 | Submit for review / Approve states on the desk (self-publish allowed; columns exist unused). |
| AI cost dashboard | Phase 4 | Per-generation list and site-wide month-to-date total (`spec/capabilities/ai-cost-ledger.md`; recording is live). |
| TLDR stale banner | Phase 4 | Editor banner offering **Regenerate** when the text changed (`spec/capabilities/format-lifecycle.md`; the stale chip, a text-only stale notice in the TLDR tab and the header Generate/Regenerate button are live; frozen = a banner with its own Regenerate action). |
| Team accounts | Phase 4 | Team page to add admins and change one's own password (`spec/capabilities/admin-auth.md` → Team additions; the CLI `admin:create` is live). |
| Revision history | deferred | Browse, view and restore revisions (`spec/capabilities/revision-history.md`; revisions are recorded on every save; History tab stays a labelled stub). |
| Whisper alignment | Phase 6 | Exact Listen timing from a local Whisper aligner, then sentence-level highlight; the sync storage and aligner-facing `PUT /api/admin/articles/:id/listen` are kept for it (`spec/capabilities/listen-sync.md`). |
| Jev coverage guard | Phase 8 option | "One line per third": swap an over-represented third's lowest pick for an empty third's best line (`spec/agent.md` §6; `eval:jev` prints per-third counts). |
| Newsletter SMTP relay | deploy choice | Google Workspace relay (`smtp-relay.gmail.com:587`) vs Brevo (`smtp-relay.brevo.com:587`) — the user chooses at deploy time (`docs/deploy.md`); until `BLOG0_SMTP_HOST` is set, transactional mail uses the stub transport (nothing delivered; `spec/architecture.md` §10). |
| Unsubscribe link-bucket exemption | Phase 7 known gap | Unsubscribe requests skip the site-wide `newsletter.link.site` cap and keep only the per-IP cap (`spec/architecture.md` §6). |
| Abort at Jev run deadline (R1) | Phase 8 known gap | Abort in-flight decisions requests and their transport retries when the 110 s run deadline passes (`spec/agent.md` §3). |

Not frozen, already settled: provider suppressions reach blog0 by **both** the hourly
`newsletter:tick` poll and the secret-gated webhook (`spec/architecture.md` §13.3) — no open
webhook-vs-poll decision. Open user decisions (not features) stay in `spec/architecture.md` →
`## Design divergences (ask user)` → Open, each with its default in force.
