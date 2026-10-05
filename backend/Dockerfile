# =============================================================================
# Multi-stage backend build.
#
# Stage 1 (build): devDeps + build tools to compile TypeScript and run
#                  prisma generate. Produces dist/ + node_modules/.
# Stage 2 (runtime): slim runtime base + prodDeps only (via npm prune).
#                    Drops devDeps (~700 MB) for a much smaller image.
#
# Previous single-stage: ~950 MB (devDeps baked in).
# After this change: ~250 MB (runtime only).
# =============================================================================

# ---- Stage 1: build (compile TS + generate prisma client) ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Build tools for native modules (ssh2 → node-gyp may invoke python3
# if prebuild fetch fails). Kept here only — not in the runtime stage.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# Install ALL deps (dev + prod). tsx + typescript + prisma CLI needed
# for the build. Cache mount keeps /root/.npm across rebuilds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY scripts/docker-start.sh ./scripts/docker-start.sh

RUN chmod +x scripts/docker-start.sh \
    && npx prisma generate \
    && npm run build \
    # Drop devDeps now that the build is done. Keeps prod deps + the
    # prisma client (which is a prod dep, so npm ci --omit=dev would
    # work too — but `npm prune --production` is faster because it
    # operates on the already-installed tree).
    && npm prune --omit=dev


# ---- Stage 2: runtime (final image) ----
FROM node:22-bookworm-slim

WORKDIR /app

# Runtime tools only — no python, no gcc, no g++.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping openssl ca-certificates postgresql-client \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# Copy the slimmed-down tree from the build stage. dist/ + prisma/
# + prod node_modules + scripts. No source TS, no devDeps, no build
# tools.
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts/docker-start.sh ./scripts/docker-start.sh
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start via the resilient startup script (see scripts/docker-start.sh).
# It runs prisma migrate deploy / db push before exec'ing node.
CMD ["sh", "-c", "scripts/docker-start.sh"]
