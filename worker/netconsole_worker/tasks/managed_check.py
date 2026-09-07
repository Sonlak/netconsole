from __future__ import annotations

from typing import Any

from netconsole_worker.models import DeviceInfo, JobInfo
from netconsole_worker.tasks.base import BaseTask
from netconsole_worker.vendor import select_backend


class ManagedCheckTask(BaseTask):
    job_type = "MANAGED_CHECK"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        # Vendor-agnostic dispatch: JuniperBackend / EOSBackend / IOSxeBackend /
        # NxosBackend each implement their own probe_identity. Result shape
        # is unchanged from the legacy Juniper-only implementation, so the
        # frontend `ManagedCheckPanel` keeps working.
        backend = select_backend(device)
        return backend.probe_identity(device)
