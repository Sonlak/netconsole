FROM python:3.12-slim

WORKDIR /app

# Cache mounts for apt + pip. The worker is small (~300MB) but the
# `pip install -r requirements.txt` step pulls cryptography, httpx,
# lxml, ncclient, scrapli etc. — total ~50MB of downloads. Caching
# `/root/.cache/pip` across builds turns a 30-60s pip install into
# a 2-5s resolve-from-cache on warm rebuilds.
# Note: do NOT add `sharing=locked` here — the GHA buildx cache exporter
# (`cache-to: type=gha`) interacts badly with locked cache mounts and
# the build fails. Default `shared` is safe for both single- and
# multi-stage builds.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    --mount=type=cache,target=/root/.cache/pip \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping openssh-client ca-certificates sshpass \
    && rm -rf /etc/apt/apt.conf.d/docker-clean \
    && pip install --no-cache-dir -r requirements.txt

COPY netconsole_worker ./netconsole_worker
COPY templates ./templates
COPY main.py ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
