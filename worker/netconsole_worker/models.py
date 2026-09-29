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
    """Parse a job payload from the backend's /api/jobs/queue response.

    Most jobs have a `device` relation; some (e.g. NETBOX_SYNC_ALL,
    scheduled housekeeping) don't. We return an empty DeviceInfo for the
    no-device case so the task code can branch on `device.id == ""`
    instead of having to special-case None.
    """
    device_payload = payload.get("device")
    job_payload = payload.get("payload")
    if job_payload is not None and not isinstance(job_payload, dict):
        job_payload = None

    if device_payload:
        device = DeviceInfo(
            id=device_payload["id"],
            name=device_payload["name"],
            ip=device_payload["ip"],
            vendor=device_payload.get("vendor", ""),
            model=device_payload.get("model", ""),
            site=device_payload.get("site", ""),
            floor=device_payload.get("floor", ""),
        )
    else:
        # No device attached — task should detect this and act accordingly.
        device = DeviceInfo(id="", name="", ip="", vendor="", model="", site="", floor="")

    return JobInfo(
        id=payload["id"],
        type=payload["type"],
        payload=job_payload,
        device=device,
    )
