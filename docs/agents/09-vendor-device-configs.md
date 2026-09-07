# 9. Vendor Device Configurations -- copy/paste blocks

> Operator-side setup for Arista EOS, Cisco IOS-XE, Cisco NX-OS.
> All blocks assume:
> - NetConsole worker host IP: **10.10.20.20** (syslog UDP target)
> - NetConsole worker API probe origin: **10.10.20.0/24**
> - Local read-only username: **netconsole**, privilege 15 (or `network-admin` on NX-OS)
> - Password used everywhere: **Admin@123** (rotate via `scripts/rotate_secrets.sh`)

> Apply the `LOCAL_USER_PASSWORD_HASH` and `ENABLE_SECRET_HASH` hashes your
> org prefers. Examples below use Type 8 / Type 9 / Type 5 hashes generated
> from `Admin@123` for illustration -- regenerate on the actual device.

---

## A. Arista EOS (any platform)

### A.1 Create the service user (15 privilege)

```eos
! Conf mode
configure terminal

! Local user -- privilege 15 (network-admin role on EOS)
username netconsole privilege 15 role network-admin secret Admin@123

! Stronger secret (preferred): replace with type 9 hash from
!   enable secret 9 <hash>
```

### A.2 Enable eAPI over HTTPS (recommended)

```eos
! Required for NetConsole to talk RESTCONF-style RPCs
management api http-commands
   protocol https
   protocol https port 443
   ! Self-signed cert is auto-generated; replace with org cert if you have one
   no shutdown
   ! Allow eAPI from the NetConsole network only
   ! (optional ACL hardening)
   ! ip access-list standard NETCONSOLE
   !    permit 10.10.20.0/24
   !    deny any
   !    exit
   !    vrf default
   !    ip access-group NETCONSOLE in

! Save config
copy running-config startup-config
```

If you must use HTTP (lab only) instead:

```eos
management api http-commands
   protocol http
   protocol http port 80
   no shutdown
```

### A.3 Syslog push to NetConsole

```eos
! Stream every facility to NetConsole at UDP 1514
logging host 10.10.20.20 1514 protocol udp
! Or restrict to NOTICE+ to match Junos 'any notice'
logging trap notice
logging facility local7
! Persist
copy running-config startup-config
```

### A.4 NTP (recommended -- for log timestamps)

```eos
ntp server 10.10.20.20 prefer
ntp server ntp.ubuntu.com iburst
! Or use the bank NTP source
```

### A.5 SSH hardening (optional, recommended)

```eos
ip ssh version 2
! Disable password-auth SSH; require keys for the operator account
! (NetConsole currently uses password -- keep enabled until we move to keys)
no ip ssh server permit-key ?
! Disable telnet
!
!
```

### A.6 Verify on the device

```eos
show management api http-commands        ! confirm "Enabled" + "https" or "http"
show logging hosts                      ! confirm 10.10.20.20 1514 udp
show users netconsole                   ! confirm privilege 15
show running-config | grep -i 'management api'
```

### A.7 Smoke test from your laptop

```bash
curl -sk -u netconsole:Admin@123 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"runCmds","params":{"version":1,"cmds":[{"cmd":"show version","format":"json"}]}}' \
  https://<device-ip>/command-api
```

Expected: JSON with `version`, `modelName`, `serialNumber`.

---

## B. Cisco IOS-XE (Catalyst 9000 / ASR / ISR / CSR)

### B.1 Enable RESTCONF over HTTPS

```cisco-iosxe
configure terminal

! --- HTTPS server (required for RESTCONF) ---
ip http secure-server
ip http authentication local
ip http secure-active-session-modules none
ip http active-session-modules none

! --- RESTCONF ---
restconf
! Implicit listen on 443 once `ip http secure-server` is on

! --- Local user (privilege 15) ---
username netconsole privilege 15 secret Admin@123
! Or stronger: username netconsole privilege 15 algorithm-type scrypt secret <secret>

! --- VTY / SSH access ---
line vty 0 15
 login local
 transport input ssh
!
ip ssh version 2
!
end

! Persist
write memory
```

### B.2 Enable NETCONF over SSH (for APPLY_CONFIG / rollback)

```cisco-iosxe
configure terminal

! NETCONF runs over SSH port 830; netconf-yang is the sub-system
netconf-yang

! Optional but recommended: only allow NETCONF from NetConsole
! netconf-yang ssh port 830

! If you use aaa new-model, ensure SSH login uses 'local'
! aaa authentication login default local

end
write memory
```

If NETCONF refuses to come up, on older 16.x images:

```cisco-iosxe
configure terminal
netconf-yang cisco-odm actions on
! Some platforms also need:
! device-tracking tracking
end
```

### B.3 Syslog push to NetConsole

```cisco-iosxe
configure terminal

! --- Timestamps with millisecond resolution ---
service timestamps debug datetime msec
service timestamps log datetime msec

! --- Syslog host (UDP 1514) ---
logging host 10.10.20.20 transport udp port 1514
! Match Junos 'any any' -- log everything from severity emergencies down
! (numerical form: 0 = emergencies, 7 = debugging)
logging trap debugging
logging facility local7

! --- Source interface (optional) ---
! logging source-interface Vlan<mgmt-vlan-id>

end
write memory
```

### B.4 (Optional) RESTCONF ACL hardening

```cisco-iosxe
configure terminal
ip access-list extended RESTCONF-IN
 permit tcp 10.10.20.0 0.0.0.255 any eq 443
 deny   tcp any any eq 443 log
!
line vty 0 15
 access-class RESTCONF-IN in vrf-also
!
end
write memory
```

### B.5 (Optional) Disable HTTP-only server (RESTCONF needs HTTPS only)

```cisco-iosxe
configure terminal
no ip http server            ! kill plaintext HTTP; RESTCONF only listens on HTTPS
end
write memory
```

### B.6 Verify on the device

```cisco-iosxe
show ip http server status               ! "HTTP secure server: Enabled"
show restconf                            ! enabled, listen 443
show netconf-yang status                 ! NETCONF OK
show netconf-yang ssh                    ! port 830
show logging                              ! confirm host 10.10.20.20 transport udp port 1514
show running-config | section username
```

### B.7 Smoke test from your laptop

```bash
# RESTCONF get interfaces
curl -sk -u netconsole:Admin@123 \
  -H 'Accept: application/yang-data+json' \
  https://<device-ip>/restconf/data/ietf-interfaces:interfaces

# RESTCONF get running config
curl -sk -u netconsole:Admin@123 \
  -H 'Accept: application/yang-data+json' \
  'https://<device-ip>/restconf/data/Cisco-IOS-XE-native:native?depth=unbounded'

# SSH + CLI fallback
ssh netconsole@<device-ip> 'show ip arp'
```

---

## C. Cisco NX-OS (Nexus 3000 / 9000 / 7000 / 9500)

### C.1 Enable NX-API over HTTP/HTTPS

```cisco-nxos
configure terminal

! --- Local user (network-admin role) ---
username netconsole password Admin@123 role network-admin

! --- Enable feature ---
feature nxapi
feature scp-server     ! optional, only if you SCP files to/from the box

! --- HTTPS (preferred) ---
nxapi https port 443
no nxapi http port 80          ! disable plaintext HTTP

! --- Sandbox + ACL (recommended) ---
! The NX-API sandbox is the /nginx/html/index.html page; leave enabled in lab.
! In prod, disable it:
! no nxapi sandbox

! --- ACL on management VRF ---
! ip access-list NETCONSOLE-NXAPI
!    permit tcp 10.10.20.0/24 any eq 443
!    deny   tcp any any eq 443 log
! line vty
!    access-class NETCONSOLE-NXAPI in

end
copy running-config startup-config
```

### C.2 Syslog push to NetConsole

```cisco-nxos
configure terminal

logging server 10.10.20.20 1514
! Default facility = local7; severity = 0..7 (debugging captures everything)
logging level debugging
logging timestamp milliseconds
logging source-interface mgmt0

end
copy running-config startup-config
```

Verify: `show logging server`.

### C.3 Enable SSH (default on NX-OS but confirm)

```cisco-nxos
configure terminal

feature ssh
ssh keytype rsa 2048   ! longer key if your image supports it

! Confirm the user has ssh access:
username netconsole sshkey ...        ! optional: pin the worker SSH key here

end
copy running-config startup-config
```

### C.4 Enable configuration rollback checkpoints

NX-OS supports `rollback running-config checkpoint` natively. Auto-create a
checkpoint on every APPLY_CONFIG by adding this to NetConsole workflow; or
configure the device to create one on every commit:

```cisco-nxos
configure terminal

! Auto-checkpoint on commit
! NX-OS does NOT have a global "checkpoint on commit" knob -- the worker
! triggers it explicitly. The CLI is:
!   checkpoint running-config file auto-checkpoint
! NetConsole should issue this BEFORE every batch config apply and stash
! the checkpoint name in DeviceSavedConfig.rollbackContent.

end
```

### C.5 Verify on the device

```cisco-nxos
show feature                    ! "nxapi enabled"
show nxapi                      ! enabled, https port 443
show nxapi status               ! current sessions
show users                      ! netconsole logged in
show logging server             ! 10.10.20.20 1514
show ssh server                 ! SSH enabled
show running-config | section username
```

### C.6 Smoke test from your laptop

```bash
# NX-API REST (DME) -- ARP table
curl -su netconsole:Admin@123 \
  http://<device-ip>/api/mo/sys/show-ip-arp-1.json | jq

# NX-API REST -- running config
curl -su netconsole:Admin@123 \
  http://<device-ip>/api/mo/sys/show-running-config-1.json | jq

# NX-API CLI batch (show + config in one POST)
curl -s -u netconsole:Admin@123 \
  -H 'Content-Type: application/json' \
  -d '{"ins_api":{"version":"1.0","type":"cli_show","cmd":"show version","format":"json"}}' \
  http://<device-ip>/ins

# SSH fallback
ssh netconsole@<device-ip> 'show ip arp'
```

---

## D. Required configuration on the NetConsole side

Whichever vendor(s) you enable above, make sure the NetConsole worker can
reach the device IPs on the management plane:

```yaml
# docker-compose.app.yml -- worker section, add (one block per vendor)
ENABLE_EOS_API: "true"            # turn on EOS eAPI adapter
ENABLE_IOSXE_API: "true"          # turn on IOS-XE RESTCONF + NETCONF adapter
ENABLE_NXOS_API: "true"           # turn on NX-API REST + CLI adapter

# Default creds (override per-device later via Device.connectorJson)
EOS_API_USER: netconsole
EOS_API_PASSWORD: Admin@123
EOS_API_SCHEME: http              # lab: http; prod: https
EOS_API_PORT: "80"                # lab: 80; prod: 443

IOSXE_API_USER: netconsole
IOSXE_API_PASSWORD: Admin@123
IOSXE_API_SCHEME: https
IOSXE_API_PORT: "443"

NXOS_API_USER: netconsole
NXOS_API_PASSWORD: Admin@123
NXOS_API_SCHEME: http
NXOS_API_PORT: "80"
```

Syslog UDP port on the NetConsole VPS is already exposed in
`docker-compose.app.yml` (`1514:1514/udp`) -- see commit `85b3086` from the
2026-09-06 21:00 session for the `expose` -> `ports` fix.

---

## E. Security checklist (all vendors)

1. Replace `Admin@123` with a per-device secret generated from
   `scripts/rotate_secrets.sh`; store it in GitHub Secrets and inject as
   env vars. Never commit plaintext passwords.
2. Restrict eAPI / RESTCONF / NX-API source IPs to `10.10.20.0/24`
   (the NetConsole worker subnet) using vendor ACLs.
3. Enable HTTPS / NETCONF only; disable HTTP `nxapi` / RESTCONF HTTP.
4. Disable the NX-API sandbox in production
   (`no nxapi sandbox`).
5. Enable logging audit on the device so any config drift is recorded:
   ```eos
   logging buffered 65536 informational
   ```
   ```cisco-iosxe
   logging buffered 65536 informational
   ```
   ```cisco-nxos
   logging logfile messages 6 size 65536
   ```
6. Set `service password-encryption` (IOS-XE) and `service secret 9` for any
   secret on the device so a physical-console dump doesn't show plaintext.
7. On IOS-XE and NX-OS, set a unique `enable secret` distinct from any user
   password. NetConsole doesn't need it (privilege 15 user), but operator
   emergency console access should still be gated.

---

## F. Per-vendor quick reference (one-screen cheat sheet)

| Setting | EOS | IOS-XE | NX-OS |
|---|---|---|---|
| **Service user** | `username netconsole privilege 15 role network-admin secret Admin@123` | `username netconsole privilege 15 secret Admin@123` | `username netconsole password Admin@123 role network-admin` |
| **Enable API** | `management api http-commands; protocol https; no shutdown` | `ip http secure-server; restconf` | `feature nxapi; nxapi https port 443` |
| **Default port** | 443 (HTTPS), 80 (HTTP) | 443 (HTTPS) | 443 (HTTPS), 80 (HTTP) |
| **Save config** | `copy running-config startup-config` | `write memory` | `copy running-config startup-config` |
| **Syslog UDP** | `logging host 10.10.20.20 1514 protocol udp` | `logging host 10.10.20.20 transport udp port 1514` | `logging server 10.10.20.20 1514` |
| **Verify API** | `show management api http-commands` | `show restconf` | `show nxapi` |
| **Verify syslog** | `show logging hosts` | `show logging` | `show logging server` |
| **SSH** | already enabled | `ip ssh version 2` | `feature ssh` |
| **Rollback** | `rollback rescue-config` | `configure replace flash:pre.config force` | `rollback running-config checkpoint previous` |
| **Commit** | implicit on `end` | `<commit>` (NETCONF) or implicit (CLI) | implicit on `end` |
