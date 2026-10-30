# NetConsole — System Overview & Workflow

> **TAI LOC BANK — Network Operations Console**
> Last updated: 2026-09-21

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Infrastructure](#2-infrastructure)
3. [Component Details](#3-component-details)
4. [Core Workflows](#4-core-workflows)
5. [Database Schema](#5-database-schema)
6. [CI/CD Pipeline](#6-cicd-pipeline)
7. [Multi-Vendor Device Support](#7-multi-vendor-device-support)
8. [Key Architecture Patterns](#8-key-architecture-patterns)

---

## 1. System Overview

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USERS (Browser)                                │
│                   https://42.119.165.109:8443                               │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ HTTPS (nginx)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (172.31.0.5)                            │
│                     React 19 + TypeScript + Ant Design 5                    │
│                     nginx on :80  │  Dev: Vite on :5173                     │
│                                                                             │
│  Pages: Dashboard │ Devices │ Fabric │ Interfaces │ DHCP │ Logs │ Jobs    │
│  Feature: Config Studio (bulk deploy) │ Web Terminal (WebSocket SSH)      │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │ /api/*  (REST + WebSocket)
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BACKEND (172.31.0.3)                            │
│                  Node.js 22 + Express 5 + TypeScript                        │
│                        Prisma 6 + PostgreSQL 16                             │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         API Routes                                   │   │
│  │  /api/auth  /api/devices  /api/jobs  /api/fabric  /api/dhcp        │   │
│  │  /api/discovery  /api/interfaces  /api/logs  /api/config  ...     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Background Schedulers                           │   │
│  │  Ping (60s) │ MAC/ARP/IF collect (300s) │ Config collect (900s)   │   │
│  │  Job watchdog (30s) │ Interface counters │ Log retention            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Syslog Receiver (UDP :1514)                       │   │
│  │           Parses device logs → DeviceLog table + alerts             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   WebSocket Terminal (:3000/ws/terminal)              │   │
│  │              Browser ↔ backend ↔ lab device SSH                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │ HTTP polling
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            WORKER (172.31.0.4)                             │
│                   Python 3.12 + httpx + Jinja2                              │
│                  ThreadPoolExecutor (8 concurrent jobs)                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Job Types (10 total)                           │   │
│  │  CONNECT_TEST │ GET_CONFIG │ GET_ARP │ GET_MAC │ GET_INTERFACES    │   │
│  │  GET_LOGS │ INTERFACE_ACTION │ MANAGED_CHECK │ APPLY_CONFIG        │   │
│  │  ROLLBACK_CONFIG │ DISCOVERY_PROBE                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                   Vendor Backends (5 vendors)                       │   │
│  │  Juniper Junos │ Cisco IOS-XE │ Arista EOS │ Cisco NX-OS │ IOS    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Worker polls GET /api/jobs/queue every 1s (prod) / 5s (local)           │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ SQL queries
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          POSTGRES (172.31.0.2)                             │
│                          PostgreSQL 16 Alpine                              │
│                                                                             │
│  Tables: Device │ Job │ InterfaceCounterSample │ DeviceLog │ AuditLog     │
│           DiscoveryScan │ ConfigTemplate │ TerminalSession │ User ...     │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ DHCP lease queries
┌─────────────────────────────────────────────────────────────────────────────┐
│           KEA DHCP HA — DC↔DR (172.31.0.10, Tailscale to DR)            │
│             Kea 3.x hot-standby │ Control agent :8000                      │
│                Backend queries via REST API                                │
│                                                                            │
│  kea-dc1 (DC primary, 10.10.20.20:67)  ← HA sync →  kea-dr1 (DR standby) │
│  kea-dr1 binds :67 on 10.10.20.30 ONLY after promote (auto on DC down)    │
└─────────────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ UDP :67
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PHYSICAL LAB NETWORK                                │
│  Core │ Dist │ Access switches (Juniper cRPD in containers)             │
│  DHCP relay from EVE-NG → 10.10.20.20:67                                 │
│  Management network: 10.10.20.x  │  VLANs: 201/202/203                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Network Topology (Lab)

```
 Internet
   │
   │ public NIC (Tailscale)
   ▼
┌──────────────────────┐
│  VPS (Tailscale IP)  │  SSH via 100.102.133.86 (Tailscale only)
│  42.119.165.109      │  Port 22 blocked on public NIC
└──────┬───────────────┘
       │ Docker bridge 172.31.0.0/24
       ▼
 ┌─────────────────────────────────────────────┐
 │        Docker (netconsole network)          │
 │  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
 │  │ frontend  │  │  backend  │  │  worker │ │
 │  │:8443(HTTP)│  │  :3000    │  │         │ │
 │  └──────────┘  └──────────┘  └─────────┘ │
 │  ┌──────────┐  ┌──────────┐              │
 │  │ postgres  │  │  kea-dhcp │              │
 │  │ :5432     │  │ 1 :67/udp │              │
 │  └──────────┘  └──────────┘              │
 │              ┌──────────┐                 │
 │              │ kea-dhcp │                 │
 │              │ 2 :8000  │                 │
 │              └──────────┘                 │
 └──────────────┬────────────────────────────┘
                │ eth0
                ▼ (10.10.20.x - lab NIC)
 ┌─────────────────────────────────────────────┐
 │           Physical Lab Network (EVE-NG)      │
 │                                              │
 │  ┌──────────┐   ┌──────────┐               │
 │  │ SW-CORE-01│───│ SW-CORE-02│  (core peer) │
 │  └────┬─────┘   └────┬─────┘               │
 │       │               │                      │
 │  ┌────┴────┐   ┌────┴────┐                │
 │  │SW-DS-01 │   │SW-DS-02 │   (dist)       │
 │  └────┬────┘   └────┬────┘                │
 │       │               │                      │
 │  ┌────┴────┐   ┌────┴────┐                │
 │  │SW-AS-01 │   │SW-AS-02 │   (access)      │
 │  └────┬────┘   └────┬────┘                │
 │       │ VLAN201/202/203                     │
 │  ┌────┴────┐                                │
 │  │  VPCs   │   (DHCP clients)               │
 │  └─────────┘                                 │
 └─────────────────────────────────────────────┘
```

### 1.3 Component Responsibilities

| Component | Role | Language | Key Responsibility |
|---|---|---|---|
| **Frontend** | SPA UI | React 19 + TS | User interaction, device management, topology visualization |
| **Backend** | API server | Node.js 22 + TS | REST API, job orchestration, scheduled data collection, syslog receiver |
| **Worker** | Job executor | Python 3.12 | Device API calls (NETCONF/RESTCONF/CLI), config push, data retrieval |
| **PostgreSQL** | Database | SQL | Persistent storage for devices, jobs, logs, configs, users |
| **Kea DHCP** | DHCP server | C++ | IP address allocation, HA failover, lease tracking |
| **nginx** | Reverse proxy | C | HTTPS termination, static file serving for frontend |

---

## 2. Infrastructure

### 2.1 Docker Compose Architecture

```
File: docker-compose.app.yml  (Production on VPS)

Network: netconsole (bridge, 172.31.0.0/24, gateway 172.31.0.254)

Services:
┌──────────────┬────────────────┬───────────────────────────────────────────┐
│ Service      │ IP             │ Notes                                      │
├──────────────┼────────────────┼───────────────────────────────────────────┤
│ postgres     │ 172.31.0.2     │ PostgreSQL 16, :5432 internal only         │
│ kea-dc1      │ 172.31.0.10    │ DC primary DHCP, :67/udp on 10.10.20.20:67│
│ kea-dr1      │ DR Tailscale   │ DR standby, :67/udp on 10.10.20.30:30     │
│              │ 100.105.166.18 │ (only binds after promote; lives on DR VPS)│
│ backend      │ 172.31.0.3     │ Express API, :3000 internal + :1514/UDP   │
│ worker       │ 172.31.0.4     │ Job processor, polls backend every 1s     │
│ frontend     │ 172.31.0.5     │ React SPA, nginx :80, exposed on :8443    │
└──────────────┴────────────────┴───────────────────────────────────────────┘

File: docker-compose.lab.yml  (Local development)

Network: lab-net (172.30.0.0/24) + per-VLAN bridges
         + physical lab devices (Juniper cRPD containers)

Additional services: port-gw (socat for SSH/HTTP port mapping)
```

### 2.2 Resource Limits (Production)

| Service | Memory Limit | CPU | Reason |
|---|---|---|---|
| backend | 1GB max / 512MB reserved | 1.5 cores | Long-lived SSH sockets for terminal sessions |
| worker | unbounded | unbounded | CPU-bound job processing |
| postgres | Docker default | Docker default | PostgreSQL self-manages |
| kea-dhcp* | Docker default | Docker default | Lightweight DHCP |

### 2.3 Port Reference

| Port | Protocol | Service | Public? | Notes |
|---|---|---|---|---|
| 8443 | TCP/HTTP | Frontend | ✅ Yes | Main user access |
| 3000 | TCP/HTTP | Backend API | ❌ Localhost only | Internal |
| 1514 | UDP | Syslog receiver | ✅ Yes | Device log ingestion |
| 5432 | TCP | PostgreSQL | ❌ Internal | Docker network only |
| 67 | UDP | DHCP server | ✅ Via 10.10.20.20 | Lab NIC for relay |
| 8001 | TCP | Kea primary Ctrl | ❌ Localhost only | Kea REST API |
| 8002 | TCP | Kea standby Ctrl | ❌ Localhost only | Kea REST API |

---

## 3. Component Details

### 3.1 Frontend (React SPA)

```
frontend/src/
├── api/                    # API client layer
│   ├── http.ts             # authFetch (JWT handling, 401 refresh, cross-tab sync)
│   ├── devices.ts          # Device CRUD + operations
│   ├── fabric.ts           # Topology (nodes/links)
│   ├── jobs.ts             # Job queue polling
│   ├── dhcp.ts             # Kea API
│   └── ...
│
├── pages/                  # Route-level pages (lazy loaded)
│   ├── DashboardPage.tsx  # Metrics + activity feed
│   ├── DevicesPage.tsx     # Device inventory list
│   ├── DeviceDetailPage.tsx # Single device view
│   ├── FabricPage.tsx      # Floor topology diagram (Dagre SVG)
│   ├── InterfacesPage.tsx  # All ports table
│   ├── DhcpPage.tsx       # DHCP pool/lease view
│   ├── LogsPage.tsx       # Syslog browser
│   ├── JobsPage.tsx       # Job queue / activity
│   ├── DiscoveryPage.tsx  # Subnet scan + sync
│   ├── GenerateConfigPage.tsx # Config studio + bulk deploy
│   └── SettingsPage.tsx   # User management
│
├── features/
│   ├── fabric/
│   │   └── FabricDiagram.tsx  # Dagre-based SVG topology renderer
│   │                            # Infers floor/tier from Device.floor + name
│   │                            # port-index fix (2026-09-21): unified incident
│   │                            # map prevents uplink shadowing at DS nodes
│   ├── ports/
│   │   ├── PortsPanel.tsx      # Port list + bulk actions
│   │   └── PortStatsDrawer.tsx # Port detail + bandwidth chart
│   └── ...
│
├── hooks/
│   ├── useAuth.ts          # Auth context (user, login, logout, mustChangePassword)
│   ├── useJobs.ts          # Job polling + state
│   ├── useDevices.ts       # Device list + filters
│   └── useSiteFilter.ts    # NKKN/NTMK site filter
│
└── layouts/
    └── AppLayout.tsx       # Sidebar nav + header shell
```

**Key routing**: `react-router-dom` v7, lazy-loaded pages, `AppLayout` shell wraps all authenticated routes.

**API auth flow**: `authFetch` attaches `Authorization: Bearer <jwt>`, auto-refreshes on 401 via `BroadcastChannel` (cross-tab coordination), single-flight refresh prevents thundering herd.

### 3.2 Backend (Express API)

```
backend/src/
├── index.ts               # Entry point — middleware chain + schedulers + UDP syslog + WebSocket
│
├── middleware/
│   ├── auth.ts            # JWT verify (HS256), requireRole() guard
│   ├── auditLog.ts        # Append-only mutation audit trail
│   └── rateLimit.ts       # In-memory sliding window (4 tiers)
│
├── routes/
│   ├── auth.ts            # POST /login, /logout, /refresh, /register, /users CRUD
│   ├── devices.ts         # Device inventory CRUD + mounts operation routes
│   ├── deviceOperations.ts # /connect-test, /get-config, /get-arp, /apply-config,
│   │                      # /interface-action, /rollback-config, etc.
│   ├── jobs.ts            # POST /, GET /queue (worker), PATCH /:id/claim|complete
│   ├── fabric.ts         # GET /api/fabric (nodes + links, 15s cache)
│   ├── dhcp.ts            # GET /leases, /subnets, /ha-status (Kea API)
│   ├── discovery.ts       # POST /scan (subnet sweep)
│   ├── interfaces.ts      # Port collection results
│   ├── logs.ts            # Device log viewer + alert rules
│   ├── configCompare.ts   # Config snapshots + diff
│   ├── generateConfig.ts  # Jinja2 template rendering
│   ├── terminal.ts        # WebSocket session create/end
│   └── ...
│
├── services/
│   ├── deviceOperations.ts # Advisory-lock job creation (pg_advisory_xact_lock)
│   │                        # Pre-emption: URGENT jobs cancel blocking NORMAL jobs
│   │
│   ├── fabricTopology.ts   # Merges interface descriptions + LLDP → nodes + links
│   │                        # Infers roles (core/dist/access) + link kinds
│   │
│   ├── collectConfig.ts   # Config fetch logic (multi-vendor dispatch)
│   │
│   ├── discoveryScan.ts    # Subnet probe orchestration
│   │
│   ├── devicePing.ts       # ICMP ping scheduler + results
│   ├── arpAddress.ts       # Periodic ARP table collection
│   ├── macAddress.ts       # Periodic MAC address table collection
│   ├── interfaces.ts       # Periodic port data collection
│   │
│   ├── interfaceCounters.ts # IF-MIB counters (BigInt octets), poll → store → rate calc
│   │
│   ├── logs.ts             # Device log collection + persistence
│   ├── logAlerts.ts        # Evaluate LogAlertRule against incoming logs
│   ├── syslogParser.ts     # Parse raw UDP syslog → structured rows
│   ├── syslogReceiver.ts   # UDP socket on :1514
│   │
│   ├── jobWatchdog.ts      # Reclaim stale RUNNING jobs every 30s
│   ├── jobRetention.ts     # Cleanup old terminal rows from Job.result JSON
│   │
│   ├── eosApi.ts           # Arista EOS API client
│   ├── iosxeRest.ts        # Cisco IOS-XE RESTCONF client
│   ├── junosRest.ts        # Juniper Junos REST API client
│   ├── junosDhcp.ts          # Junos DHCP local server client (was keaDhcp.ts)
│   │
│   └── labSsh.ts           # Lab device SSH (for Web terminal)
│
├── websocket/
│   └── terminal.ts         # WebSocket bridge: browser ↔ lab SSH
│                            # Logs every command to TerminalSession/TerminalCommand
│
└── lib/
    ├── prisma.ts           # Singleton Prisma client
    ├── refreshTokens.ts    # SHA-256 refresh token hash comparison
    └── deviceFloor.ts      # Floor number / tier layout utilities
```

### 3.3 Worker (Python Job Processor)

```
worker/
├── main.py                          # WorkerClient event loop
│                                     # Polls GET /api/jobs/queue every 1s (prod)
│                                     # ThreadPoolExecutor(8) for concurrent jobs
│
├── netconsole_worker/
│   ├── config.py                    # Pydantic Settings (reads .env)
│   │
│   ├── models.py                    # DeviceInfo, JobInfo dataclasses
│   │
│   ├── vendor.py                    # BackendConfig (all creds), select_backend()
│   │                                   # detect_vendor() → "juniper"|"eos"|"iosxe"|"nxos"|"ios"
│   │
│   ├── tasks/
│   │   ├── registry.py              # TASK_REGISTRY: 10 job types → Task classes
│   │   └── managed_check.py         # ManagedCheckTask implementation
│   │
│   ├── backends/
│   │   ├── base.py                  # DeviceBackend ABC (8 abstract methods)
│   │   ├── juniper.py               # Junos RESTCONF primary → NETCONF SSH → SSH CLI
│   │   ├── eos.py                   # EOS eAPI (HTTPS JSON-RPC) → SSH CLI
│   │   ├── iosxe.py                 # IOS-XE RESTCONF + NETCONF SSH + backend proxy
│   │   ├── nxos.py                 # NX-OS NX-API REST/CLI → SSH CLI
│   │   └── ios.py                   # IOS IOSexec HTTP API → SSH CLI
│   │
│   ├── parsers/
│   │   ├── show_arp.py              # parse_juniper_arp_table, parse_cisco_arp_table
│   │   ├── show_mac_table.py        # parse_juniper_mac_table, parse_cisco_mac_table
│   │   ├── show_lldp_neighbors.py  # parse_junos_lldp_neighbors, parse_eos_lldp_neighbors
│   │   └── ...
│   │
│   ├── junos_rest.py                # JunosRESTPool (httpx connection pool)
│   │                                 # apply_set_configuration, rollback, ARP/MAC/interfaces
│   │
│   ├── junos_netconf.py             # NETCONF-over-SSH via ncclient (port 830)
│   │
│   ├── ssh_client.py                # SSHConnectionPool (paramiko)
│   │                                 # run_ssh_command, run_ssh_commands_session
│   │                                 # NETCONF helpers: netconf_interface_action, etc.
│   │
│   └── probe.py                     # Lightweight TCP probes (socket.connect)
│
└── templates/                       # Jinja2 config templates per vendor
```

### 3.4 Database Schema (Prisma / PostgreSQL)

```
22 models total:

┌──────────────────────────────┐
│         Core Entities          │
├──────────────────────────────┤
│ Device                        │  Network device inventory
│ Job                           │  Queued work item (type/priority/status)
│ User                          │  Auth + RBAC (ADMIN/OPERATOR/VIEWER)
│ RefreshToken                  │  30-day JWT refresh (SHA-256 hashed)
│ AuditLog                      │  Append-only mutation audit trail
└──────────────────────────────┘

┌──────────────────────────────┐
│      Data Collection          │
├──────────────────────────────┤
│ InterfaceCounterSample        │  Append-only time-series (BigInt octets/errors)
│ DeviceLog                    │  Parsed syslog entries (UDP :1514)
│ DeviceSavedConfig            │  Running/saved/rollback config blobs
│ TerminalSession / TerminalCmd │  Compliance log of SSH commands
└──────────────────────────────┘

┌──────────────────────────────┐
│      Discovery & Alerts       │
├──────────────────────────────┤
│ DiscoveryScan                 │  Subnet sweep state
│ DiscoveryResult               │  Per-host probe results
│ LogAlertRule                  │  Threshold alerting rules
│ LogAlert                      │  Triggered alerts
└──────────────────────────────┘

┌──────────────────────────────┐
│        Config Mgmt            │
├──────────────────────────────┤
│ ConfigTemplate                │  Jinja2 templates (JUNIPER/CISCO/ARISTA)
└──────────────────────────────┘
```

**Key indexes:**
- `Job`: `[status, priority, createdAt]` — worker queue poll
- `Job`: `[deviceId, type, status, updatedAt]` — per-device job lookup
- `InterfaceCounterSample`: `[deviceId, interfaceName, capturedAt]` — time-series queries
- `DeviceLog`: `[deviceId, timestamp]`, `[severity, timestamp]` — log browsing
- `AuditLog`: `[userId, createdAt]`, `[createdAt]` — compliance queries

---

## 4. Core Workflows

### 4.1 User Authentication

```
User → POST /api/auth/login (username + bcrypt password)
     ← JWT access token (15min) + refresh token (30d, SHA-256 hashed in DB)

Frontend stores JWT in memory (NOT localStorage — XSS resistant).
On 401: calls POST /api/auth/refresh → new access token.
Refresh tokens are rotated on each use (one-time pad, SHA-256 hash comparison).
BroadcastChannel syncs refresh across browser tabs to prevent thundering herd.

Logout: POST /api/auth/logout → invalidates refresh token in DB.

Audit: every mutating request logged to AuditLog (user, method, path, statusCode, bodyKeys).
```

### 4.2 Device Inventory Management

```
Add device:
  User → POST /api/devices {name, ip, vendor, model, site, floor, ...}
       ← Device created (status=UNKNOWN)

  Background: ManagedCheck job auto-scheduled → probes SSH/REST ports
           → Device.status updated to ONLINE/OFFLINE

Edit device:
  User → PUT /api/devices/:id → update metadata
       ← Device updated

Delete device:
  User → DELETE /api/devices/:id → cascades Jobs, counterSamples
       ← 204 No Content

List devices:
  User → GET /api/devices?site=&floor=&vendor=&status=&search=
       ← Device[] with lastPingAt, uptimeSeconds, managedChecks
```

### 4.3 Job Queue System (Critical Path)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           JOB LIFECYCLE                                     │
└─────────────────────────────────────────────────────────────────────────────┘

CREATION:
  User/Scheduler → POST /api/jobs  (backend/src/routes/jobs.ts)
                ← Job {id, type, deviceId, priority, status=PENDING, payload}

  Backend uses pg_advisory_xact_lock(deviceId) to prevent concurrent jobs
  for the same device. Priority determines pre-emption:
    - URGENT (200): APPLY_CONFIG, INTERFACE_ACTION, GET_CONFIG (user)
    - HIGH (100): GET_INTERFACES (manual refresh)
    - NORMAL (0): GET_ARP, GET_MAC (scheduled collection)

WORKER POLL:
  Worker → GET /api/jobs/queue?limit=N
         ← Job[] sorted by priority DESC, createdAt ASC

  Worker sorts AGAIN locally (same order) before processing.
  Takes first N jobs, runs them concurrently (ThreadPoolExecutor, 8 workers).

CLAIM:
  Worker → PATCH /api/jobs/:id/claim
         ← Job {status=RUNNING, claimedAt=now}

  If 409 Conflict: another worker took it, skip.

PROCESS:
  Worker parses job.type → looks up TASK_REGISTRY → calls Task.run(job, device)
  Task selects vendor backend → calls device API (NETCONF/RESTCONF/CLI)
  Result stored in job.result JSON.

COMPLETE:
  Worker → PATCH /api/jobs/:id/complete  {result: {...}}
         ← Job {status=SUCCESS, result, updatedAt}

  OR on error:
  Worker → PATCH /api/jobs/:id/complete  {error: "timeout after 120s"}
         ← Job {status=FAILED, error, updatedAt}

WATCHDOG:
  Backend jobWatchdog (every 30s): finds RUNNING jobs older than threshold
  → marks FAILED, sets error="Watchdog: job stuck in RUNNING"
  → allows blocked devices to accept new jobs.

PRE-EMPTION (INTERFACE_ACTION example):
  User triggers shut/no-shut → POST /api/jobs {type=INTERFACE_ACTION, priority=200}
  Worker claims it → pg_advisory_xact_lock blocks GET_ARP/GET_MAC (priority=0)
  INTERFACE_ACTION completes → lock released → collection resumes.
```

### 4.4 Config Push (Apply Config)

```
User → POST /api/deviceOperations/:id/apply-config  {configLines: [...], rollback: bool}
     ← Job {id, type=APPLY_CONFIG, status=PENDING}

  Backend: pg_advisory_xact_lock(deviceId) → creates job → queues

  Worker picks up job:
    1. Selects vendor backend (iosxe/juniper/eos/nxos/ios)
    2. Backend.apply_config(lines) → pushes to device via:
       - Juniper: RESTCONF load+commit (or NETCONF SSH)
       - IOS-XE: NETCONF SSH :writable-running:1.0 (no commit needed)
       - EOS: eAPI HTTPS JSON-RPC
       - NX-OS: NX-API REST/CLI
       - IOS: IOSexec HTTP → SSH CLI fallback (write needs PTY)
    3. Worker → PATCH /api/jobs/:id/complete {result}

  Post-apply: backend snapshots config to DeviceSavedConfig.

Rollback (if user requested):
  User → POST /api/deviceOperations/:id/rollback-config
       ← Job {type=ROLLBACK_CONFIG}

  Worker calls backend.rollback_config() → device's saved rollback snapshot.
  Juniper: rollback N + commit via RESTCONF
  IOS-XE: configure replace flash:rollback-config
  EOS: configure replace flash:startup-config

⚠️  Safety net (NOT yet implemented): Pre-apply snapshot per device.
    - IOS-XE: prepend `archive config` → flash:pre.config
    - EOS: prepend `copy running-config startup-config`
    Overhead: ~1-2s/device. Manual rollback via console.
```

### 4.5 Interface Action (Shut / No-Shut)

```
User → POST /api/deviceOperations/:id/interface-action
     {action: "shutdown"|"no-shut"|"set-access-vlan", interface: "ge-0/0/1", vlanId: 10}
     ← Job {id, type=INTERFACE_ACTION, priority=200 (URGENT)}

Worker picks up (pre-empts background collection):

  Juniper:
    1. RESTCONF primary (JunosRESTPool) — load + commit set commands
       - shut:    set interfaces <name> disable  (nc:operation="merge")
       - no-shut: delete interfaces <name> disable  (nc:operation="delete")
       - set-vlan: set interfaces <name> unit 0 family ethernet-switching vlan-id <vlan>
    2. Fallback: NETCONF SSH (port 830) if RESTCONF disabled
    3. Recovery: if "configuration database modified" → discard-changes + retry

  IOS-XE:
    1. NETCONF SSH (port 830) via ncclient
       - shut:    <shutdown nc:operation="merge"/>
       - no-shut: delete <shutdown/>  (data-missing on delete = success)
    2. Backend RESTCONF proxy fallback (worker can't reach 10.10.20.x lab IPs)

  EOS:
    1. eAPI HTTPS JSON-RPC: "switchport trunk allowed vlan add" etc.
    2. SSH CLI fallback

Post-action: backend re-collects interfaces → updates Interface table in DB.
```

### 4.6 Data Collection Schedulers

```
Backend starts these setInterval schedulers at boot (src/index.ts):

┌────────────────┬────────────┬──────────────────────────────────────────────┐
│ Scheduler      │ Interval    │ What it does                                  │
├────────────────┼────────────┼──────────────────────────────────────────────┤
│ devicePing     │ 60s         │ ICMP ping all managed devices → Device.lastPingAt│
│ managedCheck   │ 600s        │ SSH/REST probe → Device.status + managedChecks │
│ macCollect     │ 300s        │ POST /api/jobs {type=GET_MAC, priority=0}     │
│ arpCollect     │ 300s        │ POST /api/jobs {type=GET_ARP, priority=0}     │
│ interfacesColl│ 600s        │ POST /api/jobs {type=GET_INTERFACES, prio=0}  │
│ configCollect  │ 900s        │ POST /api/jobs {type=GET_CONFIG, priority=0}  │
│ jobWatchdog    │ 30s         │ Reclaim stale RUNNING jobs                    │
│ counterPoll    │ optional    │ IF-MIB counters → InterfaceCounterSample      │
└────────────────┴────────────┴──────────────────────────────────────────────┘

Each collect scheduler filters eligible devices via collectableDevices service:
  - Device.status = ONLINE (not MAINTENANCE/OFFLINE)
  - Not currently running a job for the same type (pg_advisory_xact_lock)
  - Collect interval has elapsed since last job

Results stored in DB → API returns to frontend without worker round-trip.
```

### 4.7 Syslog & Log Alerting

```
Device → UDP :1514 (syslog)
       │
       ▼
Backend syslogReceiver (UDP socket)
       │
       ├──► syslogParser → DeviceLog row (structured: hostname, severity, facility, message)
       │
       └──► logAlerts → evaluates LogAlertRule[] against incoming log
                        → creates LogAlert row if match
                        → frontend polls /api/logs/alerts

Log retention: logRetention service deletes DeviceLog rows older than LOG_RETENTION_DAYS (default 30).

Alert rule fields: deviceId (null=any), minSeverity, messagePattern (regex), facility (null=any)
```

### 4.8 Fabric Topology Discovery

```
Source data:
  1. Interface descriptions (from GET_INTERFACES): "## F1-AS-01 ##" pattern → infers link
  2. LLDP neighbors (from GET_INTERFACES merge): physical topology

Build process (fabricTopology service):
  1. Fetch all ONLINE devices
  2. For each device, parse interface descriptions → extract peer names → lookup Device table
  3. Fetch LLDP neighbors from worker results → cross-reference
  4. Infer link type from floor + name:
       - Same floor, both "access": access switch to host (L2 trunk)
       - Access to dist: uplink trunk
       - Dist to core: core uplink
       - Core peer to core peer: peer (BGP/Virtual-Chassis)
  5. Cache result for 15s → serve via GET /api/fabric

Frontend rendering (FabricDiagram.tsx):
  - Dagre lays out nodes by floor (y = pixel position from floor number)
  - X position computed from rank (core=left, access=right)
  - portIndex() fix (2026-09-21): unified incident map per (node, side)
    prevents uplink shadowing when DS has both incoming (F4→DS) and
    outgoing (DS→F1/F2/F3) links on same port index
```

### 4.9 Subnet Discovery Scan

```
User → POST /api/discovery/scan  {subnet: "10.1.201.0/24", site, floor}
     ← DiscoveryScan {id, status=PENDING, totalHosts=256}

Backend:
  1. Expands /24 → 256 hosts
  2. Spawns PING jobs for each host (DISCOVERY_PROBE type)
  3. Worker probes each IP via SSH/REST → collects vendor/model/serial

Results → DiscoveryResult per host:
  PING_FAIL → SKIPPED_EXISTS
  PROBING → DISCOVERED → SYNCED (device added to inventory)
  PROBING → FAILED

Sync to inventory:
  User reviews results → clicks "Sync" → creates Device records for DISCOVERED hosts
  → assigns site/floor/vlan based on scan context
```

### 4.10 Web Terminal (SSH Compliance Logging)

```
User → POST /api/terminal  {deviceId}
     ← WebSocket URL /ws/terminal

Browser connects WebSocket:
  Browser ↔ Backend WebSocket terminal.ts
         ↔ Lab SSH (labSsh service, paramiko)
         ↔ Device SSH (port 22)

Every command + output → TerminalCommand row:
  - Passwords stripped server-side
  - Duration tracked (ms)
  - Session start/end logged (TerminalSession)

Compliance: full audit trail of every SSH command run by any operator.
```

---

## 5. Database Schema (ERD Summary)

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│    User      │──1:N──│  RefreshToken│       │ TerminalSess │
└──────┬───────┘       └──────────────┘       └──────┬───────┘
       │ 1:N                                        │ 1:N
       ▼                                           ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│    AuditLog  │       │     Job      │──N:1──│   Device     │
└──────────────┘       └──────┬───────┘       └──────┬───────┘
                               │ 1:N                   │ 1:N
                        ┌──────┴───────┐        ┌──────┴───────┐
                        │              │        │              │
                   ┌────▼────┐   ┌─────▼────┐  │   Interface  │
                   │Discovery│   │  Job     │  │ CounterSamp  │
                   │ Scan    │   │  (self)  │  │              │
                   └────┬────┘   └──────────┘  └──────────────┘
                        │ 1:N
                   ┌────▼────┐
                   │Discovery│
                   │ Result  │
                   └────┬────┘
                        │ 1:1 (optional)
                   ┌────▼────┐
                   │ Device  │──1:1──┌──────────────┐
                   └─────────┘       │DeviceSavedCfg│
                                     └──────────────┘

┌──────────────┐  1:N  ┌──────────────┐  N:1  ┌──────────────┐
│  LogAlertRule│──────→│   LogAlert    │←──────│  DeviceLog   │
└──────────────┘       └──────────────┘       └──────────────┘

┌──────────────┐       ┌──────────────┐
│ ConfigTemplate│──1:N──│    ???        │
└──────────────┘       └──────────────┘
```

---

## 6. CI/CD Pipeline

### 6.1 Deploy Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GIT PUSH → PRODUCTION                             │
└─────────────────────────────────────────────────────────────────────────────┘

  Developer
    │
    │ git add + git commit + git push origin <branch>
    │
    ▼
  GitHub PR → Code Review → Merge to main
    │
    │ push to main OR git tag v1.0.0 && git push --tags
    │
    ▼
  GitHub Actions: deploy.yml (self-hosted runner on VPS)
    │
    ├─► Step 1: Save rollback marker (.rollback-before-deploy-sha)
    │      ← Anchors current good state BEFORE we touch anything
    │
    ├─► Step 2: rsync source → /opt/netconsole
    │      ← Preserves /data, /volumes, /.tmp-cfg across deploys
    │
    ├─► Step 3: docker compose up -d --build --no-deps backend worker frontend
    │      ← Kea + Postgres NOT rebuilt (persistent state)
    │
    ├─► Step 4: Health check (probe /api/health every 2s, up to 40 attempts)
    │
    ├─► Step 5: Update .last-deploy-sha marker (this is now the new good state)
    │
    └─► Step 6: Push images to GHCR (ghcr.io/sonlak/netconsole-*)
           ← Runs in parallel, not blocking deploy

  Deploy succeeds → service live at https://42.119.165.109:8443
```

### 6.2 Auto-Rollback Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AUTO-ROLLBACK (on deploy failure)                   │
└─────────────────────────────────────────────────────────────────────────────┘

  Deploy fails (build error / health check timeout)
    │
    │ workflow_run: deploy.yml completes with conclusion=failure
    │
    ▼
  GitHub Actions: rollback.yml (reads from main branch, NOT failing commit)
    │
    ├─► Marker resolution (priority order):
    │      1. .rollback-before-deploy-sha  ← set by PREVIOUS successful deploy
    │      2. .last-deploy-sha            ← current VPS state
    │      3. git HEAD on /opt/netconsole  ← fresh VPS
    │      4. FALLBACK_SHA (hardcoded)     ← last resort
    │
    ├─► git checkout <good-sha> + rsync to /opt/netconsole
    │      ← Excludes /data, /volumes, marker files
    │
    ├─► Rebuild (3-tier fallback):
    │      1. docker compose up -d --build --no-deps  ← normal path
    │      2. docker compose up -d --no-deps         ← use cached image
    │      3. docker compose restart                  ← last resort
    │
    ├─► Health check (backend + frontend)
    │
    └─► Update markers: .last-deploy-sha = rolled-back SHA

  Rollback succeeds (~1-2 min total) → service restored
  Next deploy will overwrite markers with new good state.
```

### 6.3 Rollback Marker State Machine

```
Before any deploy:
  .rollback-before-deploy-sha: <absent>
  .last-deploy-sha:            <absent or stale>

After Deploy #1 succeeds:
  .rollback-before-deploy-sha: <sha-1>
  .last-deploy-sha:            <sha-1>

After Deploy #2 fails (while sha-1 still running):
  .rollback-before-deploy-sha: <sha-1>  ← NOT overwritten by failure!
  .last-deploy-sha:            <sha-1>

Rollback to sha-1:
  .rollback-before-deploy-sha: <sha-1>
  .last-deploy-sha:            <sha-1>

After Deploy #3 succeeds:
  .rollback-before-deploy-sha: <sha-1>  ← anchor stays (previous good)
  .last-deploy-sha:            <sha-3>   ← updated to new good
```

### 6.4 Trigger Reference

| Trigger | What happens |
|---|---|
| Push to `main` | Deploy latest main → production |
| `git tag v*.*.*` push | Deploy tagged commit → production |
| GitHub Actions UI → Deploy → Run | Deploy any ref manually |
| Deploy fails | Auto-rollback to last known-good (marker-based) |
| GitHub Actions UI → Rollback → Run | Manual rollback to arbitrary ref |

---

## 7. Multi-Vendor Device Support

### 7.1 Vendor Backend Matrix

```
┌──────────┬─────────────┬─────────────┬──────────────────────────────────────┐
│ Vendor   │ Read path  │ Write path  │ Notes                                 │
├──────────┼─────────────┼─────────────┼──────────────────────────────────────┤
│ Juniper  │ RESTCONF    │ RESTCONF    │ Primary. NETCONF SSH (port 830) for   │
│ Junos    │ (port 8443) │ load+commit  │ LLDP, uptime, scoped config reads.   │
│          │             │             │ SSH CLI fallback.                      │
├──────────┼─────────────┼─────────────┼──────────────────────────────────────┤
│ Cisco    │ NETCONF SSH │ NETCONF SSH │ Port 830. :writable-running:1.0.      │
│ IOS-XE   │ (port 830)  │ :writable-  │ No candidate, no commit.             │
│          │             │ running:1.0  │ <shutdown/> is presence container.   │
│          │             │             │ RESTCONF proxy via backend container. │
├──────────┼─────────────┼─────────────┼──────────────────────────────────────┤
│ Arista   │ eAPI HTTPS  │ eAPI HTTPS  │ JSON-RPC 2.0 over HTTPS.              │
│ EOS      │ (port 443)  │ (port 443)  │ SSH CLI fallback.                     │
├──────────┼─────────────┼─────────────┼──────────────────────────────────────┤
│ Cisco    │ NX-API REST │ NX-API CLI  │ DME JSON at /api/mo/ + CLI at /ins.  │
│ NX-OS    │ + NX-API CLI│             │ SSH CLI fallback.                     │
├──────────┼─────────────┼─────────────┼──────────────────────────────────────┤
│ Cisco    │ IOSexec     │ IOSexec HTTP│ TLS 1.0, Basic Auth, CSRF token.      │
│ IOS      │ HTTP API    │ → SSH CLI   │ Works on IOS 12.4+. No NETCONF.      │
└──────────┴─────────────┴─────────────┴──────────────────────────────────────┘
```

### 7.2 Backend Selection Flow

```
Worker receives Job {device: {vendor: "Juniper"}}
  │
  ▼
select_backend(device) → detect_vendor(vendor_string)
  │
  ├─ "juniper"  → JuniperBackend (RESTCONF primary, NETCONF SSH fallback)
  ├─ "eos"      → EosBackend      (eAPI HTTPS primary, SSH fallback)
  ├─ "iosxe"    → IosxeBackend    (NETCONF SSH primary, RESTCONF proxy)
  ├─ "nxos"     → NxosBackend     (NX-API REST/CLI, SSH fallback)
  └─ "ios"      → IosBackend      (IOSexec HTTP, SSH CLI for writes)

Each backend implements DeviceBackend ABC:
  get_interfaces()    get_arp()         get_mac()
  get_config()        apply_config()     rollback_config()
  interface_action()  probe_identity()   get_logs()
  get_lldp()

Credentials from env vars (ENABLE_*_API flags gate per-vendor):
  JUNOS_REST_USER/PASS, EOS_API_USER/PASS, IOSXE_API_USER/PASS, etc.
```

---

## 8. Key Architecture Patterns

### 8.1 Advisory Lock (Job Serialization)

```sql
-- Backend uses pg_advisory_xact_lock(deviceId) before creating a job
-- for a specific device. This prevents two concurrent jobs for the same device.
SELECT pg_advisory_xact_lock(deviceId::bigint);
INSERT INTO "Job" (...) VALUES (...);
```

Worker claims job → runs in ThreadPoolExecutor → concurrent jobs for DIFFERENT devices still work.

### 8.2 Job Priority Pre-emption

```sql
-- Worker watchdog reclaims RUNNING jobs stuck > threshold (60s)
UPDATE "Job"
SET status = 'FAILED', error = 'Watchdog: job stuck in RUNNING'
WHERE status = 'RUNNING'
  AND updatedAt < NOW() - INTERVAL '60 seconds';

-- Pre-emption: URGENT job creation cancels blocking NORMAL jobs
-- (background collection for same device)
```

### 8.3 BigInt Interface Counters

```typescript
// Interface counters exceed 2^32 on busy uplinks → BigInt in Prisma schema
model InterfaceCounterSample {
  inOctets    BigInt?
  outOctets   BigInt?
  inPackets   BigInt?
  outErrors   BigInt?
  // ...
}

// Bandwidth rate = (delta_octets × 8) / delta_seconds
// API computes on the fly; raw counters persisted for replay.
```

### 8.4 Syslog UDP Receiver

```typescript
// Backend binds UDP :1514 for device log ingestion
// No auth needed — devices send to this port directly
// Each packet parsed → DeviceLog row + LogAlert evaluation

// Port exposed on lab NIC (10.10.20.20:1514) via docker-compose:
// ports: ["10.10.20.20:1514:1514/udp"]
// DNAT rule required so host kernel forwards UDP to container.
```

### 8.5 Connection Pooling

| Pool | Library | Key | Reuse strategy |
|---|---|---|---|
| `JunosRESTPool` | httpx | host:port:user:scheme | Persistent HTTP connections; alive-check on cold entries; background reaper for idle > 600s |
| `SSHConnectionPool` | paramiko | host | Single SSHClient per host; TCP keepalive 60s; release/borrow/release pattern |

### 8.6 Frontend State Architecture

```
No Redux — pure React Context + local useState:

useAuth      → {user, login, logout, refresh}
useSite      → {site: "NKKN"|"NTMK", floor}
useJobs      → {jobs, refetch}
useDevices   → {devices, filters, pagination}
useMetricHistory → {history: MetricSnapshot[]}

// Auth: JWT in memory, NOT localStorage (XSS protection)
// 401 refresh: BroadcastChannel coordinates across tabs
// Single-flight: boolean flag prevents concurrent refresh
```

### 8.7 Config Safety Net (Backlog)

```
Current: apply_config pushes each line immediately → no rollback on SSH drop.

Planned (NOT yet implemented):
  IOS-XE: prepend `archive config` → writes flash:pre.config
          rollback: `configure replace flash:pre.config force`
  EOS:    prepend `copy running-config startup-config`
          rollback: `configure replace flash:startup-config`

Overhead: ~1-2s per device (one-time, not per-line).
Manual rollback via console (user confirmed acceptable).
```

---

## Appendix: Quick Reference

### Service URLs (Production)

| Service | URL |
|---|---|
| Frontend | https://42.119.165.109:8443 |
| Backend API | http://172.31.0.3:3000/api |
| Kea primary | http://172.31.0.10:8000/ |
| Kea standby | http://172.31.0.11:8000/ |

### Key Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login` | Authenticate |
| `GET /api/devices` | List devices |
| `POST /api/devices/:id/apply-config` | Push config |
| `POST /api/devices/:id/interface-action` | Shut/no-shut |
| `GET /api/jobs/queue` | Worker poll |
| `GET /api/fabric` | Topology |
| `GET /api/dhcp/leases` | DHCP leases |
| `GET /api/health` | Health check |

### Job Types

| Type | Priority | Who creates |
|---|---|---|
| APPLY_CONFIG | 200 | User |
| INTERFACE_ACTION | 200 | User |
| ROLLBACK_CONFIG | 200 | User |
| GET_CONFIG | 200 | User |
| CONNECT_TEST | 200 | User |
| MANAGED_CHECK | 200 | User |
| GET_INTERFACES | 100 | User (manual refresh) |
| GET_ARP | 0 | Scheduler |
| GET_MAC | 0 | Scheduler |
| GET_CONFIG | 0 | Scheduler |
| DISCOVERY_PROBE | 200 | Discovery scan |

### Critical Gotchas (from ops)

| # | Topic | Impact |
|---|---|---|
| 1 | `mustChangePassword` not wired | Admin hits dashboard with flag, no redirect |
| 2 | VPS SSH via Tailscale only | Port 22 blocked on public NIC |
| 3 | Windows CRLF | `.sh` scripts from PowerShell need `newline="\n"` |
| 4 | paramiko dead | Deploy uses Windows OpenSSH CLI, paramiko fails on OpenSSH 10 |
| 5 | Docker compose UTF-8 | Decode with `errors="replace"` |
| 6 | Worker JWT | Committed in `docker-compose.app.yml`; rotate via `scripts/rotate_secrets.sh` |
| 7 | Dagre ignores `rank` | Edge direction in DB MUST be parent→child |
| 8 | `TierLayout.y` = pixel | Not rank integer |
| 9 | Fabric port-index | Unified incident map (fixed 2026-09-21) |
| 10 | IOS-XE NETCONF | Port 830, no commit needed, presence container for shutdown |
| 11 | Junos NETCONF cold-start | 20-30s on first commit; RESTCONF load+commit ~17s |
| 12 | No fixed-offset arrays | SH_OFFSETS/FH_OFFSETS patterns break on large counts |
| 13 | `tsc --noEmit` misses TS2451 | Run `npm run build` before commit |
