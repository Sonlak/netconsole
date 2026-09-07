# 8. Vendor Extension Plan -- Add EOS + IOS-XE + NX-OS

> Added 2026-09-07. Reads on top of `docs/agents/07-vendor-api-survey.md`.
> Juniper (RESTCONF + SSH) is already wired in `worker/netconsole_worker/junos_rest.py`.
> This document covers the refactor to plug in the 3 new vendors.

---

## Goal

Wire Arista EOS, Cisco IOS-XE, and Cisco NX-OS into the same job pipeline that
Juniper uses today. The HTTP transport (`httpx.Client` pool) and SSH fallback
(`SSHConnectionPool`) are already vendor-agnostic; only the **per-vendor RPC
format** and **CLI parsing** need to land.

After this lands, every job type works on every vendor:

| Job | Juniper (current) | EOS (new) | IOS-XE (new) | NX-OS (new) |
|---|---|---|---|---|
| `GET_INTERFACES` | RESTCONF | eAPI show int | RESTCONF | NX-API REST |
| `GET_ARP` | RESTCONF | eAPI show ip arp | RESTCONF + SSH fallback | NX-API REST |
| `GET_MAC` | RESTCONF | eAPI show mac | SSH fallback | NX-API REST |
| `GET_CONFIG` | RESTCONF | eAPI show run | RESTCONF | NX-API REST |
| `APPLY_CONFIG` | RESTCONF | eAPI enable+conf+cmds | NETCONF `<edit-config>` | NX-API CLI cmds |
| `ROLLBACK_CONFIG` | RESTCONF `rollback N` | eAPI `rollback rescue-config` | SSH `configure replace flash:pre.config` | NX-API CLI `rollback running-config checkpoint` |
| `INTERFACE_ACTION` | RESTCONF set | eAPI cmds | NETCONF | NX-API cmds |
| `GET_LOGS` | syslog UDP push | syslog UDP push | syslog UDP push | syslog UDP push |
| `MANAGED_CHECK` | RESTCONF probe | eAPI show ver | RESTCONF `ietf-system` | NX-API REST `show version` |

---

## Design

### Vendor abstraction layer

Refactor `worker/netconsole_worker/` from "everything is Juniper" to a pluggable
backend. Keep the existing Juniper code intact; only the task classes in
`tasks/registry.py` change.

```text
worker/netconsole_worker/
├── backends/                       # NEW
│   ├── __init__.py
│   ├── base.py                     # ABC: get_interfaces, get_arp, ...
│   ├── juniper.py                  # wraps existing junos_rest.py
│   ├── eos.py                      # NEW: eAPI /command-api client
│   ├── iosxe.py                    # NEW: RESTCONF + NETCONF
│   └── nxos.py                     # NEW: NX-API REST + NX-API CLI
├── vendor.py                       # NEW: select backend from DeviceInfo
├── tasks/                          # CHANGED: dispatch via vendor.py
│   ├── base.py
│   ├── managed_check.py
│   └── registry.py                 # each task delegates to backend
├── junos_rest.py                   # unchanged -- wrapped by backends/juniper.py
├── ssh_client.py                   # unchanged -- reused for SSH fallback
└── config.py                       # CHANGED: new env vars
```

### Backend ABC

```python
class DeviceBackend(ABC):
    @abstractmethod
    def get_interfaces(self, device: DeviceInfo) -> dict: ...
    @abstractmethod
    def get_arp(self, device: DeviceInfo) -> dict: ...
    @abstractmethod
    def get_mac(self, device: DeviceInfo) -> dict: ...
    @abstractmethod
    def get_config(self, device: DeviceInfo) -> dict: ...
    @abstractmethod
    def apply_config(self, device: DeviceInfo, config: str, *, log: str) -> dict: ...
    @abstractmethod
    def rollback_config(self, device: DeviceInfo, rollback: int | None) -> dict: ...
    @abstractmethod
    def interface_action(self, device: DeviceInfo, *, action: str, iface: str, vlan: str) -> dict: ...
    @abstractmethod
    def probe_identity(self, device: DeviceInfo) -> dict: ...
```

Per-vendor subclass implements all 8. Each internally uses the shared
httpx pool (mirror `junos_rest.py:_clients` + lock) and the shared
`SSHConnectionPool` for SSH fallback. Result shape is the same JSON the
existing Juniper tasks already return (so the frontend doesn't change).

### Vendor selector

```python
# worker/netconsole_worker/vendor.py
def select_backend(device: DeviceInfo) -> DeviceBackend:
    vendor = (device.vendor or "").lower()
    model  = (device.model  or "").lower()

    if "arista" in vendor or vendor == "eos":
        return EOSBackend(...)
    if "cisco" in vendor:
        if any(k in model for k in ("nexus", "n9k", "n3k", "n7k")):
            return NxosBackend(...)
        if any(k in model for k in ("catalyst", "asr", "isr", "csr", "ios-xe", "ios xe", "iosxe")):
            return IOSxeBackend(...)
        # default Cisco path -- RESTCONF, fall back to SSH CLI
        return IOSxeBackend(...)
    if "juniper" in vendor or "juniper" in model or vendor == "junos":
        return JuniperBackend(...)
    raise ValueError(f"No backend for vendor={device.vendor!r} model={device.model!r}")
```

### Pool unification

Mirror `junos_rest.py`'s `_clients` dict. Move it to a shared
`http_pool.py` module so all 4 backends reuse one pool keyed by
`(host, port, user, scheme)`:

```python
# worker/netconsole_worker/http_pool.py
class HttpxPool:
    """Same shape as JunosRESTPool but vendor-agnostic."""
    def borrow(self, *, host, port, username, password, scheme, verify_tls) -> httpx.Client: ...
    def evict(self, key) -> None: ...
    def stats(self) -> dict: ...
```

`JunosRESTPool` stays for the registry — but new backends use `HttpxPool`
directly. Future cleanup: collapse into one pool class.

### Config (env vars)

Add to `worker/netconsole_worker/config.py`:

```python
# Existing (kept)
junos_rest_enabled: bool = False
junos_rest_scheme:  str = "https"
junos_rest_port:    int = 8443
junos_rest_user:    str = ""
junos_rest_password:str = ""
junos_rest_verify_tls: bool = False

lab_ssh_enabled: bool = False
lab_ssh_user: str = "lab"
lab_ssh_password: str = "lab123"
lab_ssh_port: int = 22

# NEW -- per-vendor API base URL
eos_rest_enabled:   bool = False   # ENABLE_EOS_API
eos_api_scheme:     str = "https"
eos_api_port:       int = 443
eos_api_user:       str = ""       # default = lab_ssh_user
eos_api_password:   str = ""       # default = lab_ssh_password
eos_api_verify_tls: bool = False

iosxe_rest_enabled: bool = False
iosxe_api_scheme:   str = "https"
iosxe_api_port:     int = 443
iosxe_api_user:     str = ""
iosxe_api_password: str = ""
iosxe_api_verify_tls: bool = False

nxos_rest_enabled:  bool = False
nxos_api_scheme:    str = "http"
nxos_api_port:      int = 80
nxos_api_user:      str = ""
nxos_api_password:  str = ""
nxos_api_verify_tls: bool = False
```

`backend/src/routes/devices.ts` will surface a `GET /api/devices/vendor-options`
endpoint returning the supported vendor/model combinations so the frontend
form can populate a Select.

### docker-compose.app.yml additions

```yaml
# worker section: add (kept next to JUNOS_REST_*)
LAB_SSH_ENABLED: "true"
LAB_SSH_USER: netconsole
LAB_SSH_PASSWORD: Admin@123
LAB_SSH_PORT: "22"
JUNOS_REST_ENABLED: "true"
JUNOS_REST_SCHEME: http
JUNOS_REST_PORT: "8443"
JUNOS_REST_VERIFY_TLS: "false"
JUNOS_REST_USER: netconsole
JUNOS_REST_PASSWORD: Admin@123
ENABLE_EOS_API: "true"           # NEW
EOS_API_SCHEME: http
EOS_API_PORT: "80"
EOS_API_VERIFY_TLS: "false"
EOS_API_USER: netconsole
EOS_API_PASSWORD: Admin@123
ENABLE_IOSXE_API: "true"         # NEW
IOSXE_API_SCHEME: https
IOSXE_API_PORT: "443"
IOSXE_API_VERIFY_TLS: "false"
IOSXE_API_USER: netconsole
IOSXE_API_PASSWORD: Admin@123
ENABLE_NXOS_API: "true"          # NEW
NXOS_API_SCHEME: http
NXOS_API_PORT: "80"
NXOS_API_VERIFY_TLS: "false"
NXOS_API_USER: netconsole
NXOS_API_PASSWORD: Admin@123
```

### Frontend -- `DeviceModal.tsx`

Replace the `vendor` Input with a Select. Suggested options:

- `Juniper` -- existing (RESTCONF path)
- `Arista` -- eAPI path
- `Cisco Catalyst` -- IOS-XE RESTCONF
- `Cisco Nexus` -- NX-API REST
- `Cisco Firewall` -- deferred (FMC strategy needed)
- `Other` -- free-text model

Use `Form.Item shouldUpdate` to swap `model` suggestions per vendor:

```tsx
<Form.Item name="vendor" label="Vendor" rules={[{ required: true }]}>
  <Select
    options={[
      { value: 'Juniper', label: 'Juniper' },
      { value: 'Arista', label: 'Arista EOS' },
      { value: 'Cisco Catalyst', label: 'Cisco IOS-XE (Catalyst/ASR/ISR)' },
      { value: 'Cisco Nexus', label: 'Cisco NX-OS (Nexus)' },
      { value: 'Other', label: 'Other (SSH CLI only)' },
    ]}
    onChange={(v) => form.setFieldValue('model', MODEL_HINTS[v]?.[0] ?? '')}
  />
</Form.Item>
<Form.Item shouldUpdate={(p, c) => p.vendor !== c.vendor} noStyle>
  {() => (
    <Form.Item name="model" label="Model">
      <AutoComplete
        options={MODEL_HINTS[form.getFieldValue('vendor') as string] ?? []}
        placeholder="C9300-48P / N9K-C93180YC-FX / DCS-7280SR3..."
      />
    </Form.Item>
  )}
</Form.Item>
```

No backend `Device` schema change required (`vendor` is already `String`).
Per-device connection overrides (port / scheme / verify_tls) come later via
a per-device `connector` JSON field when the env-var-only model proves too
rigid.

---

## Per-vendor RPC specifics (the meat)

### Arista EOS (`backends/eos.py`)

```python
class EOSBackend(DeviceBackend):
    def _run_cmds(self, device, cmds, fmt="json"):
        payload = {
            "jsonrpc": "2.0", "id": 1, "method": "runCmds",
            "params": {"version": 1, "cmds": cmds, "format": fmt},
        }
        return self._http_post(device, "/command-api", payload)

    def get_interfaces(self, device):
        r = self._run_cmds(device, [{"cmd": "show interfaces", "format": "json"}])
        return {"implemented": True, "source": "eos-api",
                "command": "show interfaces", "interfaces": parse_eos_interfaces(r)}

    def get_arp(self, device):
        r = self._run_cmds(device, [{"cmd": "show ip arp", "format": "json"}])
        return {"implemented": True, "source": "eos-api",
                "command": "show ip arp", "entries": parse_eos_arp(r)}

    def get_mac(self, device):
        r = self._run_cmds(device, [{"cmd": "show mac address-table", "format": "json"}])
        return {"implemented": True, "source": "eos-api",
                "command": "show mac address-table", "entries": parse_eos_mac(r)}

    def get_config(self, device):
        r = self._run_cmds(device, [{"cmd": "show running-config", "format": "text"}])
        return {"implemented": True, "source": "eos-api",
                "command": "show running-config", "config": r[0]["output"]}

    def apply_config(self, device, config, *, log):
        cmds = _text_to_eos_cmds(config)         # split on newlines, drop blanks
        r = self._run_cmds(device, ["enable", "configure", *cmds, "end"])
        return {"implemented": True, "source": "eos-api",
                "commands": cmds, "message": f"Committed config to {device.name}"}

    def rollback_config(self, device, rollback):
        cmds = ["enable", "configure", "rollback rescue-config", "end"]
        r = self._run_cmds(device, cmds)
        return {"implemented": True, "source": "eos-api", "rollback": "rescue"}

    def probe_identity(self, device):
        r = self._run_cmds(device, ["show version"])
        return {"implemented": True, "source": "eos-api",
                "parsed": parse_eos_show_version(r[0])}
```

Arista needs a `session-timeout` config (default 5 min) but eAPI is otherwise
trivial. Auth = HTTP Basic. JSON-RPC 2.0 envelopes.

**Parsers** to add in `worker/netconsole_worker/parsers/`:
- `eos_show_interfaces.py`
- `eos_show_arp.py`
- `eos_show_mac.py`
- `eos_show_version.py`

### Cisco IOS-XE (`backends/iosxe.py`)

RESTCONF first; SSH CLI fallback when RESTCONF returns 501/404 or
`Cisco-IOS-XE-mac-address-table-oper` 404s (very common on 16.x).

```python
class IOSxeBackend(DeviceBackend):
    BASE = "/restconf/data"

    def _rc_get(self, device, path):
        return self._http_get(device, f"{self.BASE}{path}",
                              headers={"Accept": "application/yang-data+json"})

    def get_interfaces(self, device):
        r = self._rc_get(device, "/ietf-interfaces:interfaces")
        if r.ok:
            return {"implemented": True, "source": "iosxe-rest",
                    "command": "ietf-interfaces:interfaces",
                    "interfaces": parse_iosxe_interfaces(r.json())}
        return self._ssh_fallback(device, "show ip interface brief",
                                  parser=parse_cisco_ios_interfaces_brief)

    def get_arp(self, device):
        # YANG coverage is patchy; go straight to SSH CLI on IOS-XE.
        return self._ssh_fallback(device, "show ip arp",
                                  parser=parse_cisco_ios_arp)

    def get_mac(self, device):
        return self._ssh_fallback(device, "show mac address-table",
                                  parser=parse_cisco_ios_mac)

    def get_config(self, device):
        r = self._rc_get(device, "/Cisco-IOS-XE-native:native?depth=unbounded")
        if r.ok:
            return {"implemented": True, "source": "iosxe-rest",
                    "config": json.dumps(r.json())}   # for archival; CLI is friendlier
        # Fall back to running-config CLI for human readability
        return self._ssh_fallback(device, "show running-config",
                                  parser=parse_cisco_ios_show_run)

    def apply_config(self, device, config, *, log):
        # IOS-XE has no native commit semantics -- use NETCONF <edit-config>
        # running, then `<commit>` in a follow-up call.
        nc_client = netconf_connect(device)
        nc_client.edit_config(target="running", config=config)
        nc_client.commit()
        return {"implemented": True, "source": "iosxe-netconf", "message": f"Committed to {device.name}"}

    def rollback_config(self, device, rollback):
        # IOS-XE uses 'configure replace' against a saved archive.
        return self._ssh_fallback(device,
            f"configure replace flash:pre.config force",   # archive written by APPLY_CONFIG
            parser=lambda x: x)

    def probe_identity(self, device):
        return self._ssh_fallback(device, "show version", parse_cisco_ios_show_version)
```

**Python libs:** `ncclient` for NETCONF (`pip install ncclient`).
**Parsers** to add: `cisco_ios_show_interfaces.py`, `cisco_ios_show_arp.py`,
`cisco_ios_show_mac.py`, `cisco_ios_show_version.py`, `cisco_ios_show_run.py`.
Use **TextFSM** templates (`ntc-templates`) for ARP/MAC/version to avoid
hand-written regexes.

### Cisco NX-OS (`backends/nxos.py`)

NX-API REST is by far the cleanest path on Nexus. Structured JSON for every
`show`. Config apply uses NX-API CLI (also JSON-RPC-flavored but same
transport).

```python
class NxosBackend(DeviceBackend):
    NXAPI_REST = "/api/mo"           # DME object paths
    NXAPI_CLI  = "/ins"              # show / config commands

    def _mo_get(self, device, mo_class):
        return self._http_get(device, f"{self.NXAPI_REST}/sys/{mo_class}.json")

    def get_interfaces(self, device):
        r = self._mo_get(device, "intf/phys-[*]")   # every physical interface
        if r.ok:
            return {"implemented": True, "source": "nxos-nxapi",
                    "interfaces": parse_nxos_interfaces(r.json())}
        return self._ssh_fallback(device, "show ip interface brief vrf all",
                                  parse_cisco_ios_interfaces_brief)

    def get_arp(self, device):
        r = self._mo_get(device, "show-ip-arp-1")
        return {"implemented": True, "source": "nxos-nxapi",
                "entries": parse_nxos_arp(r.json())}

    def get_mac(self, device):
        r = self._mo_get(device, "show-mac-address-table-1")
        return {"implemented": True, "source": "nxos-nxapi",
                "entries": parse_nxos_mac(r.json())}

    def get_config(self, device):
        r = self._mo_get(device, "show-running-config-1")
        return {"implemented": True, "source": "nxos-nxapi", "config": r.text}

    def apply_config(self, device, config, *, log):
        cmds = _text_to_nxos_cmds(config)         # one config line = one cmd
        # NX-API CLI batch:
        payload = {"ins_api": {"version": "1.0", "type": "cli_conf",
                               "cmd": "config terminal; " + "; ".join(cmds) + " ; end"}}
        return self._http_post(device, self.NXAPI_CLI, payload)

    def rollback_config(self, device, rollback):
        # 'rollback running-config checkpoint' returns to the last checkpoint
        return self._apply(device, "rollback running-config checkpoint previous")

    def probe_identity(self, device):
        r = self._mo_get(device, "show-version-1")
        return {"implemented": True, "source": "nxos-nxapi",
                "parsed": parse_nxos_show_version(r.json())}
```

**Parsers** to add: `nxos_show_interfaces.py`, `nxos_show_arp.py`,
`nxos_show_mac.py`, `nxos_show_version.py`. The DME JSON is verbose but
predictable; one normalizer function per shape.

---

## Test plan

1. **Unit tests** with mocked HTTP responses (one fixture per vendor per
   endpoint). Goal: parsers handle every documented field shape.
2. **Live test** against containerlab sims:
   - Add `lab/arista-sim/` with `ceos` image
   - Add `lab/cisco-iosxe-sim/` (use `vrnetlab/cisco_csr1000v` or
     `xrdocs/cisco-xrd`)
   - Add `lab/cisco-nxos-sim/` (use `vrnetlab/cisco_n9kv`)
   - Apply the device configs in `docs/agents/09-vendor-device-configs.md`
   - For each (vendor, task) pair, dispatch the job and assert
     `{implemented: true, source: <vendor>}` and `entries`/`interfaces` shape.
3. **Rollback test**: apply a known config, modify, rollback, assert matches.
4. **Fallback test**: kill the API server on the sim, ensure SSH fallback
   produces identical shape (so the frontend doesn't care).

---

## Rollout order (smallest blast radius first)

1. Schema: zero change needed (`vendor` is already String).
2. Worker refactor: extract `backends/juniper.py` from existing
   `tasks/registry.py` -- prove no regression on the lab Juniper sims.
3. Worker: add `backends/eos.py` + parsers + `ENABLE_EOS_API=true`.
   Land in PR; smoke-test against an `ceos` sim.
4. Worker: add `backends/iosxe.py` + parsers + `ENABLE_IOSXE_API=true`.
   Land in PR; smoke-test against a `cisco_csr1000v` sim.
5. Worker: add `backends/nxos.py` + parsers + `ENABLE_NXOS_API=true`.
   Land in PR; smoke-test against a `cisco_n9kv` sim.
6. Frontend: replace vendor Input with Select. Cosmetic -- no schema change.
7. Optional: per-device credentials table (`Device.connectorJson`) when
   the shared-credential model proves too rigid.

---

## Risks

| Risk | Mitigation |
|---|---|
| ntc-templates dependency drift | Pin `ntc-templates==2.2.1`; fall back to hand-written parser if the template is missing |
| IOS-XE YANG 501/404 surprise | SSH fallback first for ARP/MAC; RESTCONF only for stable paths |
| EOS JSON-RPC version drift | Pin `version: 1`; smoke test on each EOS version family |
| NX-API HTTP port (80) blocked by firewalls | Default to HTTPS :443 in compose; HTTP only on lab |
| ncclient transit pip dep | ~200 KB; acceptable. Or use raw SSH netconf transport to avoid it |
| New env-var sprawl | Hide behind the `ENABLE_<VENDOR>_API` boolean; only one vendor enabled at a time per device via vendor selector |
| Per-device credentials still env-only | Acceptable for v1; per-device credentials planned for v2 |

---

## File-level change list

| File | Status | Change |
|---|---|---|
| `worker/netconsole_worker/vendor.py` | NEW | `select_backend(device)` |
| `worker/netconsole_worker/backends/__init__.py` | NEW | export `DeviceBackend` |
| `worker/netconsole_worker/backends/base.py` | NEW | ABC |
| `worker/netconsole_worker/backends/juniper.py` | NEW | wraps junos_rest.py |
| `worker/netconsole_worker/backends/eos.py` | NEW | eAPI client |
| `worker/netconsole_worker/backends/iosxe.py` | NEW | RESTCONF + NETCONF |
| `worker/netconsole_worker/backends/nxos.py` | NEW | NX-API REST + CLI |
| `worker/netconsole_worker/parsers/eos_*.py` | NEW | (4 files) |
| `worker/netconsole_worker/parsers/cisco_ios_*.py` | NEW | (5 files) |
| `worker/netconsole_worker/parsers/nxos_*.py` | NEW | (4 files) |
| `worker/netconsole_worker/tasks/registry.py` | CHANGED | dispatch via vendor.py |
| `worker/netconsole_worker/tasks/managed_check.py` | CHANGED | dispatch via vendor.py |
| `worker/netconsole_worker/config.py` | CHANGED | add 12 env vars |
| `worker/requirements.txt` | CHANGED | + ncclient, + ntc-templates, + textfsm |
| `docker-compose.app.yml` | CHANGED | add 12 env vars under worker |
| `frontend/src/pages/Devices/DeviceModal.tsx` | CHANGED | vendor Select + model AutoComplete |
| `docs/agents/09-vendor-device-configs.md` | NEW | copy-paste device configs |
| `lab/arista-sim/` | NEW | containerlab def + ceos image |
| `lab/cisco-iosxe-sim/` | NEW | containerlab def + csr1000v image |
| `lab/cisco-nxos-sim/` | NEW | containerlab def + n9kv image |
