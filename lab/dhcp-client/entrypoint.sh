#!/bin/sh
set -eu

HOSTNAME_LABEL="${HOSTNAME:-dhcp-client}"
IFACE="${IFACE:-}"
if [ -z "$IFACE" ]; then
  # Prefer eth1 (containerlab), else eth0 (compose p2p).
  if ip link show eth1 >/dev/null 2>&1; then
    IFACE=eth1
  else
    IFACE=eth0
  fi
fi

echo "[$HOSTNAME_LABEL] waiting for $IFACE (and L2 path via access switch)..."
for i in $(seq 1 60); do
  if ip link show "$IFACE" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
# Give juniper-access/core a moment to build bridges/SVIs.
sleep 5

ip link set "$IFACE" up
# Drop Docker IPAM address so the host must obtain an address from Kea.
ip addr flush dev "$IFACE" || true
ip route flush table main || true

rm -f /var/lib/dhcp/dhclient.leases /var/lib/dhcp/dhclient.leases~ 2>/dev/null || true

echo "[$HOSTNAME_LABEL] requesting DHCP on $IFACE..."
# -1: try once then exit non-zero on failure; we retry in a loop below.
ATTEMPT=1
while true; do
  if dhclient -v -1 -lf /var/lib/dhcp/dhclient.leases "$IFACE"; then
    break
  fi
  echo "[$HOSTNAME_LABEL] DHCP attempt $ATTEMPT failed; retry in 3s"
  ATTEMPT=$((ATTEMPT + 1))
  ip addr flush dev "$IFACE" || true
  sleep 3
done

echo "[$HOSTNAME_LABEL] lease acquired:"
ip -br addr show "$IFACE" || true
ip route || true
echo "---- dhclient.leases ----"
cat /var/lib/dhcp/dhclient.leases || true
echo "---- ping gateway ----"
GW=$(ip route | awk '/default/ {print $3; exit}')
if [ -n "${GW:-}" ]; then
  ping -c 2 -W 2 "$GW" || true
else
  echo "no default gateway"
fi

# Keep container up; renew is handled by background dhclient if still running.
# Some dhclient builds daemonize; if not, re-run periodically.
if ! pgrep -x dhclient >/dev/null 2>&1; then
  dhclient -lf /var/lib/dhcp/dhclient.leases "$IFACE" || true
fi

exec sleep infinity
