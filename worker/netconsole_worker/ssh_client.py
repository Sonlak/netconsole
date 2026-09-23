"""Reusable SSH connection helpers.

Each call to `run_ssh_command` historically opened a brand-new TCP+SSH
session to the lab device, ran one or two CLI commands, then closed it.
For a stack that polls 4-5 collectors (MAC, ARP, interfaces, config,
logs) every 60-300s against 6 devices, that means:

  - ~25 TCP+SSH handshakes/minute across the lab
  - each handshake produces 1-2 lines in the Junos auth.log
    ("Accepted password for netconsole from <ip> port N ssh2",
     "JUNOS_AUTH_SUCCESS: Authentication succeeded ...")

Over a 24h window that drowns the logs page in login chatter and hides
the actual operational events.

This module now exposes a tiny **connection pool** keyed by
`(host, port, username)`. Tasks borrow a connection, run any number of
commands, return it. A background thread reaps idle connections every
`reap_interval` seconds so the pool never grows unbounded.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

import paramiko


@dataclass
class _PooledConn:
    client: paramiko.SSHClient
    created_at: float = field(default_factory=time.monotonic)
    use_count: int = 0
    last_used: float = field(default_factory=time.monotonic)


class SSHConnectionPool:
    """Thread-safe single-connection-per-key cache.

    One connection per (host, port, username) is kept open between
    borrows. A background daemon thread reaps connections idle for
    more than `idle_seconds` to keep the pool bounded. A monotonic
    counter (`stats`) exposes call counts so we can verify the cache
    is actually being hit.
    """

    def __init__(self, idle_seconds: float = 600.0, reap_interval: float = 60.0) -> None:
        self._lock = threading.Lock()
        self._pool: dict[tuple[str, int, str], _PooledConn] = {}
        self._idle_seconds = idle_seconds
        self._reap_interval = reap_interval
        self._stop_reaper = threading.Event()
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True, name="ssh-pool-reaper")
        self._reaper.start()
        self.stats = {"borrows": 0, "opens": 0, "reuses": 0, "closes": 0, "evictions": 0}

    # ------------------------------------------------------------------
    # Background reaper
    # ------------------------------------------------------------------
    def _reap_loop(self) -> None:
        while not self._stop_reaper.wait(self._reap_interval):
            now = time.monotonic()
            with self._lock:
                for key in list(self._pool):
                    entry = self._pool[key]
                    if now - entry.last_used > self._idle_seconds:
                        try:
                            entry.client.close()
                        except Exception:
                            pass
                        del self._pool[key]
                        self.stats["evictions"] += 1
                        self.stats["closes"] += 1

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def _key(self, host: str, port: int, username: str) -> tuple[str, int, str]:
        return (host, int(port), username)

    def _is_alive(self, conn: _PooledConn, host: str, port: int, username: str) -> bool:
        """Return False if the cached connection has been torn down.

        `transport.is_active()` checks the paramiko-level socket. We rely on
        it alone — the previous implementation also ran a `show version` exec
        on every borrow(), but that command path itself opens a channel and
        counts as SSH traffic in `auth.log` on the device. Every 30-60s the
        worker re-uses a Junos connection (the new RESTCONF-primary path
        doesn't even hit SSH, but the IOS-XE RESTCONF pool and the
        connection pool itself still poke SSH on borrow) and that command
        could fail on Junos (no `| match /./` regex syntax), causing an evict
        → reopen → auth loop that flooded auth.log with SSH logins.

        TCP keepalive (60s, set on transport in `borrow`) catches half-open
        sockets within ~3 missed keepalives. The transport-level check is
        sufficient and zero-cost — no extra channel open.
        """
        import logging
        log = logging.getLogger(__name__)
        client = conn.client
        transport = client.get_transport() if hasattr(client, "get_transport") else None
        if transport is None:
            log.debug("alive check fail %s: no transport", (host, port, username))
            return False
        if not transport.is_active():
            log.debug("alive check fail %s: transport inactive", (host, port, username))
            return False
        return True

    def borrow(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        timeout: int = 15,
    ) -> _PooledConn:
        import logging
        log = logging.getLogger(__name__)
        key = self._key(host, port, username)
        with self._lock:
            entry = self._pool.get(key)
            if entry and self._is_alive(entry, host, port, username):
                entry.last_used = time.monotonic()
                entry.use_count += 1
                self.stats["reuses"] += 1
                self.stats["borrows"] += 1
                log.debug("pool reuse %s use_count=%d", key, entry.use_count)
                return entry

            if entry:
                # Stale entry; close it before opening a new one.
                log.info("pool evict stale %s (transport dead)", key)
                try:
                    entry.client.close()
                except Exception:
                    pass
                self.stats["closes"] += 1
                del self._pool[key]

            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(
                    hostname=host,
                    port=port,
                    username=username,
                    password=password,
                    timeout=timeout,
                    look_for_keys=False,
                    allow_agent=False,
                )
            except Exception:
                # Don't cache a connection we never opened.
                raise
            # Send keepalive every 60s so lab firewalls / idle-timers
            # don't drop the connection mid-job.
            transport = client.get_transport()
            if transport is not None:
                transport.set_keepalive(60)
            entry = _PooledConn(client=client, last_used=time.monotonic(), use_count=1)
            self._pool[key] = entry
            self.stats["opens"] += 1
            self.stats["borrows"] += 1
            log.debug("pool open %s", key)
            return entry

    def release(self, host: str, port: int, username: str) -> None:
        """Mark the connection idle again. Closes only on eviction."""
        import logging
        log = logging.getLogger(__name__)
        key = self._key(host, port, username)
        with self._lock:
            entry = self._pool.get(key)
            if entry:
                entry.last_used = time.monotonic()
                log.debug("pool release %s use_count=%d", key, entry.use_count)
            else:
                log.debug("pool release MISS %s (not in pool)", key)

    def invalidate(self, host: str, port: int, username: str) -> None:
        """Force-close a poisoned connection (next borrow will reopen)."""
        key = self._key(host, port, username)
        with self._lock:
            entry = self._pool.pop(key, None)
            if entry:
                try:
                    entry.client.close()
                except Exception:
                    pass
                self.stats["closes"] += 1

    def close_all(self) -> None:
        self._stop_reaper.set()
        with self._lock:
            for entry in list(self._pool.values()):
                try:
                    entry.client.close()
                except Exception:
                    pass
                self.stats["closes"] += 1
            self._pool.clear()


# Module-level singleton — one worker process, one pool.
_POOL: SSHConnectionPool | None = None
_POOL_INIT_LOCK = threading.Lock()


def get_pool() -> SSHConnectionPool:
    global _POOL
    if _POOL is None:
        with _POOL_INIT_LOCK:
            if _POOL is None:
                _POOL = SSHConnectionPool()
    return _POOL


def _exec_on(
    client: paramiko.SSHClient,
    command: str,
    timeout: int,
    input_text: str | None,
) -> tuple[str, str, int]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if input_text is not None:
        stdin.write(input_text if input_text.endswith("\n") else input_text + "\n")
        stdin.channel.shutdown_write()
    else:
        try:
            del stdin
        except Exception:
            pass
    output = stdout.read().decode("utf-8", errors="replace")
    err_text = stderr.read().decode("utf-8", errors="replace")
    exit_status = stdout.channel.recv_exit_status()
    return output, err_text, exit_status


def _is_resource_shortage(exc: BaseException) -> bool:
    """Return True if `exc` looks like Cisco IOS-XE rejecting an SSH
    channel open because its NETCONF/SSH subsystem is busy.

    Symptom A (verified 2026-09-19 against LAB-F3-AS-02 / 10.10.20.212):
        paramiko.transport: Secsh channel 1 open FAILED: : Resource shortage
        -> paramiko.ChannelException(code, 'Resource shortage') raised from
           client.exec_command()
        -> run_ssh_command surfaces it to the worker as a successful job with
           result.implemented=false and message="ChannelException(...,
           'Resource shortage')". UI then shows "Lab integration unavailable".

    Symptom B (same device, same session, sibling of A):
        stdio.read() raises EOFError mid-read after the device drops the
        channel silently. str(EOFError()) is the empty string, so without
        retry the UI shows the bare "Lab integration unavailable" with no
        description. Same root cause — the IOS-XE 17.x SSH subsystem is
        transiently busy and drops the channel instead of answering.

    Root cause: IOS-XE 17.x shares the SSH subsystem with NETCONF. When the
    device is busy (e.g. another collection cycle is opening channels
    concurrently) the SSH server returns SSH_OPEN_RESOURCE_SHORTAGE on
    `channel open` (A) or simply closes the channel mid-read (B). The
    transport itself is fine — it's a transient device resource event,
    NOT a corrupted connection.

    Action: caller should NOT invalidate the pool entry, just back off and
    retry the channel open. Without this, every concurrent MAC sweep on the
    device loses a noticeable fraction of jobs to a perfectly-recoverable
    error.
    """
    import paramiko

    if isinstance(exc, paramiko.ChannelException):
        text = (getattr(exc, "text", "") or str(exc) or "").lower()
        if "resource shortage" in text or "resource_shortage" in text:
            return True
    if isinstance(exc, EOFError):
        # Empty EOFError mid-channel-read on IOS-XE 17.x = the same device-
        # busy event as Resource shortage. The transport is still healthy,
        # so we retry without invalidating the pool entry.
        return True
    # Fall back to substring match against the str repr — covers older
    # paramiko versions that wrap the ChannelException differently.
    s = str(exc).lower()
    return "resource shortage" in s or "channelexception" in s and "shortage" in s


def run_ssh_command(
    host: str,
    username: str,
    password: str,
    command: str,
    port: int = 22,
    timeout: int = 15,
    input_text: str | None = None,
) -> dict[str, Any]:
    """Run one CLI command on `host`, reusing a pooled connection.

    Returns the same shape as before: `sshOk`, `output`, `error`.
    If the pooled connection's transport has been closed by the server
    (common on Cisco IOS-XE after an exec completes), the pool entry is
    invalidated and a fresh connection is opened and retried transparently.

    Transient `Resource shortage` channel-open failures (Cisco IOS-XE
    NETCONF/SSH subsystem busy) are retried with exponential backoff
    WITHOUT invalidating the pool entry — the transport is still healthy.
    """
    pool = get_pool()
    entry = pool.borrow(host, port, username, password, timeout=timeout)
    # Retry budget for transient device-side resource shortage. Tuned to
    # 3 attempts × (0.3s + 0.6s + 1.2s) = ~2.1s of total wait, which keeps
    # the job within the worker watchdog (45s) while letting the device
    # recover from a brief NETCONF subsystem stall.
    backoff_schedule = (0.3, 0.6, 1.2)
    last_exc: BaseException | None = None
    for attempt in range(1 + len(backoff_schedule)):
        try:
            output, err_text, exit_status = _exec_on(entry.client, command, timeout, input_text)
            pool.release(host, port, username)
            if exit_status != 0:
                return {
                    "sshOk": False,
                    "output": output,
                    "error": err_text.strip() or f"SSH command exited with status {exit_status}",
                }
            return {
                "sshOk": True,
                "output": output if output else err_text,
                "error": None,
            }
        except Exception as exc:  # noqa: BLE001 - lab boundary
            last_exc = exc
            if _is_resource_shortage(exc) and attempt < len(backoff_schedule):
                # Transient — the device is briefly out of SSH channels.
                # Keep the pooled transport alive (it's not the culprit) and
                # try again after a short backoff. Total wait per attempt:
                # backoff_schedule[attempt] seconds (0.3, 0.6, 1.2).
                import logging
                log = logging.getLogger(__name__)
                delay = backoff_schedule[attempt]
                log.warning(
                    "SSH channel open rejected by %s (%s); retrying in %.1fs (attempt %d/%d)",
                    host, exc, delay, attempt + 1, 1 + len(backoff_schedule),
                )
                import time as _time
                _time.sleep(delay)
                continue

            # Non-transient error (or final attempt exhausted). Drop the
            # pool entry — for "Channel closed" / "not active" the transport
            # really is dead; for Resource shortage after retries we still
            # bail out cleanly.
            pool.invalidate(host, port, username)
            import paramiko
            # Retry with a fresh connection when the transport is dead or the
            # session is invalid.  These messages all mean "the underlying SSH
            # transport is gone" — a fresh connect fixes it.
            # - "SSH session not active"     → exec_command on inactive transport
            # - "No existing session"        → auth / channel on inactive transport
            # - "Channel closed"             → channel already closed
            # - "Error reading SSH protocol banner" / "Connection reset by peer"
            #   also indicate a dead transport; catch-all on SSHException covers
            #   those since they all inherit from SSHException.
            if isinstance(exc, paramiko.ssh_exception.SSHException):
                import logging
                log = logging.getLogger(__name__)
                log.debug("SSHException on %s (%s), retrying with fresh connection", host, exc)
                try:
                    fresh_entry = pool.borrow(host, port, username, password, timeout=timeout)
                except Exception as conn_exc:  # noqa: BLE001
                    return {"sshOk": False, "output": "", "error": f"retry connect failed: {conn_exc}"}
                try:
                    output, err_text, exit_status = _exec_on(
                        fresh_entry.client, command, timeout, input_text
                    )
                except Exception as exc2:  # noqa: BLE001
                    pool.invalidate(host, port, username)
                    return {"sshOk": False, "output": "", "error": str(exc2)}
                pool.release(host, port, username)
                if exit_status != 0:
                    return {
                        "sshOk": False,
                        "output": output,
                        "error": err_text.strip() or f"SSH command exited with status {exit_status}",
                    }
                return {"sshOk": True, "output": output if output else err_text}
            # Resource shortage after retries exhausted — return a clear,
            # human-readable message instead of the raw ncclient-style repr.
            if _is_resource_shortage(exc):
                return {
                    "sshOk": False,
                    "output": "",
                    "error": (
                        f"IOS-XE SSH channel open failed: device returned "
                        f"'Resource shortage' after {1 + len(backoff_schedule)} attempts. "
                        f"NETCONF/SSH subsystem busy; retry on the next collection cycle."
                    ),
                }
            return {"sshOk": False, "output": "", "error": str(exc)}

    # All retries exhausted — last_exc is guaranteed set in this branch
    # because the loop runs at least one iteration that only exits via the
    # except path when an exception is raised.
    assert last_exc is not None
    return {"sshOk": False, "output": "", "error": str(last_exc)}


def run_junos_commands(
    host: str,
    username: str,
    password: str,
    port: int = 22,
    timeout: int = 15,
) -> dict[str, Any]:
    """Convenience helper: `show version` + `show configuration | display set` on one session."""
    pool = get_pool()
    entry = pool.borrow(host, port, username, password, timeout=timeout)
    try:
        show_version = _exec_with_retry(entry.client, "show version", timeout)
        show_run = _exec_with_retry(entry.client, "show configuration | display set", timeout)
    except Exception as exc:  # noqa: BLE001 - lab boundary
        pool.invalidate(host, port, username)
        return {"sshOk": False, "showVersion": "", "showRun": "", "error": str(exc)}

    pool.release(host, port, username)
    return {
        "sshOk": True,
        "showVersion": show_version,
        "showRun": show_run,
        "error": None,
    }


def _exec_with_retry(client: paramiko.SSHClient, command: str, timeout: int) -> str:
    """Run one command; if the transport died, surface a clean error."""
    output, err_text, exit_status = _exec_on(client, command, timeout, None)
    if exit_status != 0:
        raise RuntimeError(err_text.strip() or f"exit {exit_status}")
    return output if output else err_text


def run_ssh_commands_session(
    host: str,
    username: str,
    password: str,
    commands: list[str],
    port: int = 22,
    timeout: int = 30,
) -> dict[str, Any]:
    """Send multiple CLI commands through ONE SSH session (single exec channel).

    This is required for IOS-XE configuration commands where ``configure
    terminal`` enters config mode and subsequent commands must run in that
    mode.  Using separate exec_command() calls would create a new SSH session
    for each command, causing the device to exit config mode between calls.

    Uses ``sshpass + ssh -tt`` to open a PTY session and pipe all commands
    through stdin, reading responses after each one.
    """
    import re
    import subprocess

    # Assemble commands with markers between them.
    # We use a unique marker per invocation and echo it to stderr (fd 2)
    # so it is isolated from the command output stream and easy to split.
    marker = f"__MRKR_{id(commands)}__"
    script_parts = []
    for cmd in commands:
        safe_cmd = cmd.replace("'", "'\"'\"'")
        # Echo marker to stderr (fd 2) so it never mixes with command output
        script_parts.append(
            f"echo {marker} >&2; {safe_cmd} 2>&1 | grep -v {marker} || true; echo {marker} >&2"
        )
    script = "; ".join(script_parts)

    try:
        proc = subprocess.run(
            [
                "sshpass", "-p", password,
                "ssh",
                "-o", "StrictHostKeyChecking=no",
                "-o", "ConnectTimeout=10",
                "-o", "PreferredAuthentications=password",
                "-o", "PubkeyAuthentication=no",
                "-tt",                          # force PTY for IOS-XE config mode
                f"{username}@{host}",
                "-p", str(port),
                script,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            errors="replace",
        )
    except FileNotFoundError:
        return {
            "sshOk": False,
            "outputs": [],
            "error": "sshpass not found in PATH",
        }
    except subprocess.TimeoutExpired:
        return {
            "sshOk": False,
            "outputs": [],
            "error": f"SSH session timed out after {timeout}s",
        }

    combined = proc.stdout + proc.stderr

    # If sshpass itself failed (auth refused, banner timeout, host unreachable),
    # returncode will be non-zero even when stdout/stderr are empty. Surface
    # that as a hard error instead of silently treating it as success.
    if proc.returncode != 0 and not combined.strip():
        return {
            "sshOk": False,
            "outputs": [],
            "error": (
                f"SSH exit {proc.returncode} on {host}:{port} "
                f"(no output captured — likely auth/network failure)"
            ),
        }

    # Split output by marker
    parts = re.split(re.escape(marker), combined)
    # parts[0] = anything before first marker, parts[1] = between marker 1&2, etc.
    outputs: list[dict[str, str]] = []
    for i, cmd in enumerate(commands):
        raw = parts[i + 1] if i + 1 < len(parts) else ""
        # Strip control characters and trailing whitespace
        clean = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", raw).strip()
        # Check for IOS error prefix
        is_error = clean.lower().startswith("% ") or "invalid" in clean.lower()
        outputs.append({
            "command": cmd,
            "output": clean,
            "error": clean if is_error else "",
        })

    first_error = next((o for o in outputs if o["error"]), None)

    # Even when sshpass exits 0 and no IOS errors are detected, a session that
    # returns zero bytes of output for every command is almost always a broken
    # pipe (device closed the channel before echoing anything, auth silently
    # failed, or network dropped the response). Treat it as a hard failure so
    # callers like `apply_config` don't report SUCCESS when nothing reached the
    # device.
    all_empty = all(not o["output"] for o in outputs)
    if first_error is None and all_empty and combined.strip():
        # There IS output from the session but no command got anything back —
        # likely a pager eating the response or a config-mode glitch.
        first_error = {"error": "No output from device (possible pager or session glitch)", "command": "", "output": ""}
    elif first_error is None and all_empty and not combined.strip():
        # Session produced zero bytes total — auth/network failure or device
        # closed the channel before the first echo marker.
        first_error = {"error": f"No output captured (sshpass exit {proc.returncode} — check auth/network)", "command": "", "output": ""}

    return {
        "sshOk": first_error is None,
        "outputs": outputs,
        "error": first_error["error"] if first_error else None,
    }


# ---------------------------------------------------------------------------
# NETCONF helpers for Cisco IOS-XE
# ---------------------------------------------------------------------------

_NS_NATIVE = "http://cisco.com/ns/yang/Cisco-IOS-XE-native"
_NS_NC = "urn:ietf:params:xml:ns:netconf:base:1.0"


def _iface_split(name: str) -> tuple[str, str]:
    """Split "GigabitEthernet0/0/1" → ("GigabitEthernet", "0/0/1").

    Falls back to the default YANG list type when the prefix is unknown so
    the YANG path stays valid (defaults to GigabitEthernet, matching the
    bulk of our C8000V / ISR / Cat9k fleet).
    """
    if name.startswith("GigabitEthernet"):
        return "GigabitEthernet", name[len("GigabitEthernet"):].lstrip("/")
    if name.startswith("TenGigabitEthernet"):
        return "TenGigabitEthernet", name[len("TenGigabitEthernet"):].lstrip("/")
    if name.startswith("FastEthernet"):
        return "FastEthernet", name[len("FastEthernet"):].lstrip("/")
    if name.startswith("TwoGigabitEthernet"):
        return "TwoGigabitEthernet", name[len("TwoGigabitEthernet"):].lstrip("/")
    if name.startswith("Loopback"):
        return "Loopback", name[len("Loopback"):].lstrip("/")
    if name.startswith("Port-channel"):
        return "Port-channel", name[len("Port-channel"):].lstrip("/")
    if name.startswith("Vlan"):
        return "Vlan", name[len("Vlan"):].lstrip("/")
    # Default — best-effort split on first digit.
    head = ""
    tail = name
    for i, ch in enumerate(name):
        if ch.isdigit():
            head = name[:i]
            tail = name[i:]
            break
    return (head or "GigabitEthernet"), tail.lstrip("/")


def _build_nc_iface_shutdown(name: str, shutdown: bool) -> str:
    """Return an XML string for a NETCONF <edit-config> RPC to shut/no-shut an interface.

    The RPC targets <running/> and uses a Cisco-IOS-XE-native YANG path.
    """
    iface_type, short_name = _iface_split(name)

    # For NETCONF presence containers (Cisco-style):
    #   merge + <shutdown/>  → shut (add the element)
    #   delete + <shutdown/> → no-shut (remove the element)
    op = "merge" if shutdown else "delete"

    return (
        f'<nc:edit-config xmlns:nc="{_NS_NC}">'
        '<nc:target><nc:running/></nc:target>'
        '<nc:config>'
        f'<native xmlns="{_NS_NATIVE}">'
        f'<interface>'
        f'<{iface_type}>'
        f'<name>{short_name}</name>'
        f'<shutdown nc:operation="{op}"/>'
        f'</{iface_type}>'
        f'</interface>'
        '</native>'
        '</nc:config>'
        '</nc:edit-config>'
    )


def _build_nc_iface_set_access_vlan(name: str, vlan: int) -> str:
    """Return an XML string for a NETCONF <edit-config> that sets an access VLAN.

    Cisco YANG path:
      native/interface/{type}/{name}/switchport/access/vlan

    The YANG model requires <switchport><mode>access</mode></switchport>
    to exist before <access><vlan> is accepted — setting `vlan` on a port
    that isn't in access mode silently no-ops (or hard-errors on newer
    17.x). We set both in one transaction so the port is fully configured
    atomically.
    """
    iface_type, short_name = _iface_split(name)
    return (
        f'<nc:edit-config xmlns:nc="{_NS_NC}">'
        '<nc:target><nc:running/></nc:target>'
        '<nc:config>'
        f'<native xmlns="{_NS_NATIVE}">'
        f'<interface>'
        f'<{iface_type}>'
        f'<name>{short_name}</name>'
        '<switchport>'
        '<mode xmlns:xc="urn:ietf:params:xml:ns:netconf:base:1.0">access</mode>'
        '<access>'
        f'<vlan nc:operation="merge">{vlan}</vlan>'
        '</access>'
        '</switchport>'
        f'</{iface_type}>'
        f'</interface>'
        '</native>'
        '</nc:config>'
        '</nc:edit-config>'
    )


def _build_nc_get_interface_config(name: str) -> str:
    """Return a NETCONF <get-config> filter that pulls the running-config
    subtree for one interface — equivalent to `show running-config
    interface <name>`.
    """
    iface_type, short_name = _iface_split(name)
    return (
        f'<nc:get-config xmlns:nc="{_NS_NC}">'
        '<nc:source><nc:running/></nc:source>'
        '<nc:filter type="subtree">'
        f'<native xmlns="{_NS_NATIVE}">'
        f'<interface>'
        f'<{iface_type}><name>{short_name}</name></{iface_type}>'
        f'</interface>'
        '</native>'
        '</nc:filter>'
        '</nc:get-config>'
    )


def netconf_interface_action(
    host: str,
    username: str,
    password: str,
    iface_name: str,
    action: str,  # "shut" | "no-shut"
    port: int = 830,
    timeout: int = 30,
) -> dict[str, Any]:
    """Shut or unshut an interface via NETCONF on Cisco IOS-XE.

    action "shut"    → adds <shutdown/>  (admin down)
    action "no-shut" → removes <shutdown/> (admin up)
    """
    from lxml import etree
    from ncclient import manager

    if action not in ("shut", "no-shut"):
        return {"ok": False, "error": f"Unknown action: {action}"}

    shutdown = action == "shut"

    # Build the NETCONF edit-config RPC
    config_xml = _build_nc_iface_shutdown(iface_name, shutdown)

    try:
        conn = manager.connect(
            host=host,
            port=port,
            username=username,
            password=password,
            hostkey_verify=False,
            allow_agent=False,
            look_for_keys=False,
            timeout=timeout,
        )
    except Exception as exc:
        return {"ok": False, "error": f"NETCONF connect failed: {exc}"}

    try:
        # Use raw dispatch: send the edit-config as a string so we control
        # the exact XML namespace layout the IOS-XE agent expects.
        rpc = etree.fromstring(config_xml)
        result = conn.dispatch(rpc)

        # result from dispatch() is an RPCReply with .errors and .ok
        errors = getattr(result, "errors", []) or []
        if errors:
            err = errors[0]
            err_tag = getattr(err, "tag", None) or ""
            err_msg = (
                getattr(err, "message", None)
                or getattr(err, "severity", None)
                or str(err)
            )
            # "data-missing" on delete is OK — element didn't exist → already up
            if err_tag == "data-missing" and not shutdown:
                return {
                    "ok": True,
                    "action": action,
                    "interface": iface_name,
                    "adminStatus": "up",
                    "message": f"Interface {iface_name} no-shut via NETCONF OK (was already up)",
                }
            return {"ok": False, "error": f"NETCONF [{err_tag}]: {err_msg}"}

        # .ok == True → <ok/> element present
        if getattr(result, "ok", False):
            admin = "down" if shutdown else "up"
            return {
                "ok": True,
                "action": action,
                "interface": iface_name,
                "adminStatus": admin,
                "message": f"Interface {iface_name} {action} via NETCONF OK",
            }

        # Unexpected — return raw XML
        raw = getattr(result, "xml", None) or str(result)
        return {"ok": False, "error": f"Unexpected NETCONF reply: {raw[:200]}"}

    except Exception as exc:
        return {"ok": False, "error": f"NETCONF error: {exc}"}
    finally:
        try:
            conn.close_session()
        except Exception:
            pass


def netconf_set_description(
    host: str,
    username: str,
    password: str,
    iface_name: str,
    description: str | None,  # None = delete/remove description
    port: int = 830,
    timeout: int = 30,
) -> dict[str, Any]:
    """Set or remove interface description via NETCONF on Cisco IOS-XE.

    description != None → set description via merge
    description == None  → remove description via delete
    """
    from lxml import etree
    from ncclient import manager

    iface_type, short_name = _iface_split(iface_name)

    if description is not None:
        # Escape XML special chars in the description text
        safe_desc = (
            description
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        desc_xml = f"<description>{safe_desc}</description>"
    else:
        desc_xml = '<description nc:operation="delete"/>'

    config_xml = (
        f'<nc:edit-config xmlns:nc="{_NS_NC}">'
        '<nc:target><nc:running/></nc:target>'
        '<nc:config>'
        f'<native xmlns="{_NS_NATIVE}">'
        f'<interface>'
        f'<{iface_type}>'
        f'<name>{short_name}</name>'
        f'{desc_xml}'
        f'</{iface_type}>'
        f'</interface>'
        '</native>'
        '</nc:config>'
        '</nc:edit-config>'
    )

    try:
        conn = manager.connect(
            host=host,
            port=port,
            username=username,
            password=password,
            hostkey_verify=False,
            allow_agent=False,
            look_for_keys=False,
            timeout=timeout,
        )
    except Exception as exc:
        return {"ok": False, "error": f"NETCONF connect failed: {exc}"}

    try:
        rpc = etree.fromstring(config_xml.encode())
        result = conn.dispatch(rpc)

        errors = getattr(result, "errors", []) or []
        if errors:
            err = errors[0]
            err_tag = getattr(err, "tag", None) or ""
            err_msg = (
                getattr(err, "message", None)
                or getattr(err, "severity", None)
                or str(err)
            )
            # "data-missing" on delete = description didn't exist → OK
            if err_tag == "data-missing":
                return {
                    "ok": True,
                    "action": "remove-description",
                    "interface": iface_name,
                    "description": None,
                    "message": f"Interface {iface_name} description already absent",
                }
            return {"ok": False, "error": f"NETCONF [{err_tag}]: {err_msg}"}

        if getattr(result, "ok", False):
            return {
                "ok": True,
                "action": "set-description" if description is not None else "remove-description",
                "interface": iface_name,
                "description": description,
                "message": f"Interface {iface_name} description set via NETCONF OK",
            }

        raw = getattr(result, "xml", None) or str(result)
        return {"ok": False, "error": f"Unexpected NETCONF reply: {raw[:200]}"}

    except Exception as exc:
        return {"ok": False, "error": f"NETCONF error: {exc}"}
    finally:
        try:
            conn.close_session()
        except Exception:
            pass


def netconf_set_access_vlan(
    host: str,
    username: str,
    password: str,
    iface_name: str,
    vlan: int,
    port: int = 830,
    timeout: int = 30,
) -> dict[str, Any]:
    """Set access VLAN on an interface via NETCONF (Cisco IOS-XE).

    Atomic edit-config that sets `<switchport><mode>access</mode></switchport>`
    + `<switchport><access><vlan>X</vlan></access></switchport>` so the port
    ends up in access mode with the requested VLAN in a single transaction.

    Returns:
        {"ok": True, "interface": ..., "vlan": ..., "message": "..."}
        {"ok": False, "error": "..."}
    """
    from lxml import etree
    from ncclient import manager

    config_xml = _build_nc_iface_set_access_vlan(iface_name, vlan)

    try:
        conn = manager.connect(
            host=host,
            port=port,
            username=username,
            password=password,
            hostkey_verify=False,
            allow_agent=False,
            look_for_keys=False,
            timeout=timeout,
        )
    except Exception as exc:
        return {"ok": False, "error": f"NETCONF connect failed: {exc}"}

    try:
        rpc = etree.fromstring(config_xml)
        result = conn.dispatch(rpc)

        errors = getattr(result, "errors", []) or []
        if errors:
            err = errors[0]
            err_tag = getattr(err, "tag", None) or ""
            err_msg = (
                getattr(err, "message", None)
                or getattr(err, "severity", None)
                or str(err)
            )
            return {
                "ok": False,
                "error": f"NETCONF [{err_tag}]: {err_msg}",
                "interface": iface_name,
                "vlan": vlan,
            }

        if getattr(result, "ok", False):
            return {
                "ok": True,
                "interface": iface_name,
                "vlan": vlan,
                "message": f"Access VLAN {vlan} set on {iface_name} via NETCONF",
            }

        raw = getattr(result, "xml", None) or str(result)
        return {
            "ok": False,
            "error": f"Unexpected NETCONF reply: {raw[:200]}",
            "interface": iface_name,
            "vlan": vlan,
        }

    except Exception as exc:
        return {"ok": False, "error": f"NETCONF error: {exc}", "interface": iface_name, "vlan": vlan}
    finally:
        try:
            conn.close_session()
        except Exception:
            pass


# Cisco IOS-XE native YANG → IOS-style "show running-config" text.
# Used by `netconf_get_interface_config` so the frontend modal can show
# the same shape users see in CLI.
#
# This is a best-effort serializer, NOT a faithful round-trip. We only
# cover the leaves the Frontend cares about for show-run on a single
# interface (shutdown, description, ip address, switchport, etc.). Unknown
# leaves fall back to "key value" lines so operators still see something
# useful.
def _ns(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _xml_to_ios_text(elem, indent: int = 0) -> list[str]:
    """Recursively serialize a lxml element into IOS CLI-style lines.

    Conventions:
      - container with only one child text-leaf → emit "key value" on one line
      - leaf with text → "key value"
      - presence container (empty) → "key"
      - special-cased multi-leaf containers (ip-address, channel-group) get
        their sub-leaf collapsed onto the header
      - container with multiple leaves (switchport, spanning-tree) gets a
        section header
    """
    lines: list[str] = []
    pad = " " * indent

    for child in elem:
        tag = _ns(child.tag)
        # Skip YANG metadata siblings (nc:operation, etc.) on the leaf path.
        if tag == "operation":
            continue

        children = list(child)
        text = (child.text or "").strip()

        # Special cases: containers that are really a "header + value" pair.
        if tag == "ip-address":
            # <ip-address><address><primary><address>X</address><mask>Y</mask>
            # → " ip address X Y"
            primary = child.find(".//{%s}primary" % _NS_NATIVE)
            if primary is not None:
                addr = primary.find("{%s}address" % _NS_NATIVE)
                mask = primary.find("{%s}mask" % _NS_NATIVE)
                if addr is not None and mask is not None:
                    lines.append(
                        f"{pad}ip address {(addr.text or '').strip()} "
                        f"{(mask.text or '').strip()}"
                    )
                    continue
            # Fallback — recurse
            lines.extend(_xml_to_ios_text(child, indent))
            continue

        if tag == "channel-group":
            # <channel-group><number>N</number><mode>active</mode></channel-group>
            number = child.find("{%s}number" % _NS_NATIVE)
            mode = child.find("{%s}mode" % _NS_NATIVE)
            n = (number.text or "").strip() if number is not None else ""
            m = (mode.text or "").strip() if mode is not None else ""
            if n and m:
                lines.append(f"{pad}channel-group {n} mode {m}")
                continue

        if tag == "trunk":
            # <trunk><allowed-vlan><vlans>10,20</vlans></allowed-vlan>
            #     <native-vlan><vlan>1</vlan></native-vlan>
            # → " switchport trunk allowed vlan 10,20"
            # → " switchport trunk native vlan 1"
            for sub in child:
                stag = _ns(sub.tag)
                if stag == "allowed-vlan":
                    v = sub.find("{%s}vlans" % _NS_NATIVE)
                    if v is not None:
                        lines.append(
                            f"{pad}switchport trunk allowed vlan "
                            f"{(v.text or '').strip()}"
                        )
                        continue
                if stag == "native-vlan":
                    v = sub.find("{%s}vlan" % _NS_NATIVE)
                    if v is not None:
                        lines.append(
                            f"{pad}switchport trunk native vlan "
                            f"{(v.text or '').strip()}"
                        )
                        continue
            continue

        if tag == "access":
            # <access><vlan>20</vlan></access> → " switchport access vlan 20"
            for sub in child:
                if _ns(sub.tag) == "vlan":
                    lines.append(
                        f"{pad}switchport access vlan {(sub.text or '').strip()}"
                    )
            continue

        if tag == "mode":
            # <mode>access</mode> or <mode>trunk</mode> inside <switchport>
            # → " switchport mode access"
            lines.append(f"{pad}switchport mode {text}")
            continue

        if not children:
            # Plain leaf node.
            if text:
                lines.append(f"{pad}{tag} {text}")
            else:
                # Presence container (e.g. <shutdown/>).
                lines.append(f"{pad}{tag}")
        else:
            # Generic container — recurse one indent deeper.
            sub = _xml_to_ios_text(child, indent)
            if len(children) == 1 and not list(children[0]) and not text:
                # Container with single presence-leaf child → emit "header".
                lines.append(f"{pad}{tag}")
                lines.extend(sub)
            elif tag in ("switchport", "spanning-tree"):
                lines.append(f"{pad}{tag}")
                lines.extend(sub)
            else:
                lines.extend(sub)
    return lines


def _nc_data_to_ios_text(rpc_reply_root) -> str:
    """Walk a ncclient RPCReply / lxml Element tree and emit IOS-style text.

    The root is the <rpc-reply> from a <get-config>; we find every
    <interface>/<{type}> block (there can be more than one if the filter
    returned siblings) and serialize each as its own stanza.
    """
    from lxml import etree

    lines: list[str] = []

    # ncclient may give us an RPCReply object or already an lxml root.
    root = getattr(rpc_reply_root, "data_xml", None) or rpc_reply_root
    if hasattr(root, "getroottree"):
        root = root.getroottree().getroot()
    if isinstance(root, str):
        try:
            root = etree.fromstring(root.encode())
        except Exception:
            return root

    # Find all interface list entries regardless of type prefix.
    ifaces = root.findall(f".//{{{_NS_NATIVE}}}interface")
    for iface_elem in ifaces:
        # There should be a single child per filter (e.g. <GigabitEthernet>);
        # serialize the whole block.
        for type_list in iface_elem:
            tag = _ns(type_list.tag)
            name_leaf = type_list.find(f"{{{_NS_NATIVE}}}name")
            short_name = (name_leaf.text or "").strip() if name_leaf is not None else ""
            full_name = f"{tag}{short_name}"
            lines.append(f"interface {full_name}")
            # Drop the <name> leaf (already rendered as the header).
            inner = etree.fromstring(etree.tostring(type_list))
            for nm in inner.findall(f"{{{_NS_NATIVE}}}name"):
                inner.remove(nm)
            lines.extend(_xml_to_ios_text(inner, indent=1))
            lines.append("end")
            lines.append("")

    if not lines:
        return "(no interface block returned by NETCONF)"
    return "\n".join(lines).rstrip() + "\n"


def netconf_get_interface_config(
    host: str,
    username: str,
    password: str,
    iface_name: str,
    port: int = 830,
    timeout: int = 30,
) -> dict[str, Any]:
    """Fetch the running-config subtree for one interface via NETCONF.

    Equivalent to `show running-config interface <name>` but via the
    structured YANG model. The returned `config` string is serialized
    to IOS-style CLI text so the frontend modal renders identically to
    the SSH-based path.
    """
    from lxml import etree
    from ncclient import manager

    filter_xml = _build_nc_get_interface_config(iface_name)

    try:
        conn = manager.connect(
            host=host,
            port=port,
            username=username,
            password=password,
            hostkey_verify=False,
            allow_agent=False,
            look_for_keys=False,
            timeout=timeout,
        )
    except Exception as exc:
        return {"ok": False, "error": f"NETCONF connect failed: {exc}"}

    try:
        rpc = etree.fromstring(filter_xml)
        result = conn.dispatch(rpc)

        errors = getattr(result, "errors", []) or []
        if errors:
            err = errors[0]
            err_tag = getattr(err, "tag", None) or ""
            err_msg = (
                getattr(err, "message", None)
                or getattr(err, "severity", None)
                or str(err)
            )
            return {
                "ok": False,
                "error": f"NETCONF [{err_tag}]: {err_msg}",
                "interface": iface_name,
            }

        config_text = _nc_data_to_ios_text(result)
        return {
            "ok": True,
            "interface": iface_name,
            "config": config_text,
            "message": f"Pulled config for {iface_name} via NETCONF",
        }

    except Exception as exc:
        return {"ok": False, "error": f"NETCONF error: {exc}", "interface": iface_name}
    finally:
        try:
            conn.close_session()
        except Exception:
            pass

