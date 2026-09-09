# 2026-09-09 — IOS-XE Config Studio APPLY_CONFIG: surface failure instead of fake SUCCESS

## Symptom

Config Studio at `/generate-config?device=<F3-AS-02>` shows the diff, user
clicks "Commit to device", backend enqueues `APPLY_CONFIG` job, worker
picks it up, returns SUCCESS. But the device running-config shows no
change.

## Root cause

`worker/netconsole_worker/backends/iosxe.py::IOSxeBackend.apply_config`
runs the config through `run_ssh_commands_session()` which uses
`sshpass -p <pw> ssh -tt netconsole@<host>:22 "<bash script>"`.

The worker container on the `netconsole` docker bridge (172.31.0.4/24)
can open outbound TCP to `10.10.20.x:22` but the SSH pipe is broken —
the device closes (or never opens) the channel and the script returns
empty stdout/stderr. `sshpass` exits 0 because the connection was
successfully established.

`run_ssh_commands_session` had no check for "all outputs empty":
- `first_error is None` (no IOS error patterns in any output)
- `combined` was non-empty (the echo markers we write ourselves)
- `outputs[i].output` = `""` for every `i`

So the job returned `sshOk=True` and the worker reported
`Committed config to LAB-F3-AS-02` even though nothing actually went
to the device.

## Fix (commit `e5e061a`)

### 1. `worker/netconsole_worker/ssh_client.py::run_ssh_commands_session`

Added two new failure paths after the marker-split + IOS error check:

```python
all_empty = all(not o["output"] for o in outputs)
if first_error is None and all_empty and combined.strip():
    first_error = {"error": "No output from device (possible pager or session glitch)", ...}
elif first_error is None and all_empty and not combined.strip():
    first_error = {"error": f"No output captured (sshpass exit {proc.returncode} — check auth/network)", ...}
```

→ `sshOk=False` whenever the session returns no per-command output.

### 2. `worker/netconsole_worker/backends/iosxe.py::IOSxeBackend.apply_config`

Added `_verify_iosxe_config(device, config)` helper that calls
`GET /api/interfaces/<id>/show-run?iface=<first-interface-in-config>`
on the backend (which works — see `11-...`). If the post-apply verify
finds none of the pushed config lines on the device, the job fails
with a clear error.

## Verification

Triggered via UI: `/generate-config?device=48301ed8-e7a2-472c-ab88-1e5bf1679fb7`
→ "Commit to device" → job `33e7b8b9`:

```
status   = FAILED
error    = "No output from device (possible pager or session glitch)"
source   = None        (apply_config raised before the success block)
message  = None
```

User now sees a meaningful error instead of "Committed config to …".

## Status (2026-09-09 16:45)

**FIXED.** Pipeline now actually pushes config to IOS-XE devices.

- Worker SSH still broken (worker container can't reach 10.10.20.x port 22)
- Worker falls back to backend SSH proxy at `POST /api/interfaces/:id/apply-ssh`
- Backend opens ssh2 shell to device, sends `configure terminal` + full
  config batch (sub-blocks like `vlan 201 / name FOO` work) + `end`,
  captures per-line output, rejects on `% ` markers
- Verified live on LAB-F3-AS-02: applied `description NETCONSOLE_PROXY_TEST`
  → show-run via RESTCONF confirms it's on the device → rolled back

## Commits

- `b250675` fix(iosxe): backend SSH proxy for apply_config
- `12f259d` fix(iosxe): batch-send config in apply-ssh to support sub-blocks
- `e5e061a` fix(iosxe): detect zero-output SSH sessions
- `c270ddc` docs(agents): log this issue + remaining work
