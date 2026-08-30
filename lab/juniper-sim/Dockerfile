FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONPATH=/usr/local/lib/netconsole

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-server \
    iproute2 \
    iputils-ping \
    sudo \
    python3 \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/run/sshd /usr/local/lib/netconsole /var/lib/netconsole \
  && printf 'lab ALL=(root) NOPASSWD: /sbin/ip, /bin/ip\n' > /etc/sudoers.d/lab-ip \
  && chmod 440 /etc/sudoers.d/lab-ip

COPY interface_state.py /usr/local/lib/netconsole/interface_state.py
COPY junos_cli.py /usr/local/bin/junos_cli.py
COPY junos_rest_server.py /usr/local/bin/junos_rest_server.py
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh

RUN sed -i 's/\r$//' /entrypoint.sh /usr/local/bin/junos_cli.py /usr/local/bin/junos_rest_server.py /usr/local/lib/netconsole/interface_state.py \
  && chmod +x /entrypoint.sh /usr/local/bin/junos_cli.py /usr/local/bin/junos_rest_server.py

EXPOSE 22 8443

ENTRYPOINT ["/entrypoint.sh"]
