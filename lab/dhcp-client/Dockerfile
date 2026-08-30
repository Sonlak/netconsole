FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    isc-dhcp-client \
    iproute2 \
    iputils-ping \
    ca-certificates \
    procps \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/dhcp

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
