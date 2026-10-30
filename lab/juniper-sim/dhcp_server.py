#!/usr/bin/env python3
"""Junos extended DHCP local server simulator for the NetConsole lab.

Kea was removed on 2026-10-30 — DHCP now runs on the distribution switch
itself. This module emulates the Junos Evo "extended DHCP local server"
on the containerised distribution switch (`sw-ds-01`):

  set system services dhcp-local-server group <G> interface irb.<vlan>
  set access address-assignment pool <P> family inet network <cidr>
  set access address-assignment pool <P> family inet range <R> low <ip> high <ip>
  set access address-assignment pool <P> family inet dhcp-attributes router <gw>
  set access address-assignment pool <P> family inet dhcp-attributes name-server <dns>

The pool definition is parsed out of the committed running-config
(`/var/lib/netconsole/running.set`) — the same file the REST/CLI simulators
already use — and handed to dnsmasq, which does the actual DHCP serving.

Bindings are read back from dnsmasq's lease file and exposed the same way
the real switch does:

  * RESTCONF  <get-dhcp-server-binding-information><detail/></...>
  * CLI       show dhcp server binding detail
  * CLI       clear dhcp server binding <ip>
  * CLI       clear dhcp server binding interface irb.<vlan>
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from typing import Any

RUNNING_PATH = "/var/lib/netconsole/running.set"
STATE_DIR = "/var/lib/netconsole/dhcp"
CONF_PATH = os.path.join(STATE_DIR, "dnsmasq.conf")
LEASE_PATH = os.path.join(STATE_DIR, "dnsmasq.leases")
PID_PATH = os.path.join(STATE_DIR, "dnsmasq.pid")

# Interface used for each irb unit in the lab distribution switch.
IRB_IFACE = {
    "201": os.environ.get("IRB_201_IF", "eth3"),
    "202": os.environ.get("IRB_202_IF", "eth4"),
    "203": os.environ.get("IRB_203_IF", "eth5"),
    "204": os.environ.get("IRB_204_IF", "eth6"),
}


# ---------------------------------------------------------------------------
# Config parsing
# ---------------------------------------------------------------------------

def _read_running_config() -> str:
    if not os.path.exists(RUNNING_PATH):
        return ""
    try:
        with open(RUNNING_PATH, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def parse_pools(config_text: str) -> list[dict[str, Any]]:
    """Parse `access address-assignment pool` blocks out of a set-format config."""
    pools: dict[str, dict[str, Any]] = {}

    def pool(name: str) -> dict[str, Any]:
        return pools.setdefault(
            name,
            {
                "name": name,
                "network": "",
                "low": "",
                "high": "",
                "router": "",
                "dnsServers": [],
                "leaseTime": 28800,
                "interface": "",
            },
        )

    for raw in config_text.splitlines():
        line = raw.strip()
        m = re.match(
            r"^set access address-assignment pool (\S+) family inet network (\S+)$", line
        )
        if m:
            pool(m.group(1))["network"] = m.group(2)
            continue

        m = re.match(
            r"^set access address-assignment pool (\S+) family inet range \S+ low (\S+) high (\S+)$",
            line,
        )
        if m:
            entry = pool(m.group(1))
            entry["low"] = m.group(2)
            entry["high"] = m.group(3)
            continue

        m = re.match(
            r"^set access address-assignment pool (\S+) family inet dhcp-attributes router (\S+)$",
            line,
        )
        if m:
            pool(m.group(1))["router"] = m.group(2)
            continue

        m = re.match(
            r"^set access address-assignment pool (\S+) family inet dhcp-attributes name-server (\S+)$",
            line,
        )
        if m:
            entry = pool(m.group(1))
            if m.group(2) not in entry["dnsServers"]:
                entry["dnsServers"].append(m.group(2))
            continue

        m = re.match(
            r"^set access address-assignment pool (\S+) family inet dhcp-attributes maximum-lease-time (\d+)$",
            line,
        )
        if m:
            pool(m.group(1))["leaseTime"] = int(m.group(2))
            continue

    # Bind each pool to the irb interface it was configured on.
    groups: dict[str, list[str]] = {}
    for m in re.finditer(
        r"^set system services dhcp-local-server group (\S+) interface irb\.(\d+)$",
        config_text,
        re.M,
    ):
        groups.setdefault(m.group(1), []).append(m.group(2))

    for unit in groups.get("NETCONSOLE-DHCP", []):
        for entry in pools.values():
            network = entry["network"]
            # The pool network's third octet is the VLAN id in the lab layout
            # (10.1.<vlan>.0/24). Fall back to the gateway octet.
            octet = ""
            m = re.match(r"^(\d+)\.(\d+)\.(\d+)\.", network or "")
            if m:
                octet = m.group(3)
            else:
                m = re.match(r"^(\d+)\.(\d+)\.(\d+)\.", entry["router"] or "")
                octet = m.group(3) if m else ""
            if octet == unit:
                entry["interface"] = f"irb.{unit}"

    # Static reservations (`host <name> hardware-address <mac> ip-address <ip>`).
    for m in re.finditer(
        r"^set access address-assignment pool (\S+) family inet host (\S+) "
        r"hardware-address (\S+) ip-address (\S+)$",
        config_text,
        re.M,
    ):
        entry = pool(m.group(1))
        entry.setdefault("hosts", []).append(
            {"name": m.group(2), "mac": m.group(3).lower(), "ip": m.group(4)}
        )

    return [p for p in pools.values() if p["low"] and p["high"]]


def _netmask(cidr: str) -> str:
    try:
        prefix = int(cidr.split("/")[1])
    except (IndexError, ValueError):
        return "255.255.255.0"
    mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF
    return ".".join(str((mask >> shift) & 0xFF) for shift in (24, 16, 8, 0))


# ---------------------------------------------------------------------------
# dnsmasq control
# ---------------------------------------------------------------------------

def write_dnsmasq_conf(pools: list[dict[str, Any]]) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    lines = [
        "# Generated by the NetConsole Junos DHCP local server simulator.",
        f"port=0",
        f"dhcp-range-tag={','.join(p['name'] for p in pools) if pools else 'none'}",
        "dhcp-authoritative",
        "dhcp-leasefile=" + LEASE_PATH,
        "dhcp-lease-max=1000",
        "log-dhcp",
        "log-facility=-",
    ]
    for pool in pools:
        netmask = _netmask(pool["network"] or "10.0.0.0/24")
        tag = pool["name"]
        lines.append(f"dhcp-range={pool['low']},{pool['high']},{netmask},{tag}")
        if pool["router"]:
            lines.append(f"dhcp-option=option:router,{pool['router']}")
        if pool["dnsServers"]:
            lines.append(f"dhcp-option=option:dns-server,{','.join(pool['dnsServers'])}")
        lines.append(f"dhcp-option=option:lease-time,{pool['leaseTime']}")
        for host in pool.get("hosts", []):
            lines.append(f"dhcp-host={host['mac']},{host['ip']},{host['name']},{pool['leaseTime']}")
    # Bind dnsmasq to the interfaces that carry the pool subnets.
    ifaces = []
    for pool in pools:
        unit = pool["interface"].split(".")[-1] if pool["interface"] else ""
        dev = IRB_IFACE.get(unit)
        if dev and dev not in ifaces:
            ifaces.append(dev)
    if ifaces:
        lines.append("interface=" + ",".join(ifaces))
        for dev in ifaces:
            lines.append(f"bind-interfaces")
            break
    text = "\n".join(lines) + "\n"
    with open(CONF_PATH, "w", encoding="utf-8") as handle:
        handle.write(text)
    return text


def _dnsmasq_running() -> bool:
    if not os.path.exists(PID_PATH):
        return False
    try:
        with open(PID_PATH, encoding="utf-8") as handle:
            pid = int(handle.read().strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def start_dnsmasq(pools: list[dict[str, Any]]) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    if not os.path.exists(LEASE_PATH):
        with open(LEASE_PATH, "w", encoding="utf-8") as handle:
            handle.write("")

    write_dnsmasq_conf(pools)

    if _dnsmasq_running():
        # Reload so a new pool config takes effect without dropping the server.
        try:
            with open(PID_PATH, encoding="utf-8") as handle:
                pid = int(handle.read().strip())
            os.kill(pid, signal.SIGHUP)
            return f"dnsmasq reloaded ({len(pools)} pools)"
        except (OSError, ValueError):
            pass

    binary = "/usr/sbin/dnsmasq"
    if not os.path.exists(binary):
        return "dnsmasq not installed in this image — DHCP serving disabled"
    proc = subprocess.Popen(
        [binary, "-C", CONF_PATH, "-k", "-q"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    with open(PID_PATH, "w", encoding="utf-8") as handle:
        handle.write(str(proc.pid))
    return f"dnsmasq started ({len(pools)} pools)"


def stop_dnsmasq() -> None:
    if not os.path.exists(PID_PATH):
        return
    try:
        with open(PID_PATH, encoding="utf-8") as handle:
            pid = int(handle.read().strip())
        os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError):
        pass
    try:
        os.remove(PID_PATH)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Bindings
# ---------------------------------------------------------------------------

def read_leases() -> list[dict[str, Any]]:
    """Read dnsmasq's lease file into binding records."""
    if not os.path.exists(LEASE_PATH):
        return []
    leases: list[dict[str, Any]] = []
    try:
        with open(LEASE_PATH, encoding="utf-8") as handle:
            raw = handle.read()
    except OSError:
        return []

    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        expiry, mac, ip = parts[0], parts[1], parts[2]
        hostname = parts[3] if len(parts) > 3 else "*"
        client_id = parts[4] if len(parts) > 4 else ""
        try:
            expires_epoch = int(expiry)
        except ValueError:
            expires_epoch = 0
        leases.append(
            {
                "ip": ip,
                "mac": mac.lower(),
                "hostname": "" if hostname == "*" else hostname,
                "clientId": client_id,
                "expiresEpoch": expires_epoch,
            }
        )
    return leases


def _pool_for_ip(ip: str, pools: list[dict[str, Any]]) -> dict[str, Any] | None:
    try:
        octets = [int(part) for part in ip.split(".")]
    except ValueError:
        return None
    for pool in pools:
        try:
            low = [int(part) for part in pool["low"].split(".")]
            high = [int(part) for part in pool["high"].split(".")]
        except ValueError:
            continue
        if low[0] == octets[0] and low[1] == octets[1] and low[2] == octets[2]:
            if octets[3] >= low[3] and octets[3] <= high[3]:
                return pool
    return None


def bindings_for_interface(interface: str) -> list[dict[str, Any]]:
    """Bindings whose pool is bound to `interface` (e.g. "irb.201")."""
    pools = parse_pools(_read_running_config())
    out = []
    for lease in read_leases():
        pool = _pool_for_ip(lease["ip"], pools)
        if pool and pool["interface"] == interface:
            lease = dict(lease)
            lease["poolName"] = pool["name"]
            out.append(lease)
    return out


def clear_binding(ip: str) -> bool:
    """Remove one binding from the lease file (dnsmasq keeps serving it)."""
    if not os.path.exists(LEASE_PATH):
        return False
    try:
        with open(LEASE_PATH, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return False

    kept = [line for line in lines if len(line.split()) < 3 or line.split()[2] != ip]
    changed = len(kept) != len(lines)
    if changed:
        with open(LEASE_PATH, "w", encoding="utf-8") as handle:
            handle.write("\n".join(kept) + ("\n" if kept else ""))
    return changed


def clear_bindings_for_interface(interface: str) -> int:
    pools = parse_pools(_read_running_config())
    count = 0
    for lease in read_leases():
        pool = _pool_for_ip(lease["ip"], pools)
        if pool and pool["interface"] == interface:
            if clear_binding(lease["ip"]):
                count += 1
    return count


# ---------------------------------------------------------------------------
# Junos-shaped output
# ---------------------------------------------------------------------------

def _fmt_utc(epoch: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(epoch))


def bindings_text() -> str:
    """`show dhcp server binding detail` output."""
    pools = parse_pools(_read_running_config())
    leases = read_leases()
    if not leases:
        return "Total number of leases: 0\n"

    out = []
    for index, lease in enumerate(sorted(leases, key=lambda item: _ip_key(item["ip"])), start=1):
        pool = _pool_for_ip(lease["ip"], pools) or {}
        remaining = max(0, lease["expiresEpoch"] - int(time.time()))
        expires = _fmt_utc(lease["expiresEpoch"]) if lease["expiresEpoch"] else "-"
        started = _fmt_utc(lease["expiresEpoch"] - pool.get("leaseTime", 28800)) if lease["expiresEpoch"] else "-"
        interface = pool.get("interface", "")
        client_iface = f"{interface}:xe-0/0/{index}.0" if interface else ""
        out.append(
            f"Client IP Address:  {lease['ip']}\n"
            f"       Hardware Address:             {lease['mac']}\n"
            f"                State:                        BOUND(LOCAL_SERVER_STATE_BOUND)\n"
            f"           Lease Expires:                {expires}\n"
            f"      Lease Expires in:             {remaining} seconds\n"
            f"           Lease Start:                  {started}\n"
            f"Incoming Client Interface:    {client_iface}\n"
            f"       Server Identifier:            {pool.get('router', '')}\n"
            f"              Session Id:                   {index}\n"
            f"          Client Pool Name:             {pool.get('name', '')}\n"
        )
    out.append(f"Total number of leases: {len(leases)}")
    return "\n".join(out) + "\n"


def _ip_key(ip: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in ip.split("."))
    except ValueError:
        return (0, 0, 0, 0)


def bindings_xml() -> str:
    """RESTCONF `<get-dhcp-server-binding-information><detail/></...>` reply."""
    pools = parse_pools(_read_running_config())
    leases = read_leases()
    entries = []
    for index, lease in enumerate(sorted(leases, key=lambda item: _ip_key(item["ip"])), start=1):
        pool = _pool_for_ip(lease["ip"], pools) or {}
        remaining = max(0, lease["expiresEpoch"] - int(time.time()))
        interface = pool.get("interface", "")
        client_iface = f"{interface}:xe-0/0/{index}.0" if interface else ""
        entries.append(
            "<dhcp-binding>"
            f"<allocated-address>{lease['ip']}</allocated-address>"
            f"<mac-address>{lease['mac']}</mac-address>"
            f"<hostname>{lease['hostname']}</hostname>"
            "<lease-state>BOUND</lease-state>"
            f"<lease-expires>{remaining}</lease-expires>"
            f"<lease-start-time>{_fmt_utc(lease['expiresEpoch'] - pool.get('leaseTime', 28800)) if lease['expiresEpoch'] else ''}</lease-start-time>"
            f"<lease-end-time>{_fmt_utc(lease['expiresEpoch']) if lease['expiresEpoch'] else ''}</lease-end-time>"
            f"<interface-name>{client_iface}</interface-name>"
            f"<server-ip-address>{pool.get('router', '')}</server-ip-address>"
            f"<pool-name>{pool.get('name', '')}</pool-name>"
            f"<session-id>{index}</session-id>"
            "</dhcp-binding>"
        )
    body = "".join(entries)
    return (
        '<rpc-reply xmlns:junos="http://xml.juniper.net/junos/20.3R1/junos-dhcp-server">'
        '<dhcp-binding-information>'
        f"{body}"
        "</dhcp-binding-information>"
        "</rpc-reply>"
    )


def pools_xml() -> str:
    """RESTCONF `<get-configuration>` reply for `access address-assignment`."""
    pools = parse_pools(_read_running_config())
    blocks = []
    for pool in pools:
        hosts = "".join(
            "<host>"
            f"<name>{host['name']}</name>"
            f"<hardware-address>{host['mac']}</hardware-address>"
            f"<ip-address>{host['ip']}</ip-address>"
            "</host>"
            for host in pool.get("hosts", [])
        )
        dns = "".join(f"<name-server><name>{server}</name></name-server>" for server in pool["dnsServers"])
        router = f"<router><name>{pool['router']}</name></router>" if pool["router"] else ""
        blocks.append(
            "<pool>"
            f"<name>{pool['name']}</name>"
            "<family><inet>"
            f"<network>{pool['network']}</network>"
            f"<range><name>{pool['name']}R</name><low>{pool['low']}</low><high>{pool['high']}</high></range>"
            "<dhcp-attributes>"
            f"<maximum-lease-time>{pool['leaseTime']}</maximum-lease-time>"
            f"{dns}{router}"
            "</dhcp-attributes>"
            f"{hosts}"
            "</inet></family>"
            "</pool>"
        )
    body = "".join(blocks)
    return (
        '<configuration xmlns:junos="http://xml.juniper.net/junos/20.3R1/junos-config">'
        "<access><address-assignment>"
        f"{body}"
        "</address-assignment></access>"
        "</configuration>"
    )


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def refresh() -> str:
    """Re-read the running config and restart/reload dnsmasq accordingly."""
    pools = parse_pools(_read_running_config())
    if not pools:
        stop_dnsmasq()
        return "no DHCP pools configured — DHCP server stopped"
    return start_dnsmasq(pools)


def cli_command(command: str) -> str | None:
    """Handle the DHCP-related operational commands. Returns None if unhandled."""
    text = command.strip()
    lower = text.lower()

    if lower in {"show dhcp server binding", "show dhcp server binding detail"}:
        return bindings_text()

    if lower.startswith("clear dhcp server binding "):
        target = text[len("clear dhcp server binding ") :].strip()
        if target.lower().startswith("interface "):
            interface = target[len("interface ") :].strip()
            count = clear_bindings_for_interface(interface)
            return f"Cleared {count} binding(s) on {interface}\n"
        if clear_binding(target):
            return f"Cleared binding for {target}\n"
        return f"No binding for specified IP address {target}\n"

    if lower in {"show dhcp server statistics", "show dhcp server statistics detail"}:
        pools = parse_pools(_read_running_config())
        leases = read_leases()
        return (
            "DHCP server statistics:\n"
            f"  pools: {len(pools)}\n"
            f"  leases: {len(leases)}\n"
        )

    return None
