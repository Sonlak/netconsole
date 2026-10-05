FROM python:3.12-slim

WORKDIR /app

# Cache mount for apt. Mirrors backend/Dockerfile (which builds
# successfully with cache mounts) — the only difference in the
# previous failing versions was the pip cache mount. Isolating
# the apt mount first to confirm.
RUN --mount=type=cache,target=/var/cache/apt \
    --mount=type=cache,target=/var/lib/apt \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping openssh-client ca-certificates sshpass \
    && rm -rf /etc/apt/apt.conf.d/docker-clean

# No pip cache mount — pip install is a small one-shot step.
# Layer cache is sufficient: when requirements.txt is unchanged,
# the layer is reused, no re-download. When it changes, we accept
# the 30-60s re-download (rare event).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY netconsole_worker ./netconsole_worker
COPY templates ./templates
COPY main.py ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
