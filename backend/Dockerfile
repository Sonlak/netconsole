# Multi-stage backend build.
# Stage 1 (build): devDeps + compile + prune to prodDeps.
# Stage 2 (runtime): slim runtime base + compiled artefacts only.

# ---- Stage 1: build (compile TS + generate prisma client + prune) ----
FROM node:22-bookworm-slim AS build

ARG NETCONSOLE_VERSION=unknown
ARG NETCONSOLE_GIT_COMMIT=unknown

WORKDIR /app

# OpenSSL MUST be installed before `npm ci`.
#
# The Prisma CLI detects the OpenSSL version to decide which query/schema
# engine binary to download. node:22-bookworm-slim ships no `openssl`
# binary, so Prisma cannot detect it and silently falls back to the
# OpenSSL 1.1.x engine. The runtime stage below DOES install openssl
# (3.0), so when the container starts, the prisma CLI looks for the
# 3.0.x engine, does not find it, and tries to download it from
# binaries.prisma.sh. That fails on a host without direct internet
# access -> the schema is never applied -> the backend health check
# fails -> `docker compose up` aborts because the frontend depends on
# the backend being healthy.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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
    && npm prune --omit=dev


# ---- Stage 2: runtime (final image) ----
FROM node:22-bookworm-slim

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping openssl ca-certificates postgresql-client \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts/docker-start.sh ./scripts/docker-start.sh
COPY --from=build /app/package.json ./package.json

# Guard: the Prisma engine matching THIS platform must be in the image.
# If it is missing, the prisma CLI downloads it at container start, which
# needs internet access and fails on an isolated host - the schema is then
# never applied and the backend never becomes healthy. Fail the build
# instead of shipping a broken image.
RUN ls node_modules/@prisma/engines/ | grep -qx "schema-engine-debian-openssl-3.0.x" \
    && ls node_modules/@prisma/engines/ | grep -qx "libquery_engine-debian-openssl-3.0.x.so.node" \
    || (echo "ERROR: Prisma OpenSSL 3.0.x engine missing from the image (check that openssl is installed in the build stage)" && exit 1)

ENV NODE_ENV=production
ENV PORT=3000
ARG NETCONSOLE_VERSION=unknown
ARG NETCONSOLE_GIT_COMMIT=unknown
ENV NETCONSOLE_VERSION=${NETCONSOLE_VERSION}
ENV NETCONSOLE_GIT_COMMIT=${NETCONSOLE_GIT_COMMIT}

EXPOSE 3000

CMD ["sh", "-c", "scripts/docker-start.sh"]
