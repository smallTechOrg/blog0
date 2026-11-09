# Capability: Container image (deploy-ready, target-agnostic)

Phase 5. HOW (Dockerfile stages, file paths, probes, shutdown hook): `spec/architecture.md` →
§12 Deployment; slices and gate: `spec/roadmap.md` → Phase 5.

## What It Does
Packages blog0 as one OCI image that any container platform can run: the same image serves the
site, runs the release step (migrate + verify + seed site/admin) as a separate one-off command,
reports liveness and readiness, keeps uploaded media on a mounted volume, and shuts down
gracefully when the platform stops it.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Source tree + `pnpm-lock.yaml` | build context (filtered by `.dockerignore`) | repo | yes |
| `BLOG0_DATABASE_URL` | `postgres://…` | orchestrator env | yes (boot refuses without it) |
| `BLOG0_SESSION_SECRET` | ≥ 32 chars | orchestrator secret | yes |
| `BLOG0_OPENROUTER_API_KEY` | string | orchestrator secret | yes (a real key for Jev; boot rejects only the `replace-with-` placeholder) |
| `BLOG0_PUBLIC_BASE_URL` | absolute origin | orchestrator env | yes in practice (https in production ⇒ `Secure` cookie, HSTS) |
| `BLOG0_TRUSTED_PROXY_HOPS` | 0–10 | orchestrator env | yes behind a proxy (`spec/architecture.md` §6) |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | strings | release-step env | first deploy only |
| `BLOG0_SHUTDOWN_TIMEOUT_MS` | ms, 1000–120000 | orchestrator env | no (default 8000) |
| Storage volume | directory mounted at `/data/storage` | orchestrator | yes (uploads are lost without it) |
| Every other `BLOG0_*` from `spec/architecture.md` §10 | — | orchestrator env | as documented there |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Image `blog0:<tag>` | OCI image, non-root, `node:22.23.1-slim` based | local daemon / registry |
| Web server on container port 3410 | HTTP | orchestrator port mapping |
| Release step output | `release: <db> @ PostgreSQL <v> — N applied (latest <tag>), 0 pending: OK` + `site <slug> ok…, admin <masked> ok…` lines; exit 0/1 | stdout |
| `GET /api/health/live`, `GET /api/health/ready` | JSON envelope (`spec/api.md` → health) | orchestrator probes, Docker `HEALTHCHECK` |
| `app.shutdown` log lines | JSON lines | stdout (+ `BLOG0_LOG_FILE`) |
| `docs/deploy.md` | runbook | repo |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Postgres | release: migrate, verify, upsert site/admin; app: queries; ready: ping + migration status | release exits 1 with the reason; ready answers 503 `NOT_READY` (`reason`), live stays 200 |
| npm registry, Google Fonts | build-time only (`pnpm fetch`, `next/font`) | `docker build` fails; nothing at runtime |

## Business Rules
- **One image, two commands.** Default command = the web server (Next standalone `server.js`);
  `node release.mjs` = the release step. The web server never migrates; deploys run the release
  step to completion before starting/replacing web containers.
- **Release step** = apply pending migrations → verify 0 pending (exit 1 otherwise) → ensure the
  site row (`BLOG0_SITE_SLUG`) → when `BLOG0_ADMIN_EMAIL` and `BLOG0_ADMIN_PASSWORD` are both set,
  ensure that admin exists (never resets an existing password). Idempotent: a second run prints
  `already up to date` / `ok` and changes nothing. Postgres only: a `pglite://` URL → exit 2 with
  "the release step is for Postgres; designer mode migrates in pnpm dev:design".
- **Production configuration is enforced at boot** (existing rules, `spec/architecture.md` §10):
  absent `BLOG0_DATABASE_URL` or a missing/placeholder secret → the process logs one aggregated
  error and exits 1 before serving. The image never contains `.env` files.
- **Cookies:** `Secure` exactly when `BLOG0_PUBLIC_BASE_URL` is https (existing rule).
- **Non-root:** the server and the release step run as uid 1000 (`node`); application files are
  read-only to that user; only `/data/storage` and `/app/.next/cache` are writable by it.
- **Storage:** `BLOG0_STORAGE_DIR=/data/storage` is baked in; the directory is a declared volume.
  A deployment runs **one** web instance per storage volume unless the volume is shared
  read-write (documented in the runbook).
- **Liveness vs readiness:** live = the process answers (no DB access); ready = DB answers within
  3 s **and** no migration is pending **and** the process is not shutting down. Docker
  `HEALTHCHECK` uses live. Orchestrators route traffic on ready and restart on live.
- **Graceful shutdown on SIGTERM/SIGINT:** stop accepting connections, ready flips to 503
  `SHUTTING_DOWN` at once, in-flight requests drain for up to `BLOG0_SHUTDOWN_TIMEOUT_MS`, then
  the DB pool closes and the process exits (143 after SIGTERM, 130 after SIGINT; 1 when the drain
  deadline was hit). Platform stop grace periods must exceed the timeout by ≥ 2 s.
- The local developer path is unchanged: `pnpm build && pnpm start` still runs `next start`
  (no standalone output, no warning); only the image build sets standalone output.
- `docs/deploy.md` (runbook) has exactly these nine sections, in this order: **Environment** (table of every variable
  the container reads, required/optional, secret or not — pointing at `spec/architecture.md` §10
  for semantics), **First deploy** (build/pull image → create database → release step with
  `BLOG0_ADMIN_*` → run with volume + env → check `/api/health/ready`), **Upgrades** (pull →
  release step → replace containers; never run two different app versions against a schema they
  don't share — release first, then roll), **Backups** (`pnpm backup` from a host with the repo
  and PostgreSQL 18 client tools, a nightly cron line, retention suggestion), **Restore**
  (`pnpm restore` into a scratch DB → check → point the app at it), **Rotating
  `BLOG0_SESSION_SECRET`** (every session is invalidated — all admins must sign in again; no
  data is lost), **Newsletter** (Phase 7: SMTP options, Listmonk, the cron line for
  `newsletter:tick`), **Health endpoints** (live/ready semantics, probe settings: live every 10 s,
  ready every 5 s, stop grace ≥ timeout + 2 s), **Reverse proxy** (`BLOG0_TRUSTED_PROXY_HOPS`,
  https `BLOG0_PUBLIC_BASE_URL`, large upload body limits ≥ `BLOG0_MAX_AUDIO_MB` + 1 MB, long
  read timeout ≥ 120 s for Generate).
- Out of scope: running the embedded engine (`pglite://`) in the container, multi-arch publishing,
  registries, TLS termination, any deploy job or target-specific manifests (Kubernetes, Fly,
  Render…).

> **Assumed:** base image `node:22.23.1-slim` (Debian, glibc) over Alpine — the exact Node patch
> pinned by `package.json` `devEngines` (pnpm would otherwise download a runtime), glibc prebuilds
> for `@node-rs/argon2` and Next's SWC are the primary targets, and the official image ships full
> ICU so `Intl.Segmenter` sentence splitting stays identical to development.
> **Assumed:** the image runs only `postgres://`; an explicit `pglite://` in a container is
> unsupported (PGlite is loaded through a runtime `createRequire` that standalone tracing does not
> follow).
> **Assumed (S5.1):** `dist/release.mjs` keeps only `@node-rs/argon2` (native) and `next` external;
> `postgres` (pure JS) is bundled and `@electric-sql/pglite` is replaced by a throwing stub. Reason:
> Next's standalone output under pnpm exposes `@node-rs/argon2` at `/app/node_modules` but reaches
> `postgres`/`pglite` only through hashed `.next/node_modules` links, so a bare import from
> `/app/release.mjs` cannot resolve them; the release step refuses `pglite://` before opening a DB.
> The banner aliases `createRequire` and defines `__filename`/`__dirname` (bundled CommonJS needs them).
> **Assumed:** default drain timeout 8 s so Docker's default 10 s stop grace suffices; long
> Generate calls (≤ 120 s) can be cut by a stop — the runbook says to raise both values when that
> matters.

## Success Criteria
- [ ] `docker build -t blog0:local .` succeeds from a clean clone; `docker image inspect blog0:local --format '{{.Size}}'` < 524288000 (500 MB).
- [ ] `docker run --rm blog0:local id -u` prints `1000`; `docker run --rm --entrypoint sh blog0:local -c 'test ! -e .env && test -f src/server/jev/prompts/rank-v1.md && test -f src/server/db/migrations/meta/_journal.json && test -f release.mjs'` exits 0.
- [ ] `docker run --rm blog0:local` with no env exits 1 within 15 s and its output contains `BLOG0_DATABASE_URL is required in production`.
- [ ] Release step against an empty database prints `0 pending: OK` and `site blog0 ok (created)`; a second run prints `already up to date` and `site blog0 ok`; against `pglite://x` it exits 2.
- [ ] Running container with an unreachable DB: `GET /api/health/live` → 200 `{"status":"live"…}`, `GET /api/health/ready` → 503 `NOT_READY` with `details.reason = "DB_UNAVAILABLE"`; `docker inspect` health becomes `healthy` within 60 s.
- [ ] Running container against `blog0_test` after the release step: ready → 200 `{"status":"ready","db":"ok",…,"migrations":{"pending":0,…}}`; the full `pnpm test:e2e` suite passes against it via `BLOG0_E2E_BASE_URL=http://localhost:3412` (sign-in exercises argon2 inside the image; the Listen walk's upload lands as a file under the host's `var/storage-e2e/blog0/audio/`).
- [ ] `docker stop -t 20 <container>` returns in < 12 s; exit code 143; container logs contain one `app.shutdown` line with `"phase":"draining"` and one with `"phase":"closed","outcome":"drained"`.
- [ ] With `BLOG0_PUBLIC_BASE_URL=https://…`, a successful login's `Set-Cookie` contains `Secure`; with `http://localhost:3412` it does not.
- [ ] Locally, `pnpm build && pnpm start` prints no `"next start" does not work with "output: standalone"` warning and `.next/standalone` does not exist.
- [ ] `docs/deploy.md` exists with the nine section headings listed in Business Rules.
