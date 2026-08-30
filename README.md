# netconsole

Tool network for TAI LOC BANK

## Quick start (dev)

```bash
# Lab devices (DHCP, SSH, etc.)
npm run lab:up

# App stack (backend + frontend + worker + postgres + kea)
npm run app:up

# Open http://localhost:8443 (admin / Admin@123)
```

See `docker-compose.app.yml` for the production stack.

## Deploy to production

Push a `v*.*.*` tag → GitHub Actions auto-deploys via self-hosted runner.

```bash
git tag v0.2.0
git push origin v0.2.0
```

Full setup & rollback instructions: see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

## CI

Every PR and push to `main` runs `.github/workflows/ci.yml`:
- Backend lint + tests + build
- Frontend type-check + build
- Worker lint + smoke import
- Docker Compose syntax check

