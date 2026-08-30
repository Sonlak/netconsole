# NetConsole Lab — blank managed topology

Devices boot **mgmt-only** (SSH + REST). No OSPF / VRRP / VLAN / DHCP-relay pre-config — push those from NetConsole after Managed.

```
SW-CORE-01/02  SW-DS-01/02  SW-AS-01/02   ← wired L2 links, empty config
       │              │
   lab-net mgmt   Kea HA (.21/.22) + app
```

## What is pre-built

| Item | Value |
|------|--------|
| Mgmt | `172.30.0.11`…`.16` |
| SSH / REST | `admin` / `Admin@123` (`root` / `Juniper`) |
| Host ports | SSH `2221–2226`, REST `8441–8446` |
| Kea | pools VLAN 201/202/203, router `.254` (unused until you push relay) |
| App | postgres / backend / worker / frontend |

## Start

```powershell
cd d:\NetConsole
docker compose -f docker-compose.lab.yml down --remove-orphans
docker compose -f docker-compose.lab.yml up -d --build
```

Then in UI: add/check-managed each device → push config when ready.
