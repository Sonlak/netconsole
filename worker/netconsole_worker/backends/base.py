"""Abstract device backend.

Every concrete backend (Juniper, EOS, IOS-XE, NX-OS) implements the
same 8 methods. Tasks in `tasks/registry.py` call these methods
without knowing which vendor they're talking to.

All methods take a `DeviceInfo` and return a result dict that the
existing Juniper tasks already produce. The frontend doesn't change.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from netconsole_worker.models import DeviceInfo


class DeviceBackend(ABC):
    """Common surface for all vendor backends."""

    #: Short tag used as `source` field in result dicts ("junos-rest",
    #: "eos-api", "iosxe-rest", "nxos-nxapi", "ssh-cli", ...).
    source: str = "unknown"

    def __init__(self, config: Any) -> None:
        self.config = config

    # -- READ methods ------------------------------------------------------

    @abstractmethod
    def get_interfaces(self, device: DeviceInfo) -> dict[str, Any]:
        """Return `{implemented, source, command?, interfaces, raw?, ...}`."""

    @abstractmethod
    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        """Return `{implemented, source, command?, entries, raw?, ...}`."""

    @abstractmethod
    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        """Return `{implemented, source, command?, entries, raw?, ...}`."""

    @abstractmethod
    def get_config(self, device: DeviceInfo) -> dict[str, Any]:
        """Return `{implemented, source, config, hostname?, version?, ...}`."""

    # -- WRITE methods -----------------------------------------------------

    @abstractmethod
    def apply_config(
        self,
        device: DeviceInfo,
        config: str,
        *,
        log: str,
        previous: str | None = None,
    ) -> dict[str, Any]:
        """Push `config` to the device. `previous` is the pre-apply snapshot.

        Return `{implemented, source, config, commands?, message, raw?, ...}`.
        Raise RuntimeError on failure.
        """

    @abstractmethod
    def rollback_config(
        self,
        device: DeviceInfo,
        rollback_index: int | None,
        previous: str | None = None,
    ) -> dict[str, Any]:
        """Roll back to a previous config.

        `rollback_index` is the Junos-style N (0=current, 1=previous, ...);
        vendors that don't support indexes can ignore it and use their own
        rollback mechanism (NX-OS `rollback running-config checkpoint`,
        IOS-XE `configure replace flash:...`, EOS `rollback rescue-config`).
        """

    @abstractmethod
    def interface_action(
        self,
        device: DeviceInfo,
        *,
        action: str,
        iface: str,
        vlan: str | None,
    ) -> dict[str, Any]:
        """shut / no-shut / show-run / set-access-vlan on a single interface."""

    @abstractmethod
    def probe_identity(self, device: DeviceInfo) -> dict[str, Any]:
        """Lightweight `show version` probe for the MANAGED_CHECK job."""

    # -- OPTIONAL: subclasses may override ---------------------------------

    def get_logs(self, device: DeviceInfo, filename: str | None) -> dict[str, Any]:
        """On-demand log pull. Most vendors return a stub here because logs
        arrive via syslog UDP push on the backend.

        See `worker/netconsole_worker/tasks/registry.py::GetLogsTask` for
        the rationale (the SSH `show log messages` fallback was killed on
        2026-09-06 because it flooded `auth.log`).
        """
        return {
            "implemented": False,
            "source": None,
            "entries": [],
            "hostname": device.name,
            "message": (
                f"On-demand log pull not implemented for {self.source}; "
                "view live logs on the Logs page (syslog UDP push)."
            ),
        }

    def connect_test(self, device: DeviceInfo) -> dict[str, Any]:
        """Liveness probe; default falls back to a `show version` SSH call."""
        return {"connected": False, "protocol": "ssh", "message": "not implemented"}

    def recover_junos(self, device: DeviceInfo) -> dict[str, Any]:
        """Juniper-only: post `<discard-changes/>` to clear a stuck candidate
        database. Other vendors raise NotImplementedError so the operator
        sees a clear "not supported" message instead of a silent no-op.
        """
        raise NotImplementedError(
            f"recover_junos is not implemented for backend {self.source!r}"
        )
