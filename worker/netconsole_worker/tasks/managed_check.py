from __future__ import annotations

from typing import Any

from netconsole_worker.config import settings
from netconsole_worker.models import DeviceInfo, JobInfo
from netconsole_worker.parsers.show_version import parse_show_version
from netconsole_worker.ssh_client import run_junos_commands
from netconsole_worker.tasks.base import BaseTask


class ManagedCheckTask(BaseTask):
    job_type = "MANAGED_CHECK"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        checks = {
            "ping": True,
            "ssh": False,
            "showVersion": False,
            "showRun": False,
        }

        if settings.junos_rest_enabled:
            from netconsole_worker.junos_rest import probe_device_identity

            username = settings.junos_rest_user or settings.lab_ssh_user
            password = settings.junos_rest_password or settings.lab_ssh_password
            rest = probe_device_identity(
                device.ip,
                username=username,
                password=password,
                scheme=settings.junos_rest_scheme,
                port=settings.junos_rest_port,
                verify_tls=settings.junos_rest_verify_tls,
            )
            if rest["ok"]:
                parsed = rest["fields"]
                hostname = (parsed.get("hostname") or "").strip()
                if hostname:
                    parsed["description"] = f"Hostname {hostname} (Junos REST)"
                checks = {
                    "ping": True,
                    "ssh": True,
                    "showVersion": bool(parsed.get("hostname") or parsed.get("model") or parsed.get("version")),
                    "showRun": bool(rest.get("raw")),
                }
                return {
                    "checks": checks,
                    "showVersion": rest.get("raw") or "",
                    "showRun": rest.get("raw") or "",
                    "parsed": parsed,
                    "source": "junos-rest",
                    "message": "Junos REST identity OK",
                }
            rest_error = rest.get("error") or "Junos REST identity failed"
            if not settings.lab_ssh_enabled:
                return {
                    **self.stub_result(job, device),
                    "checks": checks,
                    "message": rest_error,
                    "source": "junos-rest",
                }

        if settings.lab_ssh_enabled:
            ssh_result = run_junos_commands(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
            )

            if ssh_result["sshOk"]:
                show_version = ssh_result["showVersion"]
                show_run = ssh_result["showRun"]
                parsed = parse_show_version(device.vendor or "Juniper", show_version)
                checks = {
                    "ping": True,
                    "ssh": True,
                    "showVersion": bool(show_version.strip()),
                    "showRun": bool(show_run.strip()),
                }
                return {
                    "checks": checks,
                    "showVersion": show_version,
                    "showRun": show_run,
                    "parsed": parsed,
                    "source": "ssh-cli",
                    "message": "Lab SSH probe OK",
                }

            return {
                **self.stub_result(job, device),
                "checks": checks,
                "message": ssh_result["error"] or "Lab SSH failed",
            }

        return {
            **self.stub_result(job, device),
            "checks": checks,
            "message": "Bật JUNOS_REST_ENABLED hoặc LAB_SSH_ENABLED để lấy hostname/serial/model từ thiết bị",
        }
