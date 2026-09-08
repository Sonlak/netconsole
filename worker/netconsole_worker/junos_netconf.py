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
    return False, "Unknown NETCONF error"


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
    """Load + commit Junos config via NETCONF-over-SSH CLI.

    Per gotcha #15: cRPD commit spikes 20-30s on first commit after pool
    open.  Default timeout is 90s (split 30s load / 60s commit) to match
    the RESTCONF path.
    """
    from xml.sax.saxutils import escape

    _ = log

    set_text = "\n".join(commands).rstrip("\n")
    # Junos NETCONF <load-configuration> with format="set".
    # Reference: Junos XML Management Protocol Guide §4.7.
    # The <configuration-set> child holds the set commands verbatim.
    # Namespace prefix "junos" matches the device's expected namespace
    # (http://xml.juniper.net/junos/<version>/junos).
    load_rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<rpc>"
        '<load-configuration format="text" action="set">'
        f"<configuration-set>{escape(set_text)}</configuration-set>"
        "</load-configuration>"
        "</rpc>"
    )
    commit_rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><commit-configuration/></rpc>'
    discard_rpc = '<?xml version="1.0" encoding="UTF-8"?><rpc><discard-changes/></rpc>'

    # Per gotcha #15: cRPD commit spikes 20-30s (first commit after pool
    # open can spike higher).  Allocate ~70% of budget to commit, ~30% to
    # load, so a single 90s call gives commit 60s + load 30s.
    load_timeout = max(15.0, timeout * 0.30)
    commit_timeout = max(30.0, timeout - load_timeout)

    # --- Load ---
    ok, load_raw, load_ms = _run_nc_rpc(
        host, port, username, password, load_rpc, timeout=load_timeout
    )
    if not ok:
        return {
            "ok": False,
            "stage": "load",
            "error": load_raw,
            "raw": "",
            "loadMs": load_ms,
            "commitMs": 0,
        }
    load_ok, load_err = _parse_ok_error(load_raw)
    if not load_ok:
        return {
            "ok": False,
            "stage": "load",
            "error": load_err,
            "raw": load_raw,
            "loadMs": load_ms,
            "commitMs": 0,
        }

    # --- Commit ---
    ok, commit_raw, commit_ms = _run_nc_rpc(
        host, port, username, password, commit_rpc, timeout=commit_timeout
    )
    if not ok:
        _run_nc_rpc(host, port, username, password, discard_rpc, timeout=10)
        return {
            "ok": False,
            "stage": "commit",
            "error": commit_raw,
            "raw": load_raw + "\n" + commit_raw,
            "loadMs": load_ms,
            "commitMs": commit_ms,
        }
    commit_ok, commit_err = _parse_ok_error(commit_raw)
    if not commit_ok:
        _run_nc_rpc(host, port, username, password, discard_rpc, timeout=10)
        return {
            "ok": False,
            "stage": "commit",
            "error": commit_err,
            "raw": load_raw + "\n" + commit_raw,
            "loadMs": load_ms,
            "commitMs": commit_ms,
        }

    return {
        "ok": True,
        "stage": "commit",
        "error": None,
        "raw": load_raw + "\n" + commit_raw,
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
    """Rollback Junos config via NETCONF-over-SSH CLI."""
    index = max(0, min(int(rollback), 49))
    load_rpc = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<rpc><load-configuration><rollback>{index}</rollback></load-configuration></rpc>"
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
