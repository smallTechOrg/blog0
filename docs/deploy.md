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
| `BLOG0_OPENROUTER_BASE_URL` | optional | — | no | default `https://openrouter.ai/api/v1` (only `pnpm check:openrouter` uses it) |
| `BLOG0_OPENROUTER_DECISIONS_URL` | optional | — | no | the Jev endpoint; default `https://openrouter.ai/api/alpha/decisions` |
| `BLOG0_JEV_MODEL` / `BLOG0_JEV_TIMEOUT_MS` | optional | — | no | Jev = the decisions model, default `typesafe/jev-1.13` (no fallback) / `45000` per request |
| `BLOG0_MAX_AUDIO_MB` / `BLOG0_MAX_AUDIO_MINUTES` / `BLOG0_MAX_IMAGE_MB` | optional | — | no | upload limits, default `50` / `30` / `8` |
| `BLOG0_LOG_LEVEL` | optional | — | no | `debug` \| `info` (default) \| `warn` \| `error` |
| `BLOG0_LOG_FILE` | optional | — | no | also append JSON log lines to this path (stdout always gets them) |
| `BLOG0_SMTP_HOST` | for real confirmation mail | — | no | the SMTP relay for confirmation + test emails (see [Newsletter](#newsletter)); unset → the recording stub (nothing is delivered; one `newsletter.mail_not_configured` warning) |
| `BLOG0_SMTP_PORT` | optional | — | no | default `587` (STARTTLS required); `465` → implicit TLS |
| `BLOG0_SMTP_USER` / `BLOG0_SMTP_PASS` | with an authenticating relay | — | `PASS`: **yes** | set both, or both empty for an IP-allowlisted relay |
| `BLOG0_SMTP_FROM` | with `BLOG0_SMTP_HOST` | — | no | `Name <address>` on the domain the DNS records cover, e.g. `blog0 <newsletter@example.com>` |
| `BLOG0_NEWSLETTER_SENDER` | for real issues: `listmonk` | — | no | `listmonk` \| `stub` (default; issues recorded, never delivered) |
| `BLOG0_LISTMONK_URL` / `BLOG0_LISTMONK_API_USER` / `BLOG0_LISTMONK_LIST_ID` | with sender `listmonk` | — | no | Listmonk base URL as the container reaches it (e.g. `http://listmonk:9000`), the API user, the list id |
| `BLOG0_LISTMONK_API_TOKEN` | with sender `listmonk` | — | **yes** | the API user's token |
| `BLOG0_NEWSLETTER_WEBHOOK_SECRET` | optional | — | **yes** | ≥ 24 chars (`openssl rand -base64 32`); unset → `POST /api/newsletter/webhook` answers 404 |
| `BLOG0_UNSUBSCRIBE_SECRET` | optional | session secret | **yes** | ≥ 24 chars (`openssl rand -base64 32`); signs **new** unsubscribe links, verified before the session secret. Set it once, before the first issue, so a later session-secret rotation leaves mailed links working. See [Rotating the secrets](#rotating-blog0_session_secret) |
| `BLOG0_HEARTBEAT_BACKUP_URL` / `BLOG0_HEARTBEAT_TICK_URL` | optional (validated at boot) | — | **yes** (the URL is the credential) | absolute http(s) dead-man's-switch URLs pinged by `pnpm backup` / `pnpm newsletter:tick` — see [Heartbeats](#heartbeats) |
| `BLOG0_STORAGE_DIR` | baked in: `/data/storage` | — | no | do not change; mount the volume there |
| `PORT` / `HOSTNAME` / `NODE_ENV` | baked in: `3410` / `0.0.0.0` / `production` | — | no | map a host/ingress port to 3410 instead of changing `PORT` |

Not read by the web server: `BLOG0_TEST_DATABASE_URL`, `BLOG0_PORT`, `BLOG0_DIST_DIR`,
`BLOG0_STANDALONE`, `BLOG0_NEW_ADMIN_PASSWORD` (only by `node reset-password.mjs` —
[Reset an admin password](#reset-an-admin-password)), `BLOG0_E2E_*`, `BLOG0_REQUIRE_REAL_KEY`,
`BLOG0_CONTAINER_BUILD`, `BLOG0_LISTMONK_PORT`, `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD`
(local scripts and tests only; the last two are read by Listmonk's own first install).

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
   # <db>: applied 0002_newsletter
   # <db>: applied 0003_newsletter_prune_fix
   # <db>: applied 0004_newsletter_erasure
   # <db>: applied 0005_newsletter_erase_delete
   # release: blog0 @ PostgreSQL 18.x — 6 applied (latest 0005_newsletter_erase_delete), 0 pending: OK
   # site blog0 ok (created), admin <masked email> ok (created)
   ```

   Re-running it is safe (`already up to date`, `ok`). Afterwards remove `BLOG0_ADMIN_PASSWORD`
   from wherever you stored it; add more admins with
   `pnpm admin:create --email … --name …` from the ops checkout (password from
   `BLOG0_NEW_ADMIN_PASSWORD`).

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
   # {"ok":true,"data":{"status":"ready","db":"ok",…,"migrations":{"applied":4,"pending":0,…}}}
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
both files; written last — a directory without it is not a backup). Every table is in it —
including the six newsletter tables (`newsletter_subscriber`, `newsletter_subscriber_event`,
`newsletter_suppression`, `newsletter_issue`, `newsletter_issue_event`, `newsletter_message`):
the list, its proof of consent and the suppression ledger. Throttle windows
(`rate_limit_bucket`) are not backed up (schema only). The **Listmonk database is not** — see
[Newsletter → Backups](#newsletter-backups). A named Docker volume is readable at
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

### Heartbeats

A cron job that silently stops (host rebooted, crontab lost, `pg_dump` upgraded away) is worse
than one that fails loudly. Give each scheduled job a dead-man's switch — e.g. a free
[healthchecks.io](https://healthchecks.io) check per job (period 1 day + grace 2 h for the backup;
1 h + 30 min for the tick) — and put its ping URL in the job's environment (`.env` of the ops
checkout):

```bash
BLOG0_HEARTBEAT_BACKUP_URL=https://hc-ping.com/<uuid-of-the-backup-check>
BLOG0_HEARTBEAT_TICK_URL=https://hc-ping.com/<uuid-of-the-tick-check>
```

- `pnpm backup` sends `GET <url>` after a successful backup and `GET <url>/fail` after a failed one;
  `pnpm newsletter:tick` does the same with its own URL (a tick with any failed step counts as
  failed). Missed pings → the service alerts you; a `/fail` ping alerts at once.
- 5 s timeout; the ping **never changes the job's exit code**. Each ping logs one `ops.heartbeat`
  line (`job`, `signal`, `outcome` = `ok` | `http_error` | `timeout` | `network_error` |
  `invalid_url`, `status`, `ms`) — never the URL, which embeds the check's secret uuid. Treat both
  values as secrets.
- A usage error (exit 2) pings nothing. An invalid value (not an absolute http(s) URL) makes the
  web server refuse to boot (aggregated config error) and makes a script log `invalid_url` once
  while the job itself still runs. Services without the healthchecks.io `/fail` convention answer
  it with a 404 (logged `http_error`) — harmless.
- Prove it: `pnpm backup -- --out var/backups` → the backup check turns green.

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

## Reset an admin password

Forgotten password, or a password that may have leaked (Stage A — there is no email reset):

```bash
# in the production container (the image carries the bundled CLI):
docker exec -it blog0 node reset-password.mjs --email you@example.com
# → New password (12–200 characters): ****   Repeat the new password: ****
# password reset for y***@example.com · 2 sessions ended

# non-interactive (e.g. a platform "run command"): pass the password in the environment
docker exec -e BLOG0_NEW_ADMIN_PASSWORD='<new password>' blog0 node reset-password.mjs --email you@example.com

# from an ops checkout (or designer mode — pglite:// works here, not in the image):
BLOG0_NEW_ADMIN_PASSWORD='<new password>' pnpm admin:reset-password --email you@example.com
```

What it does, in one transaction: sets the new password (argon2id), **ends every session of that
admin** (all their browsers are signed out) and clears the email's sign-in delay (below). It prints
only the masked email and the number of sessions ended — never the password — and logs
`auth.password_reset`. Exit 1: no admin with that email in `BLOG0_SITE_SLUG`'s site (nothing
changes); exit 2: a password outside 12–200 characters, no `--email`, or no password source (set
`BLOG0_NEW_ADMIN_PASSWORD` or run with a terminal — `docker exec -it`). Prefer the prompt: an
environment variable can end up in shell history.

### Sign-in throttling (why an attacker can't lock you out)

Knowing the admin email is not enough to lock the owner out. After 5 attempts for one email
(since its last successful sign-in), every further attempt must wait 1 s, then 2, 4, 8, 16, 32 and
at most 60 s after the previous one; an attempt inside the wait is refused ("Too many attempts — try
again in N seconds.", `429` + `Retry-After`) without the password being checked, and the **right
password after the wait signs in**. 15 quiet minutes reset the count. With a real client IP
(`BLOG0_TRUSTED_PROXY_HOPS` set behind a proxy) there are also hard caps: 5 failures per (email, IP)
and 50 per IP within 15 minutes. The delay is stored in Postgres (`rate_limit_bucket`, scope
`login.delay`), so it holds across restarts and instances; `auth.login` log lines carry the
`scope` of every refusal. A reset (above) clears the email's delay immediately.

## Rotating `BLOG0_SESSION_SECRET`

(Two secrets matter here: `BLOG0_SESSION_SECRET` and the optional `BLOG0_UNSUBSCRIBE_SECRET`; the
last step below and [Rotating `BLOG0_UNSUBSCRIBE_SECRET`](#rotating-blog0_unsubscribe_secret) say
what each one breaks.)

The database stores only `HMAC-SHA256(secret, token)` of each session, so a new secret
invalidates **every** session: all admins must sign in again. No data is lost (articles, media,
subscribers and accounts are untouched; passwords are argon2 hashes, independent of the secret).
Rotate on a schedule or at once if the secret may have leaked:

1. `openssl rand -base64 48` → store it as the new `BLOG0_SESSION_SECRET` in the secret store.
2. Replace **all** web containers with the new value (instances with different secrets would
   reject each other's sessions — do not run a mixed fleet longer than the rollout).
3. Optional cleanup of the now-dead rows: `psql "$BLOG0_DATABASE_URL" -c 'delete from session'`.
4. Sign in again at `/admin/login`.
5. **Newsletter:** without `BLOG0_UNSUBSCRIBE_SECRET` the session secret also signs every
   subscriber's unsubscribe link, so links in emails already delivered stop working (they open a
   "not found" page). **With `BLOG0_UNSUBSCRIBE_SECRET` set, links signed with it keep working** —
   only links signed with the old session secret (issues sent before you set it) break. Either way
   with Listmonk re-sync at once so future issues carry fresh links: `pnpm newsletter:sync` from the
   ops checkout (expect `… N changed` with N = the confirmed subscribers) or **Site → Newsletter →
   Sync to Listmonk**. Confirmation links are unaffected (they are random tokens, stored hashed).

## Rotating `BLOG0_UNSUBSCRIBE_SECRET`

Setting it for the first time is harmless: new links are signed with it, and verification tries it
first and the session secret second, so every link already mailed keeps working. **Changing or
removing it breaks the links signed with the old value** (an unsubscribe link in an already-delivered
issue then shows "not found"; the reader can still use the footer or reply to the contact address).
Rotate it only if it leaked: set the new value on **all** web containers, run
`pnpm newsletter:sync` (or **Site → Newsletter → Sync to Listmonk**) so future issues carry links
signed with it, and accept that older mail's links stop working. Keep the two secrets different, so a
session-secret rotation never touches unsubscribe links.

## Newsletter

Product rules: `spec/capabilities/newsletter-list.md`, `spec/capabilities/newsletter-issues.md`;
mechanics: `spec/architecture.md` §12.6, §13.

**blog0 is the source of truth.** Subscribers, their proof of consent (consent text + version,
timestamps, IP, user agent, source page) and the append-only suppression ledger live in blog0's
database. Listmonk is only the sender: blog0 pushes confirmed subscribers into **one** Listmonk
list, blocklists the suppressed ones, and starts each issue there as a campaign. Nothing flows
from Listmonk into blog0 except unsubscribes/bounces (hourly poll) and campaign stats.

Two mail paths, both through the SMTP relay you choose below:

| Path | Who sends | Configured in |
|---|---|---|
| **Transactional** — the double opt-in confirmation email, the admin's test issue | blog0 (nodemailer) | `BLOG0_SMTP_*` env vars of the web container |
| **Issues** — bulk campaigns to confirmed subscribers | Listmonk | Listmonk admin → Settings → SMTP |

Double opt-in: a footer signup stores a `pending` row and emails a confirmation link (valid 72 h,
at most 3 sends per address per day); only the click makes it `confirmed`, and only `confirmed`
subscribers are synced to Listmonk. Listmonk never sends its own opt-in (the list is single
opt-in on purpose — blog0 already did it). Without `BLOG0_SMTP_HOST` the web server keeps working
but **no confirmation email leaves the server** (the stub records it and logs one
`newsletter.mail_not_configured` warning) — configure SMTP before announcing the form.

### SMTP relay — two documented options (pick one; this runbook does not)

Both use port **587 with STARTTLS** and must be allowed to send as the `BLOG0_SMTP_FROM` domain.
Use the **same relay and From domain** for blog0 and for Listmonk so one set of DNS records covers
both.

**Option A — Google Workspace SMTP relay** (`smtp-relay.gmail.com:587`, TLS). In the Workspace
Admin console → Apps → Google Workspace → Gmail → Routing → **SMTP relay service** → Add: allowed
senders "Only addresses in my domains"; authentication **either** "Only accept mail from the
specified IP addresses" (add the egress IPs of the blog0 and Listmonk hosts) **or** "Require SMTP
Authentication" (a Workspace account in your domain; with 2-Step Verification use an app
password); tick "Require TLS encryption". Check Google's relay sending limits against the list
size.

```bash
# blog0.env — IP-allowlisted relay (no credentials)
BLOG0_SMTP_HOST=smtp-relay.gmail.com
BLOG0_SMTP_PORT=587
BLOG0_SMTP_USER=
BLOG0_SMTP_PASS=
BLOG0_SMTP_FROM=blog0 <newsletter@example.com>
# … or with SMTP authentication instead:
# BLOG0_SMTP_USER=<workspace-user@example.com>
# BLOG0_SMTP_PASS=<app-password>
```

**Option B — Brevo SMTP** (`smtp-relay.brevo.com:587`, STARTTLS). In Brevo: add and
**authenticate the sending domain** (Senders, Domains & Dedicated IPs → Domains — it shows the DNS
records), then SMTP & API → SMTP → **Generate a new SMTP key**. The login is the SMTP login shown
on that page (not your account email); the password is the SMTP key.

```bash
# blog0.env
BLOG0_SMTP_HOST=smtp-relay.brevo.com
BLOG0_SMTP_PORT=587
BLOG0_SMTP_USER=<brevo-smtp-login>
BLOG0_SMTP_PASS=<brevo-smtp-key>
BLOG0_SMTP_FROM=blog0 <newsletter@example.com>
```

Prove it: sign up with your own address on the public site → the email arrives → the link opens
"You’re confirmed — welcome to <brand>." (it confirms on open). The web log has `"event":"newsletter.mail"` with `"transport":"smtp"` and
`"outcome":"sent"` (an `"outcome":"failed"` line carries the relay's error; the signup itself still
succeeds and the admin can resend from the subscriber page).

The signup form tells the reader what happened (`delivery` in the response): "Almost there — check
your inbox and confirm." when the SMTP relay accepted the confirmation; "Signup recorded — this
environment doesn't send email." while `BLOG0_SMTP_HOST` is unset (the stub); "We couldn't send your
confirmation email — please try again shortly." when the relay refused it (the pending signup is
kept). Addresses that send nothing (already confirmed, over the 3-per-day cap, suppressed) get the
environment's success answer, so the form never reveals who is subscribed. Bots are dropped
silently before anything is counted or stored: a filled hidden `website` field, or a submission
less than 2 s after the form appeared, gets the same success answer and one
`newsletter.signup_dropped` log line (`reason` `honeypot` | `too_fast`, never the email).

### DNS for the From domain (SPF, DKIM, DMARC)

Without these, Gmail/Yahoo/Outlook junk or reject the mail. All records are on the domain of
`BLOG0_SMTP_FROM` (and of Listmonk's From address — keep them the same):

| Record | Google Workspace relay | Brevo |
|---|---|---|
| **SPF** (TXT on `example.com`; one SPF record per name — merge `include:`s if one exists) | `v=spf1 include:_spf.google.com ~all` | `v=spf1 include:spf.brevo.com ~all` |
| **DKIM** | Admin console → Apps → Gmail → **Authenticate email** → generate → publish the `google._domainkey` TXT it shows → **Start authentication** | the DKIM records Brevo shows when you authenticate the domain (publish exactly what it lists) |
| **DMARC** (TXT on `_dmarc.example.com`) | `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com` | same |

Start DMARC at `p=none`, read the aggregate reports for a couple of weeks, then move to
`p=quarantine` once SPF/DKIM pass for every legitimate sender. Check a delivered message's headers
for `spf=pass`, `dkim=pass`, `dmarc=pass`.

### Listmonk beside blog0

`docker-compose.yml` is the reference shape: one Postgres **instance**, Listmonk in **its own
database** with its own role (`scripts/compose/init-db.sh` does exactly this for the local stack),
Listmonk pinned to `listmonk/listmonk:v5.1.0`, blog0 reaching it on the private network as
`http://listmonk:9000`. For production:

1. **Database** — on the blog0 Postgres instance, as a superuser (a strong password, not the dev
   `listmonk`):

   ```bash
   psql "$ADMIN_URL" -c "CREATE ROLE listmonk LOGIN PASSWORD '<listmonk-db-password>'" -c 'CREATE DATABASE listmonk OWNER listmonk'
   ```

2. **Run Listmonk** with the compose service's `command` (install once, idempotent; upgrade; serve)
   and environment, changing: `LISTMONK_db__host` / `__password` (and `__ssl_mode` if the DB needs
   TLS) to your instance, `LISTMONK_app__root_url` to Listmonk's **public https URL** (e.g.
   `https://lists.example.com` — its own unsubscribe/tracking pages use it), and the first-run
   admin `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD` (a strong password from your secret
   store; it is only read by the first `--install`). Put it behind the same TLS reverse proxy;
   restrict `/admin` to operators if you can.

3. **Admin user** — sign in at `https://lists.example.com/admin` with that admin. It is for
   operators only; blog0 never uses it.

4. **API user + token** — Listmonk v5: admin UI → **Users** → **New** → type **API user**
   (username e.g. `blog0`, a role that may read and manage subscribers, lists, campaigns,
   templates and bounces — the local stack uses the install's Super Admin role). The token is
   shown **once** → store it as `BLOG0_LISTMONK_API_TOKEN`, the username as
   `BLOG0_LISTMONK_API_USER`. The same steps as API calls (admin login → `GET /api/roles/users` →
   `POST /api/users {type:'api', …}` → `data.password` is the token) are automated, for the local
   stack, in `scripts/listmonk-dev.sh` (`pnpm listmonk:up`; its header lists the procedure).

5. **List** — from the ops checkout, with `BLOG0_LISTMONK_URL` (as reachable from that host),
   `BLOG0_LISTMONK_API_USER` and `BLOG0_LISTMONK_API_TOKEN` set:

   ```bash
   pnpm newsletter:sync -- --create-list
   # list blog0 created: id <n> — set BLOG0_LISTMONK_LIST_ID=<n>
   ```

   It creates (or finds) the private, single opt-in list `blog0`. blog0 never sends to any other
   list.

6. **Template** — nothing to do: on the first send blog0 creates the campaign template
   `blog0-issue` (`{{ template "content" . }}` — the issue HTML carries the whole layout, the
   unsubscribe link and the consent line as subscriber-attribute expressions). Do not edit or
   delete it.

7. **SMTP inside Listmonk** — admin → Settings → **SMTP**: the relay you chose above
   (`smtp-relay.gmail.com` or `smtp-relay.brevo.com`, port `587`, TLS **STARTTLS**, auth `none`
   for an IP-allowlisted Workspace relay or `login` with the same user/password or SMTP key, HELO
   hostname = your sending host's name). Settings → General: the default **From** address on the
   same domain as `BLOG0_SMTP_FROM`. Use Listmonk's **Test connection**, then send a campaign to
   yourself.

   > **Dev vs test Listmonk.** Locally, the compose **dev** Listmonk (`pnpm listmonk:up`, :9000) may
   > carry this real relay — anything sent from it is delivered. The automated tests never touch it:
   > they run on the **test** stack (`pnpm listmonk:test-up`: `listmonk-test` on :9001, database
   > `listmonk_test`, SMTP → **Mailpit** `mailpit:1025` only, inbox at <http://127.0.0.1:8025>) and
   > refuse to start against any Listmonk whose enabled SMTP is not that sink. Never point
   > `var/listmonk-test.env` or CI at a Listmonk with a real relay.

8. **Point blog0 at it** — add to the web container's env and restart it:

   ```bash
   BLOG0_NEWSLETTER_SENDER=listmonk
   BLOG0_LISTMONK_URL=http://listmonk:9000
   BLOG0_LISTMONK_API_USER=blog0
   BLOG0_LISTMONK_API_TOKEN=<token>
   BLOG0_LISTMONK_LIST_ID=<n>
   ```

   **Site → Newsletter** now reads "Sender: **Listmonk** · list blog0 · healthy". Opens and clicks
   are counted only when Listmonk's **root URL** (`LISTMONK_app__root_url`, Settings → General →
   Root URL) is a public host that readers' mail clients can reach; with `localhost`, a private IP
   or a single-label name (`listmonk`) the issue page notes that opens can't be counted (blog0 reads
   the root URL via `GET /api/settings` — the API user needs `settings:get`; else it falls back to
   `BLOG0_LISTMONK_URL` — and re-checks every 10 minutes). Push the existing
   confirmed subscribers once: **Sync to Listmonk** there, or `pnpm newsletter:sync` from the ops
   checkout (`synced N, blocklisted N, skipped N, N changed`; a second run `… 0 changed`). Every
   send syncs again first.

9. **Subscribers from before double opt-in** (migration `0002_newsletter` marks them
   `legacy_unconfirmed`; they never receive issues): once SMTP works, **Site → Newsletter → Send
   confirmation to all legacy** — each address gets one confirmation email, ever.

### Unsubscribes and bounces back into blog0

- **blog0's own link** — every issue and confirmation email links to
  `/newsletter/unsubscribe?t=…` (confirmation emails also carry `List-Unsubscribe` +
  one-click `List-Unsubscribe-Post`). That writes the suppression in blog0 and blocklists the
  address in Listmonk at once.
- **Hourly poll** — `pnpm newsletter:tick` pulls Listmonk's **blocklisted** subscribers and
  **hard bounces / complaints** since the last tick into blog0's suppression ledger (source
  `provider`), refreshes the stats of issues sent in the last 30 days, creates the digest draft
  when it is due (sends it only with auto-send on), and prunes IPs older than 12 months. blog0 has
  no in-process timer — schedule it. It runs from the ops checkout (the image does not carry the
  script), with a `.env` holding the **same values as the web server** (it validates the whole
  config: `BLOG0_DATABASE_URL`, `BLOG0_SESSION_SECRET`, `BLOG0_OPENROUTER_API_KEY`,
  `BLOG0_PUBLIC_BASE_URL`, `BLOG0_SITE_SLUG`, `BLOG0_NEWSLETTER_SENDER`, `BLOG0_LISTMONK_*` with a
  URL reachable from that host), mode 0600, and the checkout at the deployed version:

  ```cron
  7 * * * * cd /srv/blog0-repo && pnpm -s newsletter:tick >> /var/log/blog0-newsletter-tick.log 2>&1
  # optional: BLOG0_HEARTBEAT_TICK_URL in the checkout's .env → alerts when the tick stops or fails (see Heartbeats)
  # digest: not due; suppressions pulled 0; stats refreshed 1; ips pruned 0; erasures retried 0
  ```

  Exit 1 = a step failed (the others still ran; the error lines follow) — alert on it.
- **Bounce processing in Listmonk** — admin → Settings → **Bounces**: enable it (a bounce mailbox
  over POP, or a supported provider webhook) so hard bounces exist for the poll to pull. Settings →
  Privacy: keep "Allow blocklisting" on so a subscriber who unsubscribes on Listmonk's own page
  can blocklist themselves. **Caution:** an unsubscribe that Listmonk records only at list level
  (subscription `unsubscribed`, subscriber not blocklisted) is not pulled by the poll, and the next
  sync re-adds a confirmed blog0 subscriber's membership — blog0's own footer link is the
  unsubscribe path that always holds.
- **Webhook** (optional) — for a relay or automation that can POST JSON:

  ```bash
  curl -fsS -X POST https://blog.example.com/api/newsletter/webhook \
    -H "Authorization: Bearer $BLOG0_NEWSLETTER_WEBHOOK_SECRET" -H 'content-type: application/json' \
    -d '{"event":"bounce","email":"reader@example.org","reason":"550 mailbox unavailable","providerRef":"<id>"}'
  # {"ok":true,"data":{"accepted":true}}      ← false (and nothing written) for an unknown address
  ```

  `event` is `unsubscribe` | `bounce` | `complaint`. Set `BLOG0_NEWSLETTER_WEBHOOK_SECRET`
  (≥ 24 chars, `openssl rand -base64 32`) on the web server; unset, the endpoint answers 404; a
  wrong secret answers 401 `WEBHOOK_UNAUTHORIZED`. Idempotent. Listmonk itself does not call it.

### Consent records and IP retention

- Every subscriber keeps its consent text + version, signup/confirmation timestamps, user agent,
  source page and (behind a trusted proxy, `BLOG0_TRUSTED_PROXY_HOPS`) IP. Events and suppression
  entries are append-only; a suppression is never removed, so an unsubscribed address is never
  mailed again unless the person signs up and confirms anew.
- **IPs are kept 12 months**, then nulled by `pnpm newsletter:tick` (event `ip_pruned`): the
  subscriber's IPs 12 months after its latest consent or confirmation (a re-signup restarts the
  clock for the IP it records; an old confirmation's IP still ages out on its own date), and each
  event's IP 12 months after that event. Without the hourly cron the prune does not run.
- Proof of consent on request: `/admin/subscribers` → the subscriber page, or **Export audit
  (JSON)** (every subscriber, event and suppression). Listmonk holds a copy of the consent fields
  as subscriber attributes, but blog0's export is the record.

### Handling an erasure request

A reader asks (by mail to the contact address shown on `/privacy`) to have their data erased.
**Owner decision (2026-10-19): erasing personal data deletes the subscriber.** blog0 keeps only a
non-reversible "never email this address" marker (a keyed hash) and a PII-free audit row.

1. **Verify the requester** — reply from, or ask them to confirm from, the address in question;
   never erase on an unverified claim.
2. Admin → **Subscribers** → open the address → **Delete subscriber and personal data**. Type the
   address to confirm and press **Delete**. You land back on the Subscribers list with a
   confirmation that names what happened to the Listmonk copy; the person is no longer in the list,
   the CSV or the audit export. If something fails, the dialog stays open and names the failure
   (a database refusal deletes nothing — try again).
3. What it does, in one transaction (`newsletter_erase_subscriber`, migration `0005`): the
   subscriber row, its events, its suppression entries and its stored messages are **deleted**
   (and any older erased record of the same address). What stays: a marker in
   `newsletter_erasure_marker` — `sha256(site salt : address)`, never the address — and one row in
   `newsletter_erasure_log` (when, which admin, which marker, how many rows were deleted, the Listmonk
   outcome) as proof the request was honoured; the audit export lists it without the hash. Issue
   statistics keep their counts. If the same address signs up again it is **not** a clean slate: it
   needs a fresh double opt-in (its signup event says `erasedBefore`), and an import or script can
   never re-add it as confirmed — the database refuses. Deleting it again works the same way.
4. **Confirm the log line**: `newsletter.erase` with `outcome: "deleted"` and `provider:` `deleted`
   (removed from Listmonk), `not_found` (Listmonk held no copy — done), `skipped` (stub sender) or
   `failed` (a `warn`). The line never contains the address.
5. **Listmonk:** blog0 deletes the subscriber there after its own erase has committed, so a Listmonk
   outage never leaves blog0 half-done. On `failed` with `provider_retry: true`, the hourly
   `pnpm newsletter:tick` retries the delete by the remembered Listmonk id (`erasures retried N`);
   with `provider_retry: false` (Listmonk was unreachable and blog0 never knew its id) delete the
   subscriber in Listmonk's admin by hand (Subscribers → search → Delete).
6. **Backups made before the erasure still hold the data** until they expire — delete or rotate
   them per your backup policy (see [Backups](#backups)); a restore of such a backup brings the
   address back, so redo the erase after any restore and keep a note of erasures made (the
   `newsletter_erasure_log` rows of a newer backup are the record).
7. Reply to the requester. The seeded `/privacy` text is a plain-language **draft**: review and
   edit it in Admin → Site → Privacy text, and set Admin → Site → Newsletter postal address (issues
   and confirmation mail print it; sending without one only warns).

Upgrading from `0004`: migration `0005` converts every earlier erasure (the old
`erased+<hash>@erased.invalid` rows) into this state — rows deleted, marker kept, an audit row with
`source: migration` dated at the original erasure.

Residue by design: the throttle table `rate_limit_bucket` keeps only SHA-256 hashes of IPs and
addresses for up to an hour (fixed windows; excluded from backups), and `site.newsletter_erase_salt`
(in the `site` row, inside every backup) must survive restores — marker matching depends on it.

### Newsletter backups

`pnpm backup` covers the blog0 database, which includes the whole list, its consent records and
the suppression ledger (see [Backups](#backups); `rate_limit_bucket` is excluded). The
**Listmonk database is separate** and not in it. Losing it loses only campaign history and stats —
the subscribers are rebuilt from blog0 with `pnpm newsletter:sync` (a fresh Listmonk also needs
steps 4–5 and the SMTP settings again). To keep the history, dump it on the same schedule:

```bash
pg_dump -Fc -d 'postgres://listmonk:…@<host>:5432/listmonk' -f /srv/backups/listmonk-$(date -u +%Y%m%dT%H%M%SZ).dump
```

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
