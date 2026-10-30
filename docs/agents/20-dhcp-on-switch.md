# DHCP on the Distribution Switch (Junos extended DHCP local server)

> **Status:** ACTIVE — replaced Kea on 2026-10-30.
> **Scope:** dev first; prod follow-up tracked in Active TODOs.

---

## 1. Why Kea was removed

Kea 3.x ran as a container with a hot-standby HA pair (DC + DR). It was
replaced because:

- The HA pair was never actually deployed (no DR host exists).
- The Kea image baked the lab subnet list into itself, so prod served
  `10.1.201.0/24 … 10.1.204.0/24` (see gotcha #18 of `AGENTS.md`).
- The bank network already has the distribution switch in the datapath.
  Junos Evo QFX can serve DHCP natively, so the extra container + control
  agent + failover machinery was pure operational surface.

**There is no HA any more.** One switch, one DHCP server.

---

## 2. Device-side configuration

The DHCP server is the **distribution switch** (DS1 — `LAB-F6-DS-01`,
vqfx-10000 / Junos Evo 20.3R1.8). Pushed by the app via
`backend/src/services/labConfigTemplates.ts`:

```
set system services dhcp-local-server group NETCONSOLE-DHCP interface irb.201
set system services dhcp-local-server group NETCONSOLE-DHCP interface irb.202
set system services dhcp-local-server group NETCONSOLE-DHCP interface irb.203
set system services dhcp-local-server group NETCONSOLE-DHCP interface irb.204

set access address-assignment pool V201 family inet network 10.1.201.0/24
set access address-assignment pool V201 family inet range V201R low 10.1.201.10 high 10.1.201.254
set access address-assignment pool V201 family inet dhcp-attributes router 10.1.201.254
set access address-assignment pool V201 family inet dhcp-attributes name-server 10.10.20.20
set access address-assignment pool V201 family inet dhcp-attributes maximum-lease-time 28800

set access address-assignment pool V201 family inet host vpc5 \
    hardware-address aa:bb:cc:dd:ee:ff ip-address 10.1.201.50
```

### Platform quirks (verified on LAB-F6-DS-01, 2026-10-30)

| Quirk | Detail |
| --- | --- |
| Pool hierarchy | Junos Evo QFX **rejects** `system services dhcp-local-server pool …` (syntax error). Pools live under `access address-assignment pool`. |
| Lease time | There is **no** `dhcp-attributes lease-time`. Only `maximum-lease-time` (plus `t1-renewal-time` / `t2-rebinding-time`). |
| Pool description | The pool hierarchy has **no** `description` statement, so a human-friendly pool name cannot be stored. The display name is derived from the VLAN id. |
| `cli-information` RPC | **Not supported** on this platform (syntax error). Operational commands must go over SSH. |
| Binding RPC shape | The RPC must be sent **without** a `<level>` child: `<get-dhcp-server-binding-information><detail/></...>` returns the bindings, but `<get-dhcp-server-binding-information><level>detail</level></...>` silently returns an **empty** list. |
| Operational commands | `show dhcp server binding` and `show dhcp server statistics` work. The classic `show system services dhcp statistics` does **not** exist here. |

---

## 3. Backend integration

`backend/src/services/junosDhcp.ts` is the whole DHCP backend.

| Concern | Transport |
| --- | --- |
| Read pools | RESTCONF `<get-configuration>` → `<access><address-assignment/></access>` |
| Read leases | RESTCONF `<get-dhcp-server-binding-information><detail/></...>`, SSH fallback `show dhcp server binding detail` |
| Delete a lease | SSH `clear dhcp server binding <ip>` |
| Wipe a pool | SSH `clear dhcp server binding interface irb.<vlan>` |
| Static reservation | config push: `… family inet host <name> hardware-address <mac> ip-address <ip>` |

Host selection: `DHCP_SERVER_HOST` env var, default `LAB-F6-DS-01`.
Toggle: `DHCP_SERVER_ENABLED` (default on).

RESTCONF needs `JUNOS_REST_ENABLED=true`; SSH needs `LAB_SSH_USER` /
`LAB_SSH_PASSWORD`.

### Id rename

The old Kea model keyed everything by a numeric `subnetId`. Junos pools
have **names** (`V201`), so the whole stack now keys by `pool_name`:

- Backend API: `GET /api/dhcp/pools/:poolName/leases`, `POST /api/dhcp/pools/:poolName/wipe`.
- Assistant tools: `list_dhcp_leases`, `get_dhcp_pool_status`,
  `list_dhcp_subnets`, `get_dhcp_subnet`, `add_dhcp_reservation`,
  `delete_dhcp_lease`, `fix_static_reservation`, `wipe_dhcp_subnet`,
  `add_dhcp_subnet` — all take `pool_name` instead of `subnet_id`.
- Frontend types: `DhcpPool.poolName`, `DhcpServer` (replaces `DhcpHa`),
  `DhcpDashboard` (replaces `DhcpHa` + `DhcpSiteSummary`).

---

## 4. Lab simulator

`lab/juniper-sim/dhcp_server.py` emulates the Junos extended DHCP local
server inside the containerised distribution switch (`sw-ds-01`):

- Parses `access address-assignment pool` blocks out of the committed
  running config (`/var/lib/netconsole/running.set`).
- Generates a `dnsmasq` config from those pools and runs dnsmasq as the
  actual DHCP server.
- Exposes the Junos-shaped surfaces the backend expects:
  - RESTCONF `/rpc/get-dhcp-server-binding-information` → binding XML
  - RESTCONF `/rpc/get-configuration` → pool XML
  - CLI `show dhcp server binding detail`
  - CLI `clear dhcp server binding <ip>` / `… interface irb.<vlan>`
- Reloads dnsmasq on every commit (`junos_cli.py::replace_running_config`).

Offline test: `python lab/scripts/test-dhcp-sim.py` (no containers needed).

---

## 5. What was deleted

| Path | Replacement |
| --- | --- |
| `backend/src/services/keaDhcp.ts` | `backend/src/services/junosDhcp.ts` |
| `backend/src/services/keaFailback.ts` | (gone — no HA) |
| `lab/kea/*` (Dockerfile, entrypoint, templates, subnets) | `lab/juniper-sim/dhcp_server.py` |
| `docker-compose.kea-dr.yml` | (gone — no DR site) |
| `frontend/src/components/dashboard/KeaHaCard.tsx` | `DhcpServerCard.tsx` |
| `frontend/src/components/dashboard/KeaSummary.tsx` | `DhcpSummary.tsx` |

Compose changes: the `kea-dc1` service, the `kea_dc_leases` /
`kea_dr_leases` volumes, the `KEA_*` env vars and the backend's
`depends_on: kea-dc1` are all gone. `KEA_HOST_IP` was renamed
`LAB_HOST_IP` (it now only controls the syslog :1514 publish).
