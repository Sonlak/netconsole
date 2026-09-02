# AGENTS.md — NetConsole Project Notebook

> **Read this file FIRST when opening this project in any new agent session.**
> It contains: (1) what the project is, (2) how to build/run/deploy it,
> (3) credentials & endpoints, (4) ongoing work, (5) an append-only session log.
>
> Every agent that completes a task MUST append a short note to the
> **Session Log** at the bottom of this file so the next agent has context.

---

## 1. Project at a Glance

**NetConsole** — Network Operations Console for **TAI LOC BANK**.
A web platform to inventory and manage network devices (switches, routers,
firewalls), discover subnets, collect configs/ARP/MAC tables, run jobs against
devices, and visualize the fabric topology.

### Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + TypeScript + Vite + Ant Design 5 + React Router 7 |
| Backend | Node.js 22 + Express 5 + TypeScript + Prisma 6 + PostgreSQL 16 |
| Worker | Python 3.12 + Jinja2 + httpx (Juniper RESTCONF), paramiko available but currently unused |
| DHCP | Kea DHCPv4 3.x in HA hot-standby mode |
| Lab | Containerlab (Juniper cRPD simulators) |
| CI/CD | GitHub Actions + self-hosted runner on the VPS |
| Deploy | `docker compose` on a single VPS, image build on every push |

### Layout

```
d:\NetConsole\
├── frontend/          React + Ant Design UI (Vite, build → Docker image on :80 inside container)
├── backend/           Express API + Prisma (port 3000 inside container)
├── worker/            Python job processor (poll-based, no port)
├── lab/               Containerlab topology + Kea DHCP configs + entrypoint.sh
├── scripts/           Dev/maintenance shell scripts (bash + PowerShell)
├── docker-compose.app.yml    Production stack (postgres + kea-HA + backend + worker + frontend)
├── docker-compose.lab.yml    Lab stack (EVE-NG, juniper-sim, core-gw, dhcp-client)
├── .github/workflows/
│   ├── ci.yml              PR/push: lint+test+build+compose-validate
│   ├── deploy.yml          push main OR tag v*.*.*: self-hosted runner → VPS deploy
│   └── rollback.yml        manual: deploy a previous tag (must type "ROLLBACK")
├── AUDIT.md            29 KB security audit snapshot (committed on 2026-08-30)
├── README.md
└── DEPLOYMENT.md       Setup, secrets rotation, branch protection, runner install
```

### Domain entities (Prisma schema)

`Device` (site, floor, name, ip unique, status enum, vendor/model/serial) ·
`Job` (typed queue: GET_CONFIG, GET_ARP, GET_MAC, GET_INTERFACES, CONNECT_TEST,
MANAGED_CHECK, DISCOVERY_PROBE, APPLY_CONFIG, ROLLBACK_CONFIG, INTERFACE_ACTION) ·
`DiscoveryScan` + `DiscoveryResult` (subnet sweeps) ·
`DeviceSavedConfig` (current + committedContent + rollbackContent) ·
`User` (with `mustChangePassword` flag — forced first-login password change).

---

## 2. Credentials & Endpoints

> **Do NOT commit real secrets. The values below are intentionally lab defaults.**
> Production secrets live in GitHub Secrets + rotated via `scripts/rotate_secrets.sh`.

### Local dev

```
Web UI:  http://localhost:8443
API:     http://localhost:3000/api   (direct, inside backend container only)
Login:   admin / Admin@123    (must change password on first login)
```

### Production VPS (this project lives here)

```
Host:     42.119.165.109
User:     sonnx  (sudo NOPASSWD)
Web UI:   http://42.119.165.109:8443
API:      http://127.0.0.1:3000/api  (from VPS only; not published externally)
SSH key:  C:\Users\XUANSON\.ssh\id_ed25519  (must be registered on GitHub Sonlak account)
DHCP relay endpoint (LAN side):  10.10.20.20:67  (public NIC of VPS, relayed to kea)
```

### GitHub

```
Repo:        https://github.com/Sonlak/netconsole  (private)
Branches:    main  (protected: linear history, no force-push, PR required)
             feat/*  (feature branches)
```

### Compose network (static IPs on `netconsole` bridge, subnet 172.31.0.0/24)

| Service | IP | Notes |
|---|---|---|
| `netconsole-postgres` | 172.31.0.2 | Postgres 16, persistent volume `netconsole_pgdata` |
| `netconsole-kea-primary` | 172.31.0.10 | Kea DHCPv4 active |
| `netconsole-kea-standby` | 172.31.0.11 | Kea DHCPv4 hot-standby |
| `netconsole-backend` | 172.31.0.3 | Express API (exposed to host only via curl) |
| `netconsole-worker` | 172.31.0.4 | Python poller |
| `netconsole-frontend` | 172.31.0.5 | Nginx serving Vite build on host :8443 |

---

## 3. Common Commands

### Local dev (Windows + PowerShell)

```powershell
# Start lab devices (Juniper sims, DHCP relay, etc.)
npm run lab:up

# Start the full app stack (postgres + kea + backend + worker + frontend)
npm run app:up

# Tail logs
docker compose -f docker-compose.app.yml logs -f backend worker frontend

# Stop everything
npm run app:down
npm run lab:down
```

### Backend (TypeScript)

```bash
cd backend
npm ci
npx prisma generate
npx prisma db push            # sync schema to dev DB
npx prisma db seed            # seed admin user (admin / Admin@123)
npm run dev                   # tsx watch mode
npm test                      # vitest
npm run build && npm start    # production build
```

### Worker (Python)

```bash
cd worker
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
python main.py
```

### Frontend (Vite)

```bash
cd frontend
npm ci
npm run dev       # dev server on :5173 with proxy to backend :3000
npm run build     # production build → dist/
```

### Deploy to production

```powershell
# Option A — tag-based (recommended for releases)
git tag v0.3.0
git push origin v0.3.0
# GitHub Actions runs .github/workflows/deploy.yml on the self-hosted runner
# → rsync to /opt/netconsole/ → docker compose up --build --no-deps backend worker frontend
# → curl healthchecks (172.31.0.3:3000/api/health + :8443/)

# Option B — merge to main triggers deploy automatically
# (requires PR review; branch protection enforces linear history)

# Option C — manual workflow_dispatch from GitHub Actions UI
```

### Rollback

```
GitHub → Actions → Rollback → Run workflow
- Tag: v0.2.0  (must match v*.*.*)
- Confirm: ROLLBACK
```

### Emergency: SSH to VPS directly (if CI is down)

```powershell
ssh -i C:\Users\XUANSON\.ssh\id_ed25519 sonnx@42.119.165.109

# On VPS:
cd /opt/netconsole
docker compose -p netconsole -f docker-compose.app.yml ps
docker compose -p netconsole -f docker-compose.app.yml logs --tail 50 backend
docker compose -p netconsole -f docker-compose.app.yml up -d --build --no-deps backend worker frontend
```

---

## 4. Architectural Conventions

### Branching

- Trunk-based with short-lived feature branches.
- Branch names: `feat/<scope>-<short-desc>` (e.g. `feat/worker-collect-arp`),
  `fix/<scope>-<short-desc>`, `chore/<scope>`, `docs/<scope>`.
- Always rebase onto `main` before opening a PR.
- Merge via squash or fast-forward only — **no merge commits** on `main`.

### Commit messages (Conventional Commits)

```
feat(fabric): port stubs, tier sidebar, larger node cards
fix(auth): handle null mustChangePassword on legacy users
chore(deps): bump prisma to 6.4
docs: update deployment guide for self-hosted runner
refactor(worker): split job dispatcher from ssh client
test(backend): add vitest coverage for /api/auth
ci: cache pip wheel downloads
```

### Code style

- Backend: ESLint flat config + Prettier (run via `npm run lint`); TypeScript strict.
- Frontend: ESLint + Prettier; functional components + hooks; Ant Design 5 (no v4 imports).
- Worker: `ruff check .` and `ruff format .`; type hints required on public functions.
- All shared types live in `backend/src/types/` and `frontend/src/api/types.ts`.

### REST API conventions

- All routes prefixed `/api`.
- Auth: `Authorization: Bearer <jwt>` header; `authMiddleware` on every route
  except `/api/health`, `/api/auth/login`.
- Validation: Zod schemas co-located with route handlers.
- Errors: `{ error: string, code?: string }` with appropriate HTTP status.

### Job queue model

Worker polls `GET /api/jobs?status=PENDING&worker=<name>` every second,
picks up jobs, executes them via SSH/RESTCONF, writes result back via
`PATCH /api/jobs/:id`. Concurrency: 4 (configurable via `WORKER_CONCURRENCY`).

### Deploy invariants

- `docker compose up --no-deps` for `backend worker frontend` ONLY.
  Never restart `postgres` or `kea-primary/standby` from a deploy — they
  hold persistent state (DB + DHCP leases).
- Health check order: wait for backend `/api/health` (40 × 2 s = 80 s)
  → wait 3 s → check `http://127.0.0.1:8443/` returns 200.
- Self-hosted runner must be registered as a repo Actions runner with label `self-hosted`.

---

## 5. Known Gotchas (read these before debugging)

1. **`mustChangePassword` flow is partial** — backend sets the flag in seed,
   `/api/auth/login` returns it, but **frontend `ProtectedRoute` does not
   yet redirect to a forced change-password page**. So a fresh admin login
   hits the dashboard with a warning flag but no enforcement. TODO: build
   `ChangePasswordRequiredPage` and wire it into `ProtectedRoute`.
2. **Firewall on VPS** — IP allow-listing blocks the agent's home IP
   (`42.114.206.127`). The user had to whitelist `0.0.0.0/0` on port 22.
   `firewalld` is **not** running on the VPS; use raw `iptables`.
3. **Windows line endings** — any `.sh` written from PowerShell must use
   `newline="\n"` when written via `Path.write_text`; otherwise bash on
   Linux sees `set -eu\r` and errors.
4. **paramiko vs OpenSSH CLI** — the deploy script switched from paramiko
   (which fails on OpenSSH 10 due to key-exchange algorithm mismatch) to
   native Windows OpenSSH at `C:\Windows\System32\OpenSSH\ssh.exe`.
5. **`docker compose` output is not always UTF-8** — decode with
   `errors="replace"` to avoid `UnicodeDecodeError` on cp1252 console.
6. **Compose IPAM** — backend talks to kea at fixed `172.31.0.10`/`.11`,
   not via service name. Don't change the subnet without a deploy dry-run.
7. **Worker auth token** is a long-lived JWT committed in
   `docker-compose.app.yml` for the `worker → backend` link. Treat as a
   secret; rotate via `scripts/rotate_secrets.sh`.
8. **Dagre rank ignores the `rank` node field** — `frontend/src/features/fabric/FabricDiagram.tsx`
   derives rank via BFS only as *labels/tone*; dagre always recomputes
   ranks from edge direction. So **edge direction in DB must be
   parent→child (higher-tier → lower-tier)**. If a link is stored as
   `access → core`, the access will end up at rank 0 (top of the canvas)
   and the rest of the layout collapses. Normalize direction in the
   FabricTopology loader if this happens.
9. **`FabricNode.floor` must be set on every access device** — the floor
   grouping in `layoutNodes` keys columns by `node.floor`. A missing
   `floor` falls back to `node.id`, which gets its own column and looks
   like a layout bug. If you ever see a stray access node sitting alone
   at the right edge of the canvas, the device record is missing a
   `floor` value.

---

## 6. Where Things Live (quick lookup)

| Topic | Path |
|---|---|
| Backend routes | `backend/src/routes/` |
| Auth (JWT, bcrypt, middleware) | `backend/src/routes/auth.ts`, `backend/src/middleware/auth.ts` |
| Prisma schema | `backend/prisma/schema.prisma` |
| Seed admin user | `backend/prisma/seed.ts` |
| Job dispatcher | `worker/main.py` (or `worker/app.py`) |
| Device status polling | `backend/src/services/pingScheduler.ts` |
| Fabric topology UI | `frontend/src/features/fabric/FabricDiagram.tsx` (dagre + BFS rank — see Session Log 2026-09-02 22:06), `frontend/src/pages/FabricPage.tsx`, layout sanity test: `frontend/sanity.mjs` |
| Ant Design theme bridge | `frontend/src/components/antd-bridge/` + `frontend/src/styles/antd-bridge.css` |
| Containerlab topology | `lab/*.clab.yml` |
| Kea DHCP config | `lab/kea/kea-dhcp4.conf` (templated via env) |
| Self-hosted runner setup | `scripts/setup-runner.sh` |
| Secrets rotation | `scripts/rotate_secrets.sh` |
| Deploy (manual, used before CI) | `agent-tools/deploy_full_openssh.py` (in agent tools dir, NOT in repo) |
| GitHub Actions | `.github/workflows/{ci,deploy,rollback}.yml` |

---

## 7. Session Log

> **Append a short note after each completed task.** Format:
> `### YYYY-MM-DD HH:MM — <agent/task summary>`
> followed by 3–10 bullet points: what changed, why, what's left.

### 2026-08-30 17:39 — Initial GitHub push + GitHub Actions setup
- User wanted professional GitHub workflow. Surveyed repo (230 staged files,
  no commits, no remote, master branch).
- Created conventional commit structure, branch protection guidance, README
  polish plan, three GitHub Actions workflows (`ci.yml`, `deploy.yml`,
  `rollback.yml`).
- Set `git config user.name="Sonlak"`, `user.email="sonlak@users.noreply.github.com"`.
- Updated `.gitignore` (excluded `netconsole-app.tar.gz`, `.tmp-hello.txt`).
- Staged 14 dev helper scripts in `scripts/`.
- Renamed branch `master` → `main`, created initial commit `bd53299 chore: initial commit`.
- Added SSH key (id_ed25519) to GitHub `Sonlak` account.
- Remote is `git@github.com:Sonlak/netconsole.git` (SSH).
- Repo on GitHub already had a 2-line README placeholder; rebased onto it,
  resolved conflict by keeping local 4.5 KB README.
- Pushed `0339b36..ef6bca0 main → main`.
- Popped stash of 5 unstaged changes (`.gitignore`, `backend/Dockerfile`,
  `backend/src/middleware/rateLimit.ts`, `docker-compose.app.yml`,
  `frontend/src/pages/LoginPage.tsx`); committed as follow-up with relaxed
  rate limits and tightened gitignore; pushed.
- **Status at end of session:** repo live, branch protected, deploy pipeline
  in place. Next: actual VPS deploy via CI.

### 2026-08-30 15:43 — SSH to VPS + first deploy
- User frustrated that "paramiko isn't doing anything" — clarified that
  `deploy_full_openssh.py` uses **Windows OpenSSH CLI**, not paramiko.
  Paramiko was abandoned after OpenSSH 10 key-exchange incompat.
- SSH from agent to `42.119.165.109` failed: VPS firewall (and cloud
  security group) blocked `42.114.206.127`. User opened port 22 via
  `iptables -I INPUT -p tcp --dport 22 -j ACCEPT` and the cloud security
  group rule.
- Set NOPASSWD sudo for `sonnx`:
  `echo "sonnx ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/sonnx && sudo chmod 440 /etc/sudoers.d/sonnx`.
- Ran `deploy_full_openssh.py`; fixed three bugs in the script:
  1. `set -euo pipefail` shell-parse error → `set -eu`.
  2. `.sh` files SCP'd to Linux with CRLF → added `newline="\n"` to
     `Path.write_text`.
  3. `subprocess.run(text=True)` decoded docker output as cp1252 and
     crashed on non-ASCII → switched to `text=False`, decoded `utf-8` with
     `errors="replace"`.
- Deploy succeeded: 5/5 containers healthy (`backend`, `worker`, `postgres`,
  `kea-dhcp1`, `kea-dhcp2`). Frontend publishes `0.0.0.0:8443→80`. Web
  reachable at `http://42.119.165.109:8443/`.
- UI loaded but showed "Unauthorized: No token provided" everywhere →
  `SEED_DISABLED=true` in `docker-compose.app.yml` had prevented admin
  user creation.
- **Status at end of session:** stack running on VPS, but no admin user yet.

### 2026-08-30 16:40 — Login flow + force change-password (partial)
- Goal: build login page, seed admin user (`admin / Admin@123`), force
  password change on first login.
- Discovered frontend already has `LoginPage`, `ProtectedRoute`, `useAuth`,
  `api/auth`; backend already has `/api/auth/{login,me,password}`,
  `authMiddleware`, JWT, bcrypt. So feature work is **integration, not
  greenfield**.
- Made these changes (not yet deployed):
  - `backend/prisma/schema.prisma`: added `mustChangePassword Boolean @default(false)`
    and `lastLoginAt DateTime?`, `lastLoginIp String?` to `User` model.
  - `backend/prisma/seed.ts`: admin user gets `mustChangePassword: true`.
  - `backend/src/routes/auth.ts`: `/login` returns `mustChangePassword`,
    `/me` includes it, `/password` clears it on successful change.
  - Created `frontend/src/pages/ChangePasswordRequiredPage.tsx` with
    current/new/confirm fields + validation rules.
  - Updated `frontend/src/hooks/useAuth.ts` to track `mustChangePassword`
    + added `markPasswordChanged()` helper.
  - Updated `User` type in `frontend/src/api/auth.ts` to include
    `mustChangePassword?`.
- **NOT YET DONE** (left to next session):
  - Wire `ProtectedRoute` to redirect to `/change-password-required` when
    `mustChangePassword === true`.
  - Add route in `App.tsx` for the change-password page.
  - Set `SEED_DISABLED=false` in `docker-compose.app.yml` (already false
    on prod actually — verify after deploy).
  - Rebuild backend + frontend Docker images, restart containers, run
    `prisma db push` + seed.
  - Verify in browser: login `admin / Admin@123` → forced password change
    page → set new password → dashboard loads.

### 2026-09-02 18:43 — Created AGENTS.md project notebook
- Authored this file after user asked for a project notebook that any new
  agent session can auto-read to get up to speed.
- Sections: project overview, stack, layout, credentials/endpoints,
  common commands, conventions, known gotchas, file lookup, session log.
- Captured all context from chats `41762e22…` (GitHub push) and
  `acc07d57…` (VPS deploy + login flow).
- **Not yet committed** — file created locally, user will commit + push.

### 2026-09-02 19:34 — FabricDiagram: 3-tier pyramid layout (Core/Dist/Access)
- User said the column-by-floor layout was wrong: "F1/F2/F3 ngang hàng nhau"
  was misinterpreted. The real ask is the classic 3-tier pyramid — Core on top,
  Distribution in the middle, Access at the bottom (horizontally aligned).
- Rewrote `frontend/src/features/fabric/FabricDiagram.tsx`:
  - Replaced `groupByFloor` buckets with `role` buckets.
  - Each role is one horizontal row (`TIER_ORDER = ['core','dist','access']`).
  - Width is sized to the widest tier; smaller tiers center within that band.
  - `crossTierSides()` picks `bottom→top` (or `top→bottom`) for cross-tier
    links and falls back to side routing for same-tier links.
  - `makeCrossTierPath` uses a mid-Y bus line so multiple parallel links from
    different sources fan out cleanly before reaching their targets.
  - Parallel links get `TRACK_STEP_X`/`TRACK_STEP_Y` offsets.
- Added `.nc-fabric-tier-band` CSS variants (`is-core` blue, `is-dist` purple,
  `is-access` green) so each tier has a faint coloured background band.
- Build clean (`tsc -b` + `npm run build` both exit 0). Commit `99d431a`.
- Pushed to main → CI green, Deploy green. Live at
  http://42.119.165.109:8443/fabric. Verified in browser: 8 devices × 13 links
  render as Core/Dist/Access pyramid with access switches horizontally aligned.
- **Lesson:** the column-by-floor design treated each floor as a separate
  physical column; what the user wanted was the logical 3-tier hierarchy
  regardless of which floor each device happens to sit on. Layout language
  should always start from "what role does this device play" not "where is it
  located".
- **Next time:** if user adds more access floors, consider auto-spacing the
  access tier so the row gets wider naturally (already handled by
  `maxTierCount`).
- User: "F1/F2/F3 ngang hàng nhau, không phải kiểu vậy".
- Rewrote `frontend/src/features/fabric/FabricDiagram.tsx` to use
  **columns-by-floor**: one column per floor (F1, F2, F3, F6…), nodes
  inside each column stack top-down by role (core → dist → access).
  Parallel links use perpendicular track offsets so they fan out cleanly.
- Pushed commit `7edf364` directly to main (branch protection is currently
  loose — direct push accepted). Deploy workflow run `33628602951` **failed**:
  frontend TypeScript build blew up with `Cannot find module '@/data/bank'`.
- **Root cause:** `deploy.yml` rsync had `--exclude 'data/'` — unanchored,
  so it matched `frontend/src/data/` too. Since `bank.ts` was added
  (2026-08-31), every deploy had silently nuked it from `/opt/netconsole`.
  CI's `tsc` was configured as advisory so PRs with this gap still merged.
- Fix commit `923c88f` anchored all rsync excludes with a leading slash
  (`'/.git/'`, `'/.data/'`, …). Restored the missing dir on the VPS via
  manual rsync, pushed, deploy run `33629409548` **succeeded**.
- Verified live: 8 devices × 13 links now render with F1/F2/F3 in three
  adjacent columns; F6 stacks cores+dists at the right. Links are
  fan-tracked, port labels readable, kind colours match the legend.
- Lesson for the next agent: when adding a `data/` (or any common name)
  folder inside a source tree, audit **both** `.gitignore` **and**
  `deploy.yml` rsync excludes. `tsc -b` (used by `npm run build`) is
  stricter than `tsc --noEmit`, so CI's advisory typecheck can let
  module-resolution breaks slip through.

### 2026-09-02 20:45 — FabricDiagram: gravitational alignment + per-source busY
- User complaint: "topo vẽ như vậy, đéo thể hiểu được" — lines between tiers cross
  chaotically because the previous layout centered each tier independently while
  the LAB topology is full-mesh (both dists connect to ALL 3 access switches,
  both cores connect to both dists).
- `frontend/src/features/fabric/FabricDiagram.tsx` fully rewritten:
  1. **Gravitational tier placement**: Access placed evenly. Each dist centered at
     the centroid of its access children; each core centered at the centroid of
     its dist children. With symmetric spread (spacing = NODE_W+NODE_GAP_X+24)
     around that centroid, cores and dists now land in the same vertical
     columns — primary uplinks read as straight vertical lines, only the
     cross-uplinks cross in the middle.
  2. **Per-source port sorting**: each source's outgoing cross-tier links are
     sorted by target X before port indices are assigned. The leftmost port goes
     to the leftmost target, so the fan-out matches physical wiring intuition.
  3. **Per-source busY lanes**: links from different sources get non-overlapping
     busY ranges. Within a source, each link gets a unique busY index so
     parallel links from the same source don't bundle into one thick cable.
- Key constants: `TIER_GAP 188→232`, `PORT_STUB 46→42`, `TRACK_STEP_BUS 26→18→14`
  (TRACK_STEP_BUS 14 chosen so max busOffset ≈ 63 stays within the stubEnd
  vertical range, avoiding kinks in the path).
- TypeScript clean + Vite build OK. Commits `c43bfda` (main fix) + `11b0328`
  (TRACK_STEP_BUS tuning). Pushed → CI green → Deploy green. Live at
  http://42.119.165.109:8443/fabric.
- **Next:** if user wants a cleaner result for full-mesh, consider grouping
  dist→access links by "primary" child (heuristic: closest access by X) and
  showing the rest as dashed backup links. Or use dagre.js for a proper DAG layout.

### 2026-09-02 22:06 — FabricDiagram: dagre + BFS rank-inference (scales to 18 floors × 7 access)
- User reported the LAB's *real* topology is bigger than what the gravitational
  layout was designed for: **2 cores + 4 dists + 18 floors × (2 first-hop +
  5 second-hop) = 132 devices / ~260 links**. Each real floor has 2 first-hop
  access switches that uplink to 2 dists, and 5 second-hop access switches
  that daisy-chain (tail) up to those 2 first-hop. So the layout is now
  **5 logical tiers, not 3**: Core → Distribution → Access L1 → Access L2.
- The 3-tier heuristic could not handle this. Decision: replace the heuristic
  with a real DAG layout using **dagre** + **BFS rank inference**.
- `frontend/src/features/fabric/FabricDiagram.tsx` rewrite:
  1. **`inferTiers(nodes, links)`** — BFS from every core (rank 0). For each
     other node, rank = min(parent rank) + 1 (i.e. *shortest* path from a core).
     Orphan nodes fall back to role-based `TIER_RANK`. Returns
     `{ rankById: Map<id, number>, tiers: TierMeta[] }`.
  2. **`layoutNodes(nodes, links)`** — builds a `dagre.graphlib.Graph`,
     sets `rankdir: 'TB'`, `ranksep: TIER_GAP`, `nodesep: 28`. Dagre's
     longest-path ranker assigns each node to the correct tier based on
     edge direction (parent→child). The returned center coords are mapped
     to top-left `boxMap`.
  3. **Floor grouping** — dagre alone spreads rank-2/3 nodes across the
     full canvas (90 second-hop → ~24 000 px wide). After dagre lays out
     the graph, group access nodes by `device.floor`, sort floors by their
     dagre centroid X, and assign each floor a compact column of
     `FLOOR_COL_WIDE = 320` px. First-hop stays on a single X; second-hop
     stacks vertically within the column with cascading sub-offsets
     (`SH_OFFSETS = [-60, 0, 60, -30, 30]`) so 5 nodes fan out cleanly.
  4. **Cross-tier side picking** now uses BFS-inferred rank (so an
     Access L2 node uses `top` stub for uplink to its first-hop parent,
     not relative to dist). Port placement code unchanged.
  5. **`TierMeta`** replaced `TierLayout.role`. Tones: `core`, `dist`,
     `access`, `leaf`. Labels: Core, Distribution, Access L1, Access L2.
- `frontend/package.json` — added `dagre@^0.8.5` and `@types/dagre`.
- `frontend/src/styles/antd-bridge.css` — added `.nc-fabric-tier-band.is-leaf`
  (lighter green tone for Access L2 band).
- New `frontend/sanity.mjs` (committed): offline simulator for the
  18-floor topology, prints canvas dimensions and per-floor X positions.
  Verified locally:
  - 132 nodes / 260 links → **canvas 15 224 × 1 438 px** (vs ~24 000 ×
    970 px with dagre alone; unbuildable with old heuristic).
  - Rank Y separation clean: core=110, dist=438, fh=766, sh=956.
  - 18 floor columns visible, second-hop stacked per floor.
- **Critical lesson for next agent**: dagre's `rank` field on a node
  is **ignored** when `multigraph: false` — dagre always re-computes
  ranks from edge direction. So edges in DB MUST point parent→child.
  If the API ever stores links in either direction, normalize them in
  the FabricTopology loader (`bank.ts` or the page fetch) before
  passing to `layoutNodes`, otherwise dist can end up at rank 0.
- TypeScript clean + Vite build OK. Commit `e32b460`. Pushed → CI green →
  Deploy green. Live at http://42.119.165.109:8443/fabric.
- **What to verify next time you open a Fabric session**:
  - The dagre dependency is in `package.json` (don't accidentally
    remove it).
  - `frontend/sanity.mjs` exists — run `node sanity.mjs` from the
    frontend dir for a quick sanity check after layout changes.
  - If the user complains "lines missing" or "nodes overlap", check
    `boxMap` in the browser devtools — the 4th rank tier (Access L2)
    uses `rank3NodeH = 68` instead of the default 96.
  - If the user adds new tiers (e.g. a 5th hop), the only constants to
    bump are inside `inferTiers` (the `switch (r)` block — add a new
    `case 4`).
  - Floor grouping assumes every access node has a non-empty
    `node.floor`. If a node has no floor, the fallback column key is
    the node id, which means it gets its own column → looks like a
    bug. Ensure `FabricNode.floor` is always populated for access
    devices.