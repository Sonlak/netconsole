"""Offline test: SSH pool thread-safety and stats accounting.

Run from worker/ directory:
    python test_ssh_pool.py
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

from netconsole_worker.ssh_client import SSHConnectionPool


def test_stats_initial_state() -> None:
    pool = SSHConnectionPool(idle_seconds=60)
    assert pool.stats == {"borrows": 0, "opens": 0, "reuses": 0, "closes": 0, "evictions": 0}
    pool._stop_reaper.set()
    print("test_stats_initial_state: PASS")


def test_reaper_thread_is_daemon() -> None:
    pool = SSHConnectionPool(idle_seconds=0.5, reap_interval=0.05)
    assert pool._reaper.daemon is True
    assert pool._reaper.is_alive()
    pool._stop_reaper.set()
    print("test_reaper_thread_is_daemon: PASS")


def test_reuse_same_key() -> None:
    """Two borrows of the same key with a live transport should reuse."""
    pool = SSHConnectionPool(idle_seconds=60, reap_interval=10.0)

    fake_client = MagicMock()
    fake_transport = MagicMock()
    fake_transport.is_active.return_value = True
    fake_client.get_transport.return_value = fake_transport
    fake_client.close = MagicMock()

    with patch("paramiko.SSHClient") as MockSSH:
        MockSSH.return_value = fake_client
        conn1 = pool.borrow("1.2.3.4", 22, "u", "p", timeout=1)
        pool.release("1.2.3.4", 22, "u")
        conn2 = pool.borrow("1.2.3.4", 22, "u", "p", timeout=1)

    assert conn1 is conn2, "Same key should return same connection object"
    assert pool.stats["reuses"] == 1, f"Expected 1 reuse, got {pool.stats['reuses']}"
    assert pool.stats["opens"] == 1, f"Expected 1 open, got {pool.stats['opens']}"
    pool._stop_reaper.set()
    pool.close_all()
    print("test_reuse_same_key: PASS")


def test_different_key_opens_separate() -> None:
    pool = SSHConnectionPool(idle_seconds=60, reap_interval=10.0)
    fake_client1 = MagicMock()
    fake_client2 = MagicMock()
    for c in [fake_client1, fake_client2]:
        t = MagicMock()
        t.is_active.return_value = True
        c.get_transport.return_value = t
        c.close = MagicMock()

    with patch("paramiko.SSHClient") as MockSSH:
        MockSSH.side_effect = [fake_client1, fake_client2]
        conn1 = pool.borrow("1.2.3.4", 22, "u", "p", timeout=1)
        conn2 = pool.borrow("5.6.7.8", 22, "u", "p", timeout=1)

    assert conn1 is not conn2
    assert pool.stats["opens"] == 2
    assert pool.stats["reuses"] == 0
    pool._stop_reaper.set()
    pool.close_all()
    print("test_different_key_opens_separate: PASS")


def test_invalidate() -> None:
    pool = SSHConnectionPool(idle_seconds=60, reap_interval=10.0)
    fake_client = MagicMock()
    t = MagicMock()
    t.is_active.return_value = True
    fake_client.get_transport.return_value = t
    fake_client.close = MagicMock()

    with patch("paramiko.SSHClient") as MockSSH:
        MockSSH.return_value = fake_client
        _ = pool.borrow("1.2.3.4", 22, "u", "p", timeout=1)

    pool.invalidate("1.2.3.4", 22, "u")
    assert pool.stats["closes"] == 1
    assert ("1.2.3.4", 22, "u") not in pool._pool

    # Next borrow should open a new connection
    with patch("paramiko.SSHClient") as MockSSH:
        MockSSH.return_value = fake_client
        _ = pool.borrow("1.2.3.4", 22, "u", "p", timeout=1)

    assert pool.stats["opens"] == 2
    pool._stop_reaper.set()
    pool.close_all()
    print("test_invalidate: PASS")


def test_lock_contention() -> None:
    """Smoke-test: 100 threads calling borrow/invalidate/release concurrently."""
    pool = SSHConnectionPool(idle_seconds=60, reap_interval=10.0)
    errors: list[BaseException] = []

    fake_clients: dict[str, MagicMock] = {}
    for i in range(5):
        c = MagicMock()
        t = MagicMock()
        t.is_active.return_value = True
        c.get_transport.return_value = t
        c.close = MagicMock()
        fake_clients[f"10.0.0.{i}"] = c

    call_count = [0]

    def make_mock():
        c = MagicMock()
        t = MagicMock()
        t.is_active.return_value = True
        c.get_transport.return_value = t
        c.close = MagicMock()
        return c

    def worker(i: int) -> None:
        try:
            host = f"10.0.0.{i % 5}"
            with patch("paramiko.SSHClient") as MockSSH:
                with pool._lock:
                    call_count[0] += 1
                    MockSSH.return_value = make_mock()
                pool.borrow(host, 22, "u", "p", timeout=1)
                pool.release(host, 22, "u")
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(100)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert not errors, f"thread errors: {errors}"
    assert pool.stats["borrows"] == 100
    pool._stop_reaper.set()
    print("test_lock_contention: PASS")


if __name__ == "__main__":
    test_stats_initial_state()
    test_reaper_thread_is_daemon()
    test_reuse_same_key()
    test_different_key_opens_separate()
    test_invalidate()
    test_lock_contention()
    print("all tests PASS")
