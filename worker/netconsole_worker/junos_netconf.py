"""Juniper Junos NETCONF-over-SSH via the OpenSSH CLI.

This module is an alternative to junos_rest.py for apply_config / rollback /
interface_action on Juniper devices.  It opens a persistent SSH NETCONF
session using ``sshpass + ssh -s netconf`` (bypassing paramiko which is broken
on OpenSSH 10 / Windows — see gotcha #4) and sends batched XML RPCs.

Key differences from RESTCONF (junos_rest.py):

  - No HTTP layer — direct TCP to port 830.
  - Persistent SSH channel: one TCP+TLS handshake per apply-rollback pair,
    vs. two HTTP POSTs for RESTCONF.
  - NETCONF <edit-config> or <load-configuration format="set"> work identically
    to the RESTCONF load RPC; the Junos daemon processes them the same way.
  - Requires ``netconf`` subsystem to be advertised in the device hello.
  - Falls back to RESTCONF if NETCONF SSH fails.

The RPC exchange uses RFC 4741 framing: each message is terminated by the
``]]>]]>`` sentinel.  The hello exchange is done once per session; subsequent
calls reuse the same subprocess.Popen channel.
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

#: NETCONF message terminator (RFC 4741 §4.1).
_NC_END = "]]>]]>"

#: Junos NETCONF namespace.
_NS_JUNOS = "http://xml.juniper.net/junos/*/junos"
_NS_NC = "urn:ietf:params:xml:ns:netconf:base:1.0"


# ---------------------------------------------------------------------------
# Pool
# ---------------------------------------------------------------------------


@dataclass
class _PooledNC:
    """One persistent NETCONF-over-SSH subprocess."""

    proc: subprocess.Popen[str, str]
    started_at: float = field(default_factory=time.monotonic)
    use_count: int = 0
    last_used: float = field(default_factory=time.monotonic)


class JunosNETCONFPool:
    """Thread-safe subprocess pool keyed by (host, port, username).

    Keeps one long-lived ``ssh -s netconf`` process per device so multiple
    RPCs (load + commit, or load + commit + rollback) share a single
    TCP+TLS handshake.  A background reaper evicts entries idle for more
    than ``idle_seconds`` (default 10 min) to keep the pool bounded.
    """

    def __init__(
        self,
        idle_seconds: float = 600.0,
        reap_interval: float = 60.0,
        connect_timeout: float = 10.0,
    ) -> None:
        self._lock = threading.Lock()
        self._pool: dict[tuple[str, int, str], _PooledNC] = {}
        self._idle_seconds = idle_seconds
        self._reap_interval = reap_interval
        self._connect_timeout = connect_timeout
        self._stop_reaper = threading.Event()
        self._reaper = threading.Thread(
            target=self._reap_loop, daemon=True, name="nc-pool-reaper"
        )
        self._reaper.start()
        self.stats = {
            "borrows": 0,
            "opens": 0,
            "reuses": 0,
            "closes": 0,
            "evictions": 0,
        }

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
                            entry.proc.terminate()
                            entry.proc.wait(timeout=5)
                        except Exception:
                            pass
                        del self._pool[key]
                        self.stats["evictions"] += 1
                        self.stats["closes"] += 1

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _build_hello() -> str:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">'
            "<capabilities>"
            "<capability>urn:ietf:params:netconf:base:1.1</capability>"
            "<capability>urn:ietf:params:netconf:base:1.0</capability>"
            "<capability>http://xml.juniper.net/netconf/junos/1.0</capability>"
            "</capabilities>"
            "</hello>"
        )

    @staticmethod
    def _send_rpc(proc: subprocess.Popen, rpc: str) -> str:
        """Send one RPC and return the raw response string."""
        msg = f"{rpc}{_NC_END}\n"
        proc.stdin.write(msg)
        proc.stdin.flush()
        return JunosNETCONFPool._read_reply(proc)

    @staticmethod
    def _read_reply(proc: subprocess.Popen[str, str]) -> str:
        """Read until the ``]]>]]>`` terminator.

        Uses a single ``select()`` loop so it works with both blocking and
        non-blocking stdin/stdout (PIPE mode).
        """
        import select as _select

        buf = ""
        while True:
            ready, _, _ = _select.select([proc.stdout], [], [], 60)
            if not ready:
                raise TimeoutError("NETCONF read timeout (> 60s)")
            chunk = proc.stdout.read(4096)
            if not chunk:
                raise EOFError("NETCONF SSH process closed stdout")
            buf += chunk
            if _NC_END in buf:
                break
        return buf.split(_NC_END, 1)[0].strip()

    @staticmethod
    def _parse_ok_error(raw: str) -> tuple[bool, str]:
        """Return (ok, error_message_or_empty)."""
        raw_lower = raw.lower()
        if "<ok" in raw_lower or "<rpc-ok" in raw_lower:
            return True, ""
        # Extract <error-message> or <xnm:error-message>
        m = re.search(
            r"<(?:[\w.-]+:)?error-message(?:\s[^>]*)?>([^<]*)</(?:[\w.-]+:)?error-message>",
            raw,
            re.IGNORECASE,
        )
        if m:
            return False, m.group(1).strip()
        m = re.search(
            r"<(?:[\w.-]+:)?message(?:\s[^>]*)?>([^<]*)</(?:[\w.-]+:)?message>",
            raw,
            re.IGNORECASE,
        )
        if m:
            return False, m.group(1).strip()
        # RPC error tag
        m = re.search(
            r"<(?:[\w.-]+:)?rpc-error(?:\s[^>]*)?>.*?<(?:[\w.-]+:)?error-tag(?:\s[^>]*)?>([^<]*)</(?:[\w.-]+:)?error-tag>",
            raw,
            re.IGNORECASE | re.DOTALL,
        )
        if m:
            return False, f"[{m.group(1).strip()}]"
        if "<error" in raw_lower:
            return False, raw[:300]
        return False, "Unknown NETCONF error"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def borrow(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        timeout: float = 90.0,
    ) -> _PooledNC:
        key = (host, port, username)
        with self._lock:
            entry = self._pool.get(key)
            if entry is not None:
                # Quick alive check: send a <get-system-information> RPC.
                try:
                    test_rpc = '<?xml version="1.0"?><rpc><get-system-information/></rpc>'
                    _ = self._send_rpc(entry.proc, test_rpc)
                    entry.use_count += 1
                    entry.last_used = time.monotonic()
                    self.stats["borrows"] += 1
                    self.stats["reuses"] += 1
                    return entry
                except Exception as exc:
                    logger.debug("nc-pool alive check failed %s: %s", key, exc)
                    try:
                        entry.proc.terminate()
                        entry.proc.wait(timeout=5)
                    except Exception:
                        pass
                    self.stats["closes"] += 1
                    del self._pool[key]

            # Open a new NETCONF-over-SSH session.
            cmd = [
                "sshpass", "-p", password,
                "ssh",
                "-o", "StrictHostKeyChecking=no",
                "-o", f"ConnectTimeout={int(self._connect_timeout)}",
                "-o", "PreferredAuthentications=password",
                "-o", "PubkeyAuthentication=no",
                "-o", "BatchMode=no",
                "-s",                          # invoke subsystem
                f"{username}@{host}",
                "-p", str(port),
                "netconf",                     # subsystem name
            ]
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    errors="replace",
                )
            except FileNotFoundError as exc:
                raise RuntimeError(
                    "sshpass not found in PATH — install openssh-client + sshpass"
                ) from exc

            # Exchange hello: send ours, read device's.
            hello = self._build_hello()
            try:
                _ = self._send_rpc(proc, hello)
            except Exception as exc:
                proc.terminate()
                proc.wait(timeout=5)
                raise RuntimeError(f"NETCONF SSH hello exchange failed: {exc}") from exc

            entry = _PooledNC(proc=proc, last_used=time.monotonic(), use_count=1)
            self._pool[key] = entry
            self.stats["borrows"] += 1
            self.stats["opens"] += 1
            logger.debug("nc-pool open %s", key)
            return entry

    def invalidate(self, host: str, port: int, username: str) -> None:
        key = (host, port, username)
        with self._lock:
            entry = self._pool.pop(key, None)
            if entry is not None:
                try:
                    entry.proc.terminate()
                    entry.proc.wait(timeout=5)
                except Exception:
                    pass
                self.stats["closes"] += 1
                self.stats["evictions"] += 1

    def close(self) -> None:
        self._stop_reaper.set()
        with self._lock:
            for entry in self._pool.values():
                try:
                    entry.proc.terminate()
                    entry.proc.wait(timeout=5)
                except Exception:
                    pass
            self._pool.clear()


# Module-level singleton pool.
_POOL: JunosNETCONFPool | None = None
_POOL_LOCK = threading.Lock()


def get_nc_pool() -> JunosNETCONFPool:
    global _POOL
    if _POOL is None:
        with _POOL_LOCK:
            if _POOL is None:
                _POOL = JunosNETCONFPool()
    return _POOL


# ---------------------------------------------------------------------------
# Core NETCONF RPC helpers
# ---------------------------------------------------------------------------


def _load_config_via_netconf(
    proc: subprocess.Popen,
    commands: list[str],
) -> tuple[bool, str, int]:
    """Send <load-configuration format="set"> and return (ok, raw, load_ms)."""
    import time as _t
    from xml.sax.saxutils import escape

    started = _t.perf_counter()
    set_text = "\n".join(commands).rstrip("\n")
    rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rpc>'
        '<load-configuration format="set">'
        f'<configuration-set>{escape(set_text)}</configuration-set>'
        "</load-configuration>"
        "</rpc>"
    )
    raw = JunosNETCONFPool._send_rpc(proc, rpc)
    ms = int((_t.perf_counter() - started) * 1000)
    ok, _ = JunosNETCONFPool._parse_ok_error(raw)
    # <ok/> means load succeeded (no parse errors). Junos doesn't return
    # <load-success/> over NETCONF — the absence of <error> is success.
    return ok, raw, ms


def _commit_via_netconf(
    proc: subprocess.Popen,
) -> tuple[bool, str, int]:
    """Send <commit-configuration> and return (ok, raw, commit_ms)."""
    import time as _t

    started = _t.perf_counter()
    rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><commit-configuration/></rpc>'
    raw = JunosNETCONFPool._send_rpc(proc, rpc)
    ms = int((_t.perf_counter() - started) * 1000)
    # Look specifically for <commit-success> or <ok> — Junos may return
    # either depending on version.
    raw_lower = raw.lower()
    ok = (
        "<commit-success" in raw_lower
        or "<commit-success" in raw
        or "<ok" in raw_lower
    )
    return ok, raw, ms


def apply_set_configuration(
    host: str,
    commands: list[str],
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 90.0,
    log: str = "NetConsole NETCONF SSH apply",
) -> dict[str, Any]:
    """Load + commit a set of Junos CLI commands via NETCONF-over-SSH.

    Returns the same shape as ``junos_rest.apply_set_configuration`` so
    the caller (JuniperBackend.apply_config) can use either interchangeably.
    """
    _ = log

    pool = get_nc_pool()

    try:
        entry = pool.borrow(host, port, username, password, timeout=timeout)
    except Exception as exc:
        return {
            "ok": False,
            "stage": "connect",
            "error": f"NETCONF SSH connect failed: {exc}",
            "raw": "",
            "loadMs": 0,
            "commitMs": 0,
        }

    proc = entry.proc

    # --- Load ---
    load_ok, load_raw, load_ms = _load_config_via_netconf(proc, commands)
    if not load_ok:
        err_msg = load_raw[:300] if load_raw else "load-configuration failed"
        return {
            "ok": False,
            "stage": "load",
            "error": err_msg,
            "raw": load_raw or "",
            "loadMs": load_ms,
            "commitMs": 0,
        }

    # --- Commit ---
    commit_ok, commit_raw, commit_ms = _commit_via_netconf(proc)
    if not commit_ok:
        # Best-effort discard so next job starts clean.
        discard_rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><discard-changes/></rpc>'
        try:
            JunosNETCONFPool._send_rpc(proc, discard_rpc)
        except Exception:
            pass
        return {
            "ok": False,
            "stage": "commit",
            "error": commit_raw[:300] if commit_raw else "commit-configuration failed",
            "raw": f"{load_raw}\n{commit_raw}",
            "loadMs": load_ms,
            "commitMs": commit_ms,
        }

    return {
        "ok": True,
        "stage": "commit",
        "error": None,
        "raw": f"{load_raw}\n{commit_raw}",
        "loadMs": load_ms,
        "commitMs": commit_ms,
    }


def rollback_configuration(
    host: str,
    *,
    rollback: int = 1,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 90.0,
) -> dict[str, Any]:
    """Rollback Junos config to a previous revision via NETCONF-over-SSH."""
    pool = get_nc_pool()
    try:
        entry = pool.borrow(host, port, username, password, timeout=timeout)
    except Exception as exc:
        return {
            "ok": False,
            "stage": "connect",
            "error": f"NETCONF SSH connect failed: {exc}",
            "raw": "",
        }

    proc = entry.proc
    index = max(0, min(int(rollback), 49))
    load_rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<rpc><load-configuration><rollback>{index}</rollback></load-configuration></rpc>"
    )
    load_raw = JunosNETCONFPool._send_rpc(proc, load_rpc)
    load_ok, _ = JunosNETCONFPool._parse_ok_error(load_raw)
    if not load_ok:
        return {
            "ok": False,
            "stage": "load",
            "error": load_raw[:300] if load_raw else "rollback load failed",
            "raw": load_raw or "",
        }

    commit_ok, commit_raw, _ = _commit_via_netconf(proc)
    if not commit_ok:
        discard_rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><discard-changes/></rpc>'
        try:
            JunosNETCONFPool._send_rpc(proc, discard_rpc)
        except Exception:
            pass
        return {
            "ok": False,
            "stage": "commit",
            "error": commit_raw[:300] if commit_raw else "rollback commit failed",
            "raw": f"{load_raw}\n{commit_raw}",
        }

    return {
        "ok": True,
        "stage": "commit",
        "error": None,
        "raw": f"{load_raw}\n{commit_raw}",
    }
