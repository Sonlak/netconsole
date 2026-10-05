# =============================================================================
# Multi-stage backend build.
#
# Stage 1 (build): full toolchain (python, gcc for node-gyp) + devDeps
#                  to compile TypeScript and run prisma generate.
# Stage 2 (prod-deps): prodDeps only, no devDeps.
# Stage 3 (runtime): slim runtime base + prod deps + dist/ + prisma/.
#                    No build tools, no devDeps, no source TS.
#
# Result: image drops from ~950 MB (single-stage, all devDeps baked in)
# to ~250 MB (runtime only). Pull time on the VPS drops from ~30s to
# ~10s, shaving ~20s off every deploy.
# =============================================================================

# ---- Stage 1: build (compile TS + generate prisma client) ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Build tools for native modules (ssh2 → node-gyp prebuild may still
# invoke python3 if prebuild fetch fails). Cache mount keeps apt cache
# across rebuilds.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# Install ALL deps (dev + prod). tsx + typescript + prisma CLI needed
# for the build. Cache mount keeps /root/.npm across rebuilds.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY scripts/docker-start.sh ./scripts/docker-start.sh

RUN chmod +x scripts/docker-start.sh \
    && npx prisma generate \
    && npm run build


# ---- Stage 2: prod-deps (no devDeps) ----
# Separate stage so we can use a clean `npm ci --omit=dev` without
# carrying the build stage's intermediate state.
FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

# No build tools here — npm install for prodDeps rarely needs to
# invoke node-gyp (all our prod deps use prebuilt binaries).
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev


# ---- Stage 3: runtime (final image) ----
FROM node:22-bookworm-slim

WORKDIR /app

# Runtime tools only — no python, no gcc, no g++. The build tools
# are NOT needed at runtime.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping openssl ca-certificates postgresql-client \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# Copy compiled output, prisma client, and prod deps. Do NOT copy
# src/ (raw TS) or any other dev artefact.
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts/docker-start.sh ./scripts/docker-start.sh
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start via the resilient startup script (see scripts/docker-start.sh).
# It runs prisma migrate deploy / db push before exec'ing node.
CMD ["sh", "-c", "scripts/docker-start.sh"]
