"""Minimal DHCP relay (UDP 67) for the lab sim when isc-dhcp-relay is absent."""

from __future__ import annotations

import os
import select
import socket
import struct
import subprocess
import sys

DHCP_SERVER_PORT = 67
DHCP_CLIENT_PORT = 68
IP_PKTINFO = getattr(socket, "IP_PKTINFO", 8)


def _log(msg: str) -> None:
    print(f"[dhcp-relay] {msg}", flush=True)


def _iface_ipv4(name: str) -> str | None:
    try:
        out = subprocess.check_output(["ip", "-4", "-o", "addr", "show", "dev", name], text=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    found: list[str] = []
    for token in out.split():
        if "/" in token and token[0].isdigit():
            ip = token.split("/", 1)[0]
            if not ip.startswith("127."):
                found.append(ip)
    for ip in found:
        if not ip.endswith(".254"):
            return ip
    return found[0] if found else None


def _ifindex(name: str) -> int | None:
    path = f"/sys/class/net/{name}/ifindex"
    try:
        with open(path, encoding="utf-8") as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return None


def _name_from_index(idx: int) -> str | None:
    try:
        names = os.listdir("/sys/class/net")
    except OSError:
        return None
    for name in names:
        if _ifindex(name) == idx:
            return name
    return None


def _set_giaddr(pkt: bytearray, ip: str) -> None:
    if len(pkt) < 28:
        return
    if pkt[24:28] == b"\x00\x00\x00\x00":
        pkt[24:28] = socket.inet_aton(ip)
    if pkt[3] < 16:
        pkt[3] = pkt[3] + 1


def _giaddr(pkt: bytes) -> str:
    if len(pkt) < 28:
        return "0.0.0.0"
    return socket.inet_ntoa(pkt[24:28])


def _broadcast(pkt: bytes) -> bool:
    if len(pkt) < 12:
        return True
    flags = struct.unpack("!H", pkt[10:12])[0]
    return bool(flags & 0x8000)


def _yiaddr(pkt: bytes) -> str:
    if len(pkt) < 20:
        return "0.0.0.0"
    return socket.inet_ntoa(pkt[16:20])


def _parse_ifindex(ancdata: list) -> int | None:
    for level, typ, data in ancdata:
        if level == socket.IPPROTO_IP and typ == IP_PKTINFO and len(data) >= 4:
            return struct.unpack("I", data[:4])[0]
    return None


def _client_sock(iface: str, ip: str) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind((ip, DHCP_SERVER_PORT))
    return sock


def _subnet_broadcast(ip: str) -> str:
    parts = ip.split(".")
    return ".".join(parts[:3] + ["255"])


def _send_to_client(sock: socket.socket, pkt: bytes, iface_ip: str) -> None:
    dests = [_subnet_broadcast(iface_ip), "255.255.255.255"]
    yiaddr = _yiaddr(pkt)
    if yiaddr not in {"0.0.0.0", "255.255.255.255"}:
        dests.append(yiaddr)
    last_err: Exception | None = None
    sent = False
    for dest in dests:
        try:
            sock.sendto(pkt, (dest, DHCP_CLIENT_PORT))
            sent = True
        except OSError as exc:
            last_err = exc
    if not sent and last_err:
        raise last_err


def run(server: str, ifaces: list[str]) -> None:
    iface_ip: dict[str, str] = {}
    ip_to_iface: dict[str, str] = {}
    send_socks: dict[str, socket.socket] = {}
    for iface in ifaces:
        ip = _iface_ipv4(iface)
        if not ip:
            _log(f"skip {iface}: no ipv4")
            continue
        iface_ip[iface] = ip
        ip_to_iface[ip] = iface
        send_socks[iface] = _client_sock(iface, ip)
        _log(f"{iface} {ip} -> {server}")

    if not iface_ip:
        raise SystemExit("no relay interfaces")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.IPPROTO_IP, IP_PKTINFO, 1)
    sock.bind(("0.0.0.0", DHCP_SERVER_PORT))

    sock.setblocking(False)
    for extra in send_socks.values():
        extra.setblocking(False)

    watch = [sock, *send_socks.values()]
    sock_iface = {client: iface for iface, client in send_socks.items()}

    while True:
        readable, _, _ = select.select(watch, [], [], 1.0)
        for ready in readable:
            try:
                data, ancdata, _flags, addr = ready.recvmsg(4096, 256)
            except OSError:
                continue
            if len(data) < 28:
                continue
            src_ip = addr[0]
            if src_ip == server:
                iface = sock_iface.get(ready)
                if not iface:
                    giaddr = _giaddr(data)
                    iface = ip_to_iface.get(giaddr)
                if not iface:
                    _log(f"reply giaddr {_giaddr(data)} unmatched")
                    continue
                try:
                    _send_to_client(send_socks[iface], data, iface_ip[iface])
                    _log(f"offer -> {iface} yiaddr={_yiaddr(data)}")
                except OSError as exc:
                    _log(f"client send fail {iface}: {exc}")
                continue

            if ready is not sock:
                continue
            ifindex = _parse_ifindex(ancdata)
            iface = _name_from_index(ifindex) if ifindex is not None else None
            if iface not in iface_ip:
                continue
            pkt = bytearray(data)
            _set_giaddr(pkt, iface_ip[iface])
            try:
                sock.sendto(bytes(pkt), (server, DHCP_SERVER_PORT))
            except OSError as exc:
                _log(f"forward fail: {exc}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: dhcp_relay.py <server> <iface> [iface ...]")
    run(sys.argv[1], sys.argv[2:])
