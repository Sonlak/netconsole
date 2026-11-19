"""Juniper Junos NETCONF-over-SSH via the OpenSSH CLI.

Each RPC = 1 fresh sshpass+ssh session via /tmp script + subprocess.run.
The script uses a heredoc to send hello + RPC over stdin, and SSH keeps
the NETCONF channel open until the device sends its reply.  The script
process stays alive (correctly blocking) until the device responds,
so subprocess.run with capture_output=True returns the full reply.

Key flags:
  - `-T` disables PTY allocation — required because OpenSSH skips the
    NETCONF subsystem when stdin is not a TTY (even with a heredoc,
    the script process has no controlling terminal).
  - `-s netconf` invokes the NETCONF SSH subsystem on port 830.
  - `BatchMode=no` allows password auth via sshpass.

RPC format: ``<load-configuration format="text" action="set">
<configuration-set>set ...\n</configuration-set></load-configuration>``
The ``format="text"`` + ``<configuration-set>`` pair is the Junos NETCONF
equivalent of RESTCONF's ``format="text" action="set"`` + ``<configuration-set>``.
``format="set"`` is rejected by the Junos NETCONF daemon with
"expecting configuration/configuration-text".

Per gotcha #15: cRPD commit spikes 20-30s on first commit after pool open,
so default timeout is 90s split 30s load + 60s commit.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile
import time
from typing import Any

logger = logging.getLogger(__name__)

#: NETCONF message terminator (RFC 4741 §4.1).
_NC_END = "]]>]]>"

#: Matches the ``<rpc-reply>`` subtree of a raw NETCONF exchange.
#:
#: A raw NETCONF reply from a Junos device contains **two** top-level XML
#: elements: the session ``<hello>`` and then the ``<rpc-reply>``.  That
#: makes the document *multi-root*, so ``xml.etree.ElementTree.fromstring``
#: raises ``ParseError: junk after document element`` and every parser
#: downstream silently returns 0 rows.
#:
#: Fixing this at the source (extract the ``<rpc-reply>`` subtree so the
#: XML has a single root) is what makes the whole NETCONF path usable —
#: verified on a live QFX5120 running Junos 23.4R2-S8.13 on 2026-11-19,
#: where ARP went from 0 entries to 19, MAC 0 -> 9, interfaces 0 -> 23.
_RPC_REPLY_RE = re.compile(r"<rpc-reply\b.*?</rpc-reply>", re.DOTALL)


def extract_rpc_reply(raw: str) -> str:
    """Return the ``<rpc-reply>`` subtree of a raw NETCONF exchange.

    Falls back to the raw text when no ``<rpc-reply>`` is present (e.g. the
    device replied with a bare ``<ok/>``).  The result always has a single
    XML root so it can be handed straight to ``ET.fromstring``.
    """
    if not raw:
        return ""
    m = _RPC_REPLY_RE.search(raw)
    if m:
        return m.group(0)
    # Bare <ok/> or error-only replies — strip the trailing ]]>]]> terminator
    # so the fragment stays parseable.
    return raw.replace(_NC_END, "").strip()


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
        # RFC 6241 §4.1: every NETCONF message ends with ]]>]]>.
        # The device's NETCONF parser reads until it sees this terminator.
        # Without it, the device holds the hello open (expecting more hello
        # data) and never sends its own hello — the SSH session closes
        # before the RPC is ever forwarded to the subsystem.
        f"\n{_NC_END}"
    )


def _run_nc_rpc(
    host: str,
    port: int,
    username: str,
    password: str,
    rpc: str,
    timeout: float = 30.0,
) -> tuple[bool, str, int]:
    """Run one NETCONF RPC by writing a script to /tmp and executing it.

    Writes a bash script that opens ``ssh -s netconf`` and sends
    hello+RPC via the SSH session.  Uses ``subprocess.run`` so the bash
    + sshpass + ssh chain stays alive until the device sends the full
    reply (heredoc writes only on stdin; SSH keeps the channel open).
    Returns (ok, raw, ms).
    """
    # Escape single quotes in password for bash single-quote context
    safe_pass = password.replace("'", "'\"'\"'")

    # The script opens SSH NETCONF, sends hello + RPC via heredoc, and
    # waits for the device's reply before SSH closes the channel.
    script_content = (
        "#!/bin/bash\n"
        'exec /usr/bin/sshpass -p \'' + safe_pass + '\' ssh '
        "-o StrictHostKeyChecking=no "
        "-o ConnectTimeout=10 "
        "-o PreferredAuthentications=password "
        "-o PubkeyAuthentication=no "
        "-o BatchMode=no "
        "-T "                                  # force disable PTY (subsystem mode)
        f"-s {username}@{host} -p {port} netconf << 'NCEND'\n"
        + _build_hello() + "\n"
        + rpc + "\n"
        "NCEND\n"
    )

    start = time.monotonic()
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".sh", delete=False
        ) as f:
            f.write(script_content)
            script_path = f.name
        os.chmod(script_path, 0o700)
    except Exception as exc:
        return False, f"failed to create script: {exc}", 0

    try:
        # Use subprocess.run to capture all stdout/stderr after the SSH
        # subprocess finishes.  The heredoc writes hello + RPC to SSH stdin;
        # SSH keeps the channel open until the device sends its reply, so
        # the process will block (correctly) until the device responds.
        result = subprocess.run(
            ["/bin/bash", script_path],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        ms = int((time.monotonic() - start) * 1000)
        return False, f"timeout after {timeout}s (no response)", ms
    except Exception as exc:
        os.unlink(script_path)
        return False, f"failed to run script: {exc}", 0
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    ms = int((time.monotonic() - start) * 1000)
    raw = (result.stdout or b"").decode("utf-8", errors="replace").strip()
    return True, raw, ms


def _parse_ok_error(raw: str) -> tuple[bool, str]:
    """Return (ok, error_message_or_empty).

    The raw response contains the device's hello message followed by the
    RPC reply.  Both are NETCONF XML.  The hello is harmless (no <ok/>
    or <rpc-error>) so we just scan the whole text for success/error
    markers.

    Success indicators (any one):
      - <ok/>            (RFC 6241 generic success, or Junos load)
      - <rpc-ok/>        (Juniper NETCONF variant)
      - <load-success>   (Junos load-configuration success)
      - <commit-success> (Junos commit-configuration success)

    Error indicators:
      - <rpc-error> with <error-message>
      - <bad-element>    (Junos protocol-level error)
    """
    raw_lower = raw.lower()

    # Extract any error message first — if present, this takes precedence
    # over a generic <ok/> that may appear in the same <rpc-reply>.
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
    # <rpc-error> without an explicit <error-message> — pull <error-tag>
    if "<rpc-error" in raw_lower:
        tag_m = re.search(
            r"<(?:[\w.-]+:)?error-tag(?:\s[^>]*)?>([^<]*)</(?:[\w.-]+:)?error-tag>",
            raw,
            re.IGNORECASE,
        )
        if tag_m:
            return False, f"[{tag_m.group(1).strip()}]"
        return False, raw[:300]

    # Now check for success markers.
    if (
        "<ok" in raw_lower
        or "<rpc-ok" in raw_lower
        or "<commit-success" in raw_lower
        or "<load-success" in raw_lower
    ):
        return True, ""
    # <get-configuration> replies don't carry <ok/> — they ship a
    # <configuration> payload directly. Treat any reply that has the
    # configuration payload and no error markers as success.
    if (
        "<configuration" in raw_lower
        and "<rpc-error" not in raw_lower
        and "<error-message" not in raw_lower
    ):
        return True, ""
    # Read-only operational RPCs don't carry <ok/> either — they ship a
    # data payload.  The element name varies per RPC (e.g.
    # <arp-table-information>, <ethernet-switching-table-information>,
    # <l2ng-l2ald-vlan-instance-information>), so instead of enumerating
    # them we accept ANY reply that carries an <rpc-reply> envelope with
    # content and no error markers.  An unsupported RPC always comes back
    # as <rpc-error>, which the checks above already caught.
    if (
        "<rpc-reply" in raw_lower
        and "<rpc-error" not in raw_lower
        and "<error-message" not in raw_lower
        and "<bad-element" not in raw_lower
    ):
        return True, ""
    return False, "Unknown NETCONF error"


def rollback_configuration(
    host: str,
    *,
    rollback: int = 1,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 90.0,
) -> dict[str, Any]:
    """Rollback Junos config via NETCONF-over-SSH CLI."""
    index = max(0, min(int(rollback), 49))
    # Junos spec: rollback is an *attribute* on <load-configuration>, not a
    # child element.  <rollback>N</rollback> is malformed and silently no-ops.
    load_rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<rpc><load-configuration rollback="{index}"/></rpc>'
    )
    commit_rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><commit-configuration/></rpc>'
    discard_rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><discard-changes/></rpc>'
    load_timeout = max(15.0, timeout * 0.30)
    commit_timeout = max(30.0, timeout - load_timeout)

    ok, load_raw, _ = _run_nc_rpc(
        host, port, username, password, load_rpc, timeout=load_timeout
    )
    if not ok:
        return {"ok": False, "stage": "load", "error": load_raw, "raw": ""}
    ok, err = _parse_ok_error(load_raw)
    if not ok:
        return {"ok": False, "stage": "load", "error": err, "raw": load_raw}

    ok, commit_raw, _ = _run_nc_rpc(
        host, port, username, password, commit_rpc, timeout=commit_timeout
    )
    if not ok:
        _run_nc_rpc(host, port, username, password, discard_rpc, timeout=10)
        return {"ok": False, "stage": "commit", "error": commit_raw, "raw": load_raw}
    ok, err = _parse_ok_error(commit_raw)
    if not ok:
        _run_nc_rpc(host, port, username, password, discard_rpc, timeout=10)
        return {"ok": False, "stage": "commit", "error": err, "raw": load_raw}

    return {"ok": True, "stage": "commit", "error": None, "raw": load_raw + "\n" + commit_raw}


def fetch_interface_configuration(
    host: str,
    iface: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Read running config for one interface via NETCONF <get-configuration>.

    Uses xpath filter to scope the read to ``<interfaces><interface><name>X</name>``
    so we don't pull the whole 30k-line candidate db.  Returns the same
    shape as ``junos_rest.fetch_interface_configuration`` so the caller can
    pick RESTCONF or NETCONF interchangeably.
    """
    from xml.sax.saxutils import escape

    safe_iface = escape(iface.strip())
    rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<rpc>"
        '<get-configuration format="set">'
        f'<configuration><interfaces><interface><name>{safe_iface}</name></interface></interfaces></configuration>'
        "</get-configuration>"
        "</rpc>"
    )
    ok, raw, _ms = _run_nc_rpc(host, port, username, password, rpc, timeout=timeout)
    if not ok:
        return {"ok": False, "stage": "rpc", "error": raw, "payload": "", "raw": ""}
    rpc_ok, err = _parse_ok_error(raw)
    if not rpc_ok:
        return {"ok": False, "stage": "rpc", "error": err, "payload": "", "raw": raw}
    reply = extract_rpc_reply(raw)
    return {"ok": True, "stage": "rpc", "error": None, "payload": reply, "raw": reply}


def fetch_system_uptime_cli(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 22,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """Fetch system uptime via Junos CLI `show system uptime` over SSH.

    This is a fallback when NETCONF-over-SSH is unavailable (e.g. cRPD lab
    devices where port 830 is forwarded to plain OpenSSH instead of the Junos
    NETCONF subsystem).  Uses subprocess/sshpass to avoid the
    paramiko/OpenSSH-10 key-exchange incompatibility (gotcha #4).  One
    auth.log entry per call is acceptable for lab use at 5-min intervals.

    Returns raw CLI output so the caller can reuse `parse_system_uptime`.
    """
    safe_pass = password.replace("'", "'\"'\"'")
    script_content = (
        "#!/bin/bash\n"
        'exec /usr/bin/sshpass -p \'' + safe_pass + '\' ssh '
        "-o StrictHostKeyChecking=no "
        "-o ConnectTimeout=10 "
        "-o PreferredAuthentications=password "
        "-o PubkeyAuthentication=no "
        "-o BatchMode=no "
        "-T "
        f"{username}@{host} -p {port} "
        "'show system uptime'\n"
    )
    start = time.monotonic()
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".sh", delete=False
        ) as f:
            f.write(script_content)
            script_path = f.name
        os.chmod(script_path, 0o700)
    except Exception as exc:
        return {"ok": False, "stage": "script", "error": f"failed to create script: {exc}", "payload": "", "raw": ""}

    try:
        result = subprocess.run(
            ["/bin/bash", script_path],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        ms = int((time.monotonic() - start) * 1000)
        return {"ok": False, "stage": "cli", "error": f"timeout after {timeout}s", "payload": "", "raw": ""}
    except Exception as exc:
        os.unlink(script_path)
        return {"ok": False, "stage": "cli", "error": f"failed to run script: {exc}", "payload": "", "raw": ""}
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    ms = int((time.monotonic() - start) * 1000)
    raw = (result.stdout or b"").decode("utf-8", errors="replace").strip()
    stderr = (result.stderr or b"").decode("utf-8", errors="replace")

    if "Permission denied" in stderr or "Authentication" in stderr:
        return {"ok": False, "stage": "cli", "error": "authentication failed", "payload": "", "raw": raw}
    if not raw or "System booted" not in raw:
        return {"ok": False, "stage": "cli", "error": "empty or unexpected output", "payload": "", "raw": raw}

    return {"ok": True, "stage": "cli", "error": None, "payload": raw, "raw": raw, "ms": ms}


def fetch_full_configuration(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 45.0,
) -> dict[str, Any]:
    """Read the whole candidate configuration via NETCONF <get-configuration>.

    Used as a fallback when the interface-scoped fetch returns nothing
    (e.g. the interface has only default settings — Junos omits empty
    hierarchy nodes from the scoped reply).  The caller is expected to
    filter the result down to the interfaces stanza.
    """
    rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<rpc>"
        '<get-configuration format="set"/>'
        "</rpc>"
    )
    ok, raw, _ms = _run_nc_rpc(host, port, username, password, rpc, timeout=timeout)
    if not ok:
        return {"ok": False, "stage": "rpc", "error": raw, "payload": "", "raw": ""}
    rpc_ok, err = _parse_ok_error(raw)
    if not rpc_ok:
        return {"ok": False, "stage": "rpc", "error": err, "payload": "", "raw": raw}
    # Hand back ONLY the <rpc-reply> subtree — the raw exchange is
    # multi-root (<hello> + <rpc-reply>) and would fail XML parsing.
    reply = extract_rpc_reply(raw)
    return {"ok": True, "stage": "rpc", "error": None, "payload": reply, "raw": reply}


def fetch_system_uptime(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 20.0,
) -> dict[str, Any]:
    """Fetch system uptime via Junos NETCONF <get-system-uptime-information>.

    Returns raw XML payload so the caller can reuse the existing
    `parse_system_uptime` parser from device_identity_rpc.py.
    """
    rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><get-system-uptime-information/></rpc>'
    ok, raw, _ms = _run_nc_rpc(host, port, username, password, rpc, timeout=timeout)
    if not ok:
        return {"ok": False, "stage": "rpc", "error": raw, "payload": "", "raw": ""}
    rpc_ok, err = _parse_ok_error(raw)
    if not rpc_ok:
        return {"ok": False, "stage": "rpc", "error": err, "payload": "", "raw": raw}
    reply = extract_rpc_reply(raw)
    return {"ok": True, "stage": "rpc", "error": None, "payload": reply, "raw": reply}


# ---------------------------------------------------------------------------
# Operational RPCs (read path)
# ---------------------------------------------------------------------------
#
# The RPC *names* below are the ones the running Junos release actually
# implements.  The shorter aliases used by the Junos REST API do NOT exist
# as NETCONF operations — e.g. ``<get-arp-table/>`` is rejected with
# ``<bad-element>get-arp-table</bad-element>`` / "syntax error", while
# ``<get-arp-table-information/>`` works.
#
# Verified on QFX5120 / Junos 23.4R2-S8.13 (2026-11-19):
#     get-arp-table-information                 OK  0.6s
#     get-ethernet-switching-table-information OK  0.6s
#     get-interface-information                 OK  1.9s
#     get-vlan-information                      OK  0.6s
#     get-lldp-neighbors-information            OK  0.6s
#     get-system-uptime-information             OK  1.0s
#     get-log-information                       FAIL (not an operation)
#     get-chassis-inventory-information        FAIL (not an operation)


def fetch_operational(
    host: str,
    rpc_body: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Run one operational NETCONF RPC and return the ``<rpc-reply>`` XML.

    Returns the same dict shape as the other ``fetch_*`` helpers in this
    module so callers can treat RESTCONF and NETCONF interchangeably.
    """
    rpc = f'<?xml version="1.0" encoding="UTF-8"?><rpc>{rpc_body}</rpc>'
    ok, raw, _ms = _run_nc_rpc(host, port, username, password, rpc, timeout=timeout)
    if not ok:
        return {"ok": False, "stage": "rpc", "error": raw, "payload": "", "raw": ""}
    rpc_ok, err = _parse_ok_error(raw)
    if not rpc_ok:
        return {"ok": False, "stage": "rpc", "error": err, "payload": "", "raw": raw}
    reply = extract_rpc_reply(raw)
    return {"ok": True, "stage": "rpc", "error": None, "payload": reply, "raw": reply}


def fetch_arp_table(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Fetch the ARP table via NETCONF ``<get-arp-table-information/>``."""
    return fetch_operational(
        host, "<get-arp-table-information/>",
        username=username, password=password, port=port, timeout=timeout,
    )


def fetch_ethernet_switching_table(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Fetch the MAC table via NETCONF ``<get-ethernet-switching-table-information/>``."""
    return fetch_operational(
        host, "<get-ethernet-switching-table-information/>",
        username=username, password=password, port=port, timeout=timeout,
    )


def fetch_interface_information(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 45.0,
) -> dict[str, Any]:
    """Fetch interface state via NETCONF ``<get-interface-information/>``."""
    return fetch_operational(
        host, "<get-interface-information/>",
        username=username, password=password, port=port, timeout=timeout,
    )


def fetch_vlan_information(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Fetch VLAN state via NETCONF ``<get-vlan-information/>``."""
    return fetch_operational(
        host, "<get-vlan-information/>",
        username=username, password=password, port=port, timeout=timeout,
    )


def fetch_lldp_neighbors(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Fetch LLDP neighbours via NETCONF ``<get-lldp-neighbors-information/>``."""
    return fetch_operational(
        host, "<get-lldp-neighbors-information/>",
        username=username, password=password, port=port, timeout=timeout,
    )


def fetch_system_information(
    host: str,
    *,
    username: str,
    password: str,
    port: int = 830,
    timeout: float = 20.0,
) -> dict[str, Any]:
    """Fetch host identity via NETCONF ``<get-system-information/>``.

    The reply carries ``<host-name>``, ``<os-name>``, ``<os-version>`` and
    ``<hardware-model>`` — everything ``probe_identity`` needs, in ~2 KB
    and ~0.6 s, versus the ~55 KB / ~0.7 s of a full
    ``<get-configuration format="set"/>``.
    """
    return fetch_operational(
        host, "<get-system-information/>",
        username=username, password=password, port=port, timeout=timeout,
    )
