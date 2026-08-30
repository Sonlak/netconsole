#!/bin/sh
set -eu

# Prefer compose sysctls; fall back if writable.
if [ -w /proc/sys/net/ipv4/ip_forward ]; then
  echo 1 > /proc/sys/net/ipv4/ip_forward
fi

# Basic NAT for lab clients (optional internet via docker bridge)
iptables -t nat -C POSTROUTING -o eth0 -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

# DHCP relay from VLAN SVI toward Kea primary (failover handled by Kea HA)
# Interfaces are named eth0.. by docker; discover non-loopback.
IFACES=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo | cut -d@ -f1)
SERVERS="${DHCP_SERVERS:-172.30.0.21 172.30.0.22}"

set --
for iface in $IFACES; do
  set -- "$@" -i "$iface"
done

echo "[core-gw] ip_forward=1"
echo "[core-gw] interfaces: $IFACES"
echo "[core-gw] dhcp relay -> $SERVERS"
ip -br addr || true

# Keep container alive; restart relay if it exits
while true; do
  # shellcheck disable=SC2086
  dhcrelay -d $SERVERS "$@" || true
  sleep 2
done
