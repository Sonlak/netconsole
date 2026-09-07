### 12:55 -- LAB-F3-AS-02 Cisco IOS-XE: SSH-prefer + Cisco parsers

- **Identified vendor mismatch** -- DB had `LAB-F3-AS-02` (10.10.20.212) as Juniper ex9214, but SSH banner is `SSH-2.0-Cisco-1.25` (IOS-XE 17.16 with RESTCONF live on port 443). Updated `device.vendor=Cisco`, `model=Catalyst 9000`, `version=17.16`.
- **Fixed `iosxe.get_config`** to prefer `show running-config` via SSH (real CLI text) instead of RESTCONF `Cisco-IOS-XE-native:native` (returns JSON YAML model that Config Studio can't render as code). SSH-only path now matches the same shape as Juniper/Arista so the frontend `<pre>` block works.
- **Added `parse_cisco_arp_table`** in `parsers/show_arp.py` for `show ip arp` format: `Protocol Address Age Hardware-Addr Type Interface` (with vendor-style `8a3e.68ec.1149` MAC). Normalizes Cisco MAC to `aa:bb:cc:dd:ee:ff` form.
- **Added `parse_cisco_mac_table`** in `parsers/show_mac_table.py` for `show mac address-table` format: `Vlan Mac-Addr Type Ports`.
- **Added `_parse_cisco_interfaces`** in `backends/iosxe.py` to convert `show interfaces` text blocks into the same `{name, adminStatus, operStatus, speed, mtu, macAddress, description}` shape the frontend Ports panel expects. Status normalization matches Juniper `up`/`down` strings.
- **Rewired priority** for `get_interfaces`/`get_arp` to prefer SSH (RESTCONF YANG was returning empty `arp-data` on IOS-XE 17.x). Mac still uses SSH only — no YANG coverage on IOS-XE.
- **Verified end-to-end** with live jobs: `GET_CONFIG` returns 6113B CLI text, `GET_INTERFACES` 4 ports with mac + speed + status, `GET_ARP` 3 entries with normalized MACs, `GET_MAC` 20 entries from `show mac address-table`.
- **No new gotchas** -- IOS-XE follows the same pattern as Arista: SSH-CLI text is the reliable path when YANG coverage is patchy.

Committed in `60b7e4c` -- pushing to deploy.

### TODO carry-over (unchanged)
- `mustChangePassword` redirect not wired in frontend
- Per-device vendor credentials (Phase 2) -- still backlog
- Rollback schema-drift handling
