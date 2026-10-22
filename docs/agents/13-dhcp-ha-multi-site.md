# Kea DHCP HA Multi-Site Design (DC + DR)

> **Status:** Planning only — not yet implemented.
> **Date:** 2026-09-17
> **Author:** Agent review

---

## Current State

DC site, VPS 42.119.165.109, Docker bridge `172.31.0.0/24`:

| Server | Role | IP | Ports |
|--------|------|-----|-------|
| `kea-dc1` | primary | 172.31.0.10 | `:67/UDP` (DHCP), `:8000` (API) |
| `kea-dc2` | standby | 172.31.0.11 | `:8000` (API only) |

HA mode: **hot-standby**, heartbeat 10s, lease sync via `libdhcp_ha.so`.
Backend reads `KEA_API_URL` + `KEA_STANDBY_API_URL`.

---

## Goal

- 2 sites: **DC** and **DR**, each running 2 Kea servers (HA pair).
- All relay traffic points to DC under normal operation.
- DR is passive — no DHCP relay, no `:67` binding — but has a complete
  copy of DC's subnets and leases.
- When DC fails completely, ops re-point relay to DR. DR serves with zero
  config change needed.

```
Normal:
  Routers ──relay──► kea-dc1 (primary) ──HA──► kea-dc2 (standby)
                                │
                                └──► kea-dr1 (receives sync, no relay)

Failover:
  Routers ──relay──► kea-dr1 (now active) ──HA──► kea-dr2 (standby)
```

---

## Data Sync Options

### Option A — Kea HA native sync (RECOMMENDED)

DC primary syncs leases to DR-1 via the same `libdhcp_ha.so` mechanism.

**Mechanism:** Add DR-1 as a third peer in the DC primary's HA config:

```json
"peers": [
  { "name": "kea-dc1", "url": "http://<DC1_WAN>:8000/", "role": "primary" },
  { "name": "kea-dc2", "url": "http://<DC2_WAN>:8000/", "role": "standby" },
  { "name": "kea-dr1", "url": "http://<DR_WAN>:8000/",  "role": "standby" }
]
```

DR-1 is a **standby** peer — receives lease updates, has full subnet config,
but does **not** bind port 67 (no DHCP reply). DR-2 is DR-1's local standby.

**Requirements:**
- Port 8000 (Kea Control Agent HTTP) open from DC → DR via WAN.
- DR servers must have the same `subnet4` config as DC servers.
- RPO ≈ 10s (tunable via `heartbeat-delay`).

**Pros:** Simple, no PostgreSQL, no extra tooling.
**Cons:** ~10s RPO (acceptable for 8h lease lifetime).

### Option B — Shared PostgreSQL (RPO ≈ 0)

DC and DR Kea pairs both use PostgreSQL as the lease backend.
DR PostgreSQL is a streaming replication standby of DC PostgreSQL.

```
kea-dc1/dhcp2 ←→ PostgreSQL DC ←──streaming repl──► PostgreSQL DR
                                                        │
                                                        kea-dr1/dr2
```

**Pros:** Zero data loss.
**Cons:** PostgreSQL replication setup is significantly more complex.

### Option C — rsync lease files

```
kea-dc1 (memfile CSV)
     │
     └── cron rsync every 30-60s ──► kea-dr1
```

**Pros:** Dead simple.
**Cons:** RPO 30-60s, brief restart to reload lease file.

---

## Decision: Option A

RPO ≈ 10s is acceptable. Simplicity wins. Proceed with Kea HA native sync.

---

## Server Roles (Option A)

### DC site

| Server | HA role | `:67/UDP` | `:8000` | Synces to |
|--------|---------|-----------|---------|-----------|
| `kea-dc1` | primary | Yes | Yes | DC-2, DR-1 |
| `kea-dc2` | standby | No | Yes | — |
| `kea-dr1` | standby | **No** | Yes | — |
| `kea-dr2` | standby | No | Yes | — |

**DR servers do not bind port 67.** They are reachable via HTTP (port 8000)
for HA sync, but never reply to DHCP DISCOVER/REQUEST.

### DR site (VPS new)

| Server | Role | Notes |
|--------|------|-------|
| `kea-dr1` | DR primary | Receives HA sync from DC-1; passive DHCP |
| `kea-dr2` | DR standby | Standby of DR-1 for DR local failover |

---

## Subnet Design

Subnets must be identical on DC and DR servers.

### Option: Different IP ranges per site (RECOMMENDED for banking)

```
DC subnets:  10.10.x.0/24
DR subnets:  192.168.x.0/24   (or 10.y.y.0/24)
```

**Advantage:** No IP conflict when DR activates. Clients get new IPs, which is
correct behavior for a disaster recovery scenario.

**Note:** If the bank requires exact same IPs on DR, stretched L2 (VPLS/
MetroEthernet) is needed. This is a separate network design concern outside
the scope of Kea config.

### Example: VLAN 10

| Site | Subnet | Pool | Gateway |
|------|--------|------|---------|
| DC | `10.10.10.0/24` | `10.10.10.50 – 10.10.10.200` | `10.10.10.254` |
| DR | `192.168.10.0/24` | `192.168.10.50 – 192.168.10.200` | `192.168.10.254` |

---

## Failover Sequence

```
Normal state:
  Client → Switch → Router (giaddr=10.10.10.254)
                    → kea-dc1 (reply)
                    → kea-dc2 (standby)

DC site down:
  1. DC-1 + DC-2 both unreachable
  2. Ops SSH to router, change relay giaddr → DR-1 IP
     (or: routing auto-fails via BFD/HSRP — future phase)
  3. kea-dr1 has same subnet config + leases synced every 10s
  4. Client renews → kea-dr1 replies with existing lease
  5. Clients that can't renew get DISCOVER → kea-dr1 assigns new IP
```

**Manual relay switch** is the baseline. BFD/routing-based auto-switch is a
future improvement.

---

## Backend API Changes

### Current (single DC)

```typescript
KEA_API_URL:         http://172.31.0.10:8000/
KEA_STANDBY_API_URL: http://172.31.0.11:8000/
```

### Target (DC + DR)

```typescript
KEA_DC_API_URL:          http://<DC1_WAN>:8000/
KEA_DC_STANDBY_API_URL:  http://<DC2_WAN>:8000/
KEA_DR_API_URL:          http://<DR1_WAN>:8000/
KEA_DR_STANDBY_API_URL:  http://<DR2_WAN>:8000/
```

`getDhcpDashboard()` must group 4 peers by site (DC / DR) and report
reachability for all.

### keaDhcp.ts changes needed

1. Accept 4 env vars instead of 2.
2. `ha-heartbeat` call to all 4 peers in parallel.
3. Dashboard groups peers by site.
4. `keaCommand()` — target `'dc-primary' | 'dc-standby' | 'dr-primary' | 'dr-standby' | 'auto'`.

---

## Docker Compose Changes

### DC compose (add DR peer URL)

```yaml
kea-dc1:
  environment:
    KEA_SERVER_NAME: kea-dc1
    KEA_PRIMARY_URL:   http://<DC1_WAN>:8000/
    KEA_STANDBY_URL:   http://<DC2_WAN>:8000/
    KEA_DR_PRIMARY_URL: http://<DR1_WAN>:8000/   # NEW
    KEA_DR_STANDBY_URL: http://<DR2_WAN>:8000/   # NEW
  ports:
    - "<DC_PUBLIC>:67:67/udp"
    - "8001:8000"
```

### DR compose (new VPS)

```yaml
kea-dr1:
  environment:
    KEA_SERVER_NAME: kea-dr1
    KEA_PRIMARY_URL:   http://<DC1_WAN>:8000/   # WAN to DC-1
    KEA_STANDBY_URL:   http://<DC2_WAN>:8000/   # WAN to DC-2
    KEA_DR_PRIMARY_URL: http://<DR1_WAN>:8000/   # local self
    KEA_DR_STANDBY_URL: http://<DR2_WAN>:8000/   # local standby
  # NO port 67 — passive, no DHCP reply
  ports:
    - "8001:8000"

kea-dr2:
  # same as DR-1, no port 67, HA standby of DR-1
```

### HA config template changes

The `kea-dhcp4.conf.template` needs to support 4 peers. Placeholders:

```
__KEA_PEERS_JSON__
```

This is substituted at container startup to generate the correct peer list
for each server's role.

---

## RPO / RTO Summary

| Metric | Value | Notes |
|--------|-------|-------|
| RPO | ~10s | Tunable via `heartbeat-delay` in Kea HA config |
| RTO (relay switch) | ~5 min | Manual ops; auto-switch is future phase |
| Data loss window | Last ~10s of new leases | 10s out of 8h lease = negligible |
| DR-1 takes over | Immediate on relay switch | Same subnet config, synced leases |

---

## Open Questions

1. **WAN IP of DR VPS?** Not yet provisioned.
2. **Stretched L2 or separate IP ranges?** Bank needs to decide.
3. **DR PostgreSQL?** Not needed for Option A. Revisit if Option B required.
4. **Auto relay switch (BFD/HSRP)?** Future phase after initial deployment.
5. **Backend deploy on DR?** Not required. DHCP failover is independent of
   the app stack. Dashboard can run on DC only.

---

## Implementation Phases

### Phase 1 — DC stays as-is
No changes. Current setup is the foundation.

### Phase 2 — Provision DR VPS + deploy Kea pair
- New VPS with Tailscale.
- Deploy `kea-dr1` + `kea-dr2` with same subnet config as DC.
- Open port 8000 from DC WAN to DR.
- DC-1 HA config adds DR-1 as peer.
- Verify lease sync works across WAN.

### Phase 3 — Backend updates
- Add 2 new env vars for DR API URLs.
- Update `keaDhcp.ts` to query 4 peers.
- Dashboard groups by site.

### Phase 4 — DR runs in production standby
- Relay points to DC only.
- DR receives HA sync passively.
- Document relay switch procedure.

### Phase 5 — (Future) Auto relay switch
- BFD/routing-based automatic failover.
- Not in scope for initial deployment.
