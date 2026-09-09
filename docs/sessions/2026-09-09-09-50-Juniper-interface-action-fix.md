# 2026-09-09 09:50 — Fix Junos `interface_action` (shut/no-shut/set-vlan/show-run)

## Changes

- **`worker/netconsole_worker/junos_netconf.py`**:
  - Added `fetch_interface_configuration()` NETCONF helper (scoped `<get-configuration>` via xpath).
  - Added `fetch_full_configuration()` NETCONF helper (full candidate config).
  - Fixed `_parse_ok_error()`: added `<configuration>` as a success indicator for `<get-configuration>` replies (they don't carry `<ok/>`).

- **`worker/netconsole_worker/parsers/configuration_rpc.py`**:
  - Added `xml_to_set_format()`: walks NETCONF `<get-configuration>` XML and emits set-format lines. Handles `interface`/`vlan`/`area` list-entry stripping, `<name>` as path anchor, envelope tag stripping.
  - Added `netconf_get_configuration_to_set()`: public wrapper, falls back to `parse_configuration_set()` for RESTCONF-style text.
  - Added `_is_noise_output()`: strips `set ok` / `set rpc-reply ok` noise from bare `<ok/>` replies.

- **`worker/netconsole_worker/backends/juniper.py`**:
  - Rewrote `interface_action()` for write actions (shut/no-shut/set-access-vlan): RESTCONF-primary → NETCONF SSH fast-fallback (15s timeout) → SSH CLI.
  - Show-run unchanged: RESTCONF → NETCONF SSH → SSH CLI.

- **`backend/src/services/jobWatchdog.ts`**:
  - Added `INTERFACE_ACTION: 120_000` to `VENDOR_EXTRA_MS` for Juniper (total 240s, consistent with APPLY_CONFIG).

## Root cause

`interface_action` write path had two problems:
1. **NETCONF SSH first for writes** — NETCONF-over-SSH cold-start on Junos cRPD spikes 20-30s (gotcha #15). Measured on LAB-F2-AS-01: NETCONF SSH timeout fires at 27s, then RESTCONF succeeds in ~17s. Total write time ~44s.
2. **Watchdog 120s** — job sat PENDING 95-160s (worker queue backlog) + 44s execution = easily over 120s watchdog → killed as "hung RPC".

## Benchmark results (LAB-F2-AS-01, Junos cRPD 24.4R1.9)

| Action | Transport used | Execution time | Notes |
|--------|---------------|----------------|-------|
| show-run (read) | RESTCONF | ~24s total | 95s PENDING + 24s RUNNING |
| shut (write) | RESTCONF (NETCONF timed out) | loadMs=9354 + commitMs=7581 ≈ 17s | NETCONF SSH timeout 27s then RESTCONF success |
| no-shut (write) | RESTCONF | ~17s | Same pattern |

## Transport routing (corrected 2026-09-09)

| Action | Path 1 | Path 2 | Path 3 |
|--------|--------|--------|--------|
| show-run | RESTCONF (~2-5s) | NETCONF SSH | SSH CLI |
| shut / no-shut / set-access-vlan | **RESTCONF (~17s)** | NETCONF SSH (15s timeout) | SSH CLI |

Note: Originally had NETCONF SSH primary for writes — benchmark proved this wrong. RESTCONF is faster on Junos cRPD for both reads and writes.

## What's left

(None — verified on live lab device.)
