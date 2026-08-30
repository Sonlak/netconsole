from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class DeviceInfo:
    id: str
    name: str
    ip: str
    vendor: str
    model: str
    site: str
    floor: str


@dataclass
class JobInfo:
    id: str
    type: str
    device: DeviceInfo
    payload: dict[str, Any] | None = None


def parse_job(payload: dict[str, Any]) -> JobInfo:
    device = payload["device"]
    job_payload = payload.get("payload")
    if job_payload is not None and not isinstance(job_payload, dict):
        job_payload = None

    return JobInfo(
        id=payload["id"],
        type=payload["type"],
        payload=job_payload,
        device=DeviceInfo(
            id=device["id"],
            name=device["name"],
            ip=device["ip"],
            vendor=device.get("vendor", ""),
            model=device.get("model", ""),
            site=device.get("site", ""),
            floor=device.get("floor", ""),
        ),
    )
