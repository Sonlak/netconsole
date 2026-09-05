from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)


def _quiet_close(client: httpx.Client) -> None:
    try:
        client.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("httpx.Client close failed: %s", exc)

RPC_MAC_TABLE = "get-ethernet-switching-table-information"
RPC_ARP_TABLE = "get-arp-table-information"
RPC_INTERFACE_INFO = "get-interface-information"
RPC_SYSTEM_INFO = "get-system-information"
RPC_SOFTWARE_INFO = "get-software-information"
RPC_CHASSIS_INV = "get-chassis-inventory"
RPC_SYSTEM_UPTIME = "get-system-uptime-information"
RPC_CONFIGURATION = "get-configuration"
RPC_VLAN_INFO = "get-vlan-information"
RPC_LOG_INFORMATION = "get-log-information"

# --- REST pool ----------------------------------------------------------------


@dataclass
class _PooledREST:
    client: httpx.Client
    created_at: float = field(default_factory=time.monotonic)
    use_count: int = 0
    last_used: float = field(default_factory=time.monotonic)


class JunosRESTPool:
    """Thread-safe httpx.Client pool keyed by (host, port, username, scheme).

    Keeps one persistent HTTP/1.1 connection per device so load+commit on the
    same host reuse the same socket — no TCP handshake or HTTP Basic auth
    round-trip on every RPC call.  A background reaper evicts connections idle
    for more than `idle_seconds` (default 10 min) to keep the pool bounded.
    """

    def __init__(
        self,
        idle_seconds: float = 600.0,
        reap_interval: float = 60.0,
        connect_timeout: float = 5.0,
    ) -> None:
        self._lock = threading.Lock()
        self._pool: dict[tuple[str, int, str, str], _PooledREST] = {}
        self._idle_seconds = idle_seconds
        self._reap_interval = reap_interval
        self._connect_timeout = connect_timeout
        self._stop_reaper = threading.Event()
        self._reaper = threading.Thread(
            target=self._reap_loop, daemon=True, name="rest-pool-reaper"
        )
        self._reaper.start()
        self.stats = {"borrows": 0, "opens": 0, "reuses": 0, "closes": 0, "evictions": 0}

    # ------------------------------------------------------------------
    # Background reaper
    # ------------------------------------------------------------------
    def _reap_loop(self) -> None:
        while not self._stop_reaper.wait(self._reap_interval):
            now = time.monotonic()
            with self._lock:
                for key in list(self._pool):
                    entry = self._pool[key]
                    if now - entry.last_used > self._idle_seconds:
                        try:
                            _quiet_close(entry.client)
                        except Exception:  # noqa: BLE001
                            logger.debug("reaper close failed")
                        del self._pool[key]
                        self.stats["evictions"] += 1
                        self.stats["closes"] += 1

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def borrow(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        scheme: str,
        verify_tls: bool,
        timeout: float = 45.0,
    ) -> httpx.Client:
        key = (host, port, username, scheme)
        with self._lock:
            entry = self._pool.get(key)
            if entry is not None:
                # Quick alive-check: send a tiny request. If the underlying
                # socket is closed by the lab firewall, is_active() lies and
                # we get a blank output on the next real command.
                try:
                    entry.client.get(
                        f"{scheme}://{host}:{port}/rpc",
                        timeout=httpx.Timeout(self._connect_timeout, connect=self._connect_timeout),
                        headers={"Accept": "application/xml"},
                    )
                    entry.use_count += 1
                    entry.last_used = time.monotonic()
                    self.stats["borrows"] += 1
                    self.stats["reuses"] += 1
                    return entry.client
                except Exception as exc:  # noqa: BLE001
                    # socket dead — fall through to open a fresh client
                    logger.debug("rest-pool alive check failed: %s", exc)
                    _quiet_close(entry.client)
                    self.stats["closes"] += 1
                    del self._pool[key]

            # Open a new client
            client = httpx.Client(
                auth=(username, password),
                verify=verify_tls,
                timeout=httpx.Timeout(timeout, connect=self._connect_timeout),
                headers={"Accept": "application/xml", "Content-Type": "application/xml"},
            )
            entry = _PooledREST(client=client)
            self._pool[key] = entry
            entry.use_count = 1
            entry.last_used = time.monotonic()
            self.stats["borrows"] += 1
            self.stats["opens"] += 1
            return client

    def invalidate(self, host: str, port: int, username: str, scheme: str) -> None:
        key = (host, port, username, scheme)
        with self._lock:
            entry = self._pool.pop(key, None)
            if entry is not None:
                _quiet_close(entry.client)
                self.stats["closes"] += 1
                self.stats["evictions"] += 1

    def close(self) -> None:
        self._stop_reaper.set()
        with self._lock:
            for entry in self._pool.values():
                _quiet_close(entry.client)
            self._pool.clear()


# Module-level singleton pool (lazy init so config is available)
_pool: JunosRESTPool | None = None
_pool_lock = threading.Lock()


def get_rest_pool() -> JunosRESTPool:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = JunosRESTPool()
    return _pool


# --- Helpers ------------------------------------------------------------------


def compact_raw(raw: str, limit: int = 4000) -> str:
    text = raw or ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]..."


def _extract_xml_body(text: str) -> str:
    body = (text or "").strip()
    if not body:
        return ""
    if body.startswith("--"):
        start = body.find("\n<")
        if start < 0:
            start = body.find("<")
            if start < 0:
                return body
            body = body[start:]
        else:
            body = body[start + 1 :]
        end = body.find("\n--")
        if end >= 0:
            body = body[:end]
        return body.strip()
    return body


def _xml_leaf(text: str, name: str) -> str:
    import html
    import re

    match = re.search(
        rf"<(?:[\w.-]+:)?{re.escape(name)}(?:\s[^>]*)?>([^<]*)</(?:[\w.-]+:)?{re.escape(name)}>",
        text,
        re.IGNORECASE,
    )
    if not match:
        return ""
    return html.unescape(match.group(1)).strip()


def _format_one_junos_error(block: str) -> str:
    message = _xml_leaf(block, "message") or _xml_leaf(block, "error-message") or "Junos error"
    token = _xml_leaf(block, "token") or _xml_leaf(block, "error-token")
    path = _xml_leaf(block, "edit-path") or _xml_leaf(block, "error-path")
    statement = _xml_leaf(block, "statement")
    parts = [message]
    if token:
        parts.append(f"at '{token}'")
    if path:
        parts.append(f"in {path}")
    if statement:
        parts.append(f"-- {statement}")
    return " ".join(parts)


def format_junos_rpc_error(text: str) -> str | None:
    """Turn Junos <xnm:error> / <rpc-error> XML into a readable one-line message."""
    import re

    lowered = (text or "").lower()
    if "<xnm:error" not in lowered and "<rpc-error" not in lowered and "<error-message>" not in lowered:
        return None

    blocks = re.findall(
        r"<xnm:error\b[\s\S]*?</xnm:error>|<rpc-error\b[\s\S]*?</rpc-error>",
        text,
        re.IGNORECASE,
    )
    formatted = [_format_one_junos_error(block) for block in blocks]
    formatted = [item for item in formatted if item]
    if formatted:
        unique: list[str] = []
        for item in formatted:
            if item not in unique:
                unique.append(item)
        return " · ".join(unique[:6])

    message = _xml_leaf(text, "message") or _xml_leaf(text, "error-message")
    return message or "Junos RPC error"


def _rpc_error_message(text: str) -> str | None:
    return format_junos_rpc_error(text)


def _httpx_timeout(seconds: float, connect: float = 5.0) -> httpx.Timeout:
    """Create an httpx.Timeout with a configurable connect timeout.

    Previously capped connect at 1.5 s (min(1.5, max(0.4, seconds))).
    The Junos sim on the lab bridge can spike to 10-20 s on a single RPC,
    so we now default connect to 5 s — enough to survive the spike without
    hanging indefinitely on a genuinely dead device.
    """
    return httpx.Timeout(seconds, connect=min(connect, seconds))


def _fetch_with_retry(
    host: str,
    rpc: str,
    *,
    username: str,
    password: str,
    scheme: str,
    port: int,
    verify_tls: bool,
    timeout: float,
    client: httpx.Client,
) -> dict[str, Any]:
    """Call fetch_junos_rpc once; retry on transient timeout/connect errors.

    Junos sim and lab bridge can spike to 30-40 s latency on a single RPC.
    A quick retry cheaply papers over the spike without raising the timeout so
    much that genuine dead devices block the worker.
    """
    attempts = 3
    last: dict[str, Any] | None = None
    for i in range(attempts):
        result = fetch_junos_rpc(
            host, rpc,
            username=username, password=password,
            scheme=scheme, port=port, verify_tls=verify_tls,
            timeout=timeout, client=client,
        )
        if result["ok"]:
            return result
        last = result
        text = str(result.get("error") or "").lower()
        transient = any(
            token in text
            for token in ("timeout", "timed out", "connect", "refrefused", "unreachable", "network")
        )
        if not transient:
            return result
        if i < attempts - 1:
            import time as _time

            _time.sleep(1.0 * (i + 1))  # 1 s, 2 s backoff (was 0.5 s)
    return last if last else {"ok": False, "error": "unknown"}


def fetch_junos_rpc(
    host: str,
    rpc: str,
    *,
    username: str = "",
    password: str = "",
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 20.0,
    accept: str = "application/xml",
    params: dict[str, str] | None = None,
    body: str | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Call a Junos REST RPC endpoint and return JSON/XML payload.

    `username`/`password` are only required when no pooled `client` is
    supplied (in which case we open a one-shot authenticated client).
    """
    base = f"{scheme}://{host}:{port}".rstrip("/")
    url = f"{base}/rpc/{rpc}"
    if params:
        query = urlencode(params)
        url = f"{url}?{query}"

    owns_client = client is None
    if client is None:
        if not username or not password:
            return {
                "ok": False,
                "statusCode": None,
                "payload": None,
                "raw": "",
                "error": "fetch_junos_rpc: need username+password when no pooled client is provided",
            }
        client = httpx.Client(
            auth=(username, password),
            verify=verify_tls,
            timeout=_httpx_timeout(timeout),
            headers={"Accept": accept, "Content-Type": "application/xml"},
        )

    try:
        if body is not None:
            response = client.post(f"{base}/rpc", content=body)
        else:
            response = client.get(url)
            if response.status_code == 405:
                response = client.post(url)

        raw = _extract_xml_body(response.text)
        rpc_error = _rpc_error_message(raw) if raw else None
        if rpc_error:
            return {
                "ok": False,
                "statusCode": response.status_code,
                "payload": raw,
                "raw": raw,
                "error": rpc_error,
            }

        response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        payload: Any
        if "json" in content_type and not raw.lstrip().startswith("<"):
            payload = response.json()
        else:
            try:
                payload = response.json() if "json" in content_type else raw
            except Exception:  # noqa: BLE001
                payload = raw

        if isinstance(payload, str):
            payload = _extract_xml_body(payload)

        return {
            "ok": True,
            "statusCode": response.status_code,
            "payload": payload,
            "raw": raw,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - device boundary
        return {
            "ok": False,
            "statusCode": None,
            "payload": None,
            "raw": "",
            "error": str(exc),
        }
    finally:
        if owns_client:
            client.close()


def post_junos_rpc(
    host: str,
    body: str,
    *,
    username: str = "",
    password: str = "",
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 30.0,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """POST a Junos RPC body.

    When a pooled `client` is supplied we reuse its existing TLS+Basic-auth
    session (created via JunosRESTPool.borrow) and do NOT need the per-call
    `username`/`password` parameters. Falls back to creating a one-shot
    httpx.Client when no pooled client is provided.
    """
    return fetch_junos_rpc(
        host,
        "",
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
        body=body,
        client=client,
    )


def fetch_interface_configuration(
    host: str,
    iface: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 30.0,
) -> dict[str, Any]:
    from netconsole_worker.parsers.interface_set import split_interface, xml_escape

    physical, _unit = split_interface(iface)
    name = xml_escape(physical)
    return post_junos_rpc(
        host,
        (
            '<get-configuration format="set"><configuration><interfaces><interface>'
            f"<name>{name}</name></interface></interfaces></configuration></get-configuration>"
        ),
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
    )


def fetch_interfaces_set_config(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 20.0,
) -> dict[str, Any]:
    return post_junos_rpc(
        host,
        '<get-configuration format="set"><configuration><interfaces/></configuration></get-configuration>',
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
    )


def apply_set_configuration(
    host: str,
    commands: list[str],
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 45.0,
    log: str = "NetConsole interface action",
    _pool: JunosRESTPool | None = None,
) -> dict[str, Any]:
    """Load + commit a set of Junos CLI commands via RESTCONF.

    Now borrows an httpx.Client from JunosRESTPool so the same TCP+TLS
    connection is reused across the load and commit RPCs, and across
    consecutive interface actions to the same device.  Connect timeout
    is 5 s (was 1.5 s) to avoid premature retries when Junos is slow.
    """
    import time as _time
    from xml.sax.saxutils import escape

    _ = log

    set_text = "\n".join(commands) + "\n"
    load_body = (
        '<load-configuration action="set" format="text">'
        f"<configuration-set>\n{escape(set_text)}</configuration-set>"
        "</load-configuration>"
    ).encode()

    # Borrow (or open) a pooled client
    if _pool is None:
        _pool = get_rest_pool()
    client = _pool.borrow(
        host, port, username, password, scheme, verify_tls, timeout=timeout
    )

    # load RPC
    load_started = _time.perf_counter()
    loaded = post_junos_rpc(host, load_body.decode(), client=client)
    load_ms = int((_time.perf_counter() - load_started) * 1000)
    load_raw = loaded.get("raw") or ""
    if not loaded["ok"] or "<xnm:error" in load_raw.lower() or "<load-success" not in load_raw:
        detail = format_junos_rpc_error(load_raw) or loaded.get("error") or "load-configuration failed"
        return {
            "ok": False,
            "stage": "load",
            "error": f"load failed: {detail}",
            "raw": load_raw,
            "loadMs": load_ms,
            "commitMs": 0,
        }

    # commit RPC — reuse the same pooled client
    commit_started = _time.perf_counter()
    commit = post_junos_rpc(host, "<commit-configuration/>", client=client)
    commit_ms = int((_time.perf_counter() - commit_started) * 1000)
    commit_raw = commit.get("raw") or ""
    if not commit["ok"] or "<commit-success" not in commit_raw:
        # Rollback on failed commit
        post_junos_rpc(host, "<discard-changes/>", client=client)
        detail = format_junos_rpc_error(commit_raw) or commit.get("error") or "commit-configuration failed"
        return {
            "ok": False,
            "stage": "commit",
            "error": f"commit failed: {detail}",
            "raw": commit_raw,
            "loadMs": load_ms,
            "commitMs": commit_ms,
        }

    return {
        "ok": True,
        "stage": "commit",
        "error": None,
        "raw": f"{load_raw}\n{commit_raw}",
        "loadMs": load_ms,
        "commitMs": commit_ms,
    }


def rollback_configuration(
    host: str,
    *,
    rollback: int = 1,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 45.0,
) -> dict[str, Any]:
    index = max(0, min(int(rollback), 49))
    load_body = f"<load-configuration><rollback>{index}</rollback></load-configuration>"
    common = {
        "username": username,
        "password": password,
        "scheme": scheme,
        "port": port,
        "verify_tls": verify_tls,
        "timeout": timeout,
    }
    pool = get_rest_pool()
    client = pool.borrow(host, port, username, password, scheme, verify_tls, timeout=timeout)
    loaded = post_junos_rpc(host, load_body, client=client, **common)
    load_raw = loaded.get("raw") or ""
    if not loaded["ok"] or "<xnm:error" in load_raw.lower():
        detail = format_junos_rpc_error(load_raw) or loaded.get("error") or "rollback load failed"
        return {
            "ok": False,
            "stage": "load",
            "error": f"rollback load failed: {detail}",
            "raw": load_raw,
        }

    commit = post_junos_rpc(host, "<commit-configuration/>", client=client)
    commit_raw = commit.get("raw") or ""
    if not commit["ok"] or "<commit-success" not in commit_raw:
        post_junos_rpc(host, "<discard-changes/>", client=client)
        detail = format_junos_rpc_error(commit_raw) or commit.get("error") or "rollback commit failed"
        return {
            "ok": False,
            "stage": "commit",
            "error": f"rollback commit failed: {detail}",
            "raw": commit_raw,
        }

    return {
        "ok": True,
        "stage": "commit",
        "error": None,
        "raw": f"{load_raw}\n{commit_raw}",
    }


def fetch_ethernet_switching_table(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 20.0,
) -> dict[str, Any]:
    return fetch_junos_rpc(
        host,
        RPC_MAC_TABLE,
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
    )


def fetch_arp_table(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 20.0,
) -> dict[str, Any]:
    return fetch_junos_rpc(
        host,
        RPC_ARP_TABLE,
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
    )


def fetch_interface_information(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 30.0,
) -> dict[str, Any]:
    return fetch_junos_rpc(
        host,
        RPC_INTERFACE_INFO,
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
        params={"terse": ""},
    )


def fetch_vlan_information(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 20.0,
) -> dict[str, Any]:
    return fetch_junos_rpc(
        host,
        RPC_VLAN_INFO,
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
    )


def fetch_log_information(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 30.0,
    filename: str | None = None,
) -> dict[str, Any]:
    """Fetch `show log messages` (or a specific log filename) via RESTCONF."""
    params: dict[str, str] = {}
    if filename:
        params["filename"] = filename
    return fetch_junos_rpc(
        host,
        RPC_LOG_INFORMATION,
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
        params=params or None,
    )


def fetch_configuration(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 30.0,
) -> dict[str, Any]:
    return fetch_junos_rpc(
        host,
        RPC_CONFIGURATION,
        username=username,
        password=password,
        scheme=scheme,
        port=port,
        verify_tls=verify_tls,
        timeout=timeout,
        accept="application/xml",
        body='<get-configuration format="set"/>',
    )


def _probe_is_dead(result: dict[str, Any]) -> bool:
    status = result.get("statusCode")
    if isinstance(status, int) and status != 405 and status < 500:
        return True
    text = str(result.get("error") or "").lower()
    return any(
        token in text
        for token in ("timeout", "timed out", "connect", "refused", "unreachable", "name or service", "network")
    )


def probe_device_identity(
    host: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Read hostname/model/version/serial via Junos REST RPCs."""
    from netconsole_worker.parsers.device_identity_rpc import (
        parse_chassis_serial,
        parse_system_or_software_info,
        parse_system_uptime,
    )

    fields: dict[str, str] = {"vendor": "Juniper"}
    errors: list[str] = []
    raw_parts: list[str] = []
    pool = get_rest_pool()
    client = pool.borrow(host, port, username, password, scheme, verify_tls, timeout=timeout)
    common = {
        "username": username,
        "password": password,
        "scheme": scheme,
        "port": port,
        "verify_tls": verify_tls,
        "timeout": timeout,
        "accept": "application/xml",
    }

    system = fetch_junos_rpc(host, RPC_SYSTEM_INFO, client=client, **common)
    if system["ok"]:
        fields.update({k: v for k, v in parse_system_or_software_info(system["payload"] or system["raw"]).items() if v})
        raw_parts.append(system.get("raw") or "")
    else:
        errors.append(f"get-system-information: {system['error']}")
        if _probe_is_dead(system):
            return {
                "ok": False,
                "fields": fields,
                "raw": "",
                "error": system.get("error") or "Junos REST unreachable",
            }
        software = fetch_junos_rpc(host, RPC_SOFTWARE_INFO, client=client, **common)
        if software["ok"]:
            fields.update({k: v for k, v in parse_system_or_software_info(software["payload"] or software["raw"]).items() if v})
            raw_parts.append(software.get("raw") or "")
        else:
            errors.append(f"get-software-information: {software['error']}")
            if _probe_is_dead(software):
                return {
                    "ok": False,
                    "fields": fields,
                    "raw": "",
                    "error": software.get("error") or system.get("error") or "Junos REST unreachable",
                }

    if not fields.get("serial"):
        chassis = fetch_junos_rpc(host, RPC_CHASSIS_INV, client=client, **common)
        if chassis["ok"]:
            serial = parse_chassis_serial(chassis["payload"] or chassis["raw"])
            if serial:
                fields["serial"] = serial
            raw_parts.append(chassis.get("raw") or "")
        else:
            errors.append(f"get-chassis-inventory: {chassis['error']}")

    if fields.get("hostname") or fields.get("model") or fields.get("serial"):
        uptime = fetch_junos_rpc(host, RPC_SYSTEM_UPTIME, client=client, **common)
        if uptime["ok"]:
            fields.update({k: v for k, v in parse_system_uptime(uptime["payload"] or uptime["raw"]).items() if v})
            raw_parts.append(uptime.get("raw") or "")

    ok = bool(fields.get("hostname") or fields.get("model") or fields.get("serial"))
    return {
        "ok": ok,
        "fields": fields,
        "raw": "\n".join(part for part in raw_parts if part),
        "error": None if ok else ("; ".join(errors) or "Junos REST identity probe failed"),
    }
