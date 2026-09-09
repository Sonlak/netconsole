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

## What's left

The **real problem**: SSH from worker container to `10.10.20.x:22`
doesn't work. Even if we patch every SSH code path, the worker has no
path that captures output for IOS-XE config writes.

Three options to actually push config to the device:

1. **Move `apply_config` to backend** — backend calls sshpass to
   `10.10.20.212:22`. The backend container can already reach the
   device (proven by `show-run` via RESTCONF), so SSH from backend
   may work. Need to add NETCONF for partial-config too.
2. **Worker uses backend as proxy for SSH apply_config** — same code
   path, but the SSH command runs from the backend container.
   Cleanest split since the backend is the only thing that can
   reach the device.
3. **Add `ncclient` to backend and wire NETCONF SSH on port 830**
   for config push — IOS-XE supports `:writable-running:1.0` but
   NOT `:candidate:1.0`, so target `<running/>` directly.

None of these are trivial. The current PR fix is a **detector** —
it stops the silent-success bug. A **fixer** (one of the above)
is still needed for Config Studio to be useful on IOS-XE devices.

## Commits

- `e5e061a` fix(iosxe): add verify step after SSH apply_config +
  detect zero-output sessions
