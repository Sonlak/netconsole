#!/bin/bash
set -euo pipefail

# ─── Identity ────────────────────────────────────────────────────────────────
THIS_SERVER_NAME="${KEA_SERVER_NAME:-kea-dc1}"
THIS_SERVER_URL="${KEA_SERVER_URL:-10.10.20.20}"
THIS_SERVER_ROLE="${KEA_SERVER_ROLE:-primary}"

# ─── HA toggle (2026-10-22) ──────────────────────────────────────────────────
# KEA_HA_ENABLED=false renders the config WITHOUT the libdhcp_ha hook, i.e.
# a plain single-server DHCP4. This is what production uses until the DR
# host exists: prod's kea-dc1 and the lab VPS's kea-dc1 were both
# configured as `primary` with the SAME peer (10.10.20.30), which is an
# invalid HA topology -- two primaries, one peer. Kea logs a peer-mismatch
# and the hot-standby state machine stalls. Since the DR server is a later
# phase, prod runs standalone and HA gets re-enabled together with DR.
#
# Default stays `true` so the dev/lab stack (which DOES have a live peer)
# keeps working unchanged.
KEA_HA_ENABLED="${KEA_HA_ENABLED:-true}"

# HA peer config (1+1 topology: this server <-> one peer)
# Defaults assume DC<->DR split:
#   DC:  PEER_NAME=kea-dr1, PEER_ROLE=standby, PEER_URL points to DR
#   DR:  PEER_NAME=kea-dc1, PEER_ROLE=primary, PEER_URL points to DC
KEA_PEER_NAME="${KEA_PEER_NAME:-kea-dr1}"
KEA_PEER_URL="${KEA_PEER_URL:-http://172.31.0.11:8000/}"
KEA_PEER_ROLE="${KEA_PEER_ROLE:-standby}"

# HA timing (tunable for failback speed vs. network noise trade-off)
# Defaults: heartbeat 5s, response window 10s, ack delay 2s
# → failback detection ~10-15s after peer down, 1-3s swap gap
KEA_HEARTBEAT_DELAY_MS="${KEA_HEARTBEAT_DELAY_MS:-5000}"
KEA_MAX_RESPONSE_DELAY_MS="${KEA_MAX_RESPONSE_DELAY_MS:-10000}"
KEA_MAX_ACK_DELAY_MS="${KEA_MAX_ACK_DELAY_MS:-2000}"

# ─── Hook discovery ──────────────────────────────────────────────────────────
HOOK_DIR="/usr/lib/x86_64-linux-gnu/kea/hooks"
if [[ ! -f "${HOOK_DIR}/libdhcp_ha.so" ]]; then
  if [[ -f /usr/lib/kea/hooks/libdhcp_ha.so ]]; then
    HOOK_DIR="/usr/lib/kea/hooks"
  fi
fi

# ─── Data plane (optional, only when container has extra NICs) ────────────────
# Format: "eth1:10 eth2:20 eth3:30 eth4:40"  (iface:vlan -> 172.30.<vlan>.HOST_OCTET)
# Note: empty KEA_DATA_MAP must stay empty. ${VAR:-default} would
# incorrectly substitute the default when VAR is set to "".
if [ "${KEA_DATA_MAP+x}" = "x" ]; then
  DATA_MAP="${KEA_DATA_MAP}"
else
  DATA_MAP="eth1:10 eth2:20 eth3:30 eth4:40"
fi
HOST_OCTET="${KEA_HOST_OCTET:-2}"

mkdir -p /var/run/kea /var/lib/kea /etc/kea /run/kea
chmod 777 /var/run/kea /var/lib/kea /run/kea || true

# Stale PID files survive docker stop/start and block Kea with
# DHCP4_ALREADY_RUNNING / DCTL_ALREADY_RUNNING after host reboot.
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

# ─── Render config from template ──────────────────────────────────────────────
# Subnets live inline in the template — both DC and DR MUST serve the same
# subnet config so a failover doesn't change which addresses a client gets.
sed \
  -e "s|__THIS_SERVER_NAME__|${THIS_SERVER_NAME}|g" \
  -e "s|__THIS_SERVER_URL__|${THIS_SERVER_URL}|g" \
  -e "s|__THIS_SERVER_ROLE__|${THIS_SERVER_ROLE}|g" \
  -e "s|__KEA_PEER_NAME__|${KEA_PEER_NAME}|g" \
  -e "s|__KEA_PEER_URL__|${KEA_PEER_URL}|g" \
  -e "s|__KEA_PEER_ROLE__|${KEA_PEER_ROLE}|g" \
  -e "s|__KEA_HEARTBEAT_DELAY_MS__|${KEA_HEARTBEAT_DELAY_MS}|g" \
  -e "s|__KEA_MAX_RESPONSE_DELAY_MS__|${KEA_MAX_RESPONSE_DELAY_MS}|g" \
  -e "s|__KEA_MAX_ACK_DELAY_MS__|${KEA_MAX_ACK_DELAY_MS}|g" \
  -e "s|/usr/lib/x86_64-linux-gnu/kea/hooks|${HOOK_DIR}|g" \
  /etc/kea/kea-dhcp4.conf.template > /etc/kea/kea-dhcp4.conf

# ─── Routes back to relay (for DHCP replies) ─────────────────────────────────
# DHCP replies are unicast to relay giaddr. Skip when DHCP_RELAY_VIA is empty.
RELAY_VIA="${DHCP_RELAY_VIA-172.30.0.13}"
RELAY_NETS="${DHCP_RELAY_NETS:-10.1.201.0/24 10.1.202.0/24 10.1.203.0/24 10.1.204.0/24}"
if [[ -n "${RELAY_VIA}" ]]; then
  for net in ${RELAY_NETS}; do
    ip route replace "$net" via "$RELAY_VIA" 2>/dev/null || true
  done
fi

echo "[kea] starting ${THIS_SERVER_NAME} (hooks=${HOOK_DIR})"
if [ "${KEA_HA_ENABLED}" = "true" ]; then
  echo "[kea] peer: ${KEA_PEER_NAME} @ ${KEA_PEER_URL} (role=${KEA_PEER_ROLE})"
  echo "[kea] HA timing: heartbeat=${KEA_HEARTBEAT_DELAY_MS}ms response=${KEA_MAX_RESPONSE_DELAY_MS}ms ack=${KEA_MAX_ACK_DELAY_MS}ms"
else
  echo "[kea] HA DISABLED (KEA_HA_ENABLED=false) - standalone DHCP4, no peer"
fi
ip -br addr || true
ip route || true

if [ "${KEA_HA_ENABLED}" != "true" ]; then
  # Strip the libdhcp_ha hook block from the rendered config. jq is already
  # installed in the image (used by nothing else here, but present via the
  # Dockerfile apt list) so this needs no extra tooling.
  echo "[kea] removing libdhcp_ha hook from rendered config (standalone mode)"
  jq 'del(.Dhcp4["hooks-libraries"][] | select(.library | test("libdhcp_ha")))' \
    /etc/kea/kea-dhcp4.conf > /etc/kea/kea-dhcp4.conf.tmp \
    && mv /etc/kea/kea-dhcp4.conf.tmp /etc/kea/kea-dhcp4.conf
fi

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
