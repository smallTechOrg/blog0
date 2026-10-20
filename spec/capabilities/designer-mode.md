# Capability: Designer mode (zero-install local run)

Phase 2 (binding user decision). HOW (embedded engine, DB abstraction, in-process setup) lives in
`spec/architecture.md` → §11 *Designer mode*; its E2E wiring in → Test wiring. Postgres stays the production engine; this mode
exists so a designer can run and restyle the real site without installing a database.

## What It Does
Runs the whole app — reader site with the 5 articles and their decks, admin desk, Jev — on a
machine that has only Node and pnpm, from one command, with nothing to configure.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| `pnpm install && pnpm dev:design` | command | designer's terminal | yes |
| `.env` | file | optional; absent in the normal designer flow | no |
| OpenRouter key | `BLOG0_OPENROUTER_API_KEY` | optional | no |
| Committed deck fixture | `src/server/seed/decks/<slug>.json` | repo | yes (when no real key) |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Running site | `http://localhost:3410` with home, archive, about, 5 articles, 5 TLDR decks, 1 sample Listen recording (on `humans-are-software`) | browser |
| Embedded database | `var/pglite/` (gitignored) | disk |
| Session secret | `var/pglite-session-secret` (mode 0600) | disk |
| Designer admin | `designer@blog0.local` + generated password, printed once (in the ready banner) at first boot and kept in `var/designer-admin.txt` (0600; for a non-default PGlite dir `<dir>`: `<dir>.designer-admin.txt`) | console + disk |
| Sample recording | `tests/fixtures/audio/sample.mp3` stored through the storage interface under `BLOG0_STORAGE_DIR` (default `var/storage`) | disk |
| Progress lines | one plain line per setup step (`database: …`, `migrations: …`, `site …`, `admin account …`, `5 posts: …`, `decks: …`, `listen: …`), then `dev:design: database ready in <s>` | console |
| Ready banner | printed once the server answers `/api/health` and `/` has been compiled: `site:` URL, `admin:` login URL, one `designer admin:` line (email + password when just generated — "shown once" — else where the password is kept), where to edit styles/components, how to rotate the password and start over | console |
| Boot notice | one log line stating the engine (`pglite`), the data dir, and whether an OpenRouter key is configured | console |
| Jev notice (no key) | "No OpenRouter key configured — add `BLOG0_OPENROUTER_API_KEY` to `.env` to generate with Jev" in the TLDR tab; Generate disabled | admin UI |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| OpenRouter (only when a real key is set and a writer clicks Generate) | Jev call | same handling as `jev-tldr` |

## Business Rules
- Nothing beyond Node 22 + pnpm is required: no Postgres, no Docker, no `.env`.
- Engine selection is by the database URL: `pglite://<dir>` ⇒ embedded; `postgres://…` ⇒ server
  Postgres; absent ⇒ embedded at `./var/pglite` with a logged notice. The same migrations and the
  same seeds run in both engines; behaviour visible in the browser is identical.
- The absent-URL ⇒ embedded default applies **only to non-production processes** (dev,
  `dev:design`, scripts, tests). The production server (`pnpm start`) with an absent/empty database
  URL refuses to boot with "BLOG0_DATABASE_URL is required in production; set postgres://… or
  explicitly pglite://… to opt in" — a production host with a leftover `var/pglite` must never
  silently serve designer data, including the designer admin. An explicit `pglite://` URL is still
  allowed in production (deliberate opt-in) and logs the designer-mode boot notice.
- `pnpm dev:design` is idempotent: it creates the data dir if missing, migrates, seeds site +
  designer admin + 5 posts + decks + the sample recording, then starts a hot-reloading dev server.
  Re-running it changes nothing already present (no duplicate posts, no second admin, password
  unchanged, no second recording).
- **Sample recording (designer mode only):** so Listen is visible without recording anything,
  setup attaches ONE published recording — `tests/fixtures/audio/sample.mp3` — to
  `humans-are-software` through the normal upload + publish services (probe → storage `put` →
  `media_asset` + listen draft → publish), with estimated timing (no stored marks). Never part of
  the Postgres/production seeds. Skipped (one `listen: sample recording skipped — <reason>` line,
  never a boot failure) when the fixture or the article is missing or the article has unpublished
  changes. An article that already has a Listen row (seeded, uploaded or removed by the designer)
  is left alone, except that the seeded sample's file is written back under the same key when it
  vanished from the storage dir (same sha256 as the fixture).
- A port already in use stops `pnpm dev:design` before the database is opened, with a message
  naming the likely cause (another `dev:design` running) and the `BLOG0_PORT=<n>` fix.
- During setup the app's JSON `info` logs are held back (`BLOG0_LOG_LEVEL=warn` for the setup step
  only, unless the user set a level) so the progress lines and the banner stay readable; the dev
  server logs as usual.
- `pnpm dev:design` always runs on the embedded engine: a `postgres://` database URL in `.env` is
  ignored (the URL-based selection above applies to the other commands).
- The designer admin `designer@blog0.local` is always created; if `BLOG0_ADMIN_*` are set, that
  admin is seeded as well (both can sign in).
- Hot reload works when the site is opened via loopback, a LAN IPv4 address of the machine, or the
  public base URL's host (the dev server allows exactly those dev origins). To avoid an
  intermittent reload loop (HMR hash mismatch), the dev server's persistent file-system cache is
  off; if a reload loop still occurs, the README's fix is `rm -rf .next/dev` and restart.
- Secrets are generated, never hard-coded: the session secret is 48 random bytes persisted at
  `var/pglite-session-secret`; the admin password is generated once, printed once, persisted at
  `var/designer-admin.txt` ("re-run with `--reset-designer-password` to rotate it").
- With no OpenRouter key: boot succeeds; decks come from the committed fixture (see `jev-tldr`
  seeding rule in `reader-site.md`); the TLDR tab shows the "No OpenRouter key configured" notice
  and **Generate** is disabled; the cost ledger stays empty. With a real key: Jev works exactly as
  in Postgres mode.
- Admin works fully in designer mode (sign in as the designer admin, edit, publish, upload).
- Designer mode is never used by the integration gate or the production deploy; the production
  engine remains Postgres.
- `rm -rf var/pglite var/storage var/pglite-session-secret var/designer-admin.txt` is the
  documented "start over" — the next `pnpm dev:design` rebuilds everything.
- The README opens with a short **For designers** section: the one-liner, URL, login and where the
  password is, where styles/components live, how to start over, Node 22 + pnpm.

> **Assumed:** the sample recording reuses the committed test fixture `tests/fixtures/audio/sample.mp3`
> (21 s, 128 KB) instead of a second copy under `src/` — one file, already in every clone.
> **Assumed:** the E2E upload round trip moved to `ai-is-expensive` so the seeded sample on
> `humans-are-software` stays exactly as seeded; the designer E2E uses its own storage dir
> `var/storage-design-e2e` (wiped with `var/pglite-e2e`), never the designer's `var/storage`.
> **Assumed:** no pure-JS argon2 fallback: `@node-rs/argon2` 2.2.2 installs from its prebuilt
> optional package (`@node-rs/argon2-<platform>`; darwin-arm64 verified from a cold pnpm store with
> no toolchain) and has no install script. pnpm's build gate: only `esbuild` and `unrs-resolver`
> run install scripts in the lockfile, both in `allowBuilds` — a fresh clone shows no approval
> prompt ("Automatically ignored builds: None"). Playwright browsers are not needed for
> `dev:design` (`@playwright/test` has no install script).
> **Assumed:** "nothing else installed" still means network on first use: `pnpm install` downloads
> the packages (≈12 s from a cold store), and `next/font` fetches the design's three Google font
> families in dev (offline, Next is expected to fall back to the system stacks in `additions.css` with a warning — not exercised offline here).
> Verified from a clean clone with Postgres unreachable (`PGHOST=/nonexistent PGPORT=1`, no `.env`):
> zero Postgres sockets in any process of the tree and no new `pg_stat_activity` client.
> **Assumed:** the ready banner waits for `/` to compile (so the designer's first page view is not
> the slow one) and then prints; the password appears only there (once), the setup line says
> where it is.

## Success Criteria
- [ ] From a clean checkout with no `.env` (and Postgres unreachable), `pnpm install && pnpm dev:design` serves `http://localhost:3410/` within 120 s and opens no Postgres connection; the console shows exactly one line with the designer admin email + password (in the ready banner) and the `app.boot` log line reports `db_engine:"pglite"`.
- [ ] `/p/humans-are-software/listen` shows the player for the seeded sample (estimated timing); its `/media/<key>` answers 206 to a Range request; a second run prints `listen: humans-are-software already has a recording`.
- [ ] A CSS edit (`src/styles/additions.css`) and a component edit (`src/components/site/home/HomeAbout.tsx`) show in an open page without a full reload. *Verified manually (the user test path), not automated — no test asserts hot reload.*
- [ ] `/` contains "Featured Editorial" and the 5 seeded titles; `/p/humans-are-software` renders the body; `/p/humans-are-software/tldr` opens a deck whose line count is between 4 and 8 and whose first line is byte-identical to a sentence of the article.
- [ ] `/admin/login` accepts `designer@blog0.local` + the printed password; the desk lists 5 published articles, each with TLDR `ready`.
- [ ] With no key configured, the TLDR tab of any article shows "No OpenRouter key configured" and the Generate button is disabled; `/api/health` still answers `"db":"ok"`.
- [ ] Running `pnpm dev:design` a second time prints "5 posts: 0 created", "decks: 0 seeded", and no new admin password.
- [ ] With port 3410 taken, `pnpm dev:design` exits 1 with "port 3410 is already in use" before opening the database.
- [ ] `tests/e2e/designer-mode.spec.ts` (own port 3413, PGlite dir `var/pglite-e2e`, no `.env` values for DB/secret/key) passes: home + one article + the deck, the seeded sample Listen plays (player + `/media` 206), and the Jev notice when no key.
- [ ] `pnpm db:verify` against `BLOG0_DATABASE_URL=pglite://./var/pglite` prints "0 pending".
- [ ] Config loading with production mode and no database URL fails with exactly "BLOG0_DATABASE_URL is required in production; set postgres://… or explicitly pglite://… to opt in"; the same with `pglite://./var/pglite` succeeds with engine `pglite`; non-production with no URL selects `./var/pglite`.
