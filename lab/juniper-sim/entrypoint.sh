#!/bin/sh
set -eu

mkdir -p /var/run/sshd /etc/netconsole /var/lib/netconsole
ssh-keygen -A

cat > /etc/netconsole/device.env <<EOF
DEVICE_HOSTNAME=${DEVICE_HOSTNAME:-lab-jr1}
DEVICE_MODEL=${DEVICE_MODEL:-vSRX3}
DEVICE_SERIAL=${DEVICE_SERIAL:-JN1234LAB001}
DEVICE_VERSION=${DEVICE_VERSION:-22.4R1.10}
DEVICE_IP_MGMT=${DEVICE_IP_MGMT:-172.30.0.11}
EOF

ADMIN_USER="${LAB_USER:-admin}"
ADMIN_PASS="${LAB_PASSWORD:-Admin@123}"
ROOT_PASS="${ROOT_PASSWORD:-Juniper}"

if id -u "$ADMIN_USER" >/dev/null 2>&1; then
  usermod -s /usr/local/bin/junos_cli.py "$ADMIN_USER"
else
  useradd -m -s /usr/local/bin/junos_cli.py "$ADMIN_USER"
fi
echo "${ADMIN_USER}:${ADMIN_PASS}" | chpasswd
echo "root:${ROOT_PASS}" | chpasswd

if ! id -u lab >/dev/null 2>&1; then
  useradd -m -s /usr/local/bin/junos_cli.py lab
fi
echo "lab:${ADMIN_PASS}" | chpasswd

# lab SSH + REST share interface state; keep world-writable in lab
# (do not pre-create empty JSON — CLI/REST initialize defaults on first use)
chown -R lab:lab /var/lib/netconsole
chmod 777 /var/lib/netconsole

chmod +x /usr/local/bin/junos_cli.py /usr/local/bin/junos_rest_server.py

# Optional self-signed cert when REST_SCHEME=https
if [ "${REST_SCHEME:-http}" = "https" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /etc/netconsole/rest.key \
    -out /etc/netconsole/rest.crt \
    -days 3650 \
    -subj "/CN=${DEVICE_HOSTNAME:-lab-jr1}" >/dev/null 2>&1
fi

python3 /usr/local/bin/junos_rest_server.py &
exec /usr/sbin/sshd -D -e
