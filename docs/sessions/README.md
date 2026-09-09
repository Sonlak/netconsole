# Session Log Index

> Auto-loaded memory for any agent. Read this FIRST before doing any work.
> Each entry = 1 agent session. Format: `### HH:MM -- topic`.

## Active Work (read first!)

| Status | Topic | Files | Last touched |
| --- | --- | --- | --- |
| 🟡 Ready to deploy | Juniper `interface_action`: NETCONF SSH primary for shut/no-shut/set-vlan, RESTCONF→NETCONF→SSH for show-run | `worker/junos_netconf.py`, `worker/parsers/configuration_rpc.py`, `worker/backends/juniper.py` | 2026-09-09 09:50 |
| 🟡 Ready to deploy | Collect reads = REST-first; write ops = NETCONF via queue | `backend/services/junosRest.ts`, `iosxeRest.ts`, `arpAddress.ts`, `macAddress.ts`, `interfaces.ts`, `routes/deviceOperations.ts`, `routes/interfaces.ts`, `docker-compose.app.yml`, `frontend/pages/DeviceDetailPage.tsx`, `frontend/features/ports/PortsPanel.tsx` | 2026-09-08 22:00 |
| 🟢 Deployed | Config Studio Collect/Commit priority fix (commit 16019cc) | `backend/src/services/deviceOperations.ts` | 2026-09-08 20:20 |
| 🟢 Deployed | NETCONF SSH Junos end-to-end (commit 212fbd9) | `worker/junos_netconf.py` | 2026-09-08 15:30 |
| 🟢 Deployed | LAB-F3-AS-02 Cisco IOS-XE SSH-prefer parsers (60b7e4c) | `worker/netconsole_worker/backends/iosxe.py` | 2026-09-07 12:55 |

## Open TODOs (carried across sessions)

| Topic | Why blocked | Owner |
| --- | --- | --- |
| `mustChangePassword` redirect not wired | Frontend `ProtectedRoute` doesn't check flag, no `/change-password-required` route | Frontend |
| Rollback schema-drift (`prisma db push` may drop tables with data) | Need `--accept-data-loss` flag or detection logic | Backend |
| Off-host backup (rsync to Tailscale NAS or B2) | `backup_postgres.sh` dumps locally only | Backend |
| Per-device vendor credentials (Phase 2) | Backlog -- needs `Device.connectorJson` JSON column + env-resolution paths | Backend+Worker |
| Bulk-config safety net (pre-apply snapshot) | Deferred per user request -- manual rollback via console, +1-2s overhead | Backend |
| NETCONF fallback error visible to operator | Field exposed in job result, but not wired through Logs UI | Frontend |
| Extend 20s frontend poll for slow Junos commits? | TBD -- depends on UX feedback | Frontend |

## Session Log (chronological, newest first)

| Date | Time | Topic | Files touched | Status |
| --- | --- | --- | --- | --- |
| 2026-09-09 | 09:50 | Juniper `interface_action` fix: NETCONF SSH primary for shut/no-shut/set-vlan, RESTCONF→NETCONF→SSH for show-run | `worker/junos_netconf.py`, `worker/parsers/configuration_rpc.py`, `worker/backends/juniper.py` | 🟡 Ready to deploy |
| 2026-09-08 | 22:00 | Collect buttons: REST-first reads + NETCONF writes | `backend/services/junosRest.ts`, `backend/services/iosxeRest.ts` (new), `arpAddress.ts`, `macAddress.ts`, `interfaces.ts`, `routes/deviceOperations.ts`, `routes/interfaces.ts`, `docker-compose.app.yml`, `frontend/pages/DeviceDetailPage.tsx`, `frontend/features/ports/PortsPanel.tsx` | 🟡 Ready to deploy |
| 2026-09-08 | 20:20 | Config Studio Collect/Commit failing with 'Device busy' -- jobPriority URGENT/HIGH split | `backend/src/services/deviceOperations.ts`, `deviceTabCollection.ts`, `interfaces.ts` | 🟢 Deployed |
| 2026-09-08 | 15:30 | NETCONF SSH Junos end-to-end (commit 212fbd9) | `worker/junos_netconf.py`, `worker/backends/juniper.py`, `worker/Dockerfile`, `docker-compose.app.yml` | 🟢 Deployed |
| 2026-09-08 | 14:00 | NETCONF SSH Junos attempt 1 -- hello exchange stuck | `worker/junos_netconf.py` | ❌ Superseded by 15:30 |
| 2026-09-07 | 13:00 | LAB-F3-AS-02 Cisco IOS-XE SSH-prefer + parsers | `worker/backends/iosxe.py`, `parsers/show_arp.py`, `parsers/show_mac_table.py` | 🟢 Deployed |
| 2026-09-07 | 11:40 | Vendor tabs broken: ARP/MAC fields missing | frontend vendor tabs | 🟢 Deployed |
| 2026-09-07 | 00:34 | Footer copy revert -- user wanted "(c) 2026 SonLak." | frontend footer | 🟢 Deployed |
| 2026-09-07 | 00:22 | UI footer cleanup (drop Build + fix font) | frontend footer | 🟢 Deployed |
| 2026-09-06 | 23:20 | Bulk deploy: live progress tracker + completion notification | frontend Config Studio | 🟢 Deployed |
| 2026-09-06 | 22:30 | Config Studio dedupe sidebar + Bulk deploy tab | frontend Config Studio | 🟢 Deployed |
| 2026-09-06 | 22:30 | Logs: hide Junos noise by default + tame RESTCONF rate | frontend Logs | 🟢 Deployed |
| 2026-09-06 | 21:00 | Logs: syslog UDP push end-to-end + SSH fallback removed | backend+worker logs | 🟢 Deployed |
| 2026-09-06 | 17:00 | Logs: syslog UDP push verified live + SSH collector 30min | backend+worker logs | 🟢 Deployed |
| 2026-09-06 | 16:20 | Worker: stop SSH fallback when REST returns empty (92% reduction) | worker parsers | 🟢 Deployed |
| 2026-09-06 | 14:50 | CI/CD: auto-rollback + GHCR image push | CI workflows | 🟢 Deployed |
| 2026-09-06 | 14:00 | Device-lock via Postgres advisory lock | `backend/src/services/deviceOperations.ts` | 🟢 Deployed |
| 2026-09-06 | 02:50 | W1.5 shipped + rollback test + cron backup | deploy scripts | 🟢 Deployed |
| 2026-09-05 | 22:30 | Week 1 audit items: 4 of 5 shipped + CI bug fix | various | 🟢 Deployed |
| 2026-09-05 | 13:30 | Worker performance: REST pool + retry backoff | worker REST client | 🟢 Deployed |
| 2026-09-05 | 11:30 | Logs: SSH pool + cross-job dedup | worker logs | 🟢 Deployed |
| 2026-09-05 | 10:42 | Logs polling: tame 10s spam + 92% compression | frontend polling | 🟢 Deployed |
| 2026-09-05 | 09:47 | Logs page: 3 bugs fixed, data flowing now | frontend Logs | 🟢 Deployed |
| 2026-09-04 | 22:33 | VPS: delete SSH whitelist + lock port 22 public | VPS firewall | 🟢 Live |
| 2026-09-03 | 01:36 | FabricDiagram: vertical-stack 2 siblings + L-path bypass | frontend Fabric | 🟢 Deployed |
| 2026-09-03 | 01:30 | User dismissed this agent | -- | -- |
| 2026-09-03 | 01:25 | Fabric session summary + verified correct layout | frontend Fabric | 🟢 Deployed |
| 2026-09-03 | 01:10 | FabricDiagram: CI build failure silently broke deploy (gotcha #13) | CI workflow | 🟢 Deployed |
| 2026-09-03 | 00:43 | Lesson: NEVER claim visual work done without opening browser | (process rule) | -- |
| 2026-09-03 | 00:32 | AGENTS.md update request from user | AGENTS.md | 🟢 Live |
| 2026-09-03 | 00:18 | FabricDiagram: 2-sibling side-by-side + whole-graph centering | frontend Fabric | 🟢 Deployed |
| 2026-09-02 | 23:55 | FabricDiagram: parent-anchored rank-3 + dynamic rank-2 | frontend Fabric | 🟢 Deployed |
| 2026-09-02 | 23:21 | FabricDiagram: peer-edge bug + silent tier-band loss | frontend Fabric | 🟢 Deployed |
| 2026-09-02 | 22:06 | FabricDiagram: dagre + BFS rank-inference (scales to 18 floors) | frontend Fabric | 🟢 Deployed |
| 2026-09-02 | 20:45 | FabricDiagram: gravitational alignment + per-source busY | frontend Fabric | 🟢 Deployed |
| 2026-09-02 | 19:34 | FabricDiagram: 3-tier pyramid layout (Core/Dist/Access) | frontend Fabric | 🟢 Deployed |
| 2026-09-02 | 18:43 | Created AGENTS.md project notebook | AGENTS.md | 🟢 Live |
| 2026-08-30 | 17:39 | Initial GitHub push + GitHub Actions setup | repo + CI | 🟢 Live |
| 2026-08-30 | 16:40 | Login flow + force change-password (partial) | auth flow | 🟡 Partial |
| 2026-08-30 | 15:43 | SSH to VPS + first deploy | deploy scripts | 🟢 Live |

## How this file works

- **New agent** → reads top of file (Active Work + Open TODOs), then jumps to relevant session file for full detail.
- **New session** → add a row to bottom of chronological table, link to new file in `docs/sessions/YYYY-MM-DD-HH-MM-Topic.md`.
- **Status codes**: 🔴 = broken, 🟡 = in-progress, 🟢 = deployed/live, ❌ = superseded, -- = not applicable.

**Rule:** never edit old session log entries. Append-only.