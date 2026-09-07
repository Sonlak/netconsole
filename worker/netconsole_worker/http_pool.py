"""Vendor-agnostic httpx.Client pool.

`junos_rest.JunosRESTPool` is the existing implementation; new vendors
(EOS / IOS-XE / NX-OS) use this module instead of forking the same
pool into 3 more files. Future cleanup can collapse both into one
class — for now they coexist.

Key shape: `(host, port, username, scheme)` — matches the existing
JunosRESTPool so logging and stats surface look the same.
"""

from __future__ import annotations

import atexit
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _quiet_close(client: httpx.Client) -> None:
    try:
        client.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("httpx.Client close failed: %s", exc)


@dataclass
class _Pooled:
    client: httpx.Client
    created_at: float = field(default_factory=time.monotonic)
    use_count: int = 0
    last_used: float = field(default_factory=time.monotonic)


class HttpxPool:
    """One httpx.Client per (host, port, username, scheme).

    Borrow returns a client suitable for either `requests`-style calls
    (`httpx` shares the API surface) or `.get()/.post()` directly.
    A background reaper evicts connections idle for `idle_seconds`.
    """

    def __init__(
        self,
        idle_seconds: float = 600.0,
        reap_interval: float = 60.0,
        connect_timeout: float = 5.0,
    ) -> None:
        self._lock = threading.Lock()
        self._pool: dict[tuple[str, int, str, str], _Pooled] = {}
        self._idle_seconds = idle_seconds
        self._reap_interval = reap_interval
        self._connect_timeout = connect_timeout
        self._stop_reaper = threading.Event()
        self._reaper = threading.Thread(
            target=self._reap_loop, daemon=True, name="httpx-pool-reaper"
        )
        self._reaper.start()
        self.stats = {"borrows": 0, "opens": 0, "reuses": 0, "closes": 0, "evictions": 0}

    def _reap_loop(self) -> None:
        while not self._stop_reaper.wait(self._reap_interval):
            now = time.monotonic()
            with self._lock:
                for key, entry in list(self._pool.items()):
                    if now - entry.last_used > self._idle_seconds:
                        _quiet_close(entry.client)
                        del self._pool[key]
                        self.stats["evictions"] += 1
                        self.stats["closes"] += 1

    def _key(
        self, host: str, port: int, username: str, scheme: str
    ) -> tuple[str, int, str, str]:
        return (host, int(port), username, scheme)

    def borrow(
        self,
        *,
        host: str,
        port: int,
        username: str,
        password: str,
        scheme: str,
        verify_tls: bool,
        timeout: float = 45.0,
    ) -> httpx.Client:
        key = self._key(host, port, username, scheme)
        with self._lock:
            entry = self._pool.get(key)
            if entry is not None:
                entry.use_count += 1
                entry.last_used = time.monotonic()
                self.stats["borrows"] += 1
                self.stats["reuses"] += 1
                return entry.client

            client = httpx.Client(
                auth=(username, password),
                verify=verify_tls,
                timeout=httpx.Timeout(timeout, connect=self._connect_timeout),
            )
            entry = _Pooled(client=client)
            self._pool[key] = entry
            entry.use_count = 1
            entry.last_used = time.monotonic()
            self.stats["borrows"] += 1
            self.stats["opens"] += 1
            return client

    def invalidate(
        self, *, host: str, port: int, username: str, scheme: str
    ) -> None:
        key = self._key(host, port, username, scheme)
        with self._lock:
            entry = self._pool.pop(key, None)
            if entry is not None:
                _quiet_close(entry.client)
                self.stats["closes"] += 1

    def close(self) -> None:
        self._stop_reaper.set()
        with self._lock:
            for entry in self._pool.values():
                _quiet_close(entry.client)
            self._pool.clear()


# Module-level singleton — one process, one pool.
_POOL: HttpxPool | None = None
_LOCK = threading.Lock()


def get_http_pool() -> HttpxPool:
    global _POOL
    if _POOL is None:
        with _LOCK:
            if _POOL is None:
                _POOL = HttpxPool()
                atexit.register(_POOL.close)
    return _POOL


# ---------- helpers ----------------------------------------------------------


def _post_json(
    client: httpx.Client,
    *,
    path: str,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    """POST `payload` as JSON; convenience for the per-vendor backends."""
    return client.post(path, json=payload, headers=headers or {})


def _get_json(client: httpx.Client, *, path: str, headers: dict[str, str] | None = None) -> httpx.Response:
    return client.get(path, headers=headers or {})
