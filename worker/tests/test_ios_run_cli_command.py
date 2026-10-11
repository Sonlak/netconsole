"""Tests for IOSBackend.run_cli_command override.

The base `DeviceBackend.run_cli_command` falls back to paramiko SSH
which fails against IOSv 15.x (legacy KEX only). The override here
uses the IOSexec HTTP path for reads and sshpass+OpenSSH for writes,
both of which work on the legacy KEX-only device.

Verified 2026-10-11 against LAB-F3-AS-01 (Cisco IOSv 15.2 / 10.10.20.211)
where the paramiko default failed with
"Incompatible ssh peer (no acceptable kex algorithm)".
"""

from __future__ import annotations

import unittest
from unittest.mock import patch, MagicMock

from netconsole_worker.backends.ios import IOSBackend
from netconsole_worker.models import DeviceInfo


def _make_backend() -> tuple[IOSBackend, MagicMock]:
    """Build an IOSBackend with a fake config where ios_http is enabled."""
    config = MagicMock()
    config.ios_http.enabled = True
    config.ios_http.user = "netconsole"
    config.ios_http.password = "x"
    config.ios_http.port = 443
    config.ssh_user = "fallback_user"
    config.ssh_password = "fallback_pass"
    return IOSBackend(config), config


def _make_device() -> DeviceInfo:
    return DeviceInfo(
        id="d1",
        name="LAB-F3-AS-01",
        ip="10.10.20.211",
        vendor="Cisco",
        model="IOSv",
        site="LAB",
        floor="3",
    )


class IOSRunCliCommandTests(unittest.TestCase):
    def test_read_uses_http_exec(self) -> None:
        """write=False → goes through _exec() (IOSexec HTTP), not paramiko."""
        backend, _ = _make_backend()
        device = _make_device()
        http_output = (
            "Codes: L - local, C - connected, S - static, R - RIP\n"
            "Gateway of last resort is 10.10.20.1 to network 0.0.0.0\n"
            "S*   0.0.0.0/0 [1/0] via 10.10.20.1\n"
            "     10.10.20.0/24 is directly connected, GigabitEthernet0/0\n"
        )
        with patch.object(backend, "_exec", return_value=http_output) as mock_exec, \
             patch("netconsole_worker.ssh_client.run_ssh_command") as mock_paramiko:
            result = backend.run_cli_command(device, "show ip route", write=False)

        self.assertTrue(result["implemented"])
        self.assertEqual(result["source"], "ios-http")
        self.assertEqual(result["command"], "show ip route")
        self.assertIn("10.10.20.0/24 is directly connected", result["output"])
        self.assertFalse(result["truncated"])
        self.assertIsNone(result["error"])
        # Read path MUST NOT touch paramiko (would fail on IOSv kex).
        mock_paramiko.assert_not_called()
        # HTTP exec called once with the right command.
        mock_exec.assert_called_once()
        _, args, _ = mock_exec.mock_calls[0]
        self.assertEqual(args[1], "show ip route")

    def test_write_uses_ssh_cli_with_legacy_kex(self) -> None:
        """write=True → sshpass + openssh CLI with explicit KexAlgorithms=+..."""
        backend, _ = _make_backend()
        device = _make_device()
        fake_proc = MagicMock()
        fake_proc.stdout = b"Clear \"show interface\" counters on all interfaces [confirm]\n"
        fake_proc.returncode = 0
        with patch("subprocess.run", return_value=fake_proc) as mock_run, \
             patch("netconsole_worker.ssh_client.run_ssh_command") as mock_paramiko:
            result = backend.run_cli_command(device, "clear counters", write=True)

        self.assertTrue(result["implemented"])
        self.assertEqual(result["source"], "ios-ssh")
        self.assertEqual(result["command"], "clear counters")
        self.assertIsNone(result["error"])
        # Write path MUST NOT touch paramiko either.
        mock_paramiko.assert_not_called()
        # sshpass called with legacy KEX. The KexAlgorithms arg is a
        # single argv element that lists all kex the device may use —
        # the device negotiates down to the strongest one it supports.
        mock_run.assert_called_once()
        ssh_args = mock_run.call_args[0][0]
        self.assertIn("sshpass", ssh_args)
        kex_arg = next((a for a in ssh_args if a.startswith("KexAlgorithms=")), None)
        self.assertIsNotNone(kex_arg, f"no KexAlgorithms arg in {ssh_args}")
        self.assertIn("diffie-hellman-group1-sha1", kex_arg)
        self.assertIn("diffie-hellman-group14-sha1", kex_arg)
        # stdin payload includes the command + exit (NOT conf t / end).
        stdin = mock_run.call_args.kwargs.get("input", b"")
        self.assertIn(b"clear counters", stdin)
        self.assertIn(b"exit", stdin)
        self.assertNotIn(b"conf t", stdin)

    def test_output_capped_at_8kb(self) -> None:
        """Long output is truncated to 8 KB with originalBytes recorded."""
        backend, _ = _make_backend()
        device = _make_device()
        # 10 KB of output
        long_output = "x" * 10240
        with patch.object(backend, "_exec", return_value=long_output):
            result = backend.run_cli_command(device, "show running-config", write=False)

        self.assertTrue(result["truncated"])
        self.assertGreater(result["originalBytes"], 8000)
        # 8192 bytes of payload + the truncation marker line
        self.assertLessEqual(len(result["output"].encode("utf-8")), 8500)
        self.assertIn("[truncated]", result["output"])

    def test_disabled_when_ios_http_off(self) -> None:
        """If `ios_http.enabled=false`, the override refuses cleanly."""
        backend, config = _make_backend()
        config.ios_http.enabled = False
        device = _make_device()
        result = backend.run_cli_command(device, "show ip route", write=False)
        self.assertFalse(result["implemented"])
        # Error carries the env-var name so operator knows which flag
        # to flip; message carries the human-readable explanation.
        self.assertIn("IOS_HTTP", result["error"])
        self.assertIn("not enabled", result["message"])

    def test_http_failure_surfaces_error(self) -> None:
        """A HTTP-side RuntimeError is surfaced as a clean FAILED result
        (not a Python exception bubbling up to the worker)."""
        backend, _ = _make_backend()
        device = _make_device()
        with patch.object(backend, "_exec", side_effect=RuntimeError("CSRF fetch failed")):
            result = backend.run_cli_command(device, "show ip route", write=False)
        self.assertFalse(result["implemented"])
        self.assertEqual(result["source"], "ios-http")
        self.assertIn("CSRF fetch failed", result["error"])
        self.assertEqual(result["output"], "")


if __name__ == "__main__":
    unittest.main()
