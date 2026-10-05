# Multi-stage backend build.
# Stage 1 (build): devDeps + compile + prune to prodDeps.
# Stage 2 (runtime): slim runtime base + compiled artefacts only.

# ---- Stage 1: build (compile TS + generate prisma client + prune) ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

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

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "scripts/docker-start.sh"]
