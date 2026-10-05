FROM python:3.12-slim

WORKDIR /app

# Cache mount for apt. Same setup as backend/Dockerfile (which
# builds successfully with cache mounts).
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping openssh-client ca-certificates sshpass \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# Cache mount for pip. The previous version of this Dockerfile had
# 3 cache mounts in 1 RUN (apt + pip together) which consistently
# failed. Splitting into 2 RUNs + adding the pip mount to its own
# RUN — the apt mount was already confirmed working in isolation.
COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY netconsole_worker ./netconsole_worker
COPY templates ./templates
COPY main.py ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
