# Nagisa — production image.
#
# One container serves both halves: the realtime WebSocket server also serves the built
# client as static files from the same origin. That is deliberate. Splitting them across
# a CDN and an app server means cross-origin WebSocket configuration, a second TLS
# certificate and a CORS policy to maintain, in exchange for saving a few hundred
# kilobytes of static serving on a process that is otherwise idle between ticks.
#
# Put a CDN in front of this image when traffic justifies it; nothing here prevents it.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of source changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

# `npm ci` when a lockfile is present (reproducible), `npm install` otherwise.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

COPY . .

# Order matters: both apps compile against the shared package's built output.
RUN npm run build:shared \
 && npm run build:server \
 && npm run build:client

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only. The client is already compiled to static files and the
# server's only runtime dependency is `ws`.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/client/dist apps/client/dist

# Persisted activity schedule, announcements and check-in records. Mount a volume here in
# any deployment where losing the day's schedule on restart is not acceptable.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

ENV PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/apps/client/dist \
    PERSIST_PATH=/data/nagisa.json \
    LOG_LEVEL=info

EXPOSE 8787

# Never run as root. The process needs nothing but its own port and /data.
USER node

# Liveness. The orchestrator restarts the container if the tick loop wedges; /healthz
# reports unhealthy when the last tick is older than a few seconds, not merely when the
# process is alive.
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
