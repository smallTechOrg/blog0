# Deploying blog0

blog0 ships as **one OCI image** (`Dockerfile`, non-root uid 1000, `node:22.23.1-slim`) that any
container platform can run. The same image has two commands:

| Command | What it does |
|---|---|
| `node server.js` (default `CMD`) | the web server on container port **3410** — never migrates |
| `node release.mjs` | the **release step**: apply pending migrations → verify 0 pending → ensure the site row → ensure the first admin (when `BLOG0_ADMIN_EMAIL` + `BLOG0_ADMIN_PASSWORD` are set; never resets an existing password). Idempotent. Exit 0 ok, 1 failure, 2 usage (`pglite://`) |

Product rules: `spec/capabilities/container-image.md`, `spec/capabilities/backup-restore.md`,
`spec/capabilities/abuse-protection.md`. Mechanics: `spec/architecture.md` §6, §10, §12.
Nothing here is target-specific (no Kubernetes/Fly/Render manifests); translate the `docker`
commands to your platform.

Prove the whole path locally first (needs Docker, e.g. `colima start`, and Postgres from `.env`):

```bash
pnpm test:container     # builds blog0:local, release step, runs the full E2E suite against the container on :3412
# → "container-e2e: PASS" (exit 0); exit 3 = "PENDING DOCKER" (Docker not running — not a pass)
```

## Environment

Semantics, defaults and validation of every variable: `spec/architecture.md` §10 (and
`.env.example`, which documents them 1:1). The image never contains a `.env` file — pass values
from your platform's env/secret store. A missing required value or a `replace-with-…` placeholder
makes the server log one aggregated error and exit 1 before serving.

| Variable | Web server | Release step | Secret | Notes |
|---|---|---|---|---|
| `BLOG0_DATABASE_URL` | **required** | **required** | yes (holds the DB password) | `postgres://user:pass@host:5432/blog0` — Postgres 18; `pglite://` is unsupported in the container |
| `BLOG0_SESSION_SECRET` | **required** | optional | **yes** | ≥ 32 chars: `openssl rand -base64 48`. See [Rotating `BLOG0_SESSION_SECRET`](#rotating-blog0_session_secret) |
| `BLOG0_OPENROUTER_API_KEY` | **required** | — | **yes** | a real key for Jev (TLDR Generate); boot rejects only `replace-with-…`; check with `pnpm check:openrouter` |
| `BLOG0_PUBLIC_BASE_URL` | required in practice | — | no | the public **https** origin, e.g. `https://blog.example.com` — links, OG tags, CSRF origin check; https ⇒ `Secure` session cookie + HSTS + `upgrade-insecure-requests` |
| `BLOG0_TRUSTED_PROXY_HOPS` | required behind a proxy | — | no | number of proxies appending to `X-Forwarded-For` (see [Reverse proxy](#reverse-proxy)); default `0` |
| `BLOG0_SITE_SLUG` | optional | optional (same value) | no | which `site` row this deployment serves; default `blog0` |
| `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` / `BLOG0_ADMIN_NAME` | — | first deploy only | password: **yes** | creates the first admin; password ≥ 12 chars; remove after the first release |
| `BLOG0_SHUTDOWN_TIMEOUT_MS` | optional | — | no | drain deadline after SIGTERM (1000–120000, default 8000) |
| `BLOG0_RATE_LIMIT_STORE` | optional | — | no | `auto` (default: counted in Postgres — survives restarts, shared by instances) \| `db` \| `memory` |
| `BLOG0_OPENROUTER_BASE_URL` | optional | — | no | default `https://openrouter.ai/api/v1` |
| `BLOG0_JEV_MODEL` / `BLOG0_JEV_TIMEOUT_MS` | optional | — | no | default `google/gemini-2.5-flash` / `45000` |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | optional | — | no | upload limits, default `50` / `30` / `8` |
| `BLOG0_LOG_LEVEL` | optional | — | no | `debug` \| `info` (default) \| `warn` \| `error` |
| `BLOG0_LOG_FILE` | optional | — | no | also append JSON log lines to this path (stdout always gets them) |
| `BLOG0_STORAGE_DIR` | baked in: `/data/storage` | — | no | do not change; mount the volume there |
| `PORT` / `HOSTNAME` / `NODE_ENV` | baked in: `3410` / `0.0.0.0` / `production` | — | no | map a host/ingress port to 3410 instead of changing `PORT` |

Not read by the container: `BLOG0_TEST_DATABASE_URL`, `BLOG0_PORT`, `BLOG0_DIST_DIR`,
`BLOG0_STANDALONE`, `BLOG0_NEW_ADMIN_PASSWORD`, `BLOG0_E2E_*`, `BLOG0_REQUIRE_REAL_KEY`,
`BLOG0_CONTAINER_BUILD` (local scripts and tests only).

## First deploy

1. **Image.** Build it (from a clean checkout) or pull the one you pushed to your registry:

   ```bash
   docker build -t blog0:<version> .
   docker run --rm blog0:<version> id -u          # 1000 — the image runs as the non-root `node` user
   ```

2. **Database.** Create an empty Postgres 18 database and a role that owns it (e.g.
   `createdb -O blog0 blog0`). The release step creates every table.

3. **Release step** (one-off container, same env as the web server plus the first admin):

   ```bash
   docker run --rm --env-file blog0.env \
     -e BLOG0_ADMIN_EMAIL=you@example.com -e BLOG0_ADMIN_PASSWORD='<12+ chars>' -e BLOG0_ADMIN_NAME='Your Name' \
     blog0:<version> node release.mjs
   # <db>: applied 0000_init
   # <db>: applied 0001_rate_limit_bucket
   # release: blog0 @ PostgreSQL 18.x — 2 applied (latest 0001_rate_limit_bucket), 0 pending: OK
   # site blog0 ok (created), admin <masked email> ok (created)
   ```

   Re-running it is safe (`already up to date`, `ok`). Afterwards remove `BLOG0_ADMIN_PASSWORD`
   from wherever you stored it; add more admins from the desk (**Team**).

4. **Web server** with the uploads volume and the env:

   ```bash
   docker volume create blog0-storage
   docker run -d --name blog0 --restart unless-stopped --stop-timeout 10 \
     --env-file blog0.env -p 127.0.0.1:3410:3410 \
     -v blog0-storage:/data/storage \
     blog0:<version>
   ```

   `blog0.env` holds `BLOG0_DATABASE_URL`, `BLOG0_SESSION_SECRET`, `BLOG0_OPENROUTER_API_KEY`,
   `BLOG0_PUBLIC_BASE_URL=https://…`, `BLOG0_TRUSTED_PROXY_HOPS=1` (one `KEY=value` per line,
   unquoted, mode 0600). Without the volume every upload is lost when the container is replaced.
   A bind mount works too (`-v /srv/blog0/storage:/data/storage`); on Linux make it writable by
   uid 1000 first (`chown 1000:1000 /srv/blog0/storage`).

5. **Check readiness**, then put the reverse proxy (TLS) in front — see [Reverse proxy](#reverse-proxy):

   ```bash
   curl -fsS http://127.0.0.1:3410/api/health/ready
   # {"ok":true,"data":{"status":"ready","db":"ok",…,"migrations":{"applied":2,"pending":0,…}}}
   ```

   Then open `https://<your host>/admin/login` and sign in as the first admin.

### Scaling

- **One web instance per storage volume.** Uploads are written to local disk under
  `/data/storage`; a second instance on its own volume would not see them. Run more instances
  only when they share one read-write volume (network filesystem) — object storage is a later
  change.
- Everything else is multi-instance safe: sessions live in Postgres, and the sign-in / newsletter
  throttles count in Postgres (`BLOG0_RATE_LIMIT_STORE=auto`), so caps hold across instances and
  restarts.
- The release step runs **once** per deploy, never per instance.

## Upgrades

1. Take a backup ([Backups](#backups)).
2. Build or pull the new image.
3. Run the **release step** of the new image to completion (`docker run --rm --env-file blog0.env
   blog0:<new> node release.mjs`, exit 0). Migrations are applied only here — the web server
   never migrates, and `/api/health/ready` answers 503 `MIGRATIONS_PENDING` while the schema is
   behind its code.
4. Replace the web container(s) (`docker stop blog0 && docker rm blog0`, then the `docker run`
   of First deploy step 4 with the new tag). Rolling platforms: route on readiness so old
   instances keep serving until new ones are ready.

Never run two different app versions against a schema they do not share: release first, then
roll; if a release is not backwards-compatible with the running version, stop the old web
containers before the release step. Rollback = restore the pre-upgrade backup and run the old
image (migrations are forward-only).

## Backups

Backups run from a host with the repo checkout (`pnpm install` done), Node 22 and the
**PostgreSQL 18 client tools** (`pg_dump`/`pg_restore`, major ≥ the server's: macOS
`brew install postgresql@18`; Debian/Ubuntu `apt install postgresql-client-18`), with
`BLOG0_DATABASE_URL` pointing at production and the storage volume readable at a host path:

```bash
BLOG0_DATABASE_URL='postgres://…/blog0' pnpm backup -- --out /srv/backups --storage /srv/blog0/storage
# backup: /srv/backups/blog0-20261013T020000Z
# db: blog0 — <T> tables, <R> rows, dump <bytes>
# storage: <N> files, <B> bytes
# /srv/backups/blog0-20261013T020000Z        ← last line = the backup dir
```

One backup = `db.dump` (custom format, from one exported snapshot so rows and counts agree),
`storage.tar.gz` (the uploads) and `manifest.json` (row counts per table, file counts, sha256 of
both files; written last — a directory without it is not a backup). Throttle windows
(`rate_limit_bucket`) are not backed up. A named Docker volume is readable at
`docker volume inspect -f '{{.Mountpoint}}' blog0-storage` (root) — or use a bind mount.

Nightly at 02:00, keeping 14 days (crontab of the backup user; `.env` in the checkout holds the
production `BLOG0_DATABASE_URL`, mode 0600):

```cron
0 2 * * * cd /srv/blog0-repo && pnpm -s backup -- --out /srv/backups --storage /srv/blog0/storage >> /var/log/blog0-backup.log 2>&1 && find /srv/backups -maxdepth 1 -name 'blog0-*' -mtime +14 -exec rm -rf {} +
```

Retention suggestion: 14 nightly + the first backup of each month for 12 months. Copy every
backup **off the host** (another region/provider, e.g. `rclone copy` / `aws s3 sync`
of `/srv/backups`) — a backup on the database's own disk is not a backup. The dump contains
password hashes and subscriber emails: store it encrypted and access-controlled.

## Restore

Restore into a **scratch** database first, check it, then point the app at it:

```bash
pnpm restore -- --in /srv/backups/blog0-20261013T020000Z --db blog0_restored --storage /srv/blog0/storage-restored
# <table> <restored> / <manifest> ok … files <n> / <n> ok … bytes …
# restore-check: OK (<T> tables, <R> rows, <N> files)
BLOG0_DATABASE_URL='postgres://…/blog0_restored' pnpm db:verify      # … 0 pending: OK
```

- `--db` takes a bare name (host + credentials from `BLOG0_DATABASE_URL`) or a full
  `postgres://` URL; the database is created when missing. A non-empty target or storage dir is
  refused (`is not empty`) unless `--force` (which wipes it first).
- Checksums are verified before anything is touched; `pg_restore` runs in one transaction, so the
  database is either fully restored or unchanged. **restore-check** recounts every table and file
  against the manifest; any `MISMATCH` exits 1.
- `--check-only` re-runs only the check against an existing restore.
- To switch over: stop the web container(s), point `BLOG0_DATABASE_URL` at the restored
  database (or rename databases), mount the restored storage dir at `/data/storage`, run the
  release step (it reports `0 pending`), start the web container, check `/api/health/ready`.

**Drill** (monthly): restore the latest backup into `blog0_restore_check` with
`--storage /tmp/blog0-restore-check --force`, expect `restore-check: OK`, then drop it. A backup
that has never been restored is a hope, not a backup.

## Rotating `BLOG0_SESSION_SECRET`

The database stores only `HMAC-SHA256(secret, token)` of each session, so a new secret
invalidates **every** session: all admins must sign in again. No data is lost (articles, media,
subscribers and accounts are untouched; passwords are argon2 hashes, independent of the secret).
Rotate on a schedule or at once if the secret may have leaked:

1. `openssl rand -base64 48` → store it as the new `BLOG0_SESSION_SECRET` in the secret store.
2. Replace **all** web containers with the new value (instances with different secrets would
   reject each other's sessions — do not run a mixed fleet longer than the rollout).
3. Optional cleanup of the now-dead rows: `psql "$BLOG0_DATABASE_URL" -c 'delete from session'`.
4. Sign in again at `/admin/login`.

## Health endpoints

| Endpoint | Meaning | Use |
|---|---|---|
| `GET /api/health/live` | 200 `{"status":"live",…,"shuttingDown":…}` whenever the process answers; never touches the DB (also 200 during the shutdown drain) | **liveness** probe (restart when it fails) and the image's Docker `HEALTHCHECK` (every 10 s) |
| `GET /api/health/ready` | 200 `{"status":"ready","db":"ok",…,"migrations":{"pending":0,…}}` when the DB answers within 3 s, no migration is pending and the process is not shutting down; else 503 `NOT_READY` with `details.reason` = `DB_UNAVAILABLE` \| `MIGRATIONS_PENDING` \| `SHUTTING_DOWN` | **readiness** probe (route traffic only when it passes) |
| `GET /api/health` | the pre-Phase-5 summary (`status`, `db`, latency, version, uptime) | humans / uptime monitors |

Probe settings: liveness every **10 s** (timeout 3 s, 3 failures), readiness every **5 s**
(timeout 3 s). On SIGTERM the server flips ready to 503 at once, stops accepting connections,
drains in-flight requests for up to `BLOG0_SHUTDOWN_TIMEOUT_MS` (8 s), closes the DB pool and exits
143 (1 if the deadline was hit). The platform's **stop grace period must be ≥ timeout + 2 s**
(Docker's default 10 s fits the 8 s default). A TLDR Generate call can take up to 120 s: if a
deploy must never cut one, raise `BLOG0_SHUTDOWN_TIMEOUT_MS` (e.g. 120000) and the grace period
with it (`docker run --stop-timeout 125`).

### Logs

The server writes one JSON object per line to stdout (collect with your platform's log driver;
`docker logs blog0`), and also to `BLOG0_LOG_FILE` when set. Useful events: `app.boot` (port,
site, DB engine), `api.request` (method, path, status, latency, request id — also in the
`x-request-id` response header), `llm.call` (model, prompt version, tokens, cost, outcome),
`app.shutdown` (`phase: draining` → `phase: closed, outcome: drained|timeout`). Secrets, cookies
and API keys are never logged. Level: `BLOG0_LOG_LEVEL` (default `info`).

## Reverse proxy

Terminate TLS in a reverse proxy / load balancer (Caddy, nginx, Traefik, a platform ingress) and
forward to container port 3410:

- **`BLOG0_PUBLIC_BASE_URL=https://<your host>`** — the session cookie gets `Secure`, responses
  get `Strict-Transport-Security: max-age=31536000; includeSubDomains`, and the CSP adds
  `upgrade-insecure-requests`. Mutating API calls must arrive with an `Origin` equal to this
  origin (or the request's own `Host`) — keep the `Host` header when proxying.
- **`BLOG0_TRUSTED_PROXY_HOPS`** = the number of proxies in front of the app that append to
  `X-Forwarded-For` (one proxy → `1`; a CDN in front of it → `2`). The sign-in throttle and the
  newsletter per-IP cap key on that entry from the right. Leave `0` only when nothing proxies
  (then forwarded headers are ignored and the per-IP newsletter cap is skipped). Too high a value
  lets clients spoof their IP.
- **Upload body limit ≥ `BLOG0_MAX_AUDIO_MB` + 1 MB** (default 51 MB; nginx
  `client_max_body_size 51m;`).
- **Read timeout ≥ 120 s** (TLDR Generate is one long request; nginx `proxy_read_timeout 120s;`).
- Do not strip `Range` / `Content-Range` (audio seeking uses 206 responses on `/media/…`).

Minimal Caddy example (automatic TLS):

```caddy
blog.example.com {
  request_body {
    max_size 51MB
  }
  reverse_proxy 127.0.0.1:3410 {
    transport http {
      read_timeout 120s
    }
  }
}
```
