"""Vendor abstraction layer.

Every collector task in `tasks/registry.py` asks `select_backend(device)`
for the right `DeviceBackend` implementation, then calls the same 8
methods regardless of vendor. This lets us add EOS / IOS-XE / NX-OS
without forking the task layer — the per-vendor differences live in
`backends/{juniper,eos,iosxe,nxos}.py`.

The vendor is taken from `DeviceInfo.vendor` (Prisma's `Device.vendor`
string column). Model is used as a tiebreaker for Cisco sub-flavors
(IOS-XE vs NX-OS).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from netconsole_worker.models import DeviceInfo

if TYPE_CHECKING:
    from netconsole_worker.backends.base import DeviceBackend

logger = logging.getLogger(__name__)


# ------------------ Configuration ------------------------------------------


@dataclass
class VendorConfig:
    """Per-vendor RESTCONF / eAPI / NX-API credentials + endpoint.

    Populated from `settings` at process start so backends can read
    `config.enabled` without re-parsing env vars on every call.
    """

    enabled: bool = False
    scheme: str = "https"
    port: int = 443
    user: str = ""
    password: str = ""
    verify_tls: bool = False

    def creds(self, fallback_user: str, fallback_password: str) -> dict[str, Any]:
        return {
            "username": self.user or fallback_user,
            "password": self.password or fallback_password,
            "scheme": self.scheme,
            "port": self.port,
            "verify_tls": self.verify_tls,
        }


@dataclass
class BackendConfig:
    """All vendor configs in one bundle, populated at startup."""

    juniper: VendorConfig = field(default_factory=VendorConfig)
    eos: VendorConfig = field(default_factory=VendorConfig)
    iosxe: VendorConfig = field(default_factory=VendorConfig)
    nxos: VendorConfig = field(default_factory=VendorConfig)

    # SSH is shared across vendors.
    ssh_user: str = "lab"
    ssh_password: str = "lab123"
    ssh_port: int = 22
    ssh_enabled: bool = False

    @classmethod
    def from_settings(cls) -> "BackendConfig":
        from netconsole_worker.config import settings

        return cls(
            juniper=VendorConfig(
                enabled=settings.junos_rest_enabled,
                scheme=settings.junos_rest_scheme,
                port=settings.junos_rest_port,
                user=settings.junos_rest_user,
                password=settings.junos_rest_password,
                verify_tls=settings.junos_rest_verify_tls,
            ),
            eos=VendorConfig(
                enabled=settings.eos_api_enabled,
                scheme=settings.eos_api_scheme,
                port=settings.eos_api_port,
                user=settings.eos_api_user,
                password=settings.eos_api_password,
                verify_tls=settings.eos_api_verify_tls,
            ),
            iosxe=VendorConfig(
                enabled=settings.iosxe_api_enabled,
                scheme=settings.iosxe_api_scheme,
                port=settings.iosxe_api_port,
                user=settings.iosxe_api_user,
                password=settings.iosxe_api_password,
                verify_tls=settings.iosxe_api_verify_tls,
            ),
            nxos=VendorConfig(
                enabled=settings.nxos_api_enabled,
                scheme=settings.nxos_api_scheme,
                port=settings.nxos_api_port,
                user=settings.nxos_api_user,
                password=settings.nxos_api_password,
                verify_tls=settings.nxos_api_verify_tls,
            ),
            ssh_user=settings.lab_ssh_user,
            ssh_password=settings.lab_ssh_password,
            ssh_port=settings.lab_ssh_port,
            ssh_enabled=settings.lab_ssh_enabled,
        )


_CONFIG: BackendConfig | None = None
_CONFIG_LOCK = threading.Lock()


def get_backend_config() -> BackendConfig:
    global _CONFIG
    if _CONFIG is None:
        with _CONFIG_LOCK:
            if _CONFIG is None:
                _CONFIG = BackendConfig.from_settings()
    return _CONFIG


def reload_backend_config() -> BackendConfig:
    """Re-read env vars (useful after rotating secrets at runtime)."""
    global _CONFIG
    with _CONFIG_LOCK:
        _CONFIG = BackendConfig.from_settings()
    return _CONFIG


# ------------------ Vendor detection ----------------------------------------


def detect_vendor(device: DeviceInfo) -> str:
    """Return one of: 'juniper', 'eos', 'iosxe', 'nxos', 'unknown'.

    Detection priority: explicit `vendor` string first, then `model`
    keyword match as fallback. We do NOT raise on unknown — caller
    picks the default (Juniper) so the lab sims keep working.
    """
    vendor = (device.vendor or "").strip().lower()
    model = (device.model or "").strip().lower()

    if vendor in ("juniper", "junos"):
        return "juniper"
    if vendor in ("arista", "aristaeos", "eos"):
        return "eos"
    if vendor in ("cisco", "ciscoiosxe", "ios-xe", "iosxe", "catalyst"):
        return "iosxe"
    if vendor in ("cisconexus", "nexus", "nxos", "cisco-nx-os"):
        return "nxos"

    # Fallback to model-keyword matching.
    if any(k in model for k in ("nexus", "n9k", "n3k", "n7k", "n77")):
        return "nxos"
    if any(
        k in model
        for k in (
            "catalyst",
            "csr",
            "asr",
            "isr",
            "ios-xe",
            "ios xe",
            "iosxe",
            "c9300",
            "c9500",
            "c9600",
        )
    ):
        return "iosxe"
    if any(k in model for k in ("arista", "dcs-", "eos-", "ceos", "ccr", "csp")):
        return "eos"
    if any(k in model for k in ("juniper", "mx", "ex", "qfx", "srx", "junos")):
        return "juniper"

    return "unknown"


# ------------------ Backend selector ----------------------------------------


def select_backend(device: DeviceInfo) -> "DeviceBackend":
    """Return a `DeviceBackend` instance appropriate for `device`.

    Unknown vendor falls back to `JuniperBackend` so the lab Juniper sims
    keep being served by the existing RESTCONF code path. This is the
    zero-regression default; once all four vendors are wired up, callers
    that genuinely need to know can use `detect_vendor()` separately.
    """
    from netconsole_worker.backends.eos import EOSBackend
    from netconsole_worker.backends.iosxe import IOSxeBackend
    from netconsole_worker.backends.juniper import JuniperBackend
    from netconsole_worker.backends.nxos import NxosBackend

    kind = detect_vendor(device)
    config = get_backend_config()

    if kind == "eos" and config.eos.enabled:
        return EOSBackend(config)
    if kind == "iosxe" and config.iosxe.enabled:
        return IOSxeBackend(config)
    if kind == "nxos" and config.nxos.enabled:
        return NxosBackend(config)
    if kind == "juniper" and config.juniper.enabled:
        return JuniperBackend(config)

    # Fallback path: Juniper backend is the only one that's been
    # battle-tested on lab sims. If the vendor can't be detected OR the
    # matching API isn't enabled, default to Juniper RESTCONF.
    logger.debug(
        "select_backend: vendor=%s model=%s -> Juniper fallback (enabled=%s)",
        device.vendor,
        device.model,
        config.juniper.enabled,
    )
    return JuniperBackend(config)
