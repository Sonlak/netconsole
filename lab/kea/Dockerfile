FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    kea-dhcp4-server \
    kea-ctrl-agent \
    ca-certificates \
    curl \
    iproute2 \
    jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/run/kea /var/lib/kea /etc/kea

COPY kea-ctrl-agent.conf /etc/kea/kea-ctrl-agent.conf
COPY kea-dhcp4.conf.template /etc/kea/kea-dhcp4.conf.template
# Default subnet list (the LAB/dev pools). A deployment overrides this by
# mounting its own file at /etc/kea/subnets.json — production mounts
# subnets.prod.json ([] = no pools) so the prod dashboard never shows
# lab subnets. See lab/kea/entrypoint.sh::SUBNETS_FILE.
COPY subnets.default.json /etc/kea/subnets.json
COPY entrypoint.sh /entrypoint.sh
COPY seed-leases.sh /usr/local/bin/seed-leases.sh

RUN sed -i 's/\r$//' /entrypoint.sh /usr/local/bin/seed-leases.sh \
  && chmod +x /entrypoint.sh /usr/local/bin/seed-leases.sh

EXPOSE 67/udp 8000

ENTRYPOINT ["/entrypoint.sh"]
