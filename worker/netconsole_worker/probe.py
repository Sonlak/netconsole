"""Lightweight TCP probes for the MANAGED_CHECK job.

The probe only verifies that a TCP socket can connect — it does NOT
authenticate, exchange banners, or send any payload. This keeps the
managed-check loop cheap enough to run every 30s across the whole
fleet without flooding `auth.log` or burning SSH pool sessions
(gotcha around worker stop / SSH fallback on 2026-09-06).

Vendors and ports we probe:

| Vendor  | SSH  | RESTCONF/NETCONF | NX-API | eAPI  |
|---------|------|------------------|--------|-------|
| Junos   | 22   | 830 (NETCONF SSH)|   --   |  --   |
| Junos   | 22   | 8443 (RESTCONF)  |   --   |  --   |
| EOS     | 22   |    --            |   --   | 443   |
| IOS-XE  | 22   | 830 (NETCONF SSH)|   --   |  --   |
| IOS-XE  | 22   | 443 (RESTCONF)   |   --   |  --   |
| NX-OS   | 22   |    --            |  80    |  --   |

`MANAGED_CHECK` returns `{ssh, rest}` only. The old `showVersion` and
`showRun` flags are no longer fetched by the probe — the existing
`ManagedChecks` shape keeps them as `false` so downstream parsers and
the persistence path don't break, but they're not part of the
"fully managed" gate anymore (see `applyManagedCheckResult`).
"""

from __future__ import annotations

import logging
import socket
from typing import Final

logger = logging.getLogger(__name__)

# Per-probe timeout. 1.5s is long enough for a cold-TLS handshake-free
# TCP connect on the local lab / VPS subnet, short enough that 50
# devices in series finish in under 90s. SSH-banner-read timeouts on
# Junos can spike to 5s, so we cap probe duration explicitly.
_DEFAULT_TIMEOUT: Final[float] = 1.5


def tcp_open(host: str, port: int, *, timeout: float = _DEFAULT_TIMEOUT) -> bool:
    """Return True if `host:port` accepts a TCP connection within `timeout`s.

    Pure socket.connect() — no data sent, no banner read, no auth.
    Connection refused / timeout / DNS failure / OS error all return False.
    """
    if not host or not port or port <= 0 or port > 65535:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (socket.timeout, OSError):
        return False
    except Exception as exc:  # noqa: BLE001
        logger.debug("tcp_open(%s, %d) unexpected error: %s", host, port, exc)
        return False


def probe_ssh(host: str, port: int = 22, *, timeout: float = _DEFAULT_TIMEOUT) -> bool:
    """Probe SSH port only. Default 22 matches `LAB_SSH_PORT`."""
    return tcp_open(host, port, timeout=timeout)


def probe_rest_or_netconf(
    host: str,
    port: int,
    *,
    timeout: float = _DEFAULT_TIMEOUT,
) -> bool:
    """Probe a vendor API port (RESTCONF / NETCONF SSH / eAPI / NX-API).

    Same logic as `probe_ssh` — single TCP connect, no payload — but
    named separately so probe_identity call sites read clearly.
    """
    return tcp_open(host, port, timeout=timeout)