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

        `transport.is_active()` only checks the paramiko-level socket —
        it can return True while the underlying TCP is half-open. We do
        one cheap exec to make sure end-to-end is alive before reusing
        the connection. That round-trip is negligible compared to a
        fresh TCP+SSH handshake (~200ms+).
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
        try:
            # Junos shell uses CLI commands (no /bin/false or /bin/true).
            # Use a no-op RPC instead: "show version brief | count" — this
            # returns within ms and confirms the channel is alive.
            stdin, stdout, stderr = client.exec_command("show version | match /./", timeout=3)
            try:
                stdin.close()
            except Exception:
                pass
            data = stdout.read().decode("utf-8", errors="replace")
            stderr_data = stderr.read().decode("utf-8", errors="replace")
            exit_status = stdout.channel.recv_exit_status()
            log.debug(
                "alive check %s: exit=%d out=%r err=%r",
                (host, port, username),
                exit_status,
                data[:60],
                stderr_data[:60],
            )
            return exit_status == 0 and bool(data.strip())
        except Exception as e:
            log.debug("alive check fail %s: %s", (host, port, username), e)
            return False

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
    """
    pool = get_pool()
    entry = pool.borrow(host, port, username, password, timeout=timeout)
    try:
        output, err_text, exit_status = _exec_on(entry.client, command, timeout, input_text)
    except Exception as exc:  # noqa: BLE001 - lab boundary
        # ALWAYS drop the poisoned pooled entry, then decide whether to retry
        # on a brand-new connection. Without this, a half-dead transport
        # would block every subsequent job on the same (host, port, user).
        pool.invalidate(host, port, username)
        import paramiko
        if isinstance(exc, paramiko.ssh_exception.SSHException) and (
            "not active" in str(exc) or "Channel closed" in str(exc)
        ):
            import logging
            log = logging.getLogger(__name__)
            log.debug("transport died on %s, retrying with fresh connection", host)
            # pool.borrow opens a new connection if needed; wrap in try so a
            # second connect failure returns a clear error instead of leaking
            # the AttributeError we used to get from a missing _create_conn.
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
        return {"sshOk": False, "output": "", "error": str(exc)}

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
    return {
        "sshOk": first_error is None,
        "outputs": outputs,
        "error": first_error["error"] if first_error else None,
    }


def run_junos_apply_over_ssh(
    host: str,
    username: str,
    password: str,
    commands: list[str],
    *,
    port: int = 22,
    timeout: int = 90,
) -> dict[str, Any]:
    """Apply a Junos `set` config via an interactive SSH shell session.

    Why this exists: the previous code path used ``run_ssh_command`` with
    ``command="configure exclusive; " + " ; ".join(commands) + "; commit and-quit"``
    on a non-interactive exec channel. On Junos cRPD that produced
    ``error: syntax error, expecting <command>: <verb>`` for every line and
    finally ``error: unknown command: commit`` because the csh-style parser
    on a non-TTY exec channel doesn't accept ``;`` between ``set`` stanzas
    the way an interactive shell does.

    The fix: open a PTY shell (``invoke_shell``), send each line as if
    typed at the prompt (separated by ``\n``), and wait for the ``>`` or
    ``#`` prompt between commands. The session stays in ``configure
    exclusive`` until ``commit and-quit`` exits config mode.
    """
    import re
    import time as _time

    pool = get_pool()
    entry = pool.borrow(host, port, username, password, timeout=timeout)
    client = entry.client
    output_lines: list[str] = []
    try:
        shell = client.invoke_shell(term="vt100", width=512, height=512)
        shell.settimeout(15)

        def _read_until_prompt(deadline_s: float) -> str:
            """Read shell bytes until we see a Junos prompt or deadline.

            Junos shell uses one of three trailing chars on its prompt:
            ``>`` for operational mode, ``#`` for configure/edit mode,
            ``%`` for the error sub-mode. We look for that char immediately
            followed by a newline (so we don't trip on ``>`` inside an
            echoed description string). The ``[edit]`` banner is also
            emitted on entering configure mode, so we accept that as a
            legitimate non-final signal and keep reading.
            """
            buf = ""
            while _time.time() < deadline_s:
                if shell.recv_ready():
                    chunk = shell.recv(65535).decode("utf-8", errors="replace")
                    buf += chunk
                    stripped = buf.rstrip()
                    if not stripped:
                        continue
                    # Final chars on a Junos prompt line: >, #, %.
                    if len(stripped) >= 2 and stripped[-2] in "> #%" and stripped[-1] == " ":
                        return buf
                    if stripped.endswith("[edit]"):
                        # Mid-banner, keep draining.
                        continue
                else:
                    _time.sleep(0.1)
            return buf

        def _send(line: str) -> str:
            shell.send(line + "\n")
            # Per-line budget. Most lines return in <1s; the commit
            # itself can spike 20-30s on cRPD cold start. Give each
            # line 30s; the outer `timeout` is enforced separately by
            # paramiko on the borrowed connection.
            return _read_until_prompt(_time.time() + 30)

        # Drain the initial banner so we don't mistake it for a prompt.
        _time.sleep(0.3)
        if shell.recv_ready():
            output_lines.append(shell.recv(65535).decode("utf-8", errors="replace"))

        # Enter exclusive config mode first so the candidate DB is locked.
        output_lines.append(_send("configure exclusive"))

        # Send each set/delete line on its own line.
        for cmd in commands:
            output_lines.append(_send(cmd))

        # Commit and exit config mode.
        commit_out = _send("commit and-quit")
        output_lines.append(commit_out)

        shell.close()
    except Exception as exc:  # noqa: BLE001 - lab boundary
        pool.invalidate(host, port, username)
        return {
            "sshOk": False,
            "output": "\n".join(output_lines),
            "error": str(exc),
        }

    full_output = "\n".join(output_lines)
    # Strip ANSI escape sequences for error scanning.
    clean = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", full_output).lower()
    has_error = (
        "error:" in clean
        or "\n% " in clean
        or clean.rstrip().endswith("%")
    )
    return {
        "sshOk": not has_error,
        "output": full_output,
        "error": (full_output.strip() if has_error else None),
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

