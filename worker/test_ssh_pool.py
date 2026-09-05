"""Offline test: SSH pool thread-safety and stats accounting.

Run from worker/ directory:
    python test_ssh_pool.py
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from netconsole_worker.ssh_client import SSHConnectionPool


def test_idle_eviction() -> None:
    pool = SSHConnectionPool(idle_seconds=0.5)

    class _FakeClient:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

        def get_transport(self):  # noqa: ANN101 - test stub
            class _T:
                def is_active(self) -> bool:
                    return True

            return _T()

    entry_client = _FakeClient()
    pool._pool[("1.2.3.4", 22, "u")] = type("_E", (), {"client": entry_client, "last_used": time.monotonic() - 5, "use_count": 1})()
    pool._evict_idle(time.monotonic())
    assert entry_client.closed, "Idle connection should be closed on eviction"
    assert pool.stats["evictions"] == 1
    assert pool.stats["closes"] == 1
    print("test_idle_eviction: PASS")


def test_stats_monotonic() -> None:
    pool = SSHConnectionPool(idle_seconds=60)
    initial = dict(pool.stats)
    assert initial == {"borrows": 0, "opens": 0, "reuses": 0, "closes": 0, "evictions": 0}
    print("test_stats_monotonic: PASS")


def test_lock_contention() -> None:
    """Smoke-test: 100 threads calling borrow/invalidate/release shouldn't deadlock."""
    pool = SSHConnectionPool(idle_seconds=60)
    barrier = threading.Barrier(100)
    errors: list[BaseException] = []

    def worker(i: int) -> None:
        try:
            barrier.wait(timeout=5)
            key = (f"10.0.0.{i % 5}", 22, "u")
            with pool._lock:
                pool._pool.setdefault(key, None)
            pool.stats["borrows"] += 1
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(100)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert not errors, f"thread errors: {errors}"
    assert pool.stats["borrows"] == 100
    print("test_lock_contention: PASS")


if __name__ == "__main__":
    test_idle_eviction()
    test_stats_monotonic()
    test_lock_contention()
    print("all tests PASS")
