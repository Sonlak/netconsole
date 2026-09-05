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

    def _is_alive(self, conn: _PooledConn) -> bool:
        """Return False if the cached connection has been torn down.

        A previously-open transport whose channel is closed means the
        device closed the session (idle-timeout, reboot, etc.) and any
        further `exec_command` would raise EOFError.
        """
        client = conn.client
        transport = client.get_transport() if hasattr(client, "get_transport") else None
        if transport is None:
            return False
        if not transport.is_active():
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
            if entry and self._is_alive(entry):
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
        key = self._key(host, port, username)
        with self._lock:
            entry = self._pool.get(key)
            if entry:
                entry.last_used = time.monotonic()

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


def _exec_on(client: paramiko.SSHClient, command: str, timeout: int, input_text: str | None) -> tuple[str, str, int]:
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
    On any auth/transport error the pooled connection is invalidated
    so the NEXT call opens a fresh one.
    """
    pool = get_pool()
    entry = pool.borrow(host, port, username, password, timeout=timeout)
    try:
        output, err_text, exit_status = _exec_on(entry.client, command, timeout, input_text)
    except Exception as exc:  # noqa: BLE001 - lab boundary
        pool.invalidate(host, port, username)
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
