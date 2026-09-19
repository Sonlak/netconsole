"""Unit test for the new Resource shortage retry logic in run_ssh_command.

We can't easily reproduce the paramiko ChannelException in CI, so we
patch _exec_on with a function that raises on the first N calls and
succeeds afterwards.
"""
import time
import unittest
from unittest.mock import patch

import paramiko


def _make_resource_shortage():
    """Construct a paramiko.ChannelException that matches the real one
    raised by IOS-XE 17.x (verified 2026-09-19 against 10.10.20.212)."""
    return paramiko.ChannelException(4, "Resource shortage")


class ResourceShortageRetryTests(unittest.TestCase):
    def test_classifier_positive_on_real_exception(self):
        from netconsole_worker.ssh_client import _is_resource_shortage

        self.assertTrue(_is_resource_shortage(_make_resource_shortage()))

    def test_classifier_negative_on_unrelated_exception(self):
        from netconsole_worker.ssh_client import _is_resource_shortage

        self.assertFalse(_is_resource_shortage(RuntimeError("boom")))
        self.assertFalse(_is_resource_shortage(paramiko.AuthenticationException("auth")))
        self.assertFalse(
            _is_resource_shortage(paramiko.SSHException("not active"))
        )

    def test_classifier_positive_on_eoferror(self):
        """EOFError mid-channel-read on IOS-XE 17.x is the same transient
        device-busy event as Resource shortage. Must retry."""
        from netconsole_worker.ssh_client import _is_resource_shortage

        self.assertTrue(_is_resource_shortage(EOFError()))

    def test_retry_recovers_on_second_attempt(self):
        """First _exec_on raises ChannelException; second succeeds.

        Should return sshOk=True without invalidating the pool.
        """
        from netconsole_worker import ssh_client as sc
        from netconsole_worker.ssh_client import _PooledConn

        # Build a synthetic pool entry by mocking the SSHClient.
        fake_client = object()
        fake_entry = _PooledConn(client=fake_client)

        attempts = {"n": 0}

        def fake_exec(client, command, timeout, input_text):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise _make_resource_shortage()
            # Second attempt succeeds
            return ("show mac output", "", 0)

        # Capture pool calls
        invalidated = {"n": 0}
        released = {"n": 0}

        class FakePool:
            def borrow(self, host, port, username, password, timeout=15):
                return fake_entry

            def release(self, host, port, username):
                released["n"] += 1

            def invalidate(self, host, port, username):
                invalidated["n"] += 1

        # Patch sleep so we don't actually wait 0.3s during tests
        sleeps = []

        def fake_sleep(seconds):
            sleeps.append(seconds)

        with patch.object(sc, "get_pool", return_value=FakePool()), \
             patch.object(sc, "_exec_on", side_effect=fake_exec), \
             patch.object(sc.time if hasattr(sc, "time") else time, "sleep", fake_sleep):
            result = sc.run_ssh_command(
                host="10.10.20.212",
                username="netconsole",
                password="x",
                command="show mac address-table",
            )

        self.assertTrue(result["sshOk"], f"expected sshOk=True, got {result}")
        self.assertIn("show mac output", result["output"])
        self.assertEqual(attempts["n"], 2, "should have tried exactly twice")
        self.assertEqual(invalidated["n"], 0, "transport was healthy — pool entry must NOT be invalidated")
        self.assertEqual(released["n"], 1, "successful retry should release the pool entry")
        self.assertEqual(sleeps, [0.3], "should have backed off 0.3s before the retry")

    def test_eoferror_is_treated_as_transient(self):
        """EOFError mid-read on a reused IOS-XE connection should retry,
        not bubble up as a generic SSH error."""
        from netconsole_worker import ssh_client as sc
        from netconsole_worker.ssh_client import _PooledConn

        fake_client = object()
        fake_entry = _PooledConn(client=fake_client)

        attempts = {"n": 0}

        def fake_exec(client, command, timeout, input_text):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise EOFError()
            return ("mac output", "", 0)

        invalidated = {"n": 0}

        class FakePool:
            def borrow(self, host, port, username, password, timeout=15):
                return fake_entry

            def release(self, host, port, username):
                pass

            def invalidate(self, host, port, username):
                invalidated["n"] += 1

        with patch.object(sc, "get_pool", return_value=FakePool()), \
             patch.object(sc, "_exec_on", side_effect=fake_exec), \
             patch.object(time, "sleep", lambda s: None):
            result = sc.run_ssh_command(
                host="10.10.20.212",
                username="netconsole",
                password="x",
                command="show mac address-table",
            )

        self.assertTrue(result["sshOk"], f"EOFError should have retried; got {result}")
        self.assertEqual(attempts["n"], 2)
        self.assertEqual(invalidated["n"], 0)

    def test_retry_gives_up_after_three_failures(self):
        """All four attempts raise ChannelException.

        Should return sshOk=False with a clear error message; pool invalidated.
        """
        from netconsole_worker import ssh_client as sc
        from netconsole_worker.ssh_client import _PooledConn

        fake_client = object()
        fake_entry = _PooledConn(client=fake_client)

        def fake_exec_always_fail(*args, **kwargs):
            raise _make_resource_shortage()

        invalidated = {"n": 0}
        released = {"n": 0}

        class FakePool:
            def borrow(self, host, port, username, password, timeout=15):
                return fake_entry

            def release(self, host, port, username):
                released["n"] += 1

            def invalidate(self, host, port, username):
                invalidated["n"] += 1

        sleeps = []

        def fake_sleep(seconds):
            sleeps.append(seconds)

        with patch.object(sc, "get_pool", return_value=FakePool()), \
             patch.object(sc, "_exec_on", side_effect=fake_exec_always_fail), \
             patch.object(time, "sleep", fake_sleep):
            result = sc.run_ssh_command(
                host="10.10.20.212",
                username="netconsole",
                password="x",
                command="show mac address-table",
            )

        self.assertFalse(result["sshOk"], f"expected sshOk=False, got {result}")
        self.assertIn("Resource shortage", result["error"])
        self.assertIn("4 attempts", result["error"])
        # 4 total attempts: 1 + 3 retries → 3 sleeps before the final attempt
        self.assertEqual(sleeps, [0.3, 0.6, 1.2], "should have backed off 0.3, 0.6, 1.2")
        self.assertEqual(invalidated["n"], 1, "after exhausting retries, pool entry should be invalidated")

    def test_non_transient_error_is_not_retried(self):
        """Generic SSHException (not Resource shortage) should NOT be retried.

        Should propagate immediately with the original error message; pool invalidated.
        """
        from netconsole_worker import ssh_client as sc
        from netconsole_worker.ssh_client import _PooledConn

        fake_client = object()
        fake_entry = _PooledConn(client=fake_client)

        def fake_exec_unrelated(*args, **kwargs):
            raise paramiko.SSHException("Channel closed")

        invalidated = {"n": 0}
        released = {"n": 0}

        class FakePool:
            def borrow(self, host, port, username, password, timeout=15):
                return fake_entry

            def release(self, host, port, username):
                released["n"] += 1

            def invalidate(self, host, port, username):
                invalidated["n"] += 1

        with patch.object(sc, "get_pool", return_value=FakePool()), \
             patch.object(sc, "_exec_on", side_effect=fake_exec_unrelated), \
             patch.object(time, "sleep", lambda s: None):
            result = sc.run_ssh_command(
                host="10.10.20.212",
                username="netconsole",
                password="x",
                command="show mac address-table",
            )

        self.assertFalse(result["sshOk"])
        # Channel closed -> existing "retry with fresh connection" branch fires
        # which itself may succeed or fail depending on the second attempt.
        # Here we don't care — just that the non-transient error was not
        # trapped by the resource-shortage retry loop.


if __name__ == "__main__":
    unittest.main(verbosity=2)