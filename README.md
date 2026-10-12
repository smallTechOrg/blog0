# blog0

blog0 is smallTech's official blog on all things AI — an AI-native, multi-format publishing
platform (public wordmark **log0**). Writers author Markdown; readers take each article in as
**Read**, **TLDR** (a verbatim slide deck picked by Jev, the TLDR agent) or **Listen**.

Specs live in [`spec/`](spec/) (start with [`spec/roadmap.md`](spec/roadmap.md)).

Status: **scaffold** — the app boots, `/api/health` proves the database is reachable, the full
v0.1 schema is migrated, and the unit / integration / E2E harnesses run green. Features arrive
phase by phase (see the roadmap).

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22.x (`.nvmrc`) | `node --version` |
| pnpm | 11.x (pinned in `package.json` → `packageManager`) | `pnpm --version` |
| PostgreSQL | 18, running on the Unix socket `/tmp`, port 5432, user `sai`, no password | `psql -h /tmp -U sai -d postgres -c 'select version()'` |

pnpm runs every script on Node **22.23.1** regardless of the shell's `node` (it is pinned in
`package.json` → `devEngines.runtime` and installed into `node_modules` by `pnpm install`).
Check it with `pnpm exec node --version` → `v22.23.1`.

Every command below runs from the repo root: `cd /Users/sai/Workspace/Code/blog0`.

## Setup

1. **Environment file.** Copy the template, then fill the required values:

   ```bash
   cp .env.example .env
   ```

   Required: `BLOG0_DATABASE_URL`, `BLOG0_TEST_DATABASE_URL`, `BLOG0_SESSION_SECRET` (generate
   with `openssl rand -base64 48`), `BLOG0_OPENROUTER_API_KEY` (from
   <https://openrouter.ai/keys>). From Phase 1 on also `BLOG0_ADMIN_EMAIL` and
   `BLOG0_ADMIN_PASSWORD`. `.env` is gitignored — never commit it. Every variable is listed in
   the [table below](#environment-variables).

   Verify: `test -f .env && echo ".env present"`

2. **Install dependencies** (non-interactive; allowed build scripts are listed in `pnpm-workspace.yaml`):

   ```bash
   pnpm install
   ```

   Verify: `pnpm exec next --version` → `Next.js v16.4.0`

3. **Browser for E2E tests:**

   ```bash
   pnpm exec playwright install chromium
   ```

   Verify: `pnpm exec playwright --version` → `Version 1.64.0`

4. **Create the databases** (`blog0_dev` and `blog0_test`; prints `created` or `exists` per DB):

   ```bash
   pnpm db:create
   ```

   Verify: `psql -h /tmp -U sai -d postgres -Atc "select datname from pg_database where datname like 'blog0_%'"`

5. **Migrate the dev database:**

   ```bash
   pnpm db:migrate
   ```

   Verify (exit 1 if anything is pending):

   ```bash
   pnpm db:verify
   # blog0_dev @ PostgreSQL 18.1 — 1 applied (latest 0000_init), 0 pending: OK
   ```

6. **Prove the OpenRouter key and the Jev model** with one real structured-output call (prints
   only booleans/numbers, never the key; exit 1 on any failure):

   ```bash
   pnpm check:openrouter
   # key present: true
   # key valid: true
   # model google/gemini-2.5-flash listed: true
   # ...
   # structured call: ok · tokens <n> · cost $<x> · <ms> ms
   ```

   If the model is reported unlisted, set `BLOG0_JEV_MODEL` to the first available slug from the
   printed fallback list (in `.env` and `.env.example`) and record it in `spec/agent.md` §3.

## Run

Production build + server (port **3410**, override with `BLOG0_PORT`):

```bash
pnpm build
pnpm start
```

Verify (in another terminal):

```bash
curl -fsS http://localhost:3410/api/health
# {"ok":true,"data":{"status":"ok","db":"ok","dbLatencyMs":<n>,"version":"0.1.0","uptimeSec":<n>}}
```

Then open <http://localhost:3410/> — the placeholder page reads "blog0 is running". The server
logs one JSON line per API request (`"event":"api.request"`) to stdout, and also to
`BLOG0_LOG_FILE` when set.

Development server with hot reload (same port): `pnpm dev`.

## Tests

All tests run against real PostgreSQL. Integration and E2E tests use the dedicated database
`blog0_test` (`BLOG0_TEST_DATABASE_URL`), which the harness creates if missing, wipes and
migrates automatically; they refuse to run if it equals `BLOG0_DATABASE_URL`. Tests that call
the LLM use the real OpenRouter key from `.env` (they fail when it is missing; they skip only
when `CI=true` and no key is set).

| Command | What it runs |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (flat config, `eslint-config-next`) |
| `pnpm test:unit` | Vitest `unit` project — deterministic, no I/O (`tests/unit/**`) |
| `pnpm test:integration` | Vitest `integration` project — real `blog0_test`, serial (`tests/integration/**`) |
| `pnpm test` | both Vitest projects |
| `pnpm test:e2e` | Playwright (Chromium) against `pnpm start` on port **3411** using `blog0_test`; run `pnpm build` first |

E2E server logs go to `test-results/e2e-server.log`; the HTML report to `playwright-report/`
(`pnpm exec playwright show-report`).

## Database

| Command | Purpose |
|---|---|
| `pnpm db:create` | create `blog0_dev` + `blog0_test` if missing |
| `pnpm db:migrate` | apply pending migrations to `BLOG0_DATABASE_URL` |
| `pnpm db:verify` | print applied/pending migrations; exit 1 if any are pending |
| `pnpm db:generate --name <name>` | generate a new SQL migration from `src/server/db/schema.ts` into `src/server/db/migrations/` |

Scripts added by later slices: `pnpm db:seed`, `pnpm admin:create` (Phase 1, S1.1),
`pnpm eval:jev` (Phase 1, S1.3).

## Environment variables

Documented 1:1 in `.env.example`; validated at boot by `src/server/config.ts` (the server
refuses to start and lists every problem when a required value is missing or invalid).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BLOG0_DATABASE_URL` | yes | — | `postgres://sai@localhost:5432/blog0_dev` |
| `BLOG0_TEST_DATABASE_URL` | tests | — | `postgres://sai@localhost:5432/blog0_test`; must differ from the dev URL (tests refuse otherwise) |
| `BLOG0_PORT` | no | `3410` | read by `scripts/serve.mjs` (after loading `.env`) |
| `BLOG0_PUBLIC_BASE_URL` | no | `http://localhost:3410` | absolute links, OG, origin check, `Secure` cookie when https |
| `BLOG0_SITE_SLUG` | no | `blog0` | which `site` row this process serves |
| `BLOG0_SESSION_SECRET` | yes | — | ≥ 32 chars (`openssl rand -base64 48`) |
| `BLOG0_OPENROUTER_API_KEY` | yes | — | validated at boot for presence; liveness by `pnpm check:openrouter` |
| `BLOG0_OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | |
| `BLOG0_JEV_MODEL` | no | `google/gemini-2.5-flash` | see `spec/agent.md` §3 |
| `BLOG0_JEV_TIMEOUT_MS` | no | `45000` | per model attempt |
| `BLOG0_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `BLOG0_LOG_FILE` | no | — | append JSON lines here too (E2E sets it) |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | seed + E2E | name `Sai Krishna V` | first admin; password ≥ 12 |
| `BLOG0_NEW_ADMIN_PASSWORD` | no | — | non-interactive `pnpm admin:create` |
| `BLOG0_STORAGE_DIR` | no | `./var/storage` | Phase 3 |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | no | `50` / `30` / `8` | Phase 3 |
| `BLOG0_E2E_BASE_URL` | no | — | point Playwright at an already-running server (Phase 5) |

## Layout

Single package; all application source in `src/` (import alias `@/*`), tests in `tests/`,
scripts in `scripts/`. Full tree and conventions: `spec/architecture.md` → `## Layout`.
