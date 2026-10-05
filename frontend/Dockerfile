FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
# `npm ci` for deterministic + faster installs (mirrors backend/Dockerfile
# change; the prod build uses Dockerfile.prod which already used `npm ci`).
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
