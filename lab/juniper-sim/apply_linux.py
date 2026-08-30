"""Apply committed Junos set-config onto Linux dataplane (lab sim)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess


def _run(cmd: list[str]) -> str:
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return ((completed.stdout or "") + (completed.stderr or "")).strip()


def _ge_to_eth(name: str) -> str | None:
    m = re.match(r"^ge-0/0/(\d+)$", name)
    if m:
        return f"eth{m.group(1)}"
    if name in {"me0", "fxp0"}:
        return "eth0"
    if name in {"lo0", "lo"}:
        return "lo"
    return None


def _irb_to_eth(unit: str) -> str | None:
    mapping = {
        "201": os.environ.get("IRB_201_IF", "eth3"),
        "202": os.environ.get("IRB_202_IF", "eth4"),
        "203": os.environ.get("IRB_203_IF", "eth5"),
    }
    return mapping.get(unit)


def parse_set_config(text: str) -> dict:
    inet: dict[str, str] = {}
    vrrp: dict[str, tuple[str, int]] = {}
    relay_server: str | None = None
    relay_irbs: list[str] = []

    addr_re = re.compile(
        r"^set interfaces (\S+) unit (\S+) family inet address (\d+\.\d+\.\d+\.\d+/\d+)"
        r"(?: .*vrrp-group \d+ virtual-address (\d+\.\d+\.\d+\.\d+))?"
        r"(?: .*priority (\d+))?"
    )
    bootp_server = re.compile(r"^set forwarding-options helpers bootp server (\S+)")
    bootp_irb = re.compile(r"^set forwarding-options helpers bootp interface irb\.(\d+)")

    priorities: dict[str, int] = {}
    vips: dict[str, str] = {}

    for raw in text.splitlines():
        line = raw.strip()
        m = addr_re.match(line)
        if m:
            ifname, unit, cidr, vip, prio = m.groups()
            key = f"{ifname}.{unit}" if ifname != "irb" else f"irb.{unit}"
            inet[key] = cidr
            if vip:
                vips[key] = vip
            if prio:
                priorities[key] = int(prio)
            continue
        m = bootp_server.match(line)
        if m:
            relay_server = m.group(1)
            continue
        m = bootp_irb.match(line)
        if m:
            relay_irbs.append(m.group(1))

    for key, vip in vips.items():
        vrrp[key] = (vip, priorities.get(key, 100))

    return {
        "inet": inet,
        "vrrp": vrrp,
        "relay_server": relay_server,
        "relay_irbs": relay_irbs,
    }


def _iface_exists(name: str) -> bool:
    return subprocess.run(["ip", "link", "show", name], capture_output=True).returncode == 0


def _ensure_addr(dev: str, cidr: str) -> None:
    if not _iface_exists(dev):
        print(f"[apply] skip missing {dev} ({cidr})")
        return
    _run(["ip", "link", "set", dev, "up"])
    current = _run(["ip", "-4", "-o", "addr", "show", "dev", dev])
    if cidr.split("/")[0] not in current:
        print(_run(["ip", "addr", "add", cidr, "dev", dev]) or f"[apply] {dev} += {cidr}")


def apply_set_config(text: str) -> str:
    parsed = parse_set_config(text)
    logs: list[str] = []

    for sysctl, value in (
        ("/proc/sys/net/ipv4/ip_forward", "1\n"),
        ("/proc/sys/net/ipv4/conf/all/rp_filter", "0\n"),
        ("/proc/sys/net/ipv4/conf/default/rp_filter", "0\n"),
    ):
        if os.path.isfile(sysctl):
            try:
                with open(sysctl, "w", encoding="utf-8") as handle:
                    handle.write(value)
            except OSError:
                pass

    for key, cidr in parsed["inet"].items():
        if key.startswith("irb."):
            dev = _irb_to_eth(key.split(".", 1)[1])
        elif key.startswith("lo0"):
            dev = "lo"
        else:
            ifname = key.split(".", 1)[0]
            dev = _ge_to_eth(ifname)
        if not dev:
            continue
        # do not replace docker mgmt if already present
        _ensure_addr(dev, cidr)
        logs.append(f"{dev} {cidr}")

        vip_info = parsed["vrrp"].get(key)
        if vip_info and vip_info[1] >= 150:
            vip, _prio = vip_info
            mask = cidr.split("/")[1]
            _ensure_addr(dev, f"{vip}/{mask}")
            logs.append(f"{dev} vip {vip}")

    relay_ifaces: list[str] = []
    for unit in parsed["relay_irbs"]:
        dev = _irb_to_eth(unit)
        if dev and _iface_exists(dev):
            relay_ifaces.append(dev)

    server = parsed["relay_server"]
    if server and relay_ifaces:
        _run(["pkill", "-f", "dhcrelay"])
        _run(["pkill", "-f", "dhcp_relay.py"])
        dhcrelay = shutil.which("dhcrelay")
        if dhcrelay:
            cmd = [dhcrelay, "-d", *[item for iface in relay_ifaces for item in ("-i", iface)], server]
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            logs.append("dhcrelay " + " ".join(relay_ifaces) + f" -> {server}")
        else:
            relay_py = os.path.join(os.path.dirname(__file__), "dhcp_relay.py")
            log_path = "/tmp/dhcp_relay.log"
            logf = open(log_path, "ab", buffering=0)
            subprocess.Popen(
                ["python3", relay_py, server, *relay_ifaces],
                stdout=logf,
                stderr=logf,
                start_new_session=True,
            )
            logs.append("dhcp_relay.py " + " ".join(relay_ifaces) + f" -> {server}")

    msg = "dataplane applied: " + (", ".join(logs) if logs else "nothing")
    print(f"[apply] {msg}")
    return msg + "\n"


if __name__ == "__main__":
    path = os.environ.get("NETCONSOLE_RUNNING", "/var/lib/netconsole/running.set")
    with open(path, encoding="utf-8") as handle:
        print(apply_set_config(handle.read()), end="")
