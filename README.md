# blog0

blog0 is smallTech's official blog on all things AI — an AI-native, multi-format publishing
platform (public wordmark **log0**). Writers author Markdown; readers take each article in as
**Read**, **TLDR** (a verbatim slide deck picked by Jev, the TLDR agent) or **Listen**.

Specs live in [`spec/`](spec/) (start with [`spec/roadmap.md`](spec/roadmap.md)).

Status: **Phase 1 — TLDR end-to-end.** An admin signs in at `/admin/login`, writes a Markdown
article, generates a TLDR deck with Jev (one real OpenRouter call, only on an explicit click),
edits it, and publishes; readers open the article in Read or TLDR mode at `/p/<slug>`. Listen,
the newsletter, Featured/About editing and the other later-phase features show as clearly
labelled "Coming in a later phase" stubs (see the roadmap).

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
   <https://openrouter.ai/keys>). For seeding the first admin also `BLOG0_ADMIN_EMAIL`,
   `BLOG0_ADMIN_PASSWORD` (≥ 12 characters) and optionally `BLOG0_ADMIN_NAME` (see step 7).
   `.env` is gitignored — never commit it. Every variable is listed in the
   [table below](#environment-variables).

   No OpenRouter key yet? Set `BLOG0_OPENROUTER_API_KEY=pending-placeholder`: the server boots
   (the `replace-with-…` template value is rejected at boot), real-key tests report
   `PENDING KEY` (see [Tests](#tests)), and TLDR **Generate** fails until a real key is set.

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

7. **Seed the site row and the first admin** into the dev database (idempotent; an existing
   admin's password only changes with `--reset-admin-password`). It reads
   `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` from `.env` (or the shell):

   ```bash
   pnpm db:seed
   # site blog0 ok, admin s***@smalltech.in ok
   ```

   Local dev without the admin credentials in `.env`: keep them in `var/dev-admin.env`
   (`var/` is gitignored) and export them into the shell first:

   ```bash
   set -a; . var/dev-admin.env; set +a
   pnpm db:seed
   ```

   Never commit credentials. The email is masked and the password is never printed.
   More admins: `pnpm admin:create --email <address> --name "<Display Name>"` (password from
   `BLOG0_NEW_ADMIN_PASSWORD`, or a hidden prompt).

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

Then open:

| URL | What |
|---|---|
| <http://localhost:3410/> | public home (log0 wordmark, latest articles) |
| <http://localhost:3410/admin/login> | sign in with the seeded admin |
| <http://localhost:3410/admin> | the desk: article list, **New article**, editor with the TLDR panel |
| `http://localhost:3410/p/<slug>` | a published article in Read mode |
| `http://localhost:3410/p/<slug>/tldr` | the same article with the TLDR deck open |
| <http://localhost:3410/archive>, <http://localhost:3410/about> | archive and about |

The server logs one JSON line per API request (`"event":"api.request"`) to stdout, and also to
`BLOG0_LOG_FILE` when set.

`pnpm dev` (hot reload, same port) exists but is flaky on Next 16.4 — the phase gate and every
handoff use `pnpm build && pnpm start`.

### Jev evaluation

```bash
pnpm eval:jev
```

Runs Jev for real (one batched OpenRouter call per article, plus retries on invalid output) on the 5 seed posts plus
`tests/fixtures/articles/hard-cases.md` and prints a table (N, bounds, picks, coverage,
attempts, tokens, cost, latency). Non-gating; exit 1 if any article fails. With no real key it
prints `PENDING KEY …` and exits 0 without scoring — unless `CI=true`, where it exits 1.

## Tests

All tests run against real PostgreSQL. Integration and E2E tests use the dedicated database
`blog0_test` (`BLOG0_TEST_DATABASE_URL`), which the harness creates if missing, wipes and
migrates automatically; they refuse to run if it equals `BLOG0_DATABASE_URL`.

**Real-key tests and the PENDING KEY rule.** Tests that call the LLM
(`tests/integration/jev-openrouter.test.ts`, the Generate step of
`tests/integration/tldr-flow.test.ts`, the Generate step of the E2E golden path, and
`pnpm eval:jev`) use the real OpenRouter key from `.env` — never a stub. When
`BLOG0_OPENROUTER_API_KEY` is empty or a placeholder (`pending-placeholder`, `replace-with-…`):

- locally they **skip** with a visible `PENDING KEY: BLOG0_OPENROUTER_API_KEY not set` reason — a
  run with such skips is "pending key", not a pass;
- with `CI=true` they **fail** (e.g. `CI=true pnpm test:integration`).

With a real key present, a rejected key (401/403) or any provider error is always a failure.

| Command | What it runs |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (flat config, `eslint-config-next`) |
| `pnpm test:unit` | Vitest `unit` project — deterministic, no I/O (`tests/unit/**`) |
| `pnpm test:integration` | Vitest `integration` project — real `blog0_test`, serial (`tests/integration/**`) |
| `pnpm test` | both Vitest projects |
| `pnpm test:e2e` | Playwright (Chromium) against `pnpm start` on port **3411** using `blog0_test`; run `pnpm build` first |
| `pnpm eval:jev` | Jev evaluation table (real key; non-gating) |

E2E server logs go to `test-results/e2e-server.log`; the HTML report to `playwright-report/`
(`pnpm exec playwright show-report`).

## Database

| Command | Purpose |
|---|---|
| `pnpm db:create` | create `blog0_dev` + `blog0_test` if missing |
| `pnpm db:migrate` | apply pending migrations to `BLOG0_DATABASE_URL` |
| `pnpm db:verify` | print applied/pending migrations; exit 1 if any are pending |
| `pnpm db:generate --name <name>` | generate a new SQL migration from `src/server/db/schema.ts` into `src/server/db/migrations/` |
| `pnpm db:seed [--reset-admin-password]` | upsert the site row and the first admin (`BLOG0_ADMIN_*`) |
| `pnpm admin:create --email <address> --name "<Display Name>"` | add another admin to the site |

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
| `BLOG0_TRUSTED_PROXY_HOPS` | no | `0` | reverse proxies in front of the app that append to `X-Forwarded-For` (login throttling keys on the Nth-from-right entry); `0` = no proxy, forwarded headers ignored |
| `BLOG0_SESSION_SECRET` | yes | — | ≥ 32 chars (`openssl rand -base64 48`) |
| `BLOG0_OPENROUTER_API_KEY` | yes | — | validated at boot for presence (`replace-with-…` rejected); `pending-placeholder` boots but real-key tests report PENDING KEY; liveness by `pnpm check:openrouter` |
| `BLOG0_OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | |
| `BLOG0_JEV_MODEL` | no | `google/gemini-2.5-flash` | see `spec/agent.md` §3 |
| `BLOG0_JEV_TIMEOUT_MS` | no | `45000` | per model attempt |
| `BLOG0_LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `BLOG0_LOG_FILE` | no | — | append JSON lines here too (E2E sets it) |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | seed + E2E | name `Sai Krishna V` | first admin for `pnpm db:seed`; password ≥ 12; local dev may export them from gitignored `var/dev-admin.env` |
| `CI` | no | — | `true` turns PENDING KEY skips into failures |
| `BLOG0_NEW_ADMIN_PASSWORD` | no | — | non-interactive `pnpm admin:create` |
| `BLOG0_STORAGE_DIR` | no | `./var/storage` | Phase 3 |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | no | `50` / `30` / `8` | Phase 3 |
| `BLOG0_E2E_BASE_URL` | no | — | point Playwright at an already-running server (Phase 5) |

## Layout

Single package; all application source in `src/` (import alias `@/*`), tests in `tests/`,
scripts in `scripts/`. Full tree and conventions: `spec/architecture.md` → `## Layout`.
