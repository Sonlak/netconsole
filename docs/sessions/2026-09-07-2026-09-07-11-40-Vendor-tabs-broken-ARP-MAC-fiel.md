### 2026-09-07 11:40 -- Vendor tabs broken: ARP/MAC field names + EOS show-run

- User reported: tabs Config / ARP / MAC still broken on the EOS device
  (LAB-F1-AS-01 at 10.10.20.131). Shut / no-shut worked, show-run
  errored.

- Root causes:
  1. EOS / IOS-XE / NX-OS ARP parsers returned `address`/`macAddress`
     instead of `ip`/`mac`/`hostname`/`flags`. The backend's
     `arpAddress.ts` `getArpInventory` reads `entry.ip` /
     `entry.mac` / `entry.hostname` / `entry.flags` (matching the
     `ArpAddressRow` contract in `frontend/src/types/arpAddress.ts`)
     so the global ARP table and the device ARP tab rendered all
     rows with `—` everywhere.
  2. EOS / NX-OS MAC parsers returned `macAddress`/`vlanId`/
     `entryType` with no `tag`, `flags`, `sessId`. The MAC table
     broke similarly.
  3. EOS MAC was returned as Cisco-format (`000c.290d.4a63`) which
     the frontend MacAddress component can't normalize; copy-paste
     into a search field would not match other vendors' `aa:bb:...`.
  4. EOS show-run used `show running-config interface <name>` — EOS
     does NOT accept a per-interface filter on that command. eAPI
     rejects with `% Invalid input` and the job fails. Juniper and
     IOS-XE both accept the per-interface form, so this was EOS-only.

- Fix:
  - `worker/netconsole_worker/backends/eos.py`:
    * `_parse_eos_arp` now emits `{ip, mac, hostname, interface,
      flags, age}`, normalizes the MAC via `normalize_mac`, and
      drops loopback / link-local addresses (matches Juniper).
    * `_parse_eos_mac` now emits `{mac, vlan, tag, interface,
      flags, type, sessId}` with `flags` derived from `entryType`
      (`S` for static, `D` for dynamic) and MAC normalized.
    * New `_slice_eos_interface_block` parses the output of
      `show running-config section interface` and returns just
      the block for the requested interface (works for
      `Ethernet1`, `Port-Channel1`, `Vlan10`, etc.).
    * `interface_action(show-run)` now sends `show running-config
      section interface` (eAPI + SSH path) and slices the output.
  - `worker/netconsole_worker/backends/iosxe.py`:
    * `_parse_iosxe_arp` emits the correct field names + normalized
      MAC + loopback filter.
  - `worker/netconsole_worker/backends/nxos.py`:
    * `_parse_nxos_arp` + `_parse_nxos_mac` emit the correct
      field names, normalized MAC, flag derivation, loopback filter.

- Verified with a Python script that round-trips realistic EOS /
  IOS-XE / NX-OS payloads and asserts the contract. All checks pass.

- What the user needs to do:
  1. Rebuild the worker image (`docker compose build worker` or
     push to main → GitHub Actions will rebuild + redeploy).
  2. Re-collect ARP / MAC on the EOS device — the existing rows in
     `Job.result` still have the old broken shape and the API
     returns the latest job result verbatim. A fresh `Collect`
     click on the ARP / MAC tab (or `Collect All` from the device
     page) will overwrite the bad rows.
  3. For Config: the EOS get_config path always worked at the
     worker level — the tab was showing "Not collected" because no
     GET_CONFIG job had been triggered for the EOS device yet.
     Click `Collect config` once and the running-config text
     appears.