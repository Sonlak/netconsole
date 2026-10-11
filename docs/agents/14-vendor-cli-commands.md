# Vendor CLI Commands & Config Syntax — AI Assistant Reference

> **Audience**: this file is loaded by the AI assistant's tool
> description (`backend/src/services/assistant/prompts.ts`) and the
> NetConsole agent notebook. It is the single source of truth for
> which `show` / `clear` / `request` commands are valid for each
> vendor, plus the right config syntax for common changes (OSPF,
> VLAN, interface IP, static route, BGP).
>
> Added 2026-10-11 alongside the `run_cli_command` tool — the LLM
> picks the right syntax from this file when generating CLI strings
> or full config snippets.

## 0. TL;DR — pick the right tool

| User intent | Tool | Notes |
|---|---|---|
| "show X" trên 1 thiết bị | `run_cli_command` (read) | Cú pháp theo vendor |
| "clear X" trên 1 thiết bị | `run_cli_command` (write=true) | Cú pháp theo vendor |
| "request system reboot" | **KHÔNG dùng tool** — bảo user SSH vào console | Tool chặn lệnh nguy hiểm |
| Thay đổi CONFIG (OSPF / VLAN / IP / route) | `apply_config_dry_run` → `queue_apply_config` | Generate full config theo vendor, dùng `content` |
| Thay đổi 1 port (shut / no-shut / set-access-vlan) | `queue_interface_action` | Atomic per-interface, multi-action supported |
| Restart service (safe, non-config) | `run_cli_command` (write=true) | VD: `request system reboot` ở mức software-image upgrade |

---

## 1. Cú pháp CLI theo vendor

### 1.1 Juniper Junos (vendor = "juniper" hoặc "junos")

**Read — `show` family:**

```bash
show version
show interfaces terse                       # brief interface + state
show interfaces ge-0/0/0                    # chi tiết 1 cổng
show interfaces descriptions                # + description
show ospf neighbor
show ospf neighbor extensive
show ospf interface
show ospf database
show bgp summary
show route                                  # toàn bộ RIB
show route 10.0.0.0/8                       # filter prefix
show route summary
show arp no-resolve
show ethernet-switching table               # MAC table
show lldp neighbors
show configuration                          # FULL running-config (set-style)
show configuration interfaces ge-0/0/0      # section
show system processes summary
show chassis hardware
show log messages                           # last 1000 lines syslog (chỉ trên real Junos; cRPD cần SSH `show log`)
show snmp mib walk system                    # SNMP walk
```

**Operational — `clear` / `request`:**

```bash
clear interfaces statistics all             # reset tất cả counter
clear arp                                   # clear ARP cache
clear bgp neighbor 10.0.0.1                  # reset 1 BGP session
request system reboot                       # ⚠️ DANGEROUS — tool CHẶN
request system reboot at "2026-10-15 03:00" # scheduled reboot
request chassis fpc restart slot 0           # ⚠️ DANGEROUS
request system software add /var/tmp/junos.tgz  # ⚠️ DANGEROUS
```

**Config syntax (set-style, hierarchy):**

```bash
# Interface
set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members 100
set interfaces ge-0/0/0 description "uplink to core"
set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/24

# OSPF
set protocols ospf area 0 interface ge-0/0/0
set protocols ospf area 0 interface lo0.0 passive
set routing-options router-id 10.255.0.1

# BGP
set protocols bgp group EBGP neighbor 10.0.0.2 peer-as 65001
set protocols bgp group EBGP neighbor 10.0.0.2 description "uplink to peer"
set protocols bgp group IBGP type internal
set protocols bgp group IBGP neighbor 10.10.0.1

# Static route
set routing-options static route 0.0.0.0/0 next-hop 10.0.0.254

# VLAN (cRPD/EVO style with ethernet-switching)
set vlans VLAN100 vlan-id 100
set vlans VLAN100 description "office lan"
set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members 100

# System / NTP / DNS
set system host-name LAB-F6-AS-01
set system domain-name tailocbank.vn
set system name-server 8.8.8.8
set system ntp server 10.10.0.1 prefer
set system login user admin class super-user

# Commit
set (no commit yet — queue_apply_config sẽ commit sau khi user confirm)
```

### 1.2 Arista EOS (vendor = "arista" hoặc "eos")

**Read:**

```bash
show version
show interfaces status
show interfaces description
show ip interface brief
show ip ospf neighbor
show ip ospf database
show ip bgp summary
show ip route
show ip arp
show mac address-table
show lldp neighbors
show running-config
show running-config section interface Ethernet1
show environment
show inventory
show logging
```

**Operational — `clear` / `reload`:**

```bash
clear counters                              # reset tất cả interface counters
clear arp                                   # clear ARP cache
clear mac address-table dynamic             # clear dynamic MACs
clear bgp 10.0.0.1 soft                     # soft reset BGP session
clear ospf process                          # ⚠️ restarts OSPF on box
clear ip route *                            # ⚠️ nukes routing table
reload                                      # ⚠️ DANGEROUS — tool CHẶN
reload at now + 5                           # scheduled reload in 5 min
```

**Config syntax (configure-style, hierarchical):**

```bash
# Gõ `configure terminal` (hoặc `conf t`) trước khi nhập, nhưng tool chỉ nhận body — không cần prefix
! comment bắt đầu bằng !
interface Ethernet1
   description uplink to core
   ip address 10.0.0.1/24
   no switchport
   ip ospf network point-to-point
!
interface Ethernet2
   switchport access vlan 100
   switchport mode access
!
router ospf 1
   network 10.0.0.0/24 area 0
   passive-interface default
   no passive-interface Ethernet1
!
router bgp 65000
   neighbor 10.0.0.2 remote-as 65001
   neighbor 10.0.0.2 description uplink to peer
   network 10.0.0.0/24
!
ip route 0.0.0.0/0 10.0.0.254
!
vlan 100
   name office-lan
!
ntp server 10.10.0.1
ip name-server 8.8.8.8
hostname LAB-F6-AS-01
!
end
```

### 1.3 Cisco IOS-XE (vendor = "cisco" hoặc "iosxe" hoặc "catalyst")

**Read:**

```bash
show version
show ip interface brief
show ip interface
show ip ospf neighbor
show ip ospf database
show ip ospf interface
show ip bgp summary
show ip route
show ip arp
show mac address-table
show cdp neighbors                          # CDP
show cdp neighbors detail
show lldp neighbors
show running-config
show running-config section interface GigabitEthernet0/0/5
show inventory
show environment
show logging
```

**Operational — `clear` / `reload`:**

```bash
clear counters                              # reset interface counters (CHỈ IOS 15.x; IOS-XE dùng clear counters trên từng cổng)
clear counters GigabitEthernet0/0/5         # 1 port
clear arp                                   # clear ARP cache
clear arp-cache                             # alias
clear ip route *                            # ⚠️
clear ip bgp 10.0.0.1 soft                  # soft reset
clear ip ospf process                       # ⚠️ restarts OSPF
reload                                      # ⚠️ DANGEROUS — tool CHẶN
reload at 03:00 15-oct-2026                 # scheduled reload
```

**Config syntax (configure-style, hierarchical):**

```bash
! comment bắt đầu bằng !
interface GigabitEthernet0/0/5
 description uplink to core
 ip address 10.0.0.1 255.255.255.0
 ip ospf network point-to-point
 no shutdown
!
interface GigabitEthernet0/0/6
 switchport mode access
 switchport access vlan 100
!
router ospf 1
 network 10.0.0.0 0.0.0.255 area 0
 passive-interface default
 no passive-interface GigabitEthernet0/0/5
!
router bgp 65000
 neighbor 10.0.0.2 remote-as 65001
 neighbor 10.0.0.2 description uplink to peer
 network 10.0.0.0 mask 255.255.255.0
!
ip route 0.0.0.0 0.0.0.0 10.0.0.254
!
vlan 100
 name office-lan
!
ntp server 10.10.0.1
ip name-server 8.8.8.8
hostname LAB-F6-AS-01
!
end
```

### 1.4 Cisco NX-OS (vendor = "nxos" hoặc "nexus")

**Read:**

```bash
show version
show interface status
show ip ospf neighbor
show ip bgp summary
show ip route
show vpc
show running-config
show environment
```

**Config syntax:**

```bash
! NX-OS dùng Cisco-style configure
interface Ethernet1/1
  no switchport
  ip address 10.0.0.1/24
!
router ospf 1
  network 10.0.0.0/24 area 0
!
```

### 1.5 Cisco IOS (plain, IOSv / vios_l2 / ISR 800/880)

Cùng cú pháp như IOS-XE nhưng KHÔNG có RESTCONF/NETCONF. Tất cả thao tác qua SSH CLI. Vendor code path riêng (`worker/netconsole_worker/backends/ios.py`).

---

## 2. Mapping config feature ↔ cú pháp 3 vendor

Đây là bảng tra cứu nhanh cho LLM khi user yêu cầu "cấu hình OSPF cho cổng mới" hoặc tương tự.

### 2.1 Thêm OSPF cho cổng

**Juniper:**

```bash
set protocols ospf area 0 interface ge-0/0/5
set interfaces ge-0/0/5 unit 0 family inet address 10.10.20.1/24
```

**Arista EOS:**

```bash
interface Ethernet5
   ip address 10.10.20.1/24
   ip ospf network point-to-point
!
router ospf 1
   network 10.10.20.0/24 area 0
```

**Cisco IOS-XE:**

```bash
interface GigabitEthernet0/0/5
 ip address 10.10.20.1 255.255.255.0
 ip ospf network point-to-point
!
router ospf 1
 network 10.10.20.0 0.0.0.255 area 0
```

### 2.2 Set access VLAN trên access port

**Juniper (cRPD ethernet-switching):**

```bash
set interfaces ge-0/0/5 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members 201
set vlans VLAN201 vlan-id 201
```

**Arista EOS:**

```bash
interface Ethernet5
   switchport mode access
   switchport access vlan 201
!
vlan 201
   name office-floor-2
```

**Cisco IOS-XE:**

```bash
interface GigabitEthernet0/0/5
 switchport mode access
 switchport access vlan 201
!
vlan 201
 name office-floor-2
```

### 2.3 Trunk port với allowed VLAN list

**Juniper:**

```bash
set interfaces ge-0/0/5 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members 100,200,201
```

**Arista:**

```bash
interface Ethernet5
   switchport mode trunk
   switchport trunk allowed vlan 100,200,201
   switchport trunk native vlan 1
```

**Cisco:**

```bash
interface GigabitEthernet0/0/5
 switchport mode trunk
 switchport trunk allowed vlan 100,200,201
 switchport trunk native vlan 1
```

### 2.4 Static default route

**Juniper:**

```bash
set routing-options static route 0.0.0.0/0 next-hop 10.0.0.254
```

**Arista:**

```bash
ip route 0.0.0.0/0 10.0.0.254
```

**Cisco:**

```bash
ip route 0.0.0.0 0.0.0.0 10.0.0.254
```

### 2.5 BGP eBGP peering

**Juniper:**

```bash
set routing-options autonomous-system 65000
set protocols bgp group EBGP-PEER type external
set protocols bgp group EBGP-PEER peer-as 65001
set protocols bgp group EBGP-PEER neighbor 10.0.0.2
```

**Arista:**

```bash
router bgp 65000
   neighbor 10.0.0.2 remote-as 65001
   network 10.0.0.0/24
```

**Cisco:**

```bash
router bgp 65000
 neighbor 10.0.0.2 remote-as 65001
 network 10.0.0.0 mask 255.255.255.0
```

### 2.6 Description trên interface

**Juniper:**

```bash
set interfaces ge-0/0/5 description "uplink to core-LAB"
```

**Arista:**

```bash
interface Ethernet5
   description uplink to core-LAB
```

**Cisco:**

```bash
interface GigabitEthernet0/0/5
 description uplink to core-LAB
```

### 2.7 NTP server

**Juniper:**

```bash
set system ntp server 10.10.0.1 prefer
set system ntp server 10.10.0.2
```

**Arista:**

```bash
ntp server 10.10.0.1 prefer
```

**Cisco:**

```bash
ntp server 10.10.0.1 prefer
```

---

## 3. Lệnh bị tool CHẶN (an toàn)

`run_cli_command` rejects these patterns outright in the backend
handler (see `handlers.ts::runCliCommandHandler`):

- `request system zeroize` (Junos — wipe config + log + keys)
- `test software reboot` (Junos — same as zeroize)
- `request chassis cluster failover` (Junos SRX HA failover)
- `write erase` (Cisco IOS — wipe startup-config)
- `delete startup-config` (NX-OS — wipe startup-config)
- `erase startup-config` (IOS — alias)

For these operations, the user should SSH into the console directly
or use `queue_apply_config` with the right config replacement
(though for `write erase` the right answer is "use the console").

## 4. Lệnh KHÔNG gate qua confirmation (operational write)

The following are allowed with `write: true` and no confirmation card
because they're reversible / non-destructive:

- `clear counters` — reset interface counters (just stats)
- `clear arp` / `clear arp-cache` — clear ARP table (devices re-ARP)
- `clear mac address-table dynamic` (EOS) — clear dynamic MACs
- `clear ip route *` — clear route cache (not routing table on IOS)
- `clear interfaces statistics all` (Junos) — same as `clear counters`

The following are DANGEROUS but allowed (LLM has the power to shoot
its own foot; we surface `request system reboot` etc. in the
confirmation card if the operator enables per-command gating later):

- `request system reboot` (Junos)
- `reload` / `reload at ...` (EOS / IOS)
- `clear ip bgp 10.0.0.1` (BGP session reset)
- `clear ip ospf process` (OSPF restart on the box)
- `request chassis fpc restart` (Junos — restarts line card)

If the LLM picks one of these, the **handler does NOT block** but
the **system prompt explicitly tells the LLM to refuse** and to
suggest the user run the command via SSH to the device console.

## 5. Anti-hallucination rules for the LLM

1. **Always `get_device(device_name)` first** when the user names a
   device by hostname — you need the `vendor` field to pick the
   right syntax. If the device isn't found, stop and say so.

2. **Read the JSON response** of `run_cli_command` carefully. If
   `exitCode != 0` or `error` is non-null, surface the error to
   the user verbatim — DO NOT guess what went wrong.

3. **Output cap at 8 KB.** For commands with long output
   (`show ip route` on a BGP-rich device, `show log messages`),
   the worker truncates. Tell the user the output was truncated
   and point them at `get_job_detail` for the full text.

4. **Vendor detection matters.** If `get_device` returns
   `vendor: "juniper"`, NEVER use `interface Ethernet1` — use
   `ge-0/0/0` (or whatever the model actually has). If unsure,
   say so rather than hallucinate an interface name.

5. **For CONFIG changes, use `queue_apply_config` with the FULL
   config, not a `set` line at a time.** Config Studio / the
   `queue_apply_config` worker replaces the entire running-config
   with the content you provide. Do NOT send a single `set`
   line — the worker would treat that as a config replace with
   just one line, which would wipe everything else.

6. **Juniper uses set-style only** (not configure-style). If you
   mix `set` lines with `configure` lines in the same `content`,
   the worker will choke on the `configure` line. Stay pure
   set-style for Junos.

7. **Cisco / EOS use configure-style with hierarchy.** The
   `content` for `queue_apply_config` should be the body of
   `configure terminal` — NO leading `conf t` or `configure`
   line, and NO `end` (worker adds that on commit).

8. **Comment syntax differs**: Juniper uses `#`, IOS/EOS use `!`.
   Wrong comment marker will fail the commit.

## 6. Reference tables for ntc-templates (textfsm parsing)

The worker has a small allowlist of commands that get auto-parsed
to structured rows (see
`worker/netconsole_worker/parsers/textfsm_parse.py`). These are
the only ones where the assistant preview will include
`parsed.rows[]`:

| Vendor | Command | Fields |
|---|---|---|
| cisco_ios | show ip ospf neighbor | neighborId, priority, state, deadTime, address, interface |
| cisco_ios | show ip route | protocol, network, mask, distance, metric, nexthop, interface |
| cisco_ios | show cdp neighbors | neighbor, localPort, mgmtIp, platform, remotePort |
| cisco_ios | show ip bgp summary | routerId, localAs, neighbor, neighborAs, state |
| arista_eos | show ip ospf neighbor | same as cisco_ios |
| arista_eos | show ip route | same as cisco_ios |
| arista_eos | show ip bgp summary | same as cisco_ios |
| juniper_junos | show ospf neighbor | same as cisco_ios |
| juniper_junos | show route summary | table, destinations, active, holddown |

Any other command returns raw text only — the LLM parses the
text itself. That's fine for one-off commands but for a chart
or repeated queries, consider adding the template to the
allowlist (one new line in `textfsm_parse.py::ALLOWLIST`).
