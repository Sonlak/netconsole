FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONPATH=/usr/local/lib/netconsole

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-server \
    iproute2 \
    bridge-utils \
    vlan \
    iputils-ping \
    python3 \
    openssl \
    ca-certificates \
    procps \
    sudo \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/run/sshd /usr/local/lib/netconsole /var/lib/netconsole

COPY juniper-sim/interface_state.py /usr/local/lib/netconsole/interface_state.py
COPY juniper-sim/junos_cli.py /usr/local/bin/junos_cli.py
COPY juniper-sim/junos_rest_server.py /usr/local/bin/junos_rest_server.py
COPY juniper-sim/sshd_config /etc/ssh/sshd_config
COPY common/setup_mgmt.sh /usr/local/lib/netconsole/setup_mgmt.sh
COPY juniper-access/entrypoint.sh /entrypoint.sh

RUN sed -i 's/\r$//' /entrypoint.sh /usr/local/lib/netconsole/setup_mgmt.sh \
    /usr/local/bin/junos_cli.py /usr/local/bin/junos_rest_server.py \
    /usr/local/lib/netconsole/interface_state.py \
  && chmod +x /entrypoint.sh /usr/local/lib/netconsole/setup_mgmt.sh \
    /usr/local/bin/junos_cli.py /usr/local/bin/junos_rest_server.py

ENTRYPOINT ["/entrypoint.sh"]
