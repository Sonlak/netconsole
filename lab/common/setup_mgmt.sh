#!/bin/sh
# Shared SSH/REST users for production-like lab: root/Juniper, admin/Admin@123
set -eu

mkdir -p /var/run/sshd /etc/netconsole /var/lib/netconsole
ssh-keygen -A

ROOT_PASS="${ROOT_PASSWORD:-Juniper}"
ADMIN_USER="${LAB_USER:-admin}"
ADMIN_PASS="${LAB_PASSWORD:-Admin@123}"

cat > /etc/netconsole/device.env <<EOF
DEVICE_HOSTNAME=${DEVICE_HOSTNAME:-lab-device}
DEVICE_MODEL=${DEVICE_MODEL:-vEX}
DEVICE_SERIAL=${DEVICE_SERIAL:-JN000000}
DEVICE_VERSION=${DEVICE_VERSION:-21.4R3.4}
DEVICE_IP_MGMT=${DEVICE_IP_MGMT:-172.30.0.11}
DEVICE_ROLE=${DEVICE_ROLE:-}
DHCP_RELAY_SERVERS=${DHCP_RELAY_SERVERS:-}
SVI_IFACES=${SVI_IFACES:-}
LOOPBACK_IP=${LOOPBACK_IP:-}
EOF

# admin: Junos CLI shell (tool + ops)
if id -u "$ADMIN_USER" >/dev/null 2>&1; then
  usermod -s /usr/local/bin/junos_cli.py "$ADMIN_USER"
else
  useradd -m -s /usr/local/bin/junos_cli.py "$ADMIN_USER"
fi
echo "${ADMIN_USER}:${ADMIN_PASS}" | chpasswd

# root: password login (PermitRootLogin yes)
echo "root:${ROOT_PASS}" | chpasswd

# optional legacy lab user (same password as admin)
if id -u lab >/dev/null 2>&1; then
  usermod -s /usr/local/bin/junos_cli.py lab
else
  useradd -m -s /usr/local/bin/junos_cli.py lab
fi
echo "lab:${ADMIN_PASS}" | chpasswd

chown -R "${ADMIN_USER}:${ADMIN_USER}" /var/lib/netconsole 2>/dev/null || true
chmod 777 /var/lib/netconsole
chmod +x /usr/local/bin/junos_cli.py /usr/local/bin/junos_rest_server.py 2>/dev/null || true
grep -qx '/usr/local/bin/junos_cli.py' /etc/shells 2>/dev/null \
  || echo '/usr/local/bin/junos_cli.py' >> /etc/shells

# sudo ip for shut/no-shut from CLI
if [ -d /etc/sudoers.d ]; then
  printf '%s ALL=(root) NOPASSWD: /sbin/ip, /bin/ip\n' "$ADMIN_USER" > /etc/sudoers.d/lab-ip
  printf 'lab ALL=(root) NOPASSWD: /sbin/ip, /bin/ip\n' >> /etc/sudoers.d/lab-ip
  chmod 440 /etc/sudoers.d/lab-ip
fi
