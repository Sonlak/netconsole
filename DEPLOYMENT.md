# Deployment & CI/CD Guide

NetConsole uses GitHub Actions with a **self-hosted runner** to auto-deploy on every tagged release.

## Architecture

```
┌──────────┐  push tag v*.*.*   ┌───────────────┐    rsync + docker compose    ┌──────────────────────┐
│  Local   │ ─────────────────► │   GitHub.com  │ ─────────────────────────────► │  VPS (42.119.165.109)│
│ (Win)    │                    │  Sonlak/      │                               │  /opt/netconsole     │
└──────────┘                    │  netconsole   │                               │  + self-hosted runner│
                                │  Actions      │                               └──────────────────────┘
                                └───────────────┘
```

The self-hosted runner lives on the production VPS itself, so deployments are 1-hop and have direct Docker access.

---

## One-time VPS setup (~10 min)

### 1. Install OS prereqs

```bash
sudo dnf install -y git jq rsync
```

### 2. Pick a runner user

We use the existing `sonnx` user (already in `docker` group). No new user needed.

Verify:
```bash
id sonnx                 # sonnx should be in 'docker' group
docker ps                # works without sudo
```

### 3. Get a registration token

Go to: **https://github.com/Sonlak/netconsole/settings/actions/runners/new**

Click **"New self-hosted runner"** → Linux / x64.
Copy the token from the `./config.sh` command shown there.
⚠️ **Token expires in 1 hour** - if you delay, come back and regenerate.

### 4. Install runner

#### If VPS can reach `github.com` AND `release-assets.githubusercontent.com` (typical)

```powershell
# Copy the helper script to VPS
scp -i $env:USERPROFILE\.ssh\id_ed25519 `
    D:\NetConsole\scripts\setup-runner.sh `
    sonnx@42.119.165.109:/tmp/setup-runner.sh

# SSH in and run with sudo
ssh -i $env:USERPROFILE\.ssh\id_ed25519 sonnx@42.119.165.109
sudo bash /tmp/setup-runner.sh \
    --repo "Sonlak/netconsole" \
    --token "<PASTE_TOKEN_HERE>" \
    --name "vps-prod-01" \
    --labels "self-hosted,linux,production"
```

#### If VPS firewall blocks `release-assets.githubusercontent.com` (this repo's case)

Symptoms: `curl -fL https://github.com/actions/runner/releases/download/...` hangs after the 302 redirect to `release-assets.githubusercontent.com`, while `github.com`, `api.github.com`, and `codeload.github.com` all work.

Workaround: download on a machine with full internet (your laptop), SCP to VPS:

```powershell
# On Windows - downloads 209 MB locally
curl.exe -fL -o D:\NetConsole\downloads\actions-runner.tar.gz `
    https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz

# SCP to VPS
scp -i $env:USERPROFILE\.ssh\id_ed25519 `
    D:\NetConsole\downloads\actions-runner.tar.gz `
    sonnx@42.119.165.109:/tmp/actions-runner.tar.gz

# On VPS: extract, register, install service
ssh -i $env:USERPROFILE\.ssh\id_ed25519 sonnx@42.119.165.109
sudo mkdir -p /opt/actions-runner
sudo chown -R sonnx:sonnx /opt/actions-runner
sudo -u sonnx tar xzf /tmp/actions-runner.tar.gz -C /opt/actions-runner
rm -f /tmp/actions-runner.tar.gz

cd /opt/actions-runner
sudo -u sonnx ./config.sh --unattended --replace \
    --url https://github.com/Sonlak/netconsole \
    --token "<PASTE_TOKEN_HERE>" \
    --name "vps-prod-01" \
    --labels "self-hosted,linux,production" \
    --work _work

sudo ./svc.sh install sonnx
sudo ./svc.sh start
```

Expected output ends with:
```
√ Runner successfully added
√ Runner connection is good
Started running service
Listening for Jobs
```

### 5. Verify runner shows up on GitHub

Go to: **https://github.com/Sonlak/netconsole/settings/actions/runners**

You should see a green dot next to `vps-prod-01`.

Verify on VPS:
```bash
sudo systemctl status actions.runner.Sonlak-netconsole.vps-prod-01
sudo journalctl -u actions.runner.Sonlak-netconsole.vps-prod-01 -n 20 --no-pager
# expect: "Listening for Jobs"
```

---

## Day-to-day workflow

### Make changes locally
```powershell
git checkout main
git pull
git checkout -b feat/my-change
# ... edit code ...
git add .
git commit -m "feat: add thing"
git push origin feat/my-change
```

### Open PR → CI runs automatically
PR into `main` triggers `.github/workflows/ci.yml`:
- Backend lint + tests + build
- Frontend type-check + build
- Worker lint + smoke import
- Docker Compose syntax check

All 4 jobs must pass before you can merge.

### Tag a release → auto-deploy
```powershell
# Update version somewhere if applicable, then:
git checkout main
git pull
git tag v0.2.0
git push origin v0.2.0
```

This triggers `.github/workflows/deploy.yml` on the self-hosted runner, which:
1. Checks out the tag
2. `rsync`s source to `/opt/netconsole`
3. `docker compose up -d --build backend worker frontend`
4. Probes `/api/health` until backend is up (≤ 80s)
5. Verifies frontend returns 200
6. Confirms kea + postgres containers are untouched
7. Posts a summary back to GitHub Actions UI

### Manual deploy (no tag)
Actions tab → **Deploy** → **Run workflow** → pick a branch/sha.

---

## What gets touched vs preserved

| On every deploy | Preserved (never touched) |
|---|---|
| Source code in `/opt/netconsole/{backend,frontend,worker,lab,...}` | Docker named volumes: `netconsole_pgdata`, `kea_*_leases` |
| Container images for backend/worker/frontend | Running containers: `netconsole-kea-primary`, `netconsole-kea-standby`, `netconsole-postgres` |
| | `netconsole-app.tar.gz` (gitignored) |
| | `.tmp-cfg/` (configs in repo, kept) |
| | `.tmp-hello.txt` (gitignored) |

If you ever need to update Kea or Postgres, do it manually with a careful `docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml up -d --build postgres kea-dhcp1 kea-dhcp2` - **not** via the runner.

---

## Manual deploy (without GitHub Actions)

```bash
ssh sonnx@42.119.165.109
cd /opt/netconsole
docker compose -p netconsole -f docker-compose.app.yml up -d --build backend worker frontend

# Health check
sleep 5
curl -sf http://172.31.0.3:3000/api/health && echo "backend OK"
curl -sf -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8443/
```

---

## Rollback

```powershell
# List recent tags
git fetch --tags
git tag --sort=-creatordate | head -5

# Re-deploy an older tag (this triggers the same workflow)
git push origin <older-tag> --force  # NO - this doesn't redeploy
```

**Correct rollback:**
1. Create a new tag pointing to the old commit:
   ```powershell
   git checkout v0.1.0
   git tag v0.1.1      # new tag on the old commit
   git push origin v0.1.1
   ```
2. Or use manual workflow dispatch and pass the old ref:
   - Actions → Deploy → Run workflow → ref = `v0.1.0`

The runner doesn't keep old images. To rollback at the **image** level:
```bash
docker tag netconsole-backend:<new-sha> netconsole-backend:rollback
# edit compose to pin image: netconsole-backend:rollback
```

---

## Troubleshooting

### Runner offline
```bash
sudo systemctl status actions.runner.Sonlak-netconsole.vps-prod-01
sudo journalctl -u actions.runner.Sonlak-netconsole.vps-prod-01 -n 100 --no-pager
sudo systemctl restart actions.runner.Sonlak-netconsole.vps-prod-01
```

### "Permission denied" during rsync
- The runner runs as `sonnx`, which must have write access to `/opt/netconsole`.
- Confirm: `sudo -u sonnx touch /opt/netconsole/.test && rm /opt/netconsole/.test`
- If not writable: `sudo chown -R sonnx:sonnx /opt/netconsole`

### Backend won't reach `/api/health`
- Check container is up: `docker ps | grep backend`
- Check container logs: `docker logs --tail 50 netconsole-backend`
- Check database is up: `docker ps | grep postgres` (should be `healthy`)

### SELinux blocking rsync
- `sudo setsebool -P rsync_full_access 1` or use `:z` mount flags in compose (only relevant for bind mounts).

### Want to skip CI for a small change?
Commit message prefix: `[skip ci]` — but this only skips GitHub Actions, not the runner deploy (tags always deploy).

---

## Files added by this CI/CD setup

| File | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Lint + test + build on PR/push to main (GitHub-hosted runner) |
| `.github/workflows/deploy.yml` | Deploy on tag push to production (self-hosted runner) |
| `scripts/setup-runner.sh` | One-time runner install on VPS |
| `DEPLOYMENT.md` | This document |
