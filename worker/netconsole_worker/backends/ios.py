"""Cisco IOS (non-XE) backend — HTTP IOSexec API.

This backend talks to Cisco IOS devices that expose the classic HTTP
management interface (IOS 12.4+). It does NOT require NETCONF/RESTCONF —
all operations go over HTTPS port 443 using the IOSexec web interface.

Key characteristics of the IOS HTTP API:
  - HTTPS on port 443 with TLS 1.0 (some IOS images only support TLS 1.0).
  - HTTP Basic authentication; the user must have privilege 15 so no
    separate privilege-escalation step is needed.
  - Every POST requires a fresh CSRF token obtained from the previous GET.
  - IOS HTTP is single-threaded on the device — never send concurrent
    requests; a session lock serialises all calls.

HTTP API reference (IOS web interface):
  Read commands:  POST /level/15/exec/-    body: command=<cmd>&CMD=Command
  Write commands: POST /level/15/exec/-   body: conf=1&command=<conf-cmd>&CMD=Command
  (Alternatively: DELETE /level/15/configure/<path> for no-op,
   but the exec POST with conf=1 is more reliable for mixed configs.)

Verified working on IOSv 15.2 (CML lab image) at 10.10.20.211.
NETCONF (port 830) and RESTCONF (port 443 /restconf/*) are NOT available
on IOSv — only the IOSexec HTTP API works.

Device requirements:
  - ip http server              (enables the HTTP management interface)
  - ip http authentication local
  - ip http secure-server       (enables HTTPS; required for TLS 1.0)
  - A local user with privilege 15, e.g.:
      username netconsole privilege 15 secret 5 <hash>
  - transport input ssh         (on the vty lines; not strictly required for HTTP
                                 but good practice so operators can also SSH in)

NOT supported by this backend:
  - Physical Cisco IOS devices without the HTTP interface enabled
  - IOS XE with NETCONF/RESTCONF (use IOSxeBackend instead — it prefers
    the structured YANG API over the raw CLI-over-HTTP approach)
  - NX-OS (use NxosBackend instead)
"""

from __future__ import annotations

import base64
import http.cookiejar
import logging
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from netconsole_worker.backends.base import DeviceBackend
from netconsole_worker.models import DeviceInfo
from netconsole_worker.parsers.show_arp import parse_cisco_arp_table
from netconsole_worker.parsers.show_mac_table import parse_cisco_mac_table

logger = logging.getLogger(__name__)

# IOS interface name regex — accepts GigabitEthernet, FastEthernet, TenGigabitEthernet, etc.
_IFACE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9/.:-]{0,63}$")
_PROTECTED_PREFIXES = (
    "Loopback",
    "Tunnel",
    "Port-channel",
    "Vlan",
    "BDI",
)


def _validate_iface(iface: str) -> str:
    if not _IFACE_RE.match(iface):
        raise ValueError(f"Invalid IOS interface name: {iface!r}")
    if iface.startswith(_PROTECTED_PREFIXES):
        raise ValueError(f"Refusing to act on protected interface {iface}")
    return iface


# ---------------------------------------------------------------------------
# HTTPS session manager (TLS 1.0, CSRF-aware, thread-safe)
# ---------------------------------------------------------------------------

# Global TLS 1.0 SSL context — created once and reused.
# IOS HTTP servers (especially IOSv lab images) only support TLS 1.0
# and reject TLS 1.2+ handshakes. We must use ssl.PROTOCOL_TLSv1
# (TLS 1.0-only) and allow weak ciphers.
_TLS_CONTEXT: ssl.SSLContext | None = None


def _tls_context() -> ssl.SSLContext:
    global _TLS_CONTEXT
    if _TLS_CONTEXT is None:
        # Use PROTOCOL_TLSv1 for TLS 1.0-only (required by IOSv 15.2).
        # PROTOCOL_TLS_CLIENT defaults to TLS 1.2+ and IOSv rejects it.
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLSv1)  # type: ignore[attr-defined]
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        # Allow weak ciphers for IOS compatibility (private-lab IPs only).
        ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
        _TLS_CONTEXT = ctx
    return _TLS_CONTEXT


def _extract_csrf(html: str) -> str | None:
    """Pull the CSRF token from a IOS HTTP response page."""
    m = re.search(
        r'csrf_token["\s]+VALUE=["\']([A-F0-9]+)["\']',
        html,
        re.IGNORECASE,
    )
    return m.group(1) if m else None


def _strip_html(text: str) -> str:
    """Strip HTML tags from IOS HTTP response to get plain CLI output."""
    # Replace common HTML entities
    text = (
        text.replace("&#34;", '"')
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&copy;", "(c)")
    )
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Collapse blank lines
    lines = [line.rstrip() for line in text.splitlines()]
    # Remove trailing blank lines
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines).strip()


def _extract_output(html: str) -> str:
    """Extract CLI output from IOS HTTP exec response page.

    The IOSexec HTML wraps command output in a <DL> list. We find the
    content between the hidden command marker and the </DL><HR> block.

    The HTML structure varies slightly across IOS versions:
      <input type="HIDDEN" name="hidden_command" value="...">
      <input type="HIDDEN" name="csrf_token" value="...">
      <DT>output lines...</DT>
      </DL><HR>

    The value between the csrf_token input and </DL> is the CLI output.
    """
    # More permissive: accept optional whitespace after ">".
    m = re.search(
        r'hidden_command[^>]*><INPUT[^>]*csrf_token[^>]*value="([A-F0-9]+)"[^>]*>\s*([\s\S]*?)</DL><HR',
        html,
        re.IGNORECASE,
    )
    if m:
        return _strip_html(m.group(2))
    # Fallback: try stripping all HTML and return raw content.
    return _strip_html(html)


class IOSHttpSession:
    """Thread-safe IOSexec HTTPS session for one device.

    Maintains a cookie jar (to keep the HTTP session alive) and the
    current CSRF token. All operations are serialised via an instance
    lock so we never send concurrent requests (IOS HTTP cannot handle them).
    """

    def __init__(
        self,
        host: str,
        username: str,
        password: str,
        port: int = 443,
    ) -> None:
        self.host = host
        self.username = username
        self.password = password
        self.port = port
        self._base_url = f"https://{host}:{port}"
        self._auth = "Basic " + base64.b64encode(
            f"{username}:{password}".encode()
        ).decode()
        self._ctx = _tls_context()
        self._cj = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._cj),
            urllib.request.HTTPSHandler(context=self._ctx),
        )
        self._opener.addheaders = [("Authorization", self._auth)]
        self._csrf: str | None = None
        self._lock = threading.RLock()
        self._last_request_time = 0.0

    def _fetch_csrf(self) -> str | None:
        """GET /level/15/exec/- to refresh CSRF token and keep session alive."""
        try:
            req = urllib.request.Request(
                f"{self._base_url}/level/15/exec/-",
                headers={"Authorization": self._auth},
            )
            with self._opener.open(req, timeout=10) as r:
                html = r.read().decode("utf-8", errors="replace")
            return _extract_csrf(html)
        except Exception as exc:
            logger.warning("[IOS] CSRF fetch failed for %s: %s", self.host, exc)
            return None

    def exec(self, command: str, timeout: float = 30.0) -> str:
        """Send one IOS CLI command via IOSexec and return plain output.

        If the session has no valid CSRF token, fetches a fresh one first.
        Returns the stripped CLI output (no HTML). Raises on HTTP errors.
        """
        with self._lock:
            # Rate-limit: IOS HTTP can be slow; wait 0.3s between calls.
            elapsed = time.time() - self._last_request_time
            if elapsed < 0.3:
                time.sleep(0.3 - elapsed)

            # Refresh CSRF token if missing or stale.
            if self._csrf is None:
                self._csrf = self._fetch_csrf()
                if self._csrf is None:
                    # Try fetching CSRF one more time after a brief pause.
                    time.sleep(0.5)
                    self._csrf = self._fetch_csrf()
                    if self._csrf is None:
                        raise RuntimeError(
                            f"[IOS] Could not obtain CSRF token from {self.host}; "
                            "is the HTTP interface enabled on the device?"
                        )

            data = urllib.parse.urlencode({
                "command": command,
                "command_url": "/level/15/exec/-",
                "CMD": "Command",
                "csrf_token": self._csrf,
            }).encode()

            req = urllib.request.Request(
                f"{self._base_url}/level/15/exec/-",
                data=data,
                headers={
                    "Authorization": self._auth,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                method="POST",
            )
            try:
                with self._opener.open(req, timeout=timeout) as r:
                    html = r.read().decode("utf-8", errors="replace")
                self._csrf = _extract_csrf(html)  # Update CSRF for next call.
                self._last_request_time = time.time()
                return _extract_output(html)
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")[:200]
                raise RuntimeError(
                    f"[IOS] HTTP {exc.code} on '{command}': {body}"
                ) from exc
            except urllib.error.URLError as exc:
                raise RuntimeError(
                    f"[IOS] Connection error on '{command}': {exc.reason}"
                ) from exc

    def configure(self, commands: list[str], timeout: float = 60.0) -> list[str]:
        """Push configuration commands via IOSexec configure mode.

        Sends all commands in one `conf t` session (exec mode POST with
        `conf=1` in the body). Each command is URL-encoded and joined with
        \\r\\n. Returns the list of CLI output lines across all commands.

        This is the most reliable write path for IOS HTTP because it does
        not depend on knowledge of the configure endpoint URL structure.
        """
        with self._lock:
            if self._csrf is None:
                self._csrf = self._fetch_csrf()
                if self._csrf is None:
                    raise RuntimeError(
                        f"[IOS] Could not obtain CSRF token for configure on {self.host}"
                    )

            # Build the configure-mode body.
            # IOSexec accepts conf=1 to enter configure terminal mode, then
            # accepts a pipeline of commands separated by \n (NOT \r\n — \r is
            # URL-encoded as %0D and conflated with / in the command URL parser,
            # causing "end\r" to be parsed as "end/CR" which IOS rejects).
            all_cmds = ["configure terminal", *commands, "end"]
            encoded_cmds = "\n".join(all_cmds)
            data = urllib.parse.urlencode(
                {
                    "conf": "1",
                    "command": encoded_cmds,
                    "command_url": "/level/15/exec/-",
                    "CMD": "Command",
                    "csrf_token": self._csrf,
                }
            ).encode()

            req = urllib.request.Request(
                f"{self._base_url}/level/15/exec/-",
                data=data,
                headers={
                    "Authorization": self._auth,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                method="POST",
            )
            try:
                with self._opener.open(req, timeout=timeout) as r:
                    html = r.read().decode("utf-8", errors="replace")
                self._csrf = _extract_csrf(html)
                self._last_request_time = time.time()
                output = _extract_output(html)
                return [line for line in output.splitlines() if line.strip()]
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")[:200]
                raise RuntimeError(
                    f"[IOS] Configure HTTP {exc.code}: {body}"
                ) from exc
            except urllib.error.URLError as exc:
                raise RuntimeError(
                    f"[IOS] Configure connection error: {exc.reason}"
                ) from exc

    def probe(self) -> dict[str, bool]:
        """TCP probe: check if port 22 (SSH) and port 443 (HTTPS) are open."""
        import socket

        result: dict[str, bool] = {}
        for port, label in [(22, "ssh"), (443, "https")]:
            try:
                with socket.create_connection((self.host, port), timeout=2) as s:
                    s.settimeout(1)
                    try:
                        banner = s.recv(64).decode("utf-8", errors="replace").strip()
                    except Exception:
                        banner = ""
                    result[label] = True
                    if banner:
                        logger.debug("[IOS] %s port %d banner: %s", self.host, port, banner[:60])
            except (OSError, socket.timeout):
                result[label] = False
        return result


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------

# Cache IOSHttpSession per (host, port) so CSRF tokens survive across calls.
_SESSION_CACHE: dict[tuple[str, int], IOSHttpSession] = {}
_SESSION_CACHE_LOCK = threading.Lock()


def _get_session(device: DeviceInfo, config: Any) -> IOSHttpSession:
    """Return a cached IOSHttpSession for this device, creating one if needed."""
    host = device.ip
    port = config.ios_http.port
    # Credentials: prefer ios_http-specific, fall back to shared SSH creds.
    username = config.ios_http.user or config.ssh_user
    password = config.ios_http.password or config.ssh_password
    key = (host, port)
    with _SESSION_CACHE_LOCK:
        if key not in _SESSION_CACHE:
            _SESSION_CACHE[key] = IOSHttpSession(
                host=host,
                username=username,
                password=password,
                port=port,
            )
        return _SESSION_CACHE[key]


def _clear_session(device: DeviceInfo, config: Any) -> None:
    """Remove the cached session for this device (useful after auth failure)."""
    key = (device.ip, config.ios_http.port)
    with _SESSION_CACHE_LOCK:
        _SESSION_CACHE.pop(key, None)


def _text_to_cmds(config: str) -> list[str]:
    commands: list[str] = []
    for line in config.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("!"):
            continue
        commands.append(stripped)
    return commands


class IOSBackend(DeviceBackend):
    """Cisco IOS (non-XE) backend — IOSexec HTTP API on port 443."""

    source = "ios-http"

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        self._config = config

    # -- READ ---------------------------------------------------------------

    def _exec(self, device: DeviceInfo, cmd: str, timeout: float = 30.0) -> str:
        """Send one CLI command; raise RuntimeError on failure."""
        try:
            session = _get_session(device, self._config)
            return session.exec(cmd, timeout=timeout)
        except Exception as exc:
            _clear_session(device, self._config)
            raise RuntimeError(f"[IOS] exec '{cmd}' failed: {exc}") from exc

    def get_interfaces(self, device: DeviceInfo) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            return {
                "implemented": False,
                "interfaces": [],
                "source": None,
                "message": "IOS_HTTP enabled=false",
            }
        try:
            output = self._exec(device, "show interfaces status", timeout=30)
            interfaces = _parse_ios_interfaces_status(output)
            return {
                "implemented": True,
                "source": "ios-http",
                "command": "show interfaces status",
                "interfaces": interfaces,
                "message": f"IOS HTTP interfaces OK ({len(interfaces)} ports)",
                "raw": output,
            }
        except RuntimeError as exc:
            return {
                "implemented": False,
                "interfaces": [],
                "source": "ios-http",
                "message": str(exc),
            }

    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            return {
                "implemented": False,
                "entries": [],
                "source": None,
                "message": "IOS_HTTP enabled=false",
            }
        try:
            output = self._exec(device, "show ip arp", timeout=30)
            entries = parse_cisco_arp_table(output)
            return {
                "implemented": True,
                "source": "ios-http",
                "command": "show ip arp",
                "entries": entries,
                "message": f"IOS HTTP ARP OK ({len(entries)} entries)",
                "raw": output,
            }
        except RuntimeError as exc:
            return {
                "implemented": False,
                "entries": [],
                "source": "ios-http",
                "message": str(exc),
            }

    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            return {
                "implemented": False,
                "entries": [],
                "source": None,
                "message": "IOS_HTTP enabled=false",
            }
        try:
            output = self._exec(device, "show mac address-table", timeout=30)
            entries = parse_cisco_mac_table(output)
            return {
                "implemented": True,
                "source": "ios-http",
                "command": "show mac address-table",
                "entries": entries,
                "message": f"IOS HTTP MAC OK ({len(entries)} entries)",
                "raw": output,
            }
        except RuntimeError as exc:
            return {
                "implemented": False,
                "entries": [],
                "source": "ios-http",
                "message": str(exc),
            }

    def get_config(self, device: DeviceInfo) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            raise RuntimeError("IOS_HTTP enabled=false")
        try:
            output = self._exec(device, "show running-config", timeout=60)
            hostname = _parse_hostname(output)
            version = _parse_version(output)
            return {
                "implemented": True,
                "source": "ios-http",
                "config": output,
                "command": "show running-config",
                "message": f"Collected running config from {device.name}",
                "hostname": hostname,
                "version": version,
            }
        except RuntimeError as exc:
            raise RuntimeError(f"[IOS] get_config failed: {exc}") from exc

    def get_lldp(self, device: DeviceInfo) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            return {
                "implemented": False,
                "source": None,
                "neighbors": [],
                "message": "IOS_HTTP enabled=false",
            }
        try:
            output = self._exec(device, "show lldp neighbors detail", timeout=30)
            neighbors = _parse_ios_lldp(output)
            return {
                "implemented": True,
                "source": "ios-http",
                "command": "show lldp neighbors detail",
                "neighbors": neighbors,
                "message": f"IOS HTTP LLDP OK ({len(neighbors)} neighbours)",
                "raw": output,
            }
        except RuntimeError as exc:
            return {
                "implemented": False,
                "source": "ios-http",
                "neighbors": [],
                "message": str(exc),
            }

    def probe_identity(self, device: DeviceInfo) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            return {
                "checks": {"ping": False, "ssh": False, "rest": False, "showVersion": False, "showRun": False},
                "showVersion": "",
                "showRun": "",
                "parsed": {"vendor": "Cisco"},
                "source": None,
                "message": "IOS_HTTP enabled=false",
            }
        try:
            session = _get_session(device, self._config)
            probes = session.probe()
            ssh_open = probes.get("ssh", False)
            https_open = probes.get("https", False)

            # Try to get a lightweight identity response via HTTP.
            uptime_output = ""
            parsed: dict[str, Any] = {"vendor": "Cisco"}
            if https_open:
                try:
                    uptime_output = self._exec(device, "show version | include uptime", timeout=10)
                    parsed = _parse_ios_uptime(uptime_output)
                except Exception as exc:
                    logger.debug("[IOS] probe uptime failed for %s: %s", device.ip, exc)

            api_open = https_open  # HTTP API = HTTPS port
            if api_open:
                source = "ios-http"
                message = "IOS HTTP API reachable"
            elif ssh_open:
                source = "ssh-tcp"
                message = "SSH reachable (IOS HTTP not enabled on device)"
            else:
                source = None
                message = "Neither SSH nor IOS HTTP reachable"

            return {
                "checks": {
                    "ping": True,
                    "ssh": ssh_open,
                    "rest": api_open,
                    "showVersion": False,
                    "showRun": False,
                },
                "showVersion": uptime_output,
                "showRun": "",
                "parsed": parsed,
                "source": source,
                "message": message,
            }
        except Exception as exc:
            return {
                "checks": {"ping": False, "ssh": False, "rest": False, "showVersion": False, "showRun": False},
                "showVersion": "",
                "showRun": "",
                "parsed": {"vendor": "Cisco"},
                "source": None,
                "message": f"IOS probe failed: {exc}",
            }

    # -- WRITE --------------------------------------------------------------

    def _ssh_exec_stdin(self, device: DeviceInfo, commands: list[str], timeout: int = 30) -> str:
        """Push commands via SSH stdin (using sshpass + openssh CLI).

        IOS HTTP cannot handle multi-command `configure terminal` payloads
        cleanly (each POST resets CLI mode), so we use SSH for writes.
        paramiko doesn't support the legacy KEX (`diffie-hellman-group1-sha1`)
        used by IOSv 15.x, but the system `ssh` CLI with explicit
        `KexAlgorithms=+` does work.

        The TTY flag (`-tt`) is required because IOS CLI expects a
        pseudo-terminal for `conf t` mode entry; without it, the device
        won't enter configure mode and commands are silently dropped.

        The exit sequence is always:
            conf t
            <user commands>
            end
            exit
        so the SSH session terminates cleanly.
        """
        import subprocess
        import re as _re

        if not commands:
            raise RuntimeError("No commands to execute")

        # Pull credentials from ios_http (preferred) or shared ssh config.
        username = self._config.ios_http.user or self._config.ssh_user
        password = self._config.ios_http.password or self._config.ssh_password

        stdin_payload = "conf t\n" + "\n".join(commands) + "\nend\nexit\n"

        ssh_args = [
            "sshpass", "-p", password, "ssh", "-tt",
            # Legacy KEX — IOSv 15.x only supports DH group1.
            "-o", "KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1",
            "-o", "HostKeyAlgorithms=+ssh-rsa",
            "-o", "Ciphers=+aes128-cbc,3des-cbc,aes128-ctr",
            "-o", "MACs=+hmac-sha1,hmac-md5",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=8",
            "-o", "PreferredAuthentications=password,keyboard-interactive",
            "-l", username, device.ip,
        ]

        try:
            result = subprocess.run(
                ssh_args,
                input=stdin_payload.encode("utf-8"),
                capture_output=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"[IOS] SSH write timed out after {timeout}s") from exc
        except Exception as exc:
            raise RuntimeError(f"[IOS] SSH write failed: {exc}") from exc

        # Strip ANSI escape codes from output.
        ansi_re = _re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
        out = ansi_re.sub("", result.stdout.decode("utf-8", errors="replace"))
        # Strip IOS banner lines.
        skip_keywords = (
            "copyright", "confidential", "supplemental", "by using",
            "exporters", "summary of", "require further", "cisco iosv",
            "agreement", "united states", "iosv software", "ios v",
            "preventing", "this product", "importers, exporters",
            "end user", "added to the list", "warning: permanently",
        )
        lines = [
            line for line in out.splitlines()
            if not any(kw in line.lower() for kw in skip_keywords)
        ]
        cleaned = "\n".join(lines).strip()

        # Check for IOS CLI errors. % at start of line = error.
        for line in cleaned.splitlines():
            stripped = line.strip()
            if stripped.startswith("%") and "invalid" in stripped.lower():
                raise RuntimeError(f"[IOS] Config CLI error: {stripped}")

        return cleaned

    def apply_config(
        self,
        device: DeviceInfo,
        config: str,
        *,
        log: str,
        previous: str | None = None,
    ) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            raise RuntimeError("IOS_HTTP enabled=false")
        commands = _text_to_cmds(config)
        if not commands:
            raise RuntimeError("apply_config has no commands")

        output = self._ssh_exec_stdin(device, commands, timeout=60)
        return {
            "implemented": True,
            "source": "ios-ssh",
            "config": config,
            "commands": commands,
            "outputs": [{"command": "conf t + commands", "output": output}],
            "message": f"Applied {len(commands)} commands to {device.name}",
            "previous": previous or "",
        }

    def rollback_config(
        self,
        device: DeviceInfo,
        rollback_index: int | None,
        previous: str | None = None,
    ) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            raise RuntimeError("IOS_HTTP enabled=false")
        if previous:
            return self.apply_config(
                device, previous, log="", previous=None
            )
        return {
            "implemented": False,
            "source": "ios-http",
            "message": (
                "IOS rollback requires the previous config text. "
                "Apply the previous config manually via console or SSH."
            ),
        }

    def interface_action(
        self,
        device: DeviceInfo,
        *,
        action: str,
        iface: str,
        vlan: str | None,
    ) -> dict[str, Any]:
        if not self._config.ios_http.enabled:
            raise RuntimeError("IOS_HTTP enabled=false")
        try:
            iface = _validate_iface(iface)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc

        if action == "show-run":
            cmd = f"show running-config interface {iface}"
            output = self._exec(device, cmd, timeout=30)
            return {
                "implemented": True,
                "source": "ios-http",
                "action": action,
                "interface": iface,
                "vlan": vlan or None,
                "commands": [cmd],
                "outputs": [{"command": cmd, "output": output}],
                "message": f"show-run for {iface} OK",
                "adminStatus": None,
                "accessVlan": None,
                "config": output,
            }

        # Build the configure commands (no 'configure terminal' / 'end' —
        # _ssh_exec_stdin prepends conf t and appends end automatically).
        if action == "shut":
            commands = [f"interface {iface}", "shutdown"]
        elif action == "no-shut":
            commands = [f"interface {iface}", "no shutdown"]
        elif action == "set-access-vlan":
            if not vlan:
                raise RuntimeError("set-access-vlan requires a vlan argument")
            commands = [
                f"interface {iface}",
                "switchport mode access",
                f"switchport access vlan {vlan}",
            ]
        else:
            raise RuntimeError(f"Unsupported interface action for IOS: {action}")

        output = self._ssh_exec_stdin(device, commands, timeout=30)
        admin = "down" if action == "shut" else "up"
        return {
            "implemented": True,
            "source": "ios-ssh",
            "action": action,
            "interface": iface,
            "vlan": vlan or None,
            "commands": commands,
            "outputs": [{"command": "conf t + commands", "output": output}],
            "message": f"Interface {action} OK on {iface}",
            "adminStatus": admin,
            "accessVlan": vlan if action == "set-access-vlan" else None,
            "config": None,
        }


# ---------------------------------------------------------------------------
# IOS-specific output parsers
# ---------------------------------------------------------------------------

# `show interfaces status` output format:
#   Port      Name  Status       Vlan   Duplex  Speed Type
#   Gi1/0/1   UP    connected    10     a-full a-100 10/100/1000BaseTX
#   Gi1/0/2        notconnect    1        auto   auto 10/100/1000BaseTX
# Columns are separated by 2+ spaces (so the "Name" / description column
# can be empty or contain spaces). The first column is always a single
# token (the interface name like Gi1/0/1).
_IFACE_STATUS_RE = re.compile(
    r"^\s*(?P<name>\S+)\s+(?:(?P<desc>.+?)\s+)?"
    r"(?P<status>connected|notconnect|err-disabled|disabled|up|down|administratively\s+down)\s+"
    r"(?P<vlan>\S+)\s+(?P<duplex>\S+)\s+(?P<speed>\S+)\s*(?P<type>.*?)?\s*$",
    re.IGNORECASE,
)
_STATUS_MAP: dict[str, str] = {
    "connected": "up",
    "notconnect": "down",
    "err-disabled": "down",
    "errdisabled": "down",
    "disabled": "down",
    "up": "up",
    "down": "down",
    "administratively down": "down",
}


def _parse_ios_interfaces_status(output: str) -> list[dict[str, Any]]:
    """Parse `show interfaces status` text output.

    The output columns are:
      Port  Name  Status  Vlan  Duplex  Speed  Type
    Columns are separated by 2+ spaces so the description column can be
    empty (no description) or contain spaces (human-typed description).
    """
    interfaces: list[dict[str, Any]] = []
    lines = output.splitlines()
    started = False
    for raw_line in lines:
        if not started:
            if re.match(r"^Port\s+Name", raw_line.strip(), re.IGNORECASE):
                started = True
            continue
        if not raw_line.strip():
            continue

        m = _IFACE_STATUS_RE.match(raw_line)
        if not m:
            # Try a looser parse — split on whitespace and pick columns by index.
            parts = raw_line.split()
            if len(parts) >= 6:
                # Port Status Vlan Duplex Speed [Type...]
                status_raw = parts[1] if len(parts) > 1 else "unknown"
                desc = ""  # can't determine if missing fields
                # Check if second column looks like a status word
                if status_raw.lower() in _STATUS_MAP:
                    interfaces.append({
                        "name": parts[0],
                        "adminStatus": _STATUS_MAP.get(status_raw.lower(), "unknown"),
                        "operStatus": _STATUS_MAP.get(status_raw.lower(), "unknown"),
                        "description": desc,
                        "mode": "",
                        "accessVlan": parts[2] if len(parts) > 2 else "1",
                        "address": "",
                        "mtu": "",
                        "speed": _parse_speed(parts[4] if len(parts) > 4 else "", ""),
                    })
                else:
                    # Maybe format is: Port Desc Status Vlan Duplex Speed Type
                    # where Desc can be multiple tokens
                    interfaces.append({
                        "name": parts[0],
                        "adminStatus": "unknown",
                        "operStatus": "unknown",
                        "description": "",
                        "mode": "",
                        "accessVlan": "1",
                        "address": "",
                        "mtu": "",
                        "speed": None,
                    })
            continue

        status_raw = m.group("status") or ""
        oper = _STATUS_MAP.get(status_raw.lower(), "unknown")
        desc = (m.group("desc") or "").strip()

        interfaces.append({
            "name": m.group("name"),
            "adminStatus": oper,
            "operStatus": oper,
            "description": desc,
            "mode": "",
            "accessVlan": m.group("vlan") or "1",
            "address": "",
            "mtu": "",
            "speed": _parse_speed(m.group("speed") or "", m.group("duplex") or ""),
        })
    return interfaces


def _parse_speed(speed: str, duplex: str) -> int | None:
    """Parse Cisco speed+duplex strings like 'a-100', 'auto', '1000'."""
    s = speed.strip().lower()
    if s == "auto":
        return None
    # 'a-100' = auto-negotiated 100Mbps; '100' = forced 100Mbps.
    s = s.lstrip("a-").lstrip("a")
    try:
        return int(s)
    except ValueError:
        return None


def _parse_hostname(config: str) -> str | None:
    """Extract hostname from show running-config."""
    for line in config.splitlines():
        stripped = line.strip()
        if stripped.startswith("hostname "):
            return stripped[len("hostname ") :].strip()
    return None


def _parse_version(output: str) -> str | None:
    """Extract Cisco IOS version string from show version output."""
    # Typically the first non-blank line of show version.
    for line in output.splitlines()[:10]:
        stripped = line.strip()
        if stripped.startswith("Cisco IOS Software"):
            return stripped
    return None


def _parse_ios_uptime(output: str) -> dict[str, Any]:
    """Parse `show version | include uptime` into {uptime, uptimeSeconds, vendor}."""
    import re

    parsed: dict[str, Any] = {"vendor": "Cisco"}
    match = re.search(
        r"uptime is\s+(?:(\d+)\s+days?[, ]+)?(\d+)\s+hours?[;, ]+(\d+)\s+minutes?",
        output,
        re.IGNORECASE,
    )
    if match:
        days = int(match.group(1) or 0)
        hours = int(match.group(2))
        mins = int(match.group(3))
        total_seconds = days * 86400 + hours * 3600 + mins * 60
        if total_seconds > 0:
            parsed["uptimeSeconds"] = str(total_seconds)
            if days > 0:
                parsed["uptime"] = f"{days}d {hours:02d}:{mins:02d}"
            else:
                parsed["uptime"] = f"{hours}:{mins:02d}"
    return parsed


# LLDP parser — parses `show lldp neighbors detail` text output.
# Format (per neighbour):
#   ------------------------------------------------
#   Local Interface: Gi1/0/1
#   Chassis ID:     0011.2233.4455
#   Port ID:        GigabitEthernet0/0/1
#   Port Description: Uplink to CORE
#   System Name:    LAB-CORE-01
#   System Description: Cisco IOS Software ...
#   Time remaining: 107
#   Holdtime:       120
#   Capability:     Bridge, Router
_LLDP_ENTRY_RE = re.compile(
    r"Local Interface:\s*(?P<local>\S+)"
    r".*?Chassis ID:\s*(?P<chassis>\S+)"
    r".*?Port ID:\s*(?P<port>\S+)"
    r"(?:.*?Port Description:\s*(?P<port_desc>.*?))?"
    r"(?:.*?System Name:\s*(?P<sysname>\S+))?",
    re.DOTALL,
)


def _parse_ios_lldp(output: str) -> list[dict[str, str]]:
    """Parse `show lldp neighbors detail` into list of neighbour dicts."""
    # Normalise the output: strip blank lines and merge continuation lines.
    lines: list[str] = []
    for line in output.splitlines():
        s = line.strip()
        if s:
            lines.append(s)
    text = " ".join(lines)

    neighbors: list[dict[str, str]] = []
    for m in _LLDP_ENTRY_RE.finditer(text):
        local_port = m.group("local") or ""
        chassis_id = m.group("chassis") or ""
        port_id = m.group("port") or ""
        port_desc = (m.group("port_desc") or "").strip()
        # Prefer the full Port Description (e.g. LINK_TO_SW-F6-DS-01_ge-0/0/5);
        # fall back to Port ID when Description is absent.
        remote_port = port_desc if port_desc else port_id
        remote_device = m.group("sysname") or chassis_id
        neighbors.append({
            "localPort": local_port,
            "remoteDeviceId": remote_device,
            "remotePort": remote_port,
            "chassisId": chassis_id,
        })
    return neighbors
