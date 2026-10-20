# Deploying blog0 on Google Cloud (deploy as code)

blog0 runs on **one e2-micro VM** (`blog0-vm`, Docker) in the shared project `ai-agent-boilerplate0`,
behind the **existing shared HTTPS load balancer** `zero-vanguard`, with Postgres on the **shared Cloud SQL
instance** `ai-agent-db` (databases `blog0` + `listmonk`). Everything is code; rules and rationale are in
`spec/architecture.md` §12.7. The platform-neutral container runbook (every `BLOG0_*` variable, erasure
requests, health endpoints, logs) is [`docs/deploy.md`](deploy.md).

```
 GitHub Actions (WIF, no keys)                       Google Cloud (project ai-agent-boilerplate0)
 ┌───────────────────────────┐   push images    ┌────────────────────────────────┐
 │ deploy.yml                │ ───────────────▶ │ Artifact Registry  blog0       │
 │  build app + scheduler    │                  └──────────────┬─────────────────┘
 │  render env from secrets  │   scp/ssh (IAP)                 │ pull (VM service account)
 │  deploy-remote.sh <sha>   │ ──────────────▶  ┌──────────────▼─────────────────┐
 └───────────────────────────┘                  │ blog0-vm (e2-micro, 2 GB swap) │
 ┌───────────────────────────┐                  │  blog0 :3410 /lm→ listmonk    │──▶ Cloud SQL ai-agent-db
 │ provision.yml             │  infra/provision │  scheduler (tick, media backup)│    (private IP, TLS)
 │  VM, firewall, backends,  │ ───────────────▶ └──────────────▲─────────────────┘
 │  cert, LB host-rule patch │                                  │ HTTP from LB ranges only
 └───────────────────────────┘      readers ──▶ zero-vanguard LB (34.8.199.41)
                                   blog0.smalltech.in ──▶ blog0-bes :3410 (managed cert blog0-cert-v2)
```

**One host.** `https://blog0.smalltech.in` is the only name. Listmonk's *public* endpoints are served by
blog0 itself under `/lm` — the app image carries Next.js `rewrites()` that proxy an allow-list of `/lm/*`
to `http://listmonk:9000` over the compose network; Listmonk's root URL is `https://blog0.smalltech.in/lm`,
so every link in a mail (click redirect, open pixel, unsubscribe page) is `/lm/…`. Allowed (UUID-shaped
parameters only): `/lm/link/<uuid>/<uuid>/<uuid>`, `/lm/campaign/<uuid>/<uuid>/px.png`,
`/lm/subscription/<uuid>/<uuid>` (page + form), `/lm/public/static/<file>`, `/lm/public/custom.{css,js}`.
Listmonk's unsubscribe page hardcodes its assets as absolute `/public/static/*` and `/public/custom.{css,js}`
(it ignores the root URL), so those three patterns are proxied unprefixed too (blog0 has no `/public/…`
URL of its own). Everything else — `/lm`, `/lm/admin*`, `/lm/api*`, `/lm/subscription/{export,wipe,optin,form}`,
the "view in browser" page — is blog0's normal 404; the LB never sees port 9000. Code and tests:
`src/lib/http/listmonk-proxy.ts`; end-to-end proof against a real Listmonk: `scripts/lm-prefix-check.sh`.

Prove the kit on your laptop any time (Docker running; uses ports 3490/3491/3494/3495, never `:3410`):

```bash
pnpm deploy:local          # the real deploy-remote.sh against a local stack → "deploy-local: PASS"
```

## The only manual steps

1. **One GoDaddy A record** (after `provision` created the cert; to the existing LB IP):
   `blog0.smalltech.in  A 34.8.199.41`. (The old `news.blog0.smalltech.in` record, if you added it, can be
   deleted.) The Google-managed cert `blog0-cert-v2` turns `ACTIVE` some minutes after DNS resolves (up to
   ~1 h); the next `provision` run then detaches and deletes the legacy two-domain `blog0-cert`.
2. **Workspace DKIM** for the sending mailbox's domain: Admin console → Apps → Google Workspace → Gmail →
   Authenticate email → generate the key for the domain → add the TXT record `google._domainkey` at
   GoDaddy → *Start authentication*. Also, on the sending mailbox: 2-Step Verification on, an **app
   password** (that is `BLOG0_SMTP_PASS`), and POP enabled (Gmail → Settings → Forwarding and POP/IMAP) for
   bounce processing. Gmail allows 2 000 messages/day per user; Listmonk is capped at 1 800/day.

Everything else below is automatic.

## 1. Bootstrap (once, on your laptop)

Needs `gcloud` (admin login on the project), `gh` (admin on the repo), `jq`, `openssl`, **bash ≥ 4**
(macOS: `brew install bash`, then run with that bash) and a `.env` holding the values to copy:
`BLOG0_OPENROUTER_API_KEY`, `BLOG0_SMTP_HOST` (`smtp.gmail.com`), `BLOG0_SMTP_PORT` (`587`),
`BLOG0_SMTP_USER`, `BLOG0_SMTP_PASS` (the app password), `BLOG0_SMTP_FROM`, `BLOG0_ADMIN_EMAIL`
(optional: `BLOG0_ADMIN_NAME`, `BLOG0_HEARTBEAT_BACKUP_URL`, `BLOG0_HEARTBEAT_TICK_URL`).

```bash
gcloud auth login && gh auth login
bash infra/bootstrap.sh --dry-run        # read-only: shows every create/set it would do
bash infra/bootstrap.sh                  # idempotent; safe to re-run
#   --sync-env           re-copy the .env values into GitHub even if the secrets exist
#   --rotate <SECRET>    regenerate one generated secret (DB passwords are also applied to Cloud SQL;
#                        BLOG0_DB_APP_PASSWORD is applied by the next deploy's release step)
```

It creates/sets (names only are printed): the APIs it needs; service accounts `blog0-deployer` (GitHub
Actions via **Workload Identity Federation**, restricted to `smallTechOrg/blog0`, no keys) and `blog0-vm`;
Artifact Registry repo `blog0`; backup bucket `blog0-backups-<project>` (versioned, noncurrent versions
deleted after 30 days); IAM bindings **for those two service accounts only**; Cloud SQL databases `blog0` +
`listmonk` and users `blog0_owner` + `listmonk` on `ai-agent-db` (nothing else on the instance is touched);
GitHub **variables** `GCP_PROJECT GCP_REGION GCP_ZONE GCP_INSTANCE GCP_WIF_PROVIDER GCP_DEPLOYER_SA GCP_VM_SA
AR_REPO BACKUP_BUCKET SITE_DOMAIN CLOUDSQL_PRIVATE_IP` (a leftover `NEWS_DOMAIN` variable is no longer read; `gh variable delete NEWS_DOMAIN` removes it) and **secrets** (generated:
`BLOG0_SESSION_SECRET BLOG0_UNSUBSCRIBE_SECRET BLOG0_NEWSLETTER_WEBHOOK_SECRET BLOG0_DB_OWNER_PASSWORD
BLOG0_DB_APP_PASSWORD LISTMONK_DB_PASSWORD LISTMONK_ADMIN_USER LISTMONK_ADMIN_PASSWORD BLOG0_ADMIN_PASSWORD`;
copied from `.env`: `BLOG0_OPENROUTER_API_KEY BLOG0_JEV_MODEL BLOG0_SMTP_* BLOG0_ADMIN_EMAIL` and the optional
ones). `BLOG0_JEV_MODEL` is forced to `typesafe/jev-1.13`. Generated values live in `var/prod/secrets.env`
(mode 600, gitignored — your copy; GitHub secrets cannot be read back) and the first admin login in
`var/prod-admin.txt` (mode 600).

## 2. What the workflows do

**`provision.yml`** — runs on pushes to `main` / `feature/blog0-20261012-1519-v0.1` that touch `infra/**` (or
the workflow), and on *Run workflow*. As `blog0-deployer` it runs `bash infra/provision.sh`: firewall rules
`blog0-allow-lb`, `blog0-allow-iap-ssh`, `blog0-deny-public`; VM `blog0-vm` (created once; an existing VM is
never recreated or restarted; its startup script installs Docker and a 2 GB swapfile); instance group
`blog0-ig` (named port `blog0:3410`); health check `blog0-hc`; backend service `blog0-bes`; managed
certificate `blog0-cert-v2` (`blog0.smalltech.in` only); then blog0's own entries on the shared LB
(`zero-vanguard-urlmap`: host rule `blog0.smalltech.in` → matcher `blog0` ensured, blog0's legacy
`news.blog0.smalltech.in` rule + `blog0-news` matcher removed — fails closed on anything unexpected, no
other rule is touched; `blog0-cert-v2` appended to the HTTPS proxy, the legacy `blog0-cert` taken out of the
list once `v2` is ACTIVE — never while the legacy one is serving and `v2` is not — and deleted; every other
certificate keeps its order). After the url map no longer references them it deletes `blog0-listmonk-bes`
and `blog0-listmonk-hc`, drops the `listmonk:9000` named port and tightens `blog0-allow-lb` to `tcp:3410`.
`https://` and `http://vanguard.smalltech.in/` must return 200 before the first LB change and after the
last. The url map and both proxies are exported first to `var/lb-backup-<ts>/` (uploaded as the `lb-backup`
artifact, with `RESTORE.txt`); the patch is validated before import; if the canary fails after the change
the job fails and prints the restore commands (never an automatic rollback of the shared LB). Dry run on
your laptop: `GCP_PROJECT=… GCP_REGION=… GCP_ZONE=… GCP_INSTANCE=blog0-vm GCP_VM_SA=… SITE_DOMAIN=…
bash infra/provision.sh --dry-run`.

**`deploy.yml`** — runs on pushes to `main` / the feature branch (not for `docs/**`, `spec/**`, `*.md`,
`infra/**`) and on *Run workflow*. It fails early with "run provision first" if `blog0-vm` is not RUNNING;
builds the `app` and `scheduler` images on the runner (linux/amd64, GHA cache) and pushes them to Artifact
Registry as `<sha>` + `latest`; renders the VM env files from the secrets (`deploy/vm/render-env.sh`, mode
600, deleted from the runner afterwards); copies them over an **IAP SSH tunnel** to the VM; and runs
`deploy/vm/deploy-remote.sh <sha>` there: migrations as `blog0_owner`, the restricted runtime role
`blog0_app`, site + first admin, the first-deploy content seed (5 posts + deck fixtures, 0 AI calls, only when
the site has no articles), Listmonk install/upgrade, its API user/token (`/opt/blog0/listmonk-api.env`, 600)
and settings (Workspace SMTP, POP bounces `pop.gmail.com:995`, root URL `https://blog0.smalltech.in/lm`,
1 800/day, list `blog0`), `docker compose up -d --wait`, image prune (current + previous tag), and
`free -m` / `docker stats`. **Containers restart; the VM never does.** Then a VM-local smoke; the public smoke
(`scripts/deploy-smoke.sh https://blog0.smalltech.in`, incl. the `/lm` proxy checks) when `blog0-cert-v2` is
`ACTIVE`, otherwise `waiting on DNS/cert (status: …)` (not a failure). The job summary shows the sha, URLs,
certificate status and memory headroom.

First run order: `bootstrap.sh` → push (or dispatch) `provision` → add the DNS records → `deploy` (it can
run before DNS; the VM-local smoke already proves the stack, `/lm` included).

## 3. Everyday operations

```bash
# SSH (IAP tunnel, OS Login; no public SSH)
gcloud compute ssh blog0-vm --zone us-central1-a --tunnel-through-iap
# on the VM
sudo docker compose --project-directory /opt/blog0 -f /opt/blog0/docker-compose.yml --env-file /opt/blog0/compose.env ps
sudo docker compose --project-directory /opt/blog0 -f /opt/blog0/docker-compose.yml --env-file /opt/blog0/compose.env logs --tail 100 blog0
free -m
```

**Listmonk admin** is not reachable from outside (`/lm/admin` is a 404 and port 9000 is bound to the VM's loopback); use a tunnel (9100 locally — 9000 may be your dev
Listmonk) and sign in with `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD` (from `var/prod/secrets.env`):

```bash
gcloud compute ssh blog0-vm --zone us-central1-a --tunnel-through-iap -- -N -L 9100:localhost:9000
# then open http://localhost:9100/admin
```

**First admin password / reset:** `var/prod-admin.txt`; to reset later,
`sudo docker compose … exec blog0 node reset-password.mjs --email <email>` on the VM (see `docs/deploy.md`).

**Rotate a secret:** `bash infra/bootstrap.sh --rotate <NAME>`, then run `deploy` (the env files are re-rendered;
`BLOG0_DB_APP_PASSWORD` is applied by the release step). `BLOG0_SESSION_SECRET` rotation: `docs/deploy.md`.

## 4. Rollback

Re-run **deploy** at an earlier commit: Actions → *deploy* → *Run workflow* → pick the earlier branch/tag/sha
(or `git revert` and push). Images are immutable per sha; the VM keeps the current and previous tags, and
Artifact Registry keeps all of them. Migrations are forward-only: if the bad release ran a migration, the
old code must tolerate the new schema, or restore the data (next section).

## 5. Backups and restore

- **Database:** Cloud SQL automated backups and point-in-time recovery of the shared instance (managed by
  whoever owns `ai-agent-db`; check `gcloud sql instances describe ai-agent-db --format='value(settings.backupConfiguration)'`).
  Restore **never overwrites `ai-agent-db`**: clone to a NEW instance, then point blog0 at the clone.

  ```bash
  # clone as of a moment before the incident (UTC, within the PITR window) — creates a billed instance
  gcloud sql instances clone ai-agent-db blog0-restore --point-in-time 2026-10-20T10:00:00Z
  # inspect it (databases blog0 and listmonk); the clone keeps the private IP network config
  gcloud sql instances describe blog0-restore --format='value(ipAddresses[0].ipAddress)'
  # use it: set the repo variable to the clone's private IP and re-run deploy
  gh variable set CLOUDSQL_PRIVATE_IP --body <clone-private-ip>
  # when satisfied: export just blog0/listmonk from the clone for the instance owner to import, or keep running on the clone
  gcloud sql export sql blog0-restore gs://blog0-backups-ai-agent-boilerplate0/restore/blog0.sql.gz --database blog0
  gcloud sql export sql blog0-restore gs://blog0-backups-ai-agent-boilerplate0/restore/listmonk.sql.gz --database listmonk
  # delete the clone when done
  gcloud sql instances delete blog0-restore
  ```
- **Media (uploads):** the scheduler mirrors `/data/storage` to `gs://blog0-backups-<project>/media` daily
  (03:30 UTC; versioned bucket, deleted/overwritten files recoverable for 30 days; heartbeat optional).
  Restore: `gcloud storage cp -r gs://blog0-backups-<project>/media/* <dir>` and copy into the `blog0-storage`
  volume `blog0-prod_blog0-storage` (e.g. `sudo docker run --rm -v blog0-prod_blog0-storage:/data -v $PWD:/src alpine cp -r /src/. /data/`, then `chown -R 1000:1000`).
- **Code/config:** git + the GitHub secrets/variables (`var/prod/secrets.env` is your offline copy).

## 6. Costs (approximate, us-central1)

e2-micro ≈ **$7/mo** (+ ≈ $2 for its 20 GB disk), Artifact Registry / bucket / egress: pennies at this size;
the Google-managed certificate and the shared load balancer add nothing (already running for other sites);
Cloud SQL: **$0 extra** (shared `ai-agent-db`, two small databases). Cloud Build is not used.

## 7. Memory notes (1 GB RAM + 2 GB swap)

Limits: blog0 512 MB (node heap 384 MB), Listmonk 192 MB, scheduler 192 MB; steady state ≈ 400 MB. The
one-offs (release, seed) run with 384 MB limits while the old stack is up, so a deploy briefly leans on
swap. The deploy summary prints `free -m`; **resize to e2-small** (2 GB) when swap use stays high between
deploys or the OOM killer shows in `dmesg`. A machine-type change needs a stop, so schedule it —
`gcloud compute instances stop blog0-vm …`, `set-machine-type blog0-vm --machine-type e2-small`, `start`
(this one is a deliberate manual VM restart). Connection budget on the shared instance: blog0 4, scheduler
2, Listmonk 4 open, one-offs 1–2.

## 8. Live inventory and exact delete commands

Only these exist because of blog0 (all names start with `blog0`, except the **additions to shared
resources**). Project/region/zone: `ai-agent-boilerplate0`, `us-central1`, `us-central1-a`. Delete in this
order (top to bottom); each command is safe to repeat. `P=ai-agent-boilerplate0`.

```bash
P=ai-agent-boilerplate0; Z=us-central1-a
```

**A. Additions to the shared load balancer (do first; the rest depends on them).** Back up, then remove
only blog0's host rules / path matchers and detach the cert.

```bash
mkdir -p var/lb-removal && cd var/lb-removal
gcloud compute url-maps export zero-vanguard-urlmap --global --project $P --destination before.yaml --quiet
gcloud compute url-maps describe zero-vanguard-urlmap --global --project $P --format=json |
  jq 'del(.id,.kind,.selfLink,.creationTimestamp)
      | .hostRules |= map(select(.pathMatcher != "blog0" and .pathMatcher != "blog0-news"))
      | .pathMatchers |= map(select(.name != "blog0" and .name != "blog0-news"))' > after.json   # blog0-news exists only on a map provisioned by the older two-host design
diff <(jq -S .hostRules after.json) <(gcloud compute url-maps describe zero-vanguard-urlmap --global --project $P --format=json | jq -S .hostRules)  # only blog0 rules differ
gcloud compute url-maps validate --global --project $P --source after.json   # loadSucceeded: true
gcloud compute url-maps import zero-vanguard-urlmap --global --project $P --source after.json --quiet
# detach blog0-cert-v2 (and a leftover legacy blog0-cert) from the shared HTTPS proxy, keeping every other certificate in order
keep=$(gcloud compute target-https-proxies describe zero-vanguard-httpsproxy --global --project $P --format=json |
  jq -r '[.sslCertificates[] | split("/") | last | select(. != "blog0-cert" and . != "blog0-cert-v2")] | join(",")')
gcloud compute target-https-proxies update zero-vanguard-httpsproxy --global --project $P --ssl-certificates "$keep"
curl -sS -o /dev/null -w '%{http_code}\n' https://vanguard.smalltech.in/    # must stay 200
cd ../..
```

**B. blog0-owned resources.**

```bash
gcloud compute ssl-certificates delete blog0-cert-v2 --global --project $P --quiet   # (+ blog0-cert if the legacy cert still exists)
gcloud compute backend-services delete blog0-bes --global --project $P --quiet       # (+ blog0-listmonk-bes if it still exists)
gcloud compute health-checks delete blog0-hc --global --project $P --quiet           # (+ blog0-listmonk-hc if it still exists)
gcloud compute instance-groups unmanaged delete blog0-ig --zone $Z --project $P --quiet
gcloud compute instances delete blog0-vm --zone $Z --project $P --quiet            # also deletes its boot disk
gcloud compute firewall-rules delete blog0-allow-lb blog0-allow-iap-ssh blog0-deny-public --project $P --quiet
gcloud artifacts repositories delete blog0 --location us-central1 --project $P --quiet
gcloud storage rm -r gs://blog0-backups-$P --project $P                            # bucket + all backups
```

**C. Cloud SQL (shared instance — only blog0's objects).** Data is lost; export first if needed.

```bash
gcloud sql databases delete blog0 --instance ai-agent-db --project $P --quiet
gcloud sql databases delete listmonk --instance ai-agent-db --project $P --quiet
gcloud sql connect ai-agent-db --user postgres --project $P      # then: DROP ROLE IF EXISTS blog0_app;
gcloud sql users delete blog0_owner --instance ai-agent-db --project $P --quiet
gcloud sql users delete listmonk --instance ai-agent-db --project $P --quiet
```

**D. Identity.**

```bash
D=blog0-deployer@$P.iam.gserviceaccount.com; V=blog0-vm@$P.iam.gserviceaccount.com
for r in roles/compute.instanceAdmin.v1 roles/compute.loadBalancerAdmin roles/compute.securityAdmin roles/iap.tunnelResourceAccessor roles/compute.osAdminLogin; do
  gcloud projects remove-iam-policy-binding $P --member serviceAccount:$D --role $r --condition=None --quiet >/dev/null; done
for r in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud projects remove-iam-policy-binding $P --member serviceAccount:$V --role $r --condition=None --quiet >/dev/null; done
gcloud iam workload-identity-pools providers delete github --workload-identity-pool blog0-github --location global --project $P --quiet
gcloud iam workload-identity-pools delete blog0-github --location global --project $P --quiet
gcloud iam service-accounts delete $D $V --project $P --quiet
```

**E. GitHub.**

```bash
for v in GCP_PROJECT GCP_REGION GCP_ZONE GCP_INSTANCE GCP_WIF_PROVIDER GCP_DEPLOYER_SA GCP_VM_SA AR_REPO BACKUP_BUCKET SITE_DOMAIN NEWS_DOMAIN CLOUDSQL_PRIVATE_IP; do gh variable delete $v; done   # NEWS_DOMAIN: legacy, may not exist
for s in BLOG0_SESSION_SECRET BLOG0_UNSUBSCRIBE_SECRET BLOG0_NEWSLETTER_WEBHOOK_SECRET BLOG0_DB_OWNER_PASSWORD BLOG0_DB_APP_PASSWORD LISTMONK_DB_PASSWORD LISTMONK_ADMIN_USER LISTMONK_ADMIN_PASSWORD BLOG0_ADMIN_PASSWORD BLOG0_OPENROUTER_API_KEY BLOG0_JEV_MODEL BLOG0_SMTP_HOST BLOG0_SMTP_PORT BLOG0_SMTP_USER BLOG0_SMTP_PASS BLOG0_SMTP_FROM BLOG0_ADMIN_EMAIL BLOG0_ADMIN_NAME BLOG0_HEARTBEAT_BACKUP_URL BLOG0_HEARTBEAT_TICK_URL; do gh secret delete $s; done
```

Plus the GoDaddy A record (and the legacy `news.` one) and the DKIM TXT record. The APIs bootstrap enabled are left on (shared).

## 9. Troubleshooting

- *deploy says "run provision first"*: the VM is missing or stopped — run `provision` (it never starts a stopped VM; `gcloud compute instances start blog0-vm`).
- *`release` fails with `permission denied` on Cloud SQL*: check `CLOUDSQL_PRIVATE_IP`, that `blog0_owner` exists and the VM can reach the private IP (same VPC), and that `sslmode=require` is accepted (the instance requires SSL).
- *public smoke waits*: `gcloud compute ssl-certificates describe blog0-cert-v2 --global --format='value(managed.status,managed.domainStatus)'`; `PROVISIONING` + `FAILED_NOT_VISIBLE` means the A record is missing or wrong.
- *LB 502 right after a deploy*: the health check needs two passes (≈ 20 s); the deploy summary's LB-facing check is informational.
- *Listmonk tracking links 404*: only the allow-list in `src/lib/http/listmonk-proxy.ts` (`/lm/link/…`, `/lm/campaign/…/px.png`, `/lm/subscription/…`, `/lm/public/…`, plus the absolute `/public/static/*`, `/public/custom.{css,js}` assets) is proxied by design. A 500 on `/lm/*` means the `listmonk` container is down. The image bakes the target (`http://listmonk:9000`) at build time (`BLOG0_LM_PROXY_TARGET`).
