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
  - Rewrote `interface_action()` to mirror `apply_config`/`rollback_config` (commit 212fbd9):
    - **show-run**: RESTCONF scoped → NETCONF scoped → NETCONF full → SSH CLI.
    - **writes (shut/no-shut/set-access-vlan)**: NETCONF SSH → RESTCONF → SSH CLI.
  - Added `netconf_get_configuration_to_set` to imports.

## Root cause

`interface_action` was on the old routing: RESTCONF-first for writes, RESTCONF-only for show-run. Junos cRPD RESTCONF is flaky (gotcha #15: stale-socket, first-commit spike 20-30s). The `apply_config` path was already fixed in commit 212fbd9, but `interface_action` was missed.

## Transport routing summary

| Action | Path 1 | Path 2 | Path 3 |
|--------|--------|--------|--------|
| show-run | RESTCONF | NETCONF SSH | SSH CLI |
| shut / no-shut / set-access-vlan | **NETCONF SSH** | RESTCONF | SSH CLI |

## What's left

(None — all 5 unit tests pass for `xml_to_set_format`.)
