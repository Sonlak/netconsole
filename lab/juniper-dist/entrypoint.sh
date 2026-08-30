#!/bin/sh
# Blank dist: mgmt + SSH/REST only. No VRRP/OSPF/DHCP-relay/SVI — push config from NetConsole.
set -eu

MGMT_IF="${MGMT_IF:-eth0}"

bring_up_links() {
  ip link set "$MGMT_IF" up 2>/dev/null || true
  for iface in eth1 eth2 eth3 eth4 eth5 eth6; do
    if ip link show "$iface" >/dev/null 2>&1; then
      ip link set "$iface" up || true
      ip addr flush dev "$iface" 2>/dev/null || true
    fi
  done
  ip -br link || true
}

write_blank_inventory() {
  python3 - <<'PY'
import json, os, re, subprocess

mgmt = os.environ.get("DEVICE_IP_MGMT", "172.30.0.13")
ifaces = [
    {
        "name": "ge-0/0/0",
        "adminStatus": "up",
        "operStatus": "up",
        "description": "mgmt",
        "mode": "inet",
        "accessVlan": "",
        "address": f"{mgmt}/24",
        "mtu": "1514",
        "speed": "1000mbps",
        "linuxIf": "eth0",
    }
]
try:
    out = subprocess.check_output(["ip", "-o", "link", "show"], text=True)
except Exception:
    out = ""
for line in out.splitlines():
    m = re.search(r"\d+:\s+(eth(\d+)):", line)
    if not m:
        continue
    eth, num = m.group(1), m.group(2)
    if num == "0":
        continue
    ifaces.append(
        {
            "name": f"ge-0/0/{num}",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "",
            "mode": "inet",
            "accessVlan": "",
            "address": "",
            "mtu": "1514",
            "speed": "1000mbps",
            "linuxIf": eth,
        }
    )

path = "/var/lib/netconsole/interfaces.json"
os.makedirs("/var/lib/netconsole", exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump({"interfaces": ifaces}, f, indent=2)
os.chmod(path, 0o666)
print(f"[dist] blank inventory: {len(ifaces)} ifaces (mgmt only configured)")
PY
}

bring_up_links
. /usr/local/lib/netconsole/setup_mgmt.sh
rm -f /var/lib/netconsole/interfaces.json
write_blank_inventory
if [ -f /var/lib/netconsole/running.set ]; then
  PYTHONPATH=/usr/local/lib/netconsole python3 /usr/local/lib/netconsole/apply_linux.py || true
fi
python3 /usr/local/bin/junos_rest_server.py &
exec /usr/sbin/sshd -D -e
