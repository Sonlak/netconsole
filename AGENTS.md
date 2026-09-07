# NetConsole -- Agent Notebook

> **READ THIS FIRST.** Everything is indexed below.
> Detailed reference: `docs/agents/`. Session log: `docs/sessions/`.

---

## Project

Network Operations Console for **TAI LOC BANK**.
Inventory + manage network devices (switches/routers/firewalls),
discover subnets, collect configs/ARP/MAC tables, run jobs,
visualize fabric topology.

| Layer | Tech |
| --- | --- |
| Frontend | React 19 + TypeScript + Vite + Ant Design 5 |
| Backend | Node.js 22 + Express 5 + TypeScript + Prisma 6 + PostgreSQL 16 |
| Worker | Python 3.12 + Jinja2 + httpx (RESTCONF) |
| DHCP | Kea 3.x HA hot-standby |
| Lab | Containerlab (Juniper cRPD) |
| Deploy | docker compose + GitHub Actions self-hosted runner |

**Live:** https://42.119.165.109:8443  |  Login: admin / Admin@123

---

## Critical Gotchas (read before debugging)

| # | Topic | Key point |
|---| --- | --- |
| 1 | `mustChangePassword` | Frontend NOT wired -- admin hits dashboard with flag but no redirect. TODO: wire `ChangePasswordRequiredPage` |
| 2 | VPS firewall | firewalld inactive; raw `iptables` is the layer. Port 22 blocked on public NIC (`ens33`). SSH via Tailscale `100.102.133.86` only |
| 3 | Windows CRLF | `.sh` from PowerShell needs `newline="\n"` or bash dies with `set -eu\r` |
| 4 | paramiko dead | Deploy uses Windows OpenSSH CLI. paramiko fails on OpenSSH 10 key-exchange |
| 5 | docker compose UTF-8 | decode with `errors="replace"` -- cp1252 console breaks on non-ASCII |
| 6 | Compose IPAM | Backend talks to Kea at `172.31.0.10/.11` (fixed IP, not service name) |
| 7 | Worker JWT | committed in `docker-compose.app.yml`. Rotate via `scripts/rotate_secrets.sh` |
| 8 | Dagre ignores `rank` field | Edge direction in DB MUST be parent->child; dagre re-ranks from direction |
| 9 | `FabricNode.floor` | Every access device must have `floor` set -- missing value = stray node at right edge |
| 10 | Same-rank edges in dagre | Feed only cross-rank edges; same-rank links drawn by SVG renderer, not dagre |
| 11 | `TierLayout.y` = pixel Y | Not a rank integer. Any `find(tl.y === t.rank)` filter silently returns 0 |
| 12 | No fixed-offset arrays | SH_OFFSETS/FH_OFFSETS patterns break when count exceeds array length. Use dynamic spacing |
| 13 | `tsc --noEmit` misses TS2451 | Run `npm run build` (= `tsc -b && vite build`) before committing TSX. Check Frontend (build) job in GitHub Actions |
| 14 | IOS-XE NETCONF for config ops | Device must have `netconf-yang` + `netconf ssh`. Use SSH port **830**, not 22. Supports `:writable-running:1.0` but NOT `:candidate:1.0` -- target `<running/>` directly, no `<commit>` needed. `<shutdown/>` is a **presence container**, not a boolean: `shut` = `nc:operation="merge"`, `no-shut` = `nc:operation="delete"` (treat `data-missing` on delete as success). Code in `worker/netconsole_worker/ssh_client.py::netconf_interface_action`, called from `backends/iosxe.py::interface_action` (NETCONF first, SSH fallback). RESTCONF (port 443) on 17.x is unreliable — banner times out, ignore it. |
| 15 | Junos commit reliability | (a) `Junos cRPD` first commit after pool open spikes 20-30s; watchdog cap must be ≥ 300s for Juniper (worker=90s RESTCONF timeout, backend base 240s + Juniper extra 60s in `services/jobWatchdog.ts`). (b) If watchdog kills a mid-commit job, Junos keeps the half-loaded candidate. `worker/netconsole_worker/junos_rest.py::apply_set_configuration` auto-recovers on `configuration database modified` by `<discard-changes/>` + re-load+commit. (c) C-style `/* … */` in `DeviceSavedConfig.content` makes Junos emit `unknown command: /*` and leave a "modified" database — `backends/juniper.py::_set_commands` strips them and the backend `validateConfigPayload()` rejects the request with HTTP 400 before enqueue. (d) `SSHConnectionPool` has no `_create_conn` — `run_ssh_command` retry path must call `pool.borrow(...)` (fixed 2026-09-07, was a silent `AttributeError` that surfaced as "No existing session" in user logs). |

Full detail: `docs/agents/05-gotchas.md`

---

## Active TODOs

- **Notification silently swallowed on commit success** -- `reportFinal()` in `frontend/src/lib/jobNotifier.tsx` uses AntD static API (`import { notification } from 'antd'`). Toast fires but does not render on UI. Most likely cause: AntD 5 static API + React 19 StrictMode + `unstableSetRender` interaction (the docs warn this can silently no-op in StrictMode dev). Fix: switch to `App.useApp().notification` inside `jobNotifier.tsx`. Low-risk frontend patch.
- **`/api/jobs` lacks `type` filter + offset pagination** (line 48-65 of `backend/src/routes/jobs.ts`) -- hard-coded `take: 100` means audit-by-script is impossible and the UI jobs page is a lie once you have > 100 jobs. Add `type`, `offset`, `limit` query params + validate against the `JobType` enum.
- **`mustChangePassword` redirect not wired** -- `ProtectedRoute` needs to redirect to `/change-password-required` when flag is true
- **Rollback schema-drift**: `rollback.yml` fails if `prisma db push` must drop tables with data. Need `--accept-data-loss` flag or schema-drift detection
- **Off-host backup copy**: `backup_postgres.sh` dumps locally; no rsync to Tailscale NAS or B2 yet
- **Per-device vendor credentials (Phase 2)** -- shared `ENABLE_*_API` env vars are fine for v1, but prod users will want per-device override (e.g. a single Arista in a fleet of Junipers). Plan: add `Device.connectorJson` JSON column; `select_backend` reads per-device creds first, env fallback second. Schema migration is a one-line `prisma db push`, but the worker needs new env-var resolution paths. Backlog only -- not started.
- **Bulk-config safety net (pre-apply snapshot)** -- current `apply_config` commits each line immediately; if SSH drops mid-batch or a typo crashes the device, the box is half-configured with no undo. Plan (deferred, not started):
  - IOS-XE: prepend `file prompt quiet` + `archive config` to `apply_config` (writes `flash:pre.config`). Rollback stays manual via console `configure replace flash:pre.config force` -- per user: "không cần auto-reload, vẫn để chờ console vào kiểm tra".
  - EOS: prepend `copy running-config startup-config` (optionally `copy running-config rescue-config`) to `apply_config`. Rollback stays manual via console `configure replace flash:startup-config` or `rollback rescue-config`.
  - Overhead: ~1-2s per device (one-time per apply, not per line). Trade-off accepted; not implemented yet -- log here so the next agent picks it up after Phase 2 per-device creds.
  - Open design Q deferred with it: (a) post-apply verify ping? (b) keep snapshot until admin confirms OK via UI, or auto-delete on success? Decide when implementing.

---

## Quick Reference

| What | Where |
| --- | --- |
| Deploy | `npm run app:up` local; push to main/tag -> GitHub Actions deploys to VPS |
| Backend dev | `cd backend && npm run dev` (tsx watch on :3000) |
| Frontend dev | `cd frontend && npm run dev` (:5173 with proxy) |
| Worker dev | `cd worker && python main.py` |
| Lab devices | `npm run lab:up` |
| CI status | https://github.com/Sonlak/netconsole/actions |
| Live site | https://42.119.165.109:8443 |

---

## Per-Service Rules

- `.cursor/rules/netconsole-frontend.mdc` -- Frontend (React/Vite/AntD)
- `.cursor/rules/netconsole-backend.mdc` -- Backend (Express/Prisma/JWT)
- `.cursor/rules/netconsole-worker.mdc` -- Worker (Python/SSH/RESTCONF)

---

## Detailed Reference

`docs/agents/`:
- `01-project-overview.md` -- full tech stack, Prisma schema, domain entities
- `02-credentials-endpoints.md` -- all credentials, compose IPs, GitHub config
- `03-commands.md` -- full command reference (backend/frontend/worker/deploy)
- `04-architecture.md` -- branching, commit style, REST API, job queue, deploy invariants
- `05-gotchas.md` -- all 13 gotchas with full detail + commit references
- `06-file-map.md` -- "where is X" quick lookup
- `07-vendor-api-survey.md` -- Cisco + Arista + Juniper API comparison (added 2026-09-07; updated 2026-09-07 16:40 to mark RESTCONF as ⚠️ unreliable and NETCONF as ✅ working path for IOS-XE)
- `08-vendor-extension-plan.md` -- implementation plan to add EOS/IOS-XE/NX-OS (added 2026-09-07; updated 2026-09-07 16:40 to mark NETCONF as primary config/interface path on IOS-XE)
- `09-vendor-device-configs.md` -- copy/paste device-side config blocks for EOS/IOS-XE/NX-OS (added 2026-09-07)
- `10-bulk-config-safety-net.md` -- design notes for pre-apply snapshot (IOS-XE `archive config`, EOS `copy run start` + optional `rescue-config`). Manual rollback via console; +1-2s/device overhead. Backlog, not started.

---

## Session Log (archived)

All past sessions: `docs/sessions/`

---

## How to Log a New Session

After completing a task:
1. Add entry to `docs/sessions/YYYY-MM-DD.md` (one file per day, append to it)
2. Format: `### HH:MM -- <summary>`, then 3-10 bullets: what changed, why, what's left
3. If entry is urgent for next agent, also add a one-liner to `## Active TODOs` above

**Rule:** never edit old session log entries. Archive only.
