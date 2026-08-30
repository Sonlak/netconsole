from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from netconsole_worker.models import DeviceInfo, JobInfo


class BaseTask(ABC):
    job_type: str

    @abstractmethod
    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        """Execute task against device. Implement with aionet in lab."""

    def stub_result(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        return {
            "implemented": False,
            "message": "Task skeleton only. Wire aionet connection in lab.",
            "jobType": job.type,
            "device": device.name,
            "ip": device.ip,
        }
