# Deploying blog0 on Google Cloud (VM + Docker + Cloud SQL)

The production runbook for the owner's chosen shape: **one Compute Engine VM** running the
`deploy/docker-compose.prod.yml` stack (blog0, release step, scheduler, Listmonk, Caddy, Cloud SQL
Auth Proxy), **Cloud SQL for PostgreSQL** (blog0 and Listmonk in separate databases on one
instance), media backed up to a **GCS bucket**, mail through **Google Workspace**
(`smtp.gmail.com:587` + an app password). Rules behind every choice: `spec/architecture.md` §12.7.
The generic container runbook (every `BLOG0_*` variable, secret rotation, erasure requests, health
endpoints, logs) is [`docs/deploy.md`](deploy.md) — this file does not repeat it.

> **OWNER-RUN** marks every block that creates, changes or deletes a cloud resource, a DNS record
> or a Workspace setting (it costs money or affects mail). Run those yourself, in order, after
> reading them. Unmarked blocks are read-only or run on the VM against the stack itself.

Prove the kit on your laptop first (Docker running, e.g. `colima start`):

```bash
pnpm deploy:local          # the whole prod stack locally (Postgres stand-in for Cloud SQL, Mailpit for SMTP) → "deploy-local: PASS"
pnpm pg:compat -- 18       # the integration suite on postgres:18 (the Cloud SQL major) → "pg-compat: PostgreSQL 18 PASS"
```

## Owner inputs required

Fill these in before step 1; every command below reads them from your shell.

- [ ] **Project** — a GCP project id with **billing enabled** (`PROJECT_ID`).
- [ ] **Region / zone** — one region for VM, Cloud SQL and bucket (`REGION`, e.g. `europe-west1`;
      `ZONE`, e.g. `europe-west1-b`).
- [ ] **Domain** — the blog's host (`DOMAIN`, e.g. `blog.example.com`) and the newsletter tracking
      host (`NEWS_DOMAIN`, e.g. `news.blog.example.com`), both in a DNS zone you can edit.
- [ ] **Mail domain** — the domain the From address uses (`MAIL_DOMAIN`, e.g. `example.com`;
      it must be a Google Workspace domain you administer).
- [ ] **Sending mailbox** — a dedicated Workspace user, e.g. `newsletter@example.com` (`MAILBOX`):
      2-Step Verification on, an app password, POP on (section 7).
- [ ] **ACME / ops email** — receives Let's Encrypt notices (`ACME_EMAIL`).
- [ ] **DMARC report address** — e.g. `dmarc@example.com` (`DMARC_RUA`).
- [ ] **OpenRouter API key** — for Jev (TLDR Generate); goes only into `deploy/blog0.env` on the VM.
- [ ] **First admin** — email + a password ≥ 12 characters for blog0's `/admin`.
- [ ] **Repo access from the VM** — the repo URL; a read-only deploy key if it is private.
- [ ] **Heartbeat URLs** (optional, recommended) — two dead-man's-switch checks (backup daily,
      tick hourly), e.g. healthchecks.io.

```bash
# On your laptop (or Cloud Shell), once per terminal. Names are suggestions; keep them consistent.
export PROJECT_ID=your-project-id
export REGION=europe-west1
export ZONE=europe-west1-b
export DOMAIN=blog.example.com
export NEWS_DOMAIN=news.blog.example.com
export MAIL_DOMAIN=example.com
export MAILBOX=newsletter@example.com
export ACME_EMAIL=ops@example.com
export DMARC_RUA=dmarc@example.com
export VM=blog0-vm
export INSTANCE=blog0-pg
export BUCKET="${PROJECT_ID}-blog0-media"
export SA_NAME=blog0-vm
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud config set project "$PROJECT_ID"
```

## 1. Prerequisites — project, APIs, region

- `gcloud` installed and signed in as a project Owner (`gcloud auth login`).
- **One region for everything.** The VM talks to Cloud SQL on every request and the scheduler
  writes to the bucket nightly; same-region traffic is free and fast, cross-region adds latency
  and egress charges. Pick the region closest to your readers.

```bash
# OWNER-RUN — enables billable APIs
gcloud services enable compute.googleapis.com sqladmin.googleapis.com storage.googleapis.com \
  iam.googleapis.com iap.googleapis.com
```

`sqladmin` is required by the Cloud SQL Auth Proxy (it fetches the instance's certificates);
`iap` is for SSH through Identity-Aware Proxy.

Generate every secret once, on your laptop, into a 0600 file (never commit it, never paste it in a
chat). DB passwords are hex so they are safe inside a `postgres://` URL:

```bash
umask 077
cat > ~/blog0-secrets.env <<EOF
PG_ROOT_PW=$(openssl rand -hex 24)
BLOG0_DB_PW=$(openssl rand -hex 24)
LISTMONK_DB_PW=$(openssl rand -hex 24)
LISTMONK_ADMIN_PW=$(openssl rand -hex 24)
BLOG0_SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
BLOG0_UNSUBSCRIBE_SECRET=$(openssl rand -base64 32 | tr -d '\n')
BLOG0_NEWSLETTER_WEBHOOK_SECRET=$(openssl rand -base64 32 | tr -d '\n')
EOF
set -a; . ~/blog0-secrets.env; set +a
```

## 2. VM, static IP, firewall

**Size.** `e2-medium` (2 vCPU, 4 GB). The image is **built on the VM** (no registry yet) and
`next build` alone peaks above 2 GB; steady state (~1 GB: blog0 ~300 MB, Listmonk, Caddy, proxy,
the hourly tick ~150 MB) would fit `e2-small` (2 GB) — downsize once images are built elsewhere and
pulled. **Scopes** must be `cloud-platform`: with the default scopes the VM's token is read-only on
Cloud Storage and the media backup fails. What the VM may actually do is limited by its service
account's roles (section 4), not by the scope.

Create the service account first (section 4 grants its roles):

```bash
# OWNER-RUN — service account, static IP, VM, firewall
gcloud iam service-accounts create "$SA_NAME" --display-name="blog0 VM"

gcloud compute addresses create blog0-ip --region="$REGION" --network-tier=PREMIUM
export VM_IP="$(gcloud compute addresses describe blog0-ip --region="$REGION" --format='value(address)')"
echo "$VM_IP"

gcloud compute instances create "$VM" \
  --zone="$ZONE" --machine-type=e2-medium \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --address=blog0-ip --network-tier=PREMIUM \
  --tags=blog0-web \
  --service-account="$SA_EMAIL" --scopes=cloud-platform \
  --shielded-secure-boot --metadata=enable-oslogin=TRUE

# HTTP/HTTPS from anywhere (Caddy; port 80 also serves the ACME challenge + redirect to https)
gcloud compute firewall-rules create blog0-allow-web --network=default --direction=INGRESS \
  --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=blog0-web
# SSH only from Google's IAP range — no public SSH
gcloud compute firewall-rules create blog0-allow-iap-ssh --network=default --direction=INGRESS \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=blog0-web
# The auto-created default network allows SSH/RDP from 0.0.0.0/0 — remove those if present
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp --quiet
```

Nothing else is exposed: Listmonk binds to `127.0.0.1:9000` on the VM, Postgres is only reachable
through the proxy inside the compose network.

**Docker on the VM** (Docker Engine + the compose plugin from Docker's apt repo; Compose ≥ 2.24):

```bash
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap
# — now on the VM —
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# Bounded container logs (the default json-file driver never rotates)
echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
sudo usermod -aG docker "$USER"     # log out and back in for it to apply
# 2 GB swap: headroom for `next build` on 4 GB
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
docker compose version              # v2.24 or newer
```

## 3. Cloud SQL (PostgreSQL 18)

**Version: PostgreSQL 18** — Cloud SQL lists it as the default major with regular support since
2025-09-25 (<https://cloud.google.com/sql/docs/postgres/db-versions>, checked 2026-10-19; page
last updated 2026-10-15). CI and `pnpm pg:compat -- 18` run the suite on `postgres:18`.

**Choices.** **Enterprise** edition (Enterprise Plus is the default for new PG instances and has no
shared-core tiers — pass `--edition=enterprise`); tier **`db-g1-small`** (1.7 GB; `db-f1-micro`
allows ~25 connections, too few for blog0's pool + Listmonk's 10 + the tick); zonal; 10 GB SSD
with auto-increase; **public IP with no authorized networks** — nothing can connect except through
the Cloud SQL Auth Proxy, which authenticates with IAM; encrypted connections only; automated
daily backups (7 kept) + point-in-time recovery (7 days of logs); a weekly maintenance window.

```bash
# OWNER-RUN — creates a billed Cloud SQL instance (takes ~5–10 min)
gcloud sql instances create "$INSTANCE" \
  --database-version=POSTGRES_18 --edition=enterprise --tier=db-g1-small \
  --region="$REGION" --availability-type=zonal \
  --storage-type=SSD --storage-size=10GB --storage-auto-increase \
  --assign-ip --ssl-mode=ENCRYPTED_ONLY \
  --backup-start-time=02:00 --retained-backups-count=7 \
  --enable-point-in-time-recovery --retained-transaction-log-days=7 \
  --maintenance-window-day=SUN --maintenance-window-hour=3 \
  --deletion-protection \
  --root-password="$PG_ROOT_PW"

gcloud sql instances describe "$INSTANCE" --format='value(connectionName)'   # → PROJECT_ID:REGION:INSTANCE
```

No authorized networks are added — do not add any. The databases and users are created in
section 9 (step 9.1), through the proxy, once the VM can reach the instance: blog0's migrations
run as the **non-superuser owner** `blog0` (owner of the database and its `public` schema — the
PG 15+ rule), and Listmonk gets its own database and role. `pnpm pg:compat` proves exactly that
shape locally.

## 4. Service account roles

The VM's service account needs exactly two grants: connect to Cloud SQL (project-level role — it
covers the instance's connection, not its data; the DB passwords guard the data), and read/write
objects in the media bucket only (granted in section 5 once the bucket exists).

```bash
# OWNER-RUN — IAM
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/cloudsql.client --condition=None
```

## 5. GCS bucket (media backups)

Uniform bucket-level access (no per-object ACLs), public access prevented, **object versioning**
on, and a lifecycle rule deleting **noncurrent** versions 30 days after they stop being current —
the nightly `rclone sync` mirrors `/data/storage`, so a deleted or overwritten file stays
recoverable for 30 days.

```bash
# OWNER-RUN — bucket, lifecycle, IAM on the bucket
gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" \
  --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention

cat > /tmp/blog0-lifecycle.json <<'EOF'
{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":30}}]}
EOF
gcloud storage buckets update "gs://${BUCKET}" --versioning --lifecycle-file=/tmp/blog0-lifecycle.json

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin
```

## 6. DNS

At your DNS host (Cloud DNS or elsewhere). Create the A records **before** the first `up` — Caddy
requests the Let's Encrypt certificates on start and the ACME challenge needs them resolving.

```text
# OWNER-RUN — DNS records (TTL 300 while you set up)
DOMAIN                      A     <VM_IP>
NEWS_DOMAIN                 A     <VM_IP>
MAIL_DOMAIN                 TXT   "v=spf1 include:_spf.google.com ~all"
google._domainkey.MAIL_DOMAIN  TXT   "v=DKIM1; k=rsa; p=…"   (generated in Workspace, below)
_dmarc.MAIL_DOMAIN          TXT   "v=DMARC1; p=none; rua=mailto:DMARC_RUA"
```

- Remove any `AAAA` record on `DOMAIN` / `NEWS_DOMAIN` (the VM has no IPv6).
- **SPF**: a domain has exactly one SPF record — if one exists, add `include:_spf.google.com` to it
  instead of creating a second.
- **DKIM**: Google Admin console → Apps → Google Workspace → Gmail → **Authenticate email** →
  select `MAIL_DOMAIN` → **Generate new record** (2048-bit, selector `google`) → publish the TXT
  record shown → back there, **Start authentication**.
- **DMARC**: start at `p=none` and read the aggregate reports for a few weeks; tighten to
  `p=quarantine` once SPF + DKIM pass for everything sending as `MAIL_DOMAIN`.
- Check: `dig +short A "$DOMAIN"`, `dig +short TXT "google._domainkey.${MAIL_DOMAIN}"`.

## 7. Google Workspace (the sending mailbox)

Both blog0 (confirmation and test mails) and Listmonk (issues) send through
`smtp.gmail.com:587` (STARTTLS) as `MAILBOX` with one **app password**. GCE blocks outbound port 25
only; 587 and 995 are open.

**OWNER-RUN — Workspace settings:**

1. Admin console → Security → Authentication → **2-Step Verification**: allow users to turn it on.
2. Sign in as `MAILBOX` → myaccount.google.com → Security → turn on **2-Step Verification**, then
   **App passwords** → create one named `blog0` → the 16-character value is `SMTP_APP_PASSWORD`.
   Store it only in `deploy/blog0.env` and `deploy/listmonk.env` on the VM.
3. Admin console → Apps → Google Workspace → Gmail → End User Access → **POP and IMAP access**:
   enabled for the mailbox's org unit. As `MAILBOX`: Gmail → Settings → Forwarding and POP/IMAP →
   **Enable POP for all mail**. Gmail sets the Return-Path to the authenticated account, so bounces
   land in this mailbox; Listmonk reads them over `pop.gmail.com:995` (TLS) with the same app
   password.
4. **From address**: `BLOG0_SMTP_FROM` (and Listmonk's From) is `MAILBOX` or an alias verified on
   that mailbox ("Send mail as") — anything else is rewritten by Gmail.
5. **Limits**: a Workspace user sends at most **2 000 messages/day** (500 on a trial account).
   Listmonk is throttled to 1 800 per 24 h (`deploy/listmonk-settings.sh`) to leave room for
   blog0's confirmation mails. A list bigger than that needs a bulk relay (`docs/deploy.md` →
   Newsletter → SMTP options).

## 8. Checkout and env files on the VM

```bash
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap
# — on the VM —
sudo install -d -o "$USER" -g "$USER" /srv/blog0
git clone https://github.com/smallTechOrg/blog0.git /srv/blog0   # private repo: use a read-only deploy key
cd /srv/blog0
umask 077
cp deploy/compose.env.example deploy/compose.env
cp deploy/blog0.env.example deploy/blog0.env
cp deploy/listmonk.env.example deploy/listmonk.env
chmod 600 deploy/*.env
git status --short --ignored deploy/    # the three files must show as ignored ("!!"), never as untracked
```

Fill them in with an editor (`nano deploy/blog0.env`); every variable is documented in its
template, and the values come from `~/blog0-secrets.env` (copy them over the SSH session — do not
leave that file on the VM). The ones that differ per deployment:

| File | Variable | Value |
|---|---|---|
| `compose.env` | `CLOUD_SQL_INSTANCE` | `PROJECT_ID:REGION:INSTANCE` (the connection name from section 3) |
| `compose.env` | `BLOG0_IMAGE_TAG` | `$(git rev-parse --short HEAD)` |
| `compose.env` | `BLOG0_DOMAIN` / `NEWS_DOMAIN` / `ACME_EMAIL` | your hosts and ops email |
| `compose.env` | `MEDIA_BACKUP_DEST` | `:gcs,env_auth=true,bucket_policy_only=true:BUCKET/media` |
| `compose.env` | `CADDY_LOCAL_CERTS` | empty (real Let's Encrypt certificates) |
| `blog0.env` | `BLOG0_DATABASE_URL` | `postgres://blog0:BLOG0_DB_PW@cloud-sql-proxy:5432/blog0` |
| `blog0.env` | `BLOG0_PUBLIC_BASE_URL` | `https://DOMAIN` |
| `blog0.env` | `BLOG0_TRUSTED_PROXY_HOPS` | `1` (Caddy) |
| `blog0.env` | `BLOG0_SESSION_SECRET` / `BLOG0_UNSUBSCRIBE_SECRET` / `BLOG0_NEWSLETTER_WEBHOOK_SECRET` | from the secrets file |
| `blog0.env` | `BLOG0_OPENROUTER_API_KEY` | your key |
| `blog0.env` | `BLOG0_SMTP_HOST` / `PORT` / `USER` / `PASS` / `FROM` | `smtp.gmail.com` / `587` / `MAILBOX` / `SMTP_APP_PASSWORD` / `blog0 <MAILBOX>` |
| `blog0.env` | `BLOG0_ADMIN_EMAIL` / `BLOG0_ADMIN_PASSWORD` | first deploy only (section 9) |
| `blog0.env` | `BLOG0_NEWSLETTER_SENDER` | `stub` until Listmonk is set up (9.4), then `listmonk` |
| `blog0.env` | `BLOG0_HEARTBEAT_BACKUP_URL` / `BLOG0_HEARTBEAT_TICK_URL` | optional (section 11) |
| `listmonk.env` | `LISTMONK_db__password` | `LISTMONK_DB_PW` (host `cloud-sql-proxy`, user + database `listmonk`, `ssl_mode=disable` — the proxy encrypts) |
| `listmonk.env` | `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD` | `admin` / `LISTMONK_ADMIN_PW` (read by the first install only) |
| `listmonk.env` | `LISTMONK_ROOT_URL` / `LISTMONK_FROM_EMAIL` | `https://NEWS_DOMAIN` / `blog0 <MAILBOX>` |
| `listmonk.env` | `LISTMONK_SMTP_*` / `LISTMONK_BOUNCE_POP_*` | `smtp.gmail.com` `587` STARTTLS / `pop.gmail.com` `995`, user `MAILBOX`, the app password |

## 9. First release

All commands on the VM in `/srv/blog0`. Shorthand used below:

```bash
alias dc='docker compose -f deploy/docker-compose.prod.yml --env-file deploy/compose.env'
```

**9.1 Databases and roles** (once). Start only the proxy, then run `psql` from a throwaway
`postgres:18` container on the stack's network as the Cloud SQL `postgres` user:

```bash
dc up -d --wait cloud-sql-proxy
docker network ls --filter name=blog0-prod      # the stack network, normally blog0-prod_default
read -rs PG_ROOT_PW; read -rs BLOG0_DB_PW; read -rs LISTMONK_DB_PW   # paste the three values (not echoed)
docker run --rm -i --network blog0-prod_default -e PGPASSWORD="$PG_ROOT_PW" postgres:18 \
  psql -h cloud-sql-proxy -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -v blog0_pw="$BLOG0_DB_PW" -v listmonk_pw="$LISTMONK_DB_PW" <<'SQL'
CREATE ROLE blog0 LOGIN PASSWORD :'blog0_pw';
CREATE ROLE listmonk LOGIN PASSWORD :'listmonk_pw';
GRANT blog0 TO postgres;
GRANT listmonk TO postgres;
CREATE DATABASE blog0 OWNER blog0;
CREATE DATABASE listmonk OWNER listmonk;
ALTER DATABASE blog0 OWNER TO blog0;
ALTER DATABASE listmonk OWNER TO listmonk;
\connect blog0
ALTER SCHEMA public OWNER TO blog0;
\connect listmonk
ALTER SCHEMA public OWNER TO listmonk;
SQL
unset PG_ROOT_PW
```

`blog0` and `listmonk` are ordinary roles (not `cloudsqlsuperuser` members, unlike users made with
`gcloud sql users create`): each owns only its database. `GRANT … TO postgres` lets the admin user
hand them ownership (PG 16+ requires it).

**9.2 Build and start** (the release service migrates first; blog0 and the scheduler wait for it):

```bash
dc up -d --build --wait
dc logs release          # "release: blog0 @ PostgreSQL 18.x — N applied (latest …), 0 pending: OK"
                         # "site blog0 ok…, admin <masked> ok…"
dc ps                    # blog0, scheduler, listmonk, caddy, cloud-sql-proxy running; release exited 0
curl -fsS "https://${DOMAIN}/api/health/ready"   # from your laptop: "status":"ready"
```

**9.3 First admin.** The release step created it from `BLOG0_ADMIN_EMAIL` +
`BLOG0_ADMIN_PASSWORD` (it never resets an existing password). Now delete
`BLOG0_ADMIN_PASSWORD` from `deploy/blog0.env` and `dc up -d --wait`. A forgotten password later:
`dc exec blog0 node reset-password.mjs --email you@example.com` (hidden prompt; ends that admin's
sessions).

**9.4 Listmonk.** Its admin UI is only on the VM's loopback; reach it with an IAP tunnel from your
laptop:

```bash
# laptop — keep it open while you work in the Listmonk UI
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap -- -N -L 9000:localhost:9000
```

1. <http://localhost:9000/admin> → sign in as `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD`.
2. Settings (root URL, privacy, SMTP, sending window, POP bounces) — from the **laptop**, through
   the tunnel above, in your blog0 checkout (`pnpm install` done: the script needs `curl` + `node`,
   which the VM does not have). It reads the VM's `deploy/listmonk.env` through `--env-file` (a
   plain parser — the file is never sourced by a shell); copy it over for the run and delete it:

   ```bash
   # laptop, a second terminal, in the blog0 checkout — idempotent
   umask 077
   gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
     --command='cat /srv/blog0/deploy/listmonk.env' > deploy/listmonk.env   # git-ignored, 0600
   deploy/listmonk-settings.sh --env-file deploy/listmonk.env http://localhost:9000
   # listmonk-settings: ok
   rm deploy/listmonk.env
   ```

   Then Settings → SMTP → **Test connection**.
3. Users → New → type **API user**, username `blog0`, role Super Admin (or one that manages
   subscribers, lists, campaigns, templates, bounces and reads settings) → the token is shown
   **once** → `BLOG0_LISTMONK_API_TOKEN`.
4. Lists → New → name **`blog0`**, type private, single opt-in → its id → `BLOG0_LISTMONK_LIST_ID`.
   (The image carries no `newsletter:sync` CLI; the list is made here and Admin → Newsletter's
   sync covers the subscribers.)
5. In `deploy/blog0.env`: `BLOG0_NEWSLETTER_SENDER=listmonk`, `BLOG0_LISTMONK_URL=http://listmonk:9000`,
   `BLOG0_LISTMONK_API_USER=blog0`, the token and list id → `dc up -d --wait`.
6. blog0 Admin → Site → Newsletter shows "Sender: **Listmonk** · list blog0 · healthy" → **Sync to
   Listmonk**.

Listmonk's admin and API stay reachable **only** through this tunnel (section 14).

**9.5 Content.** Sign in at `https://DOMAIN/admin`, create an article, **Generate with Jev** for
its TLDR, **Publish**. The smoke test needs one published article.

## 10. Smoke test

From a laptop checkout (real TLS — no `--insecure`; curl's certificate check **is** the TLS check):

```bash
pnpm deploy:smoke -- "https://${DOMAIN}" "https://${NEWS_DOMAIN}"
# deploy-smoke: … ok (readiness, home, privacy, article + TLDR, newsletter links, Listmonk tracking routes, blocked admin routes)
# deploy-smoke: PASS
```

Then subscribe with a real address on the site, confirm from the email, and send yourself a test
issue — check the email's headers show `spf=pass`, `dkim=pass`, `dmarc=pass`.

## 11. Backups and the restore drill

| What | How | Kept |
|---|---|---|
| blog0 + Listmonk databases | Cloud SQL automated backups (daily 02:00 UTC) + PITR | 7 backups, 7 days of logs (any second) |
| Uploaded media (`/data/storage`) | `scheduler` container, 03:30 UTC: `rclone sync` → `gs://BUCKET/media` | current + 30 days of noncurrent versions |
| Heartbeats | `BLOG0_HEARTBEAT_BACKUP_URL` (media backup), `BLOG0_HEARTBEAT_TICK_URL` (hourly `newsletter:tick`) | — |

`pnpm backup` (pg_dump) stays a local/self-host tool; on GCP the database backups are Cloud SQL's.
Check the scheduler: `dc logs --tail 50 scheduler` (one `ops.media_backup` line per night,
`digest:` lines hourly); `gcloud sql backups list --instance="$INSTANCE"`.

**Restore drill** (monthly; ~30 min; a temporary billed instance). It proves a point-in-time
database copy plus the bucket rebuild a working site, without touching production.

```bash
# OWNER-RUN — laptop: clone the instance as it was at a chosen moment (UTC, within the last 7 days)
gcloud sql instances clone "$INSTANCE" "${INSTANCE}-drill" --point-in-time='2026-10-19T09:00:00Z'
gcloud sql instances describe "${INSTANCE}-drill" --format='value(connectionName)'
```

```bash
# VM, in /srv/blog0: a scratch stack on its own network, port 127.0.0.1:3499, stub sender
TAG="$(sed -n 's/^BLOG0_IMAGE_TAG=//p' deploy/compose.env)"
read -rs BLOG0_DB_PW
docker network create blog0-drill
docker run -d --name drill-proxy --network blog0-drill --network-alias cloud-sql-proxy \
  gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.26.2-alpine \
  --address 0.0.0.0 --port 5432 "${PROJECT_ID}:${REGION}:${INSTANCE}-drill"
docker volume create blog0-drill-storage
docker run --rm -v blog0-drill-storage:/data/storage "blog0-scheduler:${TAG}" \
  rclone copy ":gcs,env_auth=true,bucket_policy_only=true:${BUCKET}/media" /data/storage --config /dev/null
docker run -d --name drill-blog0 --network blog0-drill -p 127.0.0.1:3499:3410 \
  --env-file deploy/blog0.env \
  -e BLOG0_DATABASE_URL="postgres://blog0:${BLOG0_DB_PW}@cloud-sql-proxy:5432/blog0" \
  -e BLOG0_PUBLIC_BASE_URL=http://127.0.0.1:3499 -e BLOG0_TRUSTED_PROXY_HOPS=0 \
  -e BLOG0_NEWSLETTER_SENDER=stub -e BLOG0_SMTP_HOST= \
  -e BLOG0_HEARTBEAT_BACKUP_URL= -e BLOG0_HEARTBEAT_TICK_URL= \
  -v blog0-drill-storage:/data/storage "blog0:${TAG}"
sleep 15
curl -fsS http://127.0.0.1:3499/api/health/ready                       # "status":"ready"
curl -fsS http://127.0.0.1:3499/sitemap.xml | grep -o '/p/[^<]*' | head -3   # your articles
curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3499$(curl -fsS http://127.0.0.1:3499/sitemap.xml | grep -o '/p/[^<]*' | head -1)"   # 200
docker exec drill-blog0 sh -c 'find /data/storage -type f | wc -l'      # ≈ the production count
# teardown
docker rm -f drill-blog0 drill-proxy && docker volume rm blog0-drill-storage && docker network rm blog0-drill
```

```bash
# OWNER-RUN — laptop: delete the drill instance (clones copy deletion protection)
gcloud sql instances patch "${INSTANCE}-drill" --no-deletion-protection
gcloud sql instances delete "${INSTANCE}-drill" --quiet
```

The drill's blog0 has the real OpenRouter key but the stub sender and no SMTP: it can never mail
anyone. A single deleted media file: `gcloud storage ls --all-versions "gs://${BUCKET}/media/<key>"`
then `gcloud storage cp "gs://${BUCKET}/media/<key>#<generation>" …` into the volume.

## 12. Upgrades

```bash
# VM, /srv/blog0
git checkout main            # back on the branch (a rollback, section 13, left a detached checkout)
grep '^BLOG0_IMAGE_TAG=' deploy/compose.env >> deploy/tag-history     # remember the running tag
git pull --ff-only
sed -i "s/^BLOG0_IMAGE_TAG=.*/BLOG0_IMAGE_TAG=$(git rev-parse --short HEAD)/" deploy/compose.env
dc up -d --build --wait      # builds blog0:<sha> + blog0-scheduler:<sha>; release migrates first, then blog0/scheduler are replaced
dc logs release | tail -n 3  # "… 0 pending: OK"
pnpm deploy:smoke -- "https://${DOMAIN}" "https://${NEWS_DOMAIN}"    # from the laptop
docker image ls blog0        # keep the last 3 tags; `docker image rm blog0:<old> blog0-scheduler:<old>` beyond
```

A failed release (exit ≠ 0) leaves the old blog0 and scheduler containers running — fix and run
`dc up -d --build --wait` again. Note the time of every upgrade that applied a migration (the
release log has `applied <tag>` lines; no migration = `already up to date`): rollback may need it. Changes to `deploy/*.env.example` in a new
version: `diff deploy/blog0.env.example deploy/blog0.env` and copy new variables over.

## 13. Rollback

**No migration in the bad release** (its release log said `already up to date`, with no `applied <tag>` lines):

```bash
PREV="$(tail -n 1 deploy/tag-history | cut -d= -f2)"
git checkout "$PREV"    # the compose/Caddy files of that version (images are still local) — a detached checkout
sed -i "s/^BLOG0_IMAGE_TAG=.*/BLOG0_IMAGE_TAG=${PREV}/" deploy/compose.env
dc up -d --wait
```

The checkout stays detached at `$PREV` until the fixed release: the next upgrade (section 12) starts
with `git checkout main`, so `git pull --ff-only` runs on the branch again.

**The bad release ran a migration.** Migrations only move forward; the previous image may not run
on the new schema. Restore the database to just before that release with point-in-time recovery
into a new instance, then point the stack at it:

```bash
# OWNER-RUN — laptop: the time = a minute before the bad release started (UTC)
gcloud sql instances clone "$INSTANCE" "${INSTANCE}-r1" --point-in-time='2026-10-19T09:00:00Z'
```

On the VM: set `CLOUD_SQL_INSTANCE=PROJECT_ID:REGION:INSTANCE-r1` in `deploy/compose.env`, then the
three rollback commands above. Everything written after that moment (articles, subscribers,
Listmonk's sends — both databases are restored together) is lost; export what you need from the
old instance first. Once stable, the old instance can be deleted (deletion protection off first)
and `INSTANCE` in your notes renamed. Media is unaffected (files are only added).

## 14. Listmonk admin access

- Listmonk listens on `127.0.0.1:9000` on the VM only; the public `NEWS_DOMAIN` serves just the
  tracking/unsubscribe routes (Caddy answers everything else with a 404 + `X-Blog0-Edge: denied`;
  `deploy-smoke.sh` checks it). Admin work = the IAP tunnel in 9.4; SSH itself is IAP-only.
- Who may tunnel: project members with `roles/iap.tunnelResourceAccessor` and OS Login
  (`roles/compute.osAdminLogin`). Owners have both.
- Rotate the Listmonk admin password in its UI (Users); the `LISTMONK_ADMIN_*` env values only
  matter for the first install.

## 15. Costs (approximate)

Rough on-demand list prices for a European or US region, October 2026 — **approximate; check the
[pricing calculator](https://cloud.google.com/products/calculator)** for your region:

| Item | ≈ USD / month |
|---|---|
| VM `e2-medium` (24/7) | 25–28 |
| Boot disk 30 GB `pd-balanced` | 3 |
| Static external IPv4 (in use) | 3.6 |
| Cloud SQL `db-g1-small` Enterprise (24/7) | 26–28 |
| Cloud SQL 10 GB SSD + backups/PITR logs | 2–4 |
| GCS bucket (a few GB, Standard) + operations | < 1 |
| Network egress (modest traffic) | 1–5 |
| **Total** | **≈ 60–70** |

Downsizing later: `e2-small` once images are built elsewhere (≈ −12/month). The restore drill's
temporary instance costs ≈ 0.04/hour while it exists. Workspace licences are not included.
