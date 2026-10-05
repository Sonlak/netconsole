FROM node:22-bookworm-slim

WORKDIR /app

# Cache mount for apt. Requires BuildKit (`DOCKER_BUILDKIT=1`, enabled
# by default in modern docker but explicit in the deploy env).
# Saves ~10-15s on rebuilds by keeping /var/cache/apt across builds.
# `id` lets us share this cache across multiple RUN steps in the same
# Dockerfile (e.g. the apt-get below and any future apt-using step).
# Default `shared` mode — `sharing=locked` interacts badly with the
# GHA cache exporter (`cache-to: type=gha`) and the build fails.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping openssl ca-certificates postgresql-client \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

COPY package.json package-lock.json* ./
# Cache mount for npm. Persists /root/.npm across builds so the
# download cache (tarballs, indexes) survives. On warm rebuilds where
# package*.json is unchanged, `npm ci` resolves from cache in <2s
# instead of 30-60s of network downloads.
# Note: `npm ci` always purges node_modules first, but it still uses
# the cache to skip downloading tarballs it has seen before.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
COPY scripts/docker-start.sh ./scripts/docker-start.sh

RUN chmod +x scripts/docker-start.sh \
    && npx prisma generate \
    && npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start via the resilient startup script (see scripts/docker-start.sh for rationale).
# This script handles schema drift gracefully — the container ALWAYS starts,
# even if prisma db push fails due to data-loss or schema incompatibility.
CMD ["sh", "-c", "scripts/docker-start.sh"]
