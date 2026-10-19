# syntax=docker/dockerfile:1
# blog0 — one non-root image, two commands (spec/architecture.md §12.1, capability container-image):
#   docker run … blog0:local                     → the web server (Next standalone server.js, port 3410)
#   docker run … blog0:local node release.mjs    → the release step (migrate + verify + site/admin)
#   docker exec -it <c> node reset-password.mjs --email <e>  → reset an admin's password (Stage A)
#   docker run … blog0:local node newsletter-tick.mjs   → the hourly newsletter tick (Stage B)
#   docker run … blog0:local node seed-content.mjs      → first-deploy content seed (GCP deploy; no-op once the site has articles)
# Build: docker build -t blog0:local .   (no BLOG0_* runtime value exists at build time)
# The default target is `app` (= runtime, the last stage). The Stage B `scheduler` stage (runtime +
# supercronic + rclone, spec/architecture.md §12.7) is built only on request:
#   docker build --target scheduler -t blog0-scheduler:local .

# Must equal package.json devEngines.runtime.version.
ARG NODE_VERSION=22.23.1

# ---- 1. deps: the pnpm store, keyed only by the lockfile ------------------------------------
FROM node:${NODE_VERSION}-slim AS deps
# = package.json packageManager; npm -g rather than corepack (no signature-key drift).
RUN npm install -g pnpm@11.7.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile

# ---- 2. build: install offline, Next standalone build + the CLI bundles (release, reset-password, newsletter-tick, seed-content)
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1 BLOG0_STANDALONE=1
RUN pnpm build && pnpm build:release && mkdir -p public

# ---- 3. runtime: standalone server + static assets + migrations + prompts + the three CLIs ----
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3410 \
    BLOG0_PORT=3410 \
    HOSTNAME=0.0.0.0 \
    BLOG0_STORAGE_DIR=/data/storage
# Application files stay root-owned (read-only to the `node` user).
COPY --from=build /app/.next/standalone/ ./
COPY --from=build /app/.next/static/ ./.next/static/
COPY --from=build /app/public/ ./public/
# Read through process.cwd() paths at runtime (db/migrate.ts, jev/prompt.ts) — not traced by Next.
COPY --from=build /app/src/server/db/migrations/ ./src/server/db/migrations/
COPY --from=build /app/src/server/jev/prompts/ ./src/server/jev/prompts/
# GCP deploy (§12.7): the first-deploy content seed reads the 5 posts + their committed deck fixtures.
COPY --from=build /app/src/server/seed/posts/*.md ./src/server/seed/posts/
COPY --from=build /app/src/server/seed/decks/*.json ./src/server/seed/decks/
COPY --from=build /app/dist/release.mjs ./release.mjs
COPY --from=build /app/dist/reset-password.mjs ./reset-password.mjs
COPY --from=build /app/dist/newsletter-tick.mjs ./newsletter-tick.mjs
COPY --from=build /app/dist/seed-content.mjs ./seed-content.mjs
# Only the uploads volume and Next's cache are writable by the runtime user (uid 1000).
RUN mkdir -p /data/storage /app/.next/cache && chown node:node /data/storage /app/.next/cache
VOLUME /data/storage
USER node
EXPOSE 3410
STOPSIGNAL SIGTERM
# Liveness only (no DB access): GET /api/health/live (spec/api.md → health).
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3410)+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","server.js"]

# ---- 4. scheduler (Stage B): runtime + supercronic + rclone; cron jobs only, no web server -------
# crontab (UTC): hourly `node /app/newsletter-tick.mjs`, daily /app/scheduler/media-backup.sh
# (rclone sync of the read-only uploads volume to MEDIA_BACKUP_DEST + heartbeat).
FROM runtime AS scheduler
ARG TARGETARCH
# supercronic: pinned version + per-arch sha256 (= the GitHub release asset digests).
ARG SUPERCRONIC_VERSION=v0.2.50
ARG SUPERCRONIC_SHA256_AMD64=d2d7c97fbfefc763d5bbcbbb3f8d61f9dd3410ce5d05a737c414994b80b8cdd0
ARG SUPERCRONIC_SHA256_ARM64=a1c0af9872e8de89a1ce5c1b596e26c42917d5a2cf914d98faee2e28156899e2
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends rclone curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sum="${SUPERCRONIC_SHA256_AMD64}" ;; \
      arm64) sum="${SUPERCRONIC_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH:-amd64}"; \
    echo "${sum}  /usr/local/bin/supercronic" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/supercronic
COPY deploy/scheduler/crontab deploy/scheduler/media-backup.sh /app/scheduler/
# /backup/media: the local-verification backup target (a named volume there inherits this ownership).
RUN chmod 0644 /app/scheduler/crontab && chmod 0755 /app/scheduler/media-backup.sh \
 && mkdir -p /backup/media && chown node:node /backup/media
USER node
HEALTHCHECK NONE
CMD ["supercronic","-passthrough-logs","/app/scheduler/crontab"]

# ---- default target: the unchanged runtime image (CI `image` job, pnpm test:container) ----------
FROM runtime AS app
