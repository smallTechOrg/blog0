# syntax=docker/dockerfile:1
# blog0 — one non-root image, two commands (spec/architecture.md §12.1, capability container-image):
#   docker run … blog0:local                     → the web server (Next standalone server.js, port 3410)
#   docker run … blog0:local node release.mjs    → the release step (migrate + verify + site/admin)
# Build: docker build -t blog0:local .   (no BLOG0_* runtime value exists at build time)

# Must equal package.json devEngines.runtime.version.
ARG NODE_VERSION=22.23.1

# ---- 1. deps: the pnpm store, keyed only by the lockfile ------------------------------------
FROM node:${NODE_VERSION}-slim AS deps
# = package.json packageManager; npm -g rather than corepack (no signature-key drift).
RUN npm install -g pnpm@11.7.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile

# ---- 2. build: install offline, Next standalone build + the release-step bundle --------------
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1 BLOG0_STANDALONE=1
RUN pnpm build && pnpm build:release && mkdir -p public

# ---- 3. runtime: standalone server + static assets + migrations + prompts + release.mjs -------
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
COPY --from=build /app/dist/release.mjs ./release.mjs
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
