#!/bin/bash
set -euo pipefail

THIS_SERVER_NAME="${KEA_SERVER_NAME:-kea-primary}"
HOOK_DIR="/usr/lib/x86_64-linux-gnu/kea/hooks"
# Format: "eth1:10 eth2:20 eth3:30 eth4:40"  (iface:vlan -> 172.30.<vlan>.2)
# Note: empty KEA_DATA_MAP must stay empty (standby). ${VAR:-default} would
# incorrectly substitute the default when VAR is set to "".
if [ "${KEA_DATA_MAP+x}" = "x" ]; then
  DATA_MAP="${KEA_DATA_MAP}"
else
  DATA_MAP="eth1:10 eth2:20 eth3:30 eth4:40"
fi
HOST_OCTET="${KEA_HOST_OCTET:-2}"

if [[ ! -f "${HOOK_DIR}/libdhcp_ha.so" ]]; then
  if [[ -f /usr/lib/kea/hooks/libdhcp_ha.so ]]; then
    HOOK_DIR="/usr/lib/kea/hooks"
  fi
fi

mkdir -p /var/run/kea /var/lib/kea /etc/kea /run/kea
chmod 777 /var/run/kea /var/lib/kea /run/kea || true

# Stale PID files survive docker stop/start and block Kea with
# DHCP4_ALREADY_RUNNING / DCTL_ALREADY_RUNNING after Desktop reboot.
rm -f /run/kea/*.pid /var/run/kea/*.pid 2>/dev/null || true

# Kea REQUIRES a usable IPv4 on each DHCP data interface.
if [[ -n "${DATA_MAP// }" ]]; then
  for binding in $DATA_MAP; do
    iface="${binding%%:*}"
    vid="${binding##*:}"
    for i in $(seq 1 60); do
      ip link show "$iface" >/dev/null 2>&1 && break
      sleep 0.5
    done
    if ip link show "$iface" >/dev/null 2>&1; then
      ip link set "$iface" up
      ip addr flush dev "$iface" 2>/dev/null || true
      ip addr add "172.30.${vid}.${HOST_OCTET}/24" dev "$iface"
      echo "[kea] ${iface} = 172.30.${vid}.${HOST_OCTET}/24"
    else
      echo "[kea] WARN: missing ${iface}"
    fi
  done
fi

PRIMARY_URL="${KEA_PRIMARY_URL:-http://172.30.0.21:8000/}"
STANDBY_URL="${KEA_STANDBY_URL:-http://172.30.0.22:8000/}"

sed \
  -e "s|__THIS_SERVER_NAME__|${THIS_SERVER_NAME}|g" \
  -e "s|__KEA_PRIMARY_URL__|${PRIMARY_URL}|g" \
  -e "s|__KEA_STANDBY_URL__|${STANDBY_URL}|g" \
  -e "s|/usr/lib/x86_64-linux-gnu/kea/hooks|${HOOK_DIR}|g" \
  /etc/kea/kea-dhcp4.conf.template > /etc/kea/kea-dhcp4.conf

# DHCP replies are unicast to relay giaddr. Skip when DHCP_RELAY_VIA is empty.
RELAY_VIA="${DHCP_RELAY_VIA-172.30.0.13}"
RELAY_NETS="${DHCP_RELAY_NETS:-10.1.201.0/24 10.1.202.0/24 10.1.203.0/24}"
if [[ -n "${RELAY_VIA}" ]]; then
  for net in ${RELAY_NETS}; do
    ip route replace "$net" via "$RELAY_VIA" 2>/dev/null || true
  done
fi

echo "[kea] starting ${THIS_SERVER_NAME} (hooks=${HOOK_DIR})"
ip -br addr || true
ip route || true

kea-dhcp4 -c /etc/kea/kea-dhcp4.conf &
DHCP_PID=$!

kea-ctrl-agent -c /etc/kea/kea-ctrl-agent.conf &
CA_PID=$!

for i in $(seq 1 30); do
  if curl -sf -X POST http://127.0.0.1:8000/ \
    -H 'Content-Type: application/json' \
    -d '{"command":"version-get","service":["dhcp4"]}' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ "${THIS_SERVER_NAME}" == "kea-primary" && "${KEA_SEED_LEASES:-false}" == "true" ]]; then
  /usr/local/bin/seed-leases.sh || echo "[kea] seed leases skipped/failed"
fi

wait -n ${DHCP_PID} ${CA_PID}
exit $?
