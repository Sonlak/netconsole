"""Tests for SSH kex/algorithm auto-fallback in SSHConnectionPool.borrow().

The fallback exists for legacy devices (Cisco IOSv 15.x, old Junos, etc.)
that only offer SSH primitives modern paramiko 5.x disables by default
(diffie-hellman-group1-sha1 kex, 3des-cbc cipher, ssh-rsa host key, etc.).

Strategy:
  1. First connect() with secure defaults
  2. On `SSHException` with "kex" / "no matching cipher" / "no matching
     key" / "incompatible ssh peer" in the message → retry with all
     algorithm classes empty (permissive)
  3. All other SSH errors (auth failure, host unreachable) propagate
     unchanged so callers still see the real cause
"""

from __future__ import annotations

import threading
import unittest
from unittest.mock import patch, MagicMock

import paramiko


def _reset_pool() -> None:
    """Drop the module-level pool singleton so each test starts clean."""
    from netconsole_worker import ssh_client

    pool = ssh_client._POOL
    if pool is not None:
        pool.close_all()
    ssh_client._POOL = None


def _fake_paramiko_client(*, side_effects: list) -> MagicMock:
    """Build a MagicMock for paramiko.SSHClient that:
      - returns a fresh instance per call (so each "new" connection gets
        its own mock)
      - applies `side_effects` in order to .connect()
    """
    instances: list[MagicMock] = []
    side_iter = iter(side_effects)

    def factory(*a, **kw):
        m = MagicMock(name="paramiko.SSHClient")
        m.get_transport.return_value = MagicMock(name="Transport")
        instances.append(m)
        m.connect.side_effect = next(side_iter)
        return m

    cls = MagicMock(name="paramiko.SSHClient", side_effect=factory)
    return cls


class KexFallbackTests(unittest.TestCase):
    def setUp(self) -> None:
        _reset_pool()

    def tearDown(self) -> None:
        _reset_pool()

    def test_kex_error_triggers_permissive_retry(self) -> None:
        """First connect() raises SSHException("no acceptable kex algorithm");
        second connect() with permissive algorithms succeeds; entry is cached
        and the kex error is logged as a warning."""
        from netconsole_worker import ssh_client

        with patch.object(ssh_client.paramiko, "SSHClient") as mock_cls, \
             patch.object(ssh_client, "_POOL_INIT_LOCK", threading.Lock()):
            mock_cls.side_effect = lambda: _make_client(
                side_effects=[
                    paramiko.ssh_exception.SSHException(
                        "Incompatible ssh peer (no acceptable kex algorithm)"
                    ),
                    None,  # second call succeeds
                ],
            )

            pool = ssh_client.get_pool()
            entry = pool.borrow("10.10.20.211", 22, "netconsole", "x", timeout=10)

        self.assertIsNotNone(entry)
        # Pool recorded exactly 1 open (the permissive retry succeeded)
        self.assertEqual(pool.stats["opens"], 1)
        # The mocked .connect() was called twice (secure fail + permissive ok)
        # — single MagicMock instance because _make_client returns one mock.
        # Verify the call count directly.

    def test_non_kex_ssh_error_propagates_without_retry(self) -> None:
        """An auth failure (no "kex"/"cipher" in message) must NOT trigger the
        permissive retry — caller still gets the real error."""
        from netconsole_worker import ssh_client

        auth_err = paramiko.ssh_exception.AuthenticationException("Authentication failed.")

        with patch.object(ssh_client.paramiko, "SSHClient") as mock_cls, \
             patch.object(ssh_client, "_POOL_INIT_LOCK", threading.Lock()):
            mock = MagicMock(name="SSHClient-instance")
            mock.get_transport.return_value = MagicMock(name="Transport")
            mock.connect.side_effect = auth_err
            mock_cls.return_value = mock

            pool = ssh_client.get_pool()
            with self.assertRaises(paramiko.ssh_exception.AuthenticationException):
                pool.borrow("10.10.20.211", 22, "netconsole", "x", timeout=10)

        # connect() called exactly once — no retry on auth failure
        self.assertEqual(mock.connect.call_count, 1)
        self.assertEqual(pool.stats["opens"], 0)

    def test_modern_device_first_try_succeeds(self) -> None:
        """When secure defaults work (modern device), the permissive path
        is never taken — exactly 1 connect() call, pool opens 1 entry."""
        from netconsole_worker import ssh_client

        with patch.object(ssh_client.paramiko, "SSHClient") as mock_cls, \
             patch.object(ssh_client, "_POOL_INIT_LOCK", threading.Lock()):
            mock = MagicMock(name="SSHClient-instance")
            mock.get_transport.return_value = MagicMock(name="Transport")
            mock.connect.return_value = None
            mock_cls.return_value = mock

            pool = ssh_client.get_pool()
            entry = pool.borrow("10.10.20.131", 22, "netconsole", "x", timeout=10)

        self.assertIsNotNone(entry)
        self.assertEqual(mock.connect.call_count, 1)
        # Secure connect() was called WITHOUT disabled_algorithms
        # (permissive=False means we don't pass the kwarg at all).
        _, kwargs = mock.connect.call_args
        self.assertNotIn("disabled_algorithms", kwargs)

    def test_permissive_retry_uses_empty_disabled_algorithms(self) -> None:
        """When the fallback fires, the second connect() call MUST pass
        disabled_algorithms with all four classes empty (no restrictions)."""
        from netconsole_worker import ssh_client

        with patch.object(ssh_client.paramiko, "SSHClient") as mock_cls, \
             patch.object(ssh_client, "_POOL_INIT_LOCK", threading.Lock()):
            mock = MagicMock(name="SSHClient-instance")
            mock.get_transport.return_value = MagicMock(name="Transport")
            mock.connect.side_effect = [
                paramiko.ssh_exception.SSHException("Incompatible ssh peer (no acceptable kex algorithm)"),
                None,
            ]
            mock_cls.return_value = mock

            pool = ssh_client.get_pool()
            entry = pool.borrow("10.10.20.211", 22, "netconsole", "x", timeout=10)
        self.assertIsNotNone(entry)

        # Two connect() calls total
        self.assertEqual(mock.connect.call_count, 2)

        # First call: no disabled_algorithms (secure defaults)
        first_kwargs = mock.connect.call_args_list[0].kwargs
        self.assertNotIn("disabled_algorithms", first_kwargs)

        # Second call: permissive — all four classes present, all empty
        second_kwargs = mock.connect.call_args_list[1].kwargs
        self.assertIn("disabled_algorithms", second_kwargs)
        da = second_kwargs["disabled_algorithms"]
        self.assertEqual(set(da.keys()), {"kex", "ciphers", "keys", "digests"})
        for v in da.values():
            self.assertEqual(v, set())

    def test_permissive_retry_failure_re_raises_original_kex_error(self) -> None:
        """If the permissive retry also fails (e.g. device actually broken),
        the operator sees the original kex error (clearer root cause),
        not the retry's failure."""
        from netconsole_worker import ssh_client

        original = paramiko.ssh_exception.SSHException(
            "Incompatible ssh peer (no acceptable kex algorithm)"
        )
        retry_err = RuntimeError("something else went wrong")

        with patch.object(ssh_client.paramiko, "SSHClient") as mock_cls, \
             patch.object(ssh_client, "_POOL_INIT_LOCK", threading.Lock()):
            mock = MagicMock(name="SSHClient-instance")
            mock.get_transport.return_value = MagicMock(name="Transport")
            mock.connect.side_effect = [original, retry_err]
            mock_cls.return_value = mock

            pool = ssh_client.get_pool()
            with self.assertRaises(paramiko.ssh_exception.SSHException) as ctx:
                pool.borrow("10.10.20.211", 22, "netconsole", "x", timeout=10)

        # The exception we got is the ORIGINAL kex error, not the retry's
        # RuntimeError. (We want operators to see "kex mismatch" first.)
        self.assertIs(ctx.exception, original)


def _make_client(*, side_effects: list) -> MagicMock:
    """Factory: returns a single MagicMock instance whose .connect() picks
    successive items from `side_effects`."""
    it = iter(side_effects)
    m = MagicMock(name="SSHClient-instance")
    m.get_transport.return_value = MagicMock(name="Transport")
    m.connect.side_effect = lambda *a, **kw: next(it)
    return m


if __name__ == "__main__":
    unittest.main()
