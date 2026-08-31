# NetConsole — Local Development & Deployment Guide

A professional flow:

```
  Local dev → push branch → PR → CI (lint/test/build) → merge to main → auto-deploy to VPS
```

---

## 1. Local development — full stack on your machine

### One-time setup

```bash
# Prereqs
# - Node.js 22.x
# - Python 3.12
# - Docker Desktop (or Docker Engine on Linux)
# - Git

git clone https://github.com/Sonlak/netconsole.git
cd netconsole
```

### Start the database (only thing you need Docker for locally)

```bash
docker run -d --name nc-postgres \
  -e POSTGRES_USER=netconsole \
  -e POSTGRES_PASSWORD=netconsole \
  -e POSTGRES_DB=netconsole \
  -p 5432:5432 \
  postgres:16-alpine

# (Optional) seed-only Kea DHCP container if you're testing DHCP features
# docker compose -f docker-compose.app.yml up -d kea-dhcp1 kea-dhcp2
```

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env if needed (default DATABASE_URL points to localhost:5432 — OK for local)
npm ci
npm run db:generate       # generate Prisma client
npm run db:push           # create tables in local Postgres
npm run db:seed           # create admin user (admin / Admin@123)
npm run dev               # http://localhost:3000
```

Verify: `curl http://localhost:3000/api/health` → `{"status":"ok"}`

### Frontend

```bash
cd frontend
cp .env.example .env       # optional, defaults are fine
npm ci
npm run dev                # http://localhost:5173 (proxies /api → :3000)
```

### Worker (optional for most UI work)

```bash
cd worker
cp .env.example .env
# Generate worker token:
cd ../backend && node -e "console.log(require('jsonwebtoken').sign({sub:'worker',role:'worker'},process.env.JWT_SECRET||'CHANGE_ME_TO_A_SECURE_SECRET_AT_LEAST_32_CHARS_LONG',{expiresIn:'365d'}))"
cd ../worker
# Paste into WORKER_AUTH_TOKEN in .env
pip install -r requirements.txt
python main.py
```

---

## 2. Run CI checks locally (catch errors before pushing)

```bash
# Backend
cd backend
npm ci && npx prisma generate && npx tsc --noEmit && npm test

# Frontend
cd frontend
npm ci && npx tsc -b && npm run build

# Worker
cd worker
pip install -r requirements.txt ruff
ruff check .
```

If all three pass, your PR will be green.

---

## 3. Push & open PR — CI runs automatically

```bash
git checkout -b feature/my-change
git add .
git commit -m "feat: describe change"
git push -u origin feature/my-change
gh pr create --base main --title "..." --body "..."
```

CI runs on **every push to any branch** (lint + test + build). Wait for the green
check before requesting review.

---

## 4. Merge → automatic deploy

When the PR merges into `main`:

- `Deploy` workflow runs on the **self-hosted runner on the VPS** (`vps-prod-01`)
- It `rsync`s the new code to `/opt/netconsole` (preserves `.env`, data volumes)
- Runs `docker compose up -d --build --no-deps backend worker frontend`
  (kea + postgres are NOT restarted — they hold persistent state)
- Health-checks backend on `http://172.31.0.3:3000/api/health`
- Health-checks frontend on `http://127.0.0.1:8443`

If you need to deploy a specific tag instead of main:

```bash
git tag v0.3.0
git push origin v0.3.0
```

The tag push also triggers `Deploy`.

Manual deploy: GitHub → Actions → Deploy → Run workflow → choose ref.

---

## 5. Required GitHub settings (do this once)

Go to **Settings → Branches → Branch protection rules → Add rule**:

- Branch name pattern: `main`
- ☑ Require a pull request before merging
- ☑ Require approvals: 1
- ☑ Require status checks to pass before merging
  - Search and add: **CI / Backend**, **CI / Frontend**, **CI / Worker**, **CI / Compose**
- ☑ Do not allow force pushes
- ☑ Do not allow deletions

This forces every change to go through a PR with CI green before merging → auto-deploys cleanly.

---

## 6. Environment / secrets on the VPS

Self-hosted runner reads no secrets from GitHub. Production secrets live in:

- `/opt/netconsole/.env`                  — frontend / app-wide
- `/opt/netconsole/backend/.env`          — backend runtime
- `/opt/netconsole/docker-compose.app.yml` — `JWT_SECRET`, `WORKER_AUTH_TOKEN`, etc.

`.env` is excluded from `rsync` (in `.gitignore`), so it survives deploys.

To rotate `WORKER_AUTH_TOKEN`:

```bash
# On VPS as sonnx
cd /opt/netconsole/backend
NEW=$(node -e "console.log(require('jsonwebtoken').sign({sub:'worker',role:'worker'},process.env.JWT_SECRET||'CHANGE_ME_IN_PRODUCTION',{expiresIn:'365d'}))")
sed -i "s|WORKER_AUTH_TOKEN: \"[^\"]*\"|WORKER_AUTH_TOKEN: \"$NEW\"|" docker-compose.app.yml
docker compose -p netconsole -f docker-compose.app.yml up -d --no-deps worker
```

---

## 7. Quick troubleshooting

| Symptom | Likely cause |
| --- | --- |
| CI fails on `prisma generate` | DB service didn't become healthy → check service healthcheck |
| CI backend `prisma db push` fails | DB connection string / network issue in runner image |
| Frontend `tsc` fails on PR but passes locally | Diff in `tsconfig` paths / Node version (CI pins 22) |
| Deploy fails at "Wait for backend healthy" | Backend can't reach DB → check `172.31.0.2` is up; check logs |
| Deploy shows 401 in worker logs | `WORKER_AUTH_TOKEN` rotated or wrong → regenerate per §6 |
| Seed not creating admin | `SEED_ON_BOOT` not `true` in compose → see `backend/Dockerfile` CMD |

---

## 8. One-shot local full-stack with Docker (optional)

If you don't want to run backend/frontend as host processes:

```bash
# Override compose with a local-only env file
cp docker-compose.app.yml docker-compose.local.yml
# Edit docker-compose.local.yml: change DEPLOY_DIR paths, expose all ports to localhost
docker compose -f docker-compose.local.yml up --build
```

Frontend on `http://localhost:8443`, backend API on `http://localhost:3000/api`.

(Production compose binds backend only to container network — that's intentional.)
