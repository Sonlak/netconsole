FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
# Cache mount for npm. Persists /root/.npm across builds.
# On warm rebuilds (no package*.json change), `npm ci` resolves
# from cache in <2s instead of 20-30s of network downloads.
# Requires BuildKit (`DOCKER_BUILDKIT=1`).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
