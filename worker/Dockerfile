FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY netconsole_worker ./netconsole_worker
COPY templates ./templates
COPY main.py ./

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
