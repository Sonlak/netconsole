FROM python:3.12-slim

WORKDIR /app

# Cache mounts for apt + pip. The worker is small (~300MB) but the
# `pip install -r requirements.txt` step pulls cryptography, httpx,
# lxml, ncclient, scrapli etc. — total ~50MB of downloads. Caching
# `/root/.cache/pip` across builds turns a 30-60s pip install into
# a 2-5s resolve-from-cache on warm rebuilds.
# `sharing=locked` for both — pip's resolver acquires a lock on the
# cache, and apt holds locks on its lists/cache too.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    --mount=type=cache,target=/root/.cache/pip,sharing=locked \
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
