"""Tests for junos_rest._verify_commit_landed empty-commit recovery path.

The Junos cRPD simulator occasionally returns an empty body for the
`<commit-configuration/>` RPC while the commit itself does NOT land on
the device. The OLD code treated empty body as success, which silently
discarded user changes (verified 2026-10-11 against LAB-F6-CORE-02,
job 22adada7... — apply_config SUCCESS but device state unchanged).

The fix runs a `<get-configuration>` readback after an empty commit
response and checks whether a high-signal token from one of the
loaded `set` commands appears in the running config. If yes, the
commit landed (the response was just lost in transit). If no, the
worker discards the candidate and retries on a fresh socket.

These tests exercise the verification helper directly. The retry
integration test (with discard-changes + fresh pool) is in
`test_junos_commit_retry.py` if needed later.
"""

from __future__ import annotations

import unittest
from unittest.mock import patch, MagicMock

from netconsole_worker.junos_rest import apply_set_configuration


def _make_pool(*, post_responses: list[dict] | None = None) -> MagicMock:
    """Build a mock JunosRESTPool that returns the supplied sequence of
    post_junos_rpc responses (one per RPC). The pool's `borrow` always
    returns the same fake client; the worker reads the response body
    via `client.post(...)` but the real worker uses
    `post_junos_rpc(host, body, client=client, ...)` which wraps that.
    """
    pool = MagicMock(name="JunosRESTPool")
    fake_client = MagicMock(name="httpx.Client")
    pool.borrow.return_value = fake_client
    return pool


class VerifyCommitLandedTests(unittest.TestCase):
    """The verification readback path inside apply_set_configuration."""

    def _run_apply(self, *, post_responses: list[dict]) -> dict:
        """Run apply_set_configuration with a mock pool that returns
        `post_responses` in order. Each response dict has shape:
            {"ok": bool, "raw": str}
        The sequence must include at minimum:
          1. load response (must have <load-success/>)
          2. commit response (test sets to {"ok":True, "raw":""} to
             trigger the empty-body path)
          3. verification readback response (for _verify_commit_landed)
          4..N. optional retry responses (discard + load + commit)
        """
        from netconsole_worker import junos_rest

        pool = _make_pool()
        # post_junos_rpc is called in order: load, commit, get-config,
        # and possibly discard + load + commit on retry. The default
        # MagicMock returns a fresh MagicMock per call, so we set
        # side_effect with a list to drive deterministic responses.
        with patch.object(junos_rest, "get_rest_pool", return_value=pool), \
             patch.object(junos_rest, "post_junos_rpc",
                          side_effect=post_responses):
            result = apply_set_configuration(
                host="10.10.20.101",
                commands=["set protocols ospf area 0.0.0.100"],
                username="netconsole",
                password="x",
            )
        return result

    def test_commit_empty_but_verified_returns_success(self) -> None:
        """Empty commit body + verification token present in readback
        → success. The commit actually landed, the response was just
        lost in transit."""
        result = self._run_apply(post_responses=[
            # 1. load — succeeds
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 2. commit — empty body (the bug we're working around)
            {"ok": True, "raw": ""},
            # 3. verification readback — token "0.0.0.100" is present
            {"ok": True, "raw": "<configuration><protocols><ospf><area><name>0.0.0.100</name></area></ospf></protocols></configuration>"},
        ])
        self.assertTrue(result["ok"], f"expected ok=True, got {result}")
        self.assertIn("verified by readback", result["raw"])

    def test_commit_empty_and_unverified_triggers_retry(self) -> None:
        """Empty commit body + verification token NOT in readback →
        discard candidate, retry on fresh socket. If the retry commit
        returns a proper success body, the apply succeeds with the
        standard success raw."""
        result = self._run_apply(post_responses=[
            # 1. load — succeeds
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 2. commit — empty body
            {"ok": True, "raw": ""},
            # 3. verification readback — token NOT present (commit didn't land)
            {"ok": True, "raw": "<configuration><protocols><ospf><area><name>0.0.0.0</name></area></ospf></protocols></configuration>"},
            # 4. discard-changes
            {"ok": True, "raw": "<ok/>"},
            # 5. retry load
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 6. retry commit — succeeds this time
            {"ok": True, "raw": "<commit-results><commit-success/></commit-results>"},
        ])
        self.assertTrue(result["ok"], f"expected ok=True, got {result}")
        self.assertIn("recovered after empty-commit", result["raw"])

    def test_commit_empty_and_retry_commit_also_empty_returns_failure(self) -> None:
        """Worst case: empty commit + unverified readback + retry commit
        also returns empty. We can't tell if the commit landed, so the
        apply must FAIL with a clear message — never silently report
        success."""
        result = self._run_apply(post_responses=[
            # 1. load
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 2. commit — empty
            {"ok": True, "raw": ""},
            # 3. verification — token not present
            {"ok": True, "raw": "<configuration><protocols></protocols></configuration>"},
            # 4. discard
            {"ok": True, "raw": "<ok/>"},
            # 5. retry load
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 6. retry commit — STILL empty
            {"ok": True, "raw": ""},
        ])
        self.assertFalse(result["ok"], f"expected ok=False, got {result}")
        self.assertEqual(result["stage"], "commit-retry-after-empty-commit")
        self.assertIn("Cannot determine if the commit landed", result["error"])

    def test_verification_readback_failure_assumes_unverified(self) -> None:
        """If the verification readback itself fails (network error),
        treat as unverified → retry path. Don't silently report
        success just because the read timed out."""
        result = self._run_apply(post_responses=[
            # 1. load
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 2. commit — empty
            {"ok": True, "raw": ""},
            # 3. verification readback — also empty (network error simulated)
            {"ok": True, "raw": ""},
            # 4. discard
            {"ok": True, "raw": "<ok/>"},
            # 5. retry load
            {"ok": True, "raw": "<load-configuration-results><load-success/></load-configuration-results>"},
            # 6. retry commit — proper success
            {"ok": True, "raw": "<commit-results><commit-success/></commit-results>"},
        ])
        # Retry path lands successfully → overall ok=True
        self.assertTrue(result["ok"], f"expected ok=True via retry, got {result}")


if __name__ == "__main__":
    unittest.main()
