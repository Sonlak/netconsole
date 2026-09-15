FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      iputils-ping openssl ca-certificates postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

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
