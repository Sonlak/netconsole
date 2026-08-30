#!/usr/bin/env python3
"""Minimal Juniper Junos CLI simulator for NetConsole lab."""

from __future__ import annotations

import os
import re
import subprocess
import sys

# sshd login sessions do not inherit Docker ENV PYTHONPATH
sys.path.insert(0, "/usr/local/lib/netconsole")

import interface_state


def _load_device_env() -> dict[str, str]:
    values: dict[str, str] = {}
    config_path = "/etc/netconsole/device.env"
    if not os.path.exists(config_path):
        return values

    with open(config_path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()

    return values


_FILE_ENV = _load_device_env()


def _device_value(key: str, default: str) -> str:
    return os.environ.get(key) or _FILE_ENV.get(key) or default


HOSTNAME = _device_value("DEVICE_HOSTNAME", "lab-jr1")
MODEL = _device_value("DEVICE_MODEL", "vSRX3")
SERIAL = _device_value("DEVICE_SERIAL", "JN1234LAB001")
VERSION = _device_value("DEVICE_VERSION", "22.4R1.10")
MGMT_IP = _device_value("DEVICE_IP_MGMT", "172.30.0.11")

RUNNING_PATH = "/var/lib/netconsole/running.set"
ROLLBACK_PATH = "/var/lib/netconsole/rollback.set"


def _read_text(path: str) -> str:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _write_text(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content if content.endswith("\n") else content + "\n")
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def stored_running_config() -> str:
    return _read_text(RUNNING_PATH)


def replace_running_config(content: str) -> str:
    text = content.strip()
    if not text:
        return "error: empty configuration\n"
    current = stored_running_config() or show_configuration_set()
    _write_text(ROLLBACK_PATH, current)
    _write_text(RUNNING_PATH, text)
    extra = ""
    try:
        import apply_linux

        extra = apply_linux.apply_set_config(text)
    except Exception as exc:  # noqa: BLE001 - lab dataplane best-effort
        extra = f"dataplane warn: {exc}\n"
    return "commit complete\n" + extra


def rollback_running_config() -> str:
    previous = _read_text(ROLLBACK_PATH)
    if not previous.strip():
        return "error: no rollback configuration\n"
    current = stored_running_config() or show_configuration_set()
    _write_text(RUNNING_PATH, previous)
    _write_text(ROLLBACK_PATH, current)
    extra = ""
    try:
        import apply_linux

        extra = apply_linux.apply_set_config(previous)
    except Exception as exc:  # noqa: BLE001 - lab dataplane best-effort
        extra = f"dataplane warn: {exc}\n"
    return "rollback complete\n" + extra


def show_version() -> str:
    return f"""Hostname: {HOSTNAME}
Model: {MODEL}
JUNOS Software Release [{VERSION}]
Kernel 64-bit  UNIX {VERSION}
Serial number: {SERIAL}
"""


def _forwarding_options_block() -> str:
    servers = interface_state.dhcp_relay_servers()
    if not servers:
        return ""
    relay_ifaces = [
        f"{iface['name']}.0"
        for iface in interface_state.load_interfaces()
        if iface.get("mode") == "inet" and iface.get("accessVlan")
    ]
    if not relay_ifaces:
        return ""
    server_lines = "\n".join(f"            server {ip};" for ip in servers)
    iface_lines = "\n".join(f"                {name};" for name in relay_ifaces)
    return f"""
forwarding-options {{
    helpers {{
        bootp {{
            description "DHCP relay to Kea";
{server_lines}
            interface {{
{iface_lines}
            }}
        }}
    }}
}}
"""


def _forwarding_options_set() -> str:
    servers = interface_state.dhcp_relay_servers()
    if not servers:
        return ""
    lines = ['set forwarding-options helpers bootp description "DHCP relay to Kea"']
    for ip in servers:
        lines.append(f"set forwarding-options helpers bootp server {ip}")
    for iface in interface_state.load_interfaces():
        if iface.get("mode") == "inet" and iface.get("accessVlan"):
            lines.append(
                f"set forwarding-options helpers bootp interface {iface['name']}.0"
            )
    return "\n".join(lines) + "\n"


def show_configuration() -> str:
    stored = stored_running_config().strip()
    if stored:
        return stored + "\n"
    iface_blocks: list[str] = []
    for iface in interface_state.load_interfaces():
        name = iface["name"]
        body_lines = []
        if iface.get("adminStatus") == "down":
            body_lines.append("        disable;")
        if iface.get("description"):
            body_lines.append(f'        description "{iface["description"]}";')
        if iface.get("mode") == "inet":
            addr = iface.get("address") or f"{MGMT_IP}/24"
            body_lines.append("        unit 0 {")
            body_lines.append("            family inet {")
            body_lines.append(f"                address {addr};")
            body_lines.append("            }")
            body_lines.append("        }")
        elif iface.get("mode") == "trunk":
            body_lines.append("        unit 0 {")
            body_lines.append("            family ethernet-switching {")
            body_lines.append("                interface-mode trunk;")
            body_lines.append("                vlan {")
            body_lines.append("                    members all;")
            body_lines.append("                }")
            body_lines.append("            }")
            body_lines.append("        }")
        else:
            vlan = iface.get("accessVlan") or "1"
            body_lines.append("        unit 0 {")
            body_lines.append("            family ethernet-switching {")
            body_lines.append("                interface-mode access;")
            body_lines.append("                vlan {")
            body_lines.append(f"                    members {vlan};")
            body_lines.append("                }")
            body_lines.append("            }")
            body_lines.append("        }")
        iface_blocks.append(f"    {name} {{\n" + "\n".join(body_lines) + "\n    }")

    interfaces_body = "\n".join(iface_blocks)
    forwarding = _forwarding_options_block()
    return f"""## Last commit: 2026-08-10 09:00:00 UTC by lab
version "{VERSION}";
system {{
    host-name {HOSTNAME};
    root-authentication {{
        encrypted-password "$6$labhash";
    }}
    services {{
        ssh;
    }}
}}
interfaces {{
{interfaces_body}
}}
{forwarding}"""


def show_configuration_set() -> str:
    stored = stored_running_config().strip()
    if stored:
        return stored + "\n"
    base = f"""set version "{VERSION}"
set system host-name {HOSTNAME}
set system services ssh
"""
    return base + interface_state.format_config_set_interfaces() + _forwarding_options_set()


def show_arp() -> str:
    # Live ARP from Linux dataplane (PCs / gateways), not hardcoded demo rows.
    return interface_state.format_show_arp()


def run_ping(raw: str) -> str:
    """Operational-mode ping backed by Linux iputils (Junos-like syntax)."""
    tokens = raw.split()
    if len(tokens) < 2 or tokens[0].lower() != "ping":
        return "syntax error, expecting: ping <host> [count <n>]\n"

    host: str | None = None
    count = 5
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        lower = tok.lower()
        if lower == "count" and i + 1 < len(tokens):
            try:
                count = max(1, min(int(tokens[i + 1]), 20))
            except ValueError:
                return f"error: invalid count '{tokens[i + 1]}'\n"
            i += 2
            continue
        if lower in {"rapid", "do-not-fragment", "inet", "inet6"}:
            i += 1
            continue
        if host is None and not lower.startswith("-"):
            host = tok
            i += 1
            continue
        return f"error: unrecognized ping option '{tok}'\n"

    if not host:
        return "syntax error, expecting: ping <host> [count <n>]\n"

    try:
        completed = subprocess.run(
            ["ping", "-c", str(count), "-W", "2", host],
            capture_output=True,
            text=True,
            timeout=max(10, count * 3),
            check=False,
        )
    except FileNotFoundError:
        return "error: ping binary not available in this image\n"
    except subprocess.TimeoutExpired:
        return f"ping: request timed out to {host}\n"

    out = (completed.stdout or "") + (completed.stderr or "")
    return out if out.endswith("\n") else out + "\n"


def show_mac_table() -> str:
    # Live L2 table derived from dataplane ARP (PC / gateway / DHCP MACs).
    return interface_state.format_show_mac_table()


def help_text() -> str:
    return """Available commands:
  show version
  show configuration
  show configuration | display set
  show arp
  show ethernet-switching table
  show interfaces
  show interfaces terse
  show configuration interfaces <if>
  ping <host> [count <n>]
  set interfaces <if> disable
  delete interfaces <if> disable
  set interfaces <if> unit 0 family ethernet-switching interface-mode access
  set interfaces <if> unit 0 family ethernet-switching vlan members <vlan>
  commit
  replace-running-config   (stdin = set-format config)
  rollback-running-config
  exit
"""


def handle_command(raw: str) -> str | None:
    command = raw.strip()
    if not command:
        return ""

    lower = command.lower()
    if lower in {"exit", "quit", "logout"}:
        return None
    if lower in {"help", "?"}:
        return help_text()
    if lower == "show version":
        return show_version()
    if lower == "show configuration":
        return show_configuration()
    if lower in {"show configuration | display set", "show config | display set"}:
        return show_configuration_set()
    if lower == "show arp":
        return show_arp()
    if lower in {"show ethernet-switching table", "show ethernet switching table"}:
        return show_mac_table()
    if lower in {"show interfaces", "show interface"}:
        return interface_state.format_show_interfaces()
    if lower in {"show interfaces terse", "show interface terse"}:
        return interface_state.format_terse()
    if lower == "ping" or lower.startswith("ping "):
        return run_ping(command)

    m_show_cfg = re.match(r"^show\s+configuration\s+interfaces\s+(\S+)$", lower)
    if m_show_cfg:
        # recover original interface token casing
        parts = command.split()
        name = parts[-1]
        return interface_state.format_config_interface(name)

    if lower.startswith("set interfaces ") or lower.startswith("delete interfaces ") or lower == "commit":
        return interface_state.apply_set_command(command)
    if lower in {"rollback", "rollback-running-config"}:
        return rollback_running_config()

    return f"unknown command: {command}\nType 'help' for supported commands."


def run_batch(command: str) -> int:
    result = handle_command(command)
    if result is None:
        return 0
    sys.stdout.write(result)
    if not result.endswith("\n"):
        sys.stdout.write("\n")
    return 0


def run_interactive() -> None:
    user = os.environ.get("USER", "lab")
    sys.stdout.write(f"NetConsole Juniper lab simulator ({MODEL})\n")
    sys.stdout.write("Type 'help' for commands.\n\n")

    while True:
        sys.stdout.write(f"{user}@{HOSTNAME}> ")
        sys.stdout.flush()
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            sys.stdout.write("\n")
            break

        if line == "":
            break

        result = handle_command(line)
        if result is None:
            break
        sys.stdout.write(result)
        if not result.endswith("\n"):
            sys.stdout.write("\n")


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "-c":
        command = sys.argv[2] if len(sys.argv) == 3 else " ".join(sys.argv[2:])
        lowered = command.strip().lower()
        if lowered in {"replace-running-config", "load-set-config"}:
            payload = sys.stdin.read()
            sys.stdout.write(replace_running_config(payload))
            raise SystemExit(0)
        if lowered in {"rollback-running-config", "rollback"}:
            sys.stdout.write(rollback_running_config())
            raise SystemExit(0)
        raise SystemExit(run_batch(command))

    run_interactive()


if __name__ == "__main__":
    main()
