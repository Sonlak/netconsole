# 2026-09-09 — IOS-XE show-run via backend RESTCONF (worker → backend → device)

## Root cause

Two cascading problems:

1. **Worker container can't reach 10.10.20.x reliably.** `sshpass + ssh` from
   the worker Docker container to `10.10.20.212:22` returned empty output —
   the SSH channel opens but no response lands in the captured pipe. NETCONF
   port 830 also fails the same way. Only the **backend** container has a
   working path to lab IOS-XE devices (proven by the working RESTCONF for
   ARP/MAC collection today).

2. **Backend `iosxeInterfaceConfigToText` was buggy.** A generic
   `walk()` recursive renderer output garbage like:
   ```
   interface GigabitEthernet4
     Cisco-IOS-XE-native:GigabitEthernet
       name 4
       ip
         address
           primary
             address 10.10.20.212
             mask 255.255.255.0
   ```
   AND its top-level key filter rejected fully-qualified YANG keys like
   `Cisco-IOS-XE-native:GigabitEthernet`.

## Changes

- **`backend/src/routes/interfaces.ts`** (route existed but uncommitted):
  `GET /api/interfaces/:deviceId/show-run?iface=X` — calls
  `fetchIosxeInterfaceRunningConfig` and returns IOS CLI text.
- **`backend/src/services/iosxeRest.ts`**:
  - `fetchIosxeInterfaceRunningConfig()` (committed now) — GETs
    `Cisco-IOS-XE-native:native/interface/<X>=<id>` via RESTCONF port 443.
  - **Rewrote `iosxeInterfaceConfigToText`** to render proper IOS CLI:
    skips `name` leaf, formats `ip address primary address/mask` as a single
    line, strips YANG namespace prefixes, handles `negotiation auto`,
    `switchport mode`, presence containers, descriptions.
  - Fixed `verifyTls` polarity (was inverted).
- **`docker-compose.app.yml`**: added `NODE_TLS_REJECT_UNAUTHORIZED=0` to
  backend env so Node.js `fetch()` accepts the lab self-signed cert.
- **`worker/netconsole_worker/backends/iosxe.py`**:
  - Added `_backend_show_run(device, iface)` helper that calls
    `GET /api/interfaces/:deviceId/show-run?iface=X` on the backend.
  - In `interface_action(show-run)`, the new `_backend_show_run` path runs
    FIRST (Path 1). On backend failure → fall through to NETCONF port 830 →
    SSH CLI (unchanged).
- **`worker/netconsole_worker/ssh_client.py`**:
  - Surface sshpass non-zero exit + empty output as a hard error in
    `run_ssh_commands_session` (was silently returning success — masked
    the original bug).
  - Bug fix: `combined = proc.stdout + proc.stderr` must be assigned
    before the early-return guard references it (ruff F821 caught it).

## Verification

Live on LAB-F3-AS-02 / 10.10.20.212:

- Direct REST call:
  ```
  GET /api/interfaces/48301ed8-.../show-run?iface=GigabitEthernet4
  → {
      "config": "interface GigabitEthernet4\nip address 10.10.20.212 255.255.255.0\nnegotiation auto\n!",
      "source": "iosxe-rest"
    }
  ```
- Worker job 3dfcde6c:
  ```
  result.source = "iosxe-rest"
  result.config = "interface GigabitEthernet4\nip address 10.10.20.212 255.255.255.0\nnegotiation auto\n!"
  result.message = "RESTCONF via backend (iosxe-rest)"
  ```
- UI modal at `/devices/<F3-AS-02>?tab=ports` → **Show run GigabitEthernet4**
  now displays the real config.

## Commits

- `116535d` feat(iosxe): show-run via backend RESTCONF
- `382ea8f` fix(worker): ruff F401 - move settings import inside method
- `bdd3c3b` fix(worker): hoist combined = stdout+stderr above the check
- `8f92793` fix(backend): TS5076 - parens around '&&'/'??' precedence
- `2b3103a` fix(backend): invert verifyTls flag + NODE_TLS_REJECT_UNAUTHORIZED=0
- `a80298f` fix(backend): rewrite iosxeInterfaceConfigToText to clean IOS CLI
- `5bc0aaa` fix(backend): any object/array key is the interface block

## What's left

(None — verified on live lab device. CI green, deploy green.)
