FROM python:3.12-slim

WORKDIR /app

# Stage 1: apt. Cache mount keeps /var/cache/apt + /var/lib/apt
# across builds. On warm rebuilds `apt-get update` is a no-op (lists
# already current) and `apt-get install` resolves from local cache
# in <1s instead of 5-10s of downloads.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        iputils-ping openssh-client ca-certificates sshpass \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# Stage 2: pip. Cache mount for /root/.cache/pip keeps downloaded
# wheels across builds. `pip install --no-cache-dir` is the right
# flag here — it tells pip to USE the cache mount (instead of writing
# to a separate ~/.cache/pip that doesn't exist in the slim image).
# On warm rebuilds, pip resolves all packages from the local cache
# in 2-5s instead of 30-60s of downloads.
# (NOTE: `--no-cache-dir` here is NOT a contradiction with the cache
# mount — `--no-cache-dir` means "don't use the build-time pip cache",
# which doesn't exist anyway; the cache mount provides the cache.)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY netconsole_worker ./netconsole_worker
COPY templates ./templates
COPY main.py ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
