from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import httpx

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
        # Keep a handful so the UI stays readable when Junos returns a stack of errors.
        unique: list[str] = []
        for item in formatted:
            if item not in unique:
                unique.append(item)
        return " · ".join(unique[:6])

    message = _xml_leaf(text, "message") or _xml_leaf(text, "error-message")
    return message or "Junos RPC error"


def _rpc_error_message(text: str) -> str | None:
    return format_junos_rpc_error(text)


def _httpx_timeout(seconds: float) -> httpx.Timeout:
    connect = min(1.5, max(0.4, seconds))
    return httpx.Timeout(seconds, connect=connect)


def fetch_junos_rpc(
    host: str,
    rpc: str,
    *,
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 20.0,
    accept: str = "application/xml",
    params: dict[str, str] | None = None,
    body: str | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Call a Junos REST RPC endpoint and return JSON/XML payload."""
    base = f"{scheme}://{host}:{port}".rstrip("/")
    url = f"{base}/rpc/{rpc}"
    if params:
        query = urlencode(params)
        url = f"{url}?{query}"

    owns_client = client is None
    if client is None:
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
    username: str,
    password: str,
    scheme: str = "https",
    port: int = 8443,
    verify_tls: bool = False,
    timeout: float = 30.0,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
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
) -> dict[str, Any]:
    import time
    from xml.sax.saxutils import escape

    _ = log

    set_text = "\n".join(commands) + "\n"
    load_body = (
        '<load-configuration action="set" format="text">'
        f"<configuration-set>\n{escape(set_text)}</configuration-set>"
        "</load-configuration>"
    )
    common = {
        "username": username,
        "password": password,
        "scheme": scheme,
        "port": port,
        "verify_tls": verify_tls,
        "timeout": timeout,
    }
    with httpx.Client(
        auth=(username, password),
        verify=verify_tls,
        timeout=timeout,
        headers={"Accept": "application/xml", "Content-Type": "application/xml"},
    ) as client:
        load_started = time.perf_counter()
        loaded = post_junos_rpc(host, load_body, client=client, **common)
        load_ms = int((time.perf_counter() - load_started) * 1000)
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

        commit_started = time.perf_counter()
        commit = post_junos_rpc(
            host,
            "<commit-configuration/>",
            client=client,
            **common,
        )
        commit_ms = int((time.perf_counter() - commit_started) * 1000)
        commit_raw = commit.get("raw") or ""
        if not commit["ok"] or "<commit-success" not in commit_raw:
            post_junos_rpc(host, "<discard-changes/>", client=client, **common)
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
    with httpx.Client(
        auth=(username, password),
        verify=verify_tls,
        timeout=timeout,
        headers={"Accept": "application/xml", "Content-Type": "application/xml"},
    ) as client:
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

        commit = post_junos_rpc(
            host,
            "<commit-configuration/>",
            client=client,
            **common,
        )
        commit_raw = commit.get("raw") or ""
        if not commit["ok"] or "<commit-success" not in commit_raw:
            post_junos_rpc(host, "<discard-changes/>", client=client, **common)
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
    timeout: float = 30.0,
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
    common = {
        "username": username,
        "password": password,
        "scheme": scheme,
        "port": port,
        "verify_tls": verify_tls,
        "timeout": timeout,
        "accept": "application/xml",
    }

    with httpx.Client(
        auth=(username, password),
        verify=verify_tls,
        timeout=_httpx_timeout(timeout),
        headers={"Accept": "application/xml", "Content-Type": "application/xml"},
    ) as client:
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
