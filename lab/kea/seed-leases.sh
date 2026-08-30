#!/bin/bash
set -euo pipefail

API="http://127.0.0.1:8000/"

kea() {
  local payload="$1"
  curl -sf -X POST "$API" \
    -H 'Content-Type: application/json' \
    -d "$payload"
}

# Avoid reseeding if leases already exist
existing="$(kea '{"command":"lease4-get-all","service":["dhcp4"]}' || true)"
if echo "$existing" | grep -q '"ip-address"'; then
  echo "[kea-seed] leases already present"
  exit 0
fi

echo "[kea-seed] adding demo leases"

add_lease() {
  local ip="$1" mac="$2" subnet="$3" hostname="$4"
  kea "$(cat <<EOF
{
  "command": "lease4-add",
  "service": ["dhcp4"],
  "arguments": {
    "ip-address": "${ip}",
    "hw-address": "${mac}",
    "subnet-id": ${subnet},
    "hostname": "${hostname}",
    "valid-lft": 3600
  }
}
EOF
)" >/dev/null || true
}

add_lease "172.30.10.101" "aa:bb:cc:10:00:01" 10 "pc-vlan10-01"
add_lease "172.30.10.102" "aa:bb:cc:10:00:02" 10 "pc-vlan10-02"
add_lease "172.30.10.110" "aa:bb:cc:10:00:10" 10 "ap-vlan10-01"
add_lease "172.30.20.105" "aa:bb:cc:20:00:05" 20 "pc-vlan20-01"
add_lease "172.30.20.120" "aa:bb:cc:20:00:20" 20 "camera-vlan20-01"
add_lease "172.30.30.150" "aa:bb:cc:30:00:50" 30 "pc-vlan30-01"
add_lease "172.30.30.151" "aa:bb:cc:30:00:51" 30 "pc-vlan30-02"

echo "[kea-seed] done"
