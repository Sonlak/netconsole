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

Full detail: `docs/agents/05-gotchas.md`

---

## Active TODOs

- **`mustChangePassword` redirect not wired** -- `ProtectedRoute` needs to redirect to `/change-password-required` when flag is true
- **Rollback schema-drift**: `rollback.yml` fails if `prisma db push` must drop tables with data. Need `--accept-data-loss` flag or schema-drift detection
- **Off-host backup copy**: `backup_postgres.sh` dumps locally; no rsync to Tailscale NAS or B2 yet
- **Multi-vendor worker (EOS + Cisco IOS-XE + NX-OS)** -- add `backends/{eos,iosxe,nxos}.py` + parsers + env vars; full plan in `docs/agents/08-vendor-extension-plan.md`, device configs in `docs/agents/09-vendor-device-configs.md`. Rollout order: refactor `backends/juniper.py` first (zero regression) -> EOS -> IOS-XE -> NX-OS -> frontend vendor Select. New libs: `ncclient`, `ntc-templates`, `textfsm`. Lab: confirm `ceos` / `csr1000v` / `n9kv` images + decide shared vs per-device credentials (still env-var-only in v1). NOTE: user requested 2026-09-07; response blocked by token budget -- pick up next session

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
- `07-vendor-api-survey.md` -- Cisco + Arista + Juniper API comparison (added 2026-09-07)
- `08-vendor-extension-plan.md` -- implementation plan to add EOS/IOS-XE/NX-OS (added 2026-09-07)
- `09-vendor-device-configs.md` -- copy/paste device-side config blocks for EOS/IOS-XE/NX-OS (added 2026-09-07)

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
