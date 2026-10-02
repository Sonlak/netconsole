"""NETBOX_SYNC_DEVICE / NETBOX_SYNC_ALL — sync device inventory + ports to NetBox.

Periodically pushes the NetConsole `Device` table and port inventory to NetBox
so operators have a single source of truth for IPAM/DCIM. Runs as a worker
job so it gets all the existing queue/retry/audit infrastructure for free.

Phase 1 scope (device-level):
  - dcim.devices: name, device_type, role, site, serial, status,
    description, custom_fields.netconsole_id, rack, position (unit)
  - dcim.sites (auto-created if missing)
  - dcim.manufacturers (auto-created if missing)
  - dcim.device-types (auto-created if missing, model + part-number)
  - dcim.device-roles (auto-created if missing)
  - dcim.racks (auto-created if missing, 42U)
  - dcim.platforms: version string becomes the platform name (e.g. "18.4R1.5")
    so operators can filter devices by exact OS release; falls back to the
    canonical vendor→platform map when version is not set
  - tags: source-netconsole (created on first sync)

Phase 2 scope (port/interface-level, added 2026-10-02):
  - dcim.interfaces: name, type, enabled, description, mtu, speed (bps),
    mode (access / tagged / tagged-all), mac_address
  - ipam.vlans: created on-the-fly when an interface carries VLAN info
  - dcim.interfaces.tagged_vlans / untagged_vlan: VLAN assignment
  - ipam.ip-addresses + dcim.interfaces: L3 interface IP assignment
  - Speed map: device reports Mbps; NetBox stores bps (× 1 000 000)
  - Interface type map: name prefix → NetBox type value (e.g.
    "GigabitEthernet" → "1000base-t", "ge-" → "1000base-t")
  - Idempotency: create if missing; PATCH only if something changed

Idempotency:
  - Device: Look-up by custom_fields.netconsole_id (canonical key)
    Fallback to serial (for devices created before the custom field was set)
    PATCH if found, POST if not
    Saves the NetBox device id on the Device row (netboxDeviceId) so
    subsequent cycles can skip the look-up entirely
  - Interface: Look-up by (device_id, name). PATCH if found; POST if not.
    Only writes if something changed (type, enabled, description, mtu,
    speed, mode) to keep updatedAt clean.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from netconsole_worker.clients.netbox import NetBoxError, get_netbox_client
from netconsole_worker.config import settings
from netconsole_worker.models import DeviceInfo, JobInfo
from netconsole_worker.tasks.base import BaseTask

logger = logging.getLogger(__name__)


def _build_description(device: DeviceInfo) -> str | None:
    """Build a human-readable NetBox device description from a NetConsole DeviceInfo.

    NetConsole DeviceInfo is a slim subset of Device. Full field access
    (description, lastPingAt, manageError, version, etc.) happens via
    the backend's GET /api/devices/:id response, which the worker can
    re-fetch if it needs more than DeviceInfo carries.
    """
    parts: list[str] = []
    if device.site:
        parts.append(f"site={device.site}")
    if device.floor:
        parts.append(f"floor={device.floor}")
    if device.vendor:
        parts.append(f"vendor={device.vendor}")
    if device.model:
        parts.append(f"model={device.model}")
    return " · ".join(parts) if parts else None


def _to_pretty_vendor(vendor: str) -> str:
    """Normalize vendor casing so 'cisco' / 'Cisco' / 'CISCO' all map to the
    same NetBox Manufacturer (avoids creating duplicates on case drift)."""
    if not vendor:
        return "Unknown"
    return vendor.strip().title()


class NetboxSyncDeviceTask(BaseTask):
    """Sync a single NetConsole device to NetBox.

    Worker entry point: the worker calls run(job, device) where `device` is
    the DeviceInfo attached to the Job row. We look up the full Device row
    via the backend REST API to get the latest fields (description, version,
    lastPingAt, etc.) — the slim DeviceInfo does not carry these.
    """

    job_type = "NETBOX_SYNC_DEVICE"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        if not settings.netbox_url or not settings.netbox_token:
            return {
                "ok": False,
                "error": "NetBox sync is not configured (NETBOX_URL / NETBOX_TOKEN missing in worker env)",
                "device": device.name,
            }

        nb = get_netbox_client()

        # Health-check the API before doing any work. Catches auth errors,
        # bad URL, unreachable host — without failing halfway through a sync.
        if not nb.health_check():
            raise NetBoxError(
                f"NetBox health check failed — URL={settings.netbox_url!r}, "
                f"token length={len(settings.netbox_token)}"
            )

        # Re-fetch the full Device row from the backend so we have the
        # latest description / version / lastPingAt / status.
        full_device = self._fetch_full_device(device.id)
        if not full_device:
            return {
                "ok": False,
                "error": f"Could not fetch full Device row for id={device.id}",
                "device": device.name,
            }

        netconsole_id = str(full_device.get("id") or device.id)
        name = str(full_device.get("name") or device.name)
        serial = str(full_device.get("serial") or "")
        site = str(full_device.get("site") or device.site or "default")
        vendor = _to_pretty_vendor(str(full_device.get("vendor") or device.vendor))
        model = str(full_device.get("model") or device.model or "Unknown")
        status = str(full_device.get("status") or "UNKNOWN")
        description = full_device.get("description") or _build_description(device)
        management_ip = full_device.get("ip") or device.ip or None
        version = full_device.get("version") or None
        part_number = full_device.get("partNumber") or None
        rack = full_device.get("rack") or None
        unit = full_device.get("unit") or None
        floor = full_device.get("floor") or None
        existing_nb_id = full_device.get("netboxDeviceId") or None

        if not serial:
            return {
                "ok": False,
                "error": f"Device {name} has no serial number; cannot sync to NetBox (serial is required for fallback lookup)",
                "device": name,
            }

        try:
            nb_device, created = nb.upsert_device(
                netconsole_id=netconsole_id,
                name=name,
                serial=serial,
                site=site,
                vendor=vendor,
                model=model,
                status=status,
                description=description,
                management_ip=management_ip,
                version=version,
                part_number=part_number,
                rack=rack,
                unit=unit,
                floor=floor,
                existing_device_id=existing_nb_id,
            )
        except NetBoxError as exc:
            # Surface the error to the job row so the scheduler can retry
            # next cycle. We re-raise so the job ends in FAILED status.
            raise NetBoxError(f"NetBox upsert failed for device '{name}': {exc}") from exc

        # --- Phase 2: sync interfaces ---------------------------------
        nb_site = nb.find_site(site)
        site_id = nb_site["id"] if nb_site else None
        iface_result: dict[str, Any] = {"ok": True, "created": 0, "updated": 0, "skipped": 0}
        if site_id is None:
            logger.warning(
                "[netbox-sync] device '%s' site '%s' not found in NetBox — skipping interface sync",
                name, site,
            )
        else:
            interfaces = self._fetch_device_interfaces(netconsole_id)
            if interfaces:
                iface_result = nb.sync_device_interfaces(
                    device_id=nb_device["id"],
                    device_name=name,
                    interfaces=interfaces,
                    site_id=site_id,
                )
                logger.info(
                    "[netbox-sync] device '%s' interface sync: created=%d updated=%d skipped=%d",
                    name,
                    iface_result.get("created", 0),
                    iface_result.get("updated", 0),
                    iface_result.get("skipped", 0),
                )

        return {
            "ok": True,
            "device": name,
            "netconsoleId": netconsole_id,
            "netboxDeviceId": nb_device.get("id"),
            "netboxUrl": nb_device.get("url"),
            "created": created,
            "interfaces": iface_result,
            "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    def _fetch_full_device(self, device_id: str) -> dict[str, Any] | None:
        """Fetch the full Device row from the NetConsole backend.

        NetConsole's DeviceInfo is slim (id, name, ip, vendor, model, site, floor).
        For the NetBox sync we also need description, version, status, serial,
        and netboxDeviceId. The backend already exposes GET /api/devices/:id.
        """
        url = settings.api_base_url.rstrip("/")
        token = settings.worker_auth_token
        if not token:
            logger.warning("netbox-sync: WORKER_AUTH_TOKEN not set, cannot re-fetch device %s", device_id)
            return None
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(
                    f"{url}/devices/{device_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
            if response.status_code == 200:
                return response.json()
            logger.warning(
                "netbox-sync: GET /devices/%s returned %d: %s",
                device_id, response.status_code, response.text[:200],
            )
        except Exception as exc:
            logger.warning("netbox-sync: GET /devices/%s failed: %s", device_id, exc)
        return None

    def _fetch_device_interfaces(self, device_id: str) -> list[dict[str, Any]]:
        """Fetch the latest GET_INTERFACES job result for a device from the backend.

        Calls GET /api/interfaces/:deviceId — returns the full interfaces[] array
        from the most recent SUCCESS GET_INTERFACES job. Returns [] if no
        successful interface collection exists yet.
        """
        url = settings.api_base_url.rstrip("/")
        token = settings.worker_auth_token
        if not token:
            logger.debug(
                "netbox-sync: WORKER_AUTH_TOKEN not set, cannot fetch interfaces for device %s",
                device_id,
            )
            return []
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.get(
                    f"{url}/interfaces/{device_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
            if response.status_code == 200:
                body = response.json()
                interfaces = body.get("interfaces", [])
                if isinstance(interfaces, list):
                    logger.debug(
                        "netbox-sync: fetched %d interfaces for device %s",
                        len(interfaces), device_id,
                    )
                    return interfaces
                logger.warning(
                    "netbox-sync: /interfaces/%s returned interfaces=%r (not a list)",
                    device_id, body.get("interfaces"),
                )
            elif response.status_code == 404:
                logger.debug(
                    "netbox-sync: no interface data for device %s (404)",
                    device_id,
                )
            else:
                logger.warning(
                    "netbox-sync: GET /interfaces/%s returned %d",
                    device_id, response.status_code,
                )
        except Exception as exc:
            logger.warning(
                "netbox-sync: GET /interfaces/%s failed: %s",
                device_id, exc,
            )
        return []

    def stub_result(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        return {
            "implemented": True,
            "ok": False,
            "message": "NetBox sync requires NETBOX_URL and NETBOX_TOKEN env vars",
            "jobType": job.type,
            "device": device.name,
            "ip": device.ip,
        }


class NetboxSyncAllTask(BaseTask):
    """Sync every device (+ its interfaces) to NetBox in one job.

    Used by the periodic scheduler (so the scheduler doesn't have to
    pre-resolve the device list, and so the run shows up as ONE job
    in the Jobs page with a per-device summary in `result`).

    Resolution: GET /api/devices on the backend, then iterate. This is
    simpler than the worker tracking the full inventory, and the backend
    is the single source of truth anyway.

    After each device is upserted, fetches its latest GET_INTERFACES job
    result and syncs port inventory to NetBox (Phase 2: dcim.interfaces).

    Failure mode: if any single device fails, we log it and continue
    (the job result records the list of failed devices). Only a
    top-level error (e.g. NetBox unreachable for the whole run) raises
    to mark the job as FAILED.
    """

    job_type = "NETBOX_SYNC_ALL"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        if not settings.netbox_url or not settings.netbox_token:
            return {
                "ok": False,
                "error": "NetBox sync is not configured (NETBOX_URL / NETBOX_TOKEN missing in worker env)",
            }

        devices = self._fetch_all_devices()
        if not devices:
            return {
                "ok": True,
                "message": "No devices to sync",
                "deviceCount": 0,
                "results": [],
            }

        logger.info("[netbox-sync] starting bulk sync, %d devices", len(devices))

        nb = get_netbox_client()
        if not nb.health_check():
            raise NetBoxError("NetBox health check failed at the start of bulk sync")

        results: list[dict[str, Any]] = []
        ok_count = 0
        fail_count = 0
        created_count = 0
        updated_count = 0

        # Aggregate counters across all devices
        total_iface_created = 0
        total_iface_updated = 0
        total_iface_skipped = 0
        total_vlans = 0
        total_ips = 0

        for dev in devices:
            dev_id = str(dev.get("id") or "")
            if not dev_id:
                continue

            netconsole_id = dev_id
            name = str(dev.get("name") or "")
            serial = str(dev.get("serial") or "")
            site = str(dev.get("site") or "default")
            vendor = _to_pretty_vendor(str(dev.get("vendor") or ""))
            model = str(dev.get("model") or "Unknown")
            status = str(dev.get("status") or "UNKNOWN")
            description = dev.get("description") or None
            management_ip = dev.get("ip") or None
            version = dev.get("version") or None
            part_number = dev.get("partNumber") or None
            rack = dev.get("rack") or None
            unit = dev.get("unit") or None
            floor = dev.get("floor") or None
            existing_nb_id = dev.get("netboxDeviceId") or None

            if not serial:
                results.append({
                    "device": name or dev_id,
                    "ok": False,
                    "error": "missing serial number",
                })
                fail_count += 1
                continue

            try:
                nb_device, created = nb.upsert_device(
                    netconsole_id=netconsole_id,
                    name=name,
                    serial=serial,
                    site=site,
                    vendor=vendor,
                    model=model,
                    status=status,
                    description=description,
                    management_ip=management_ip,
                    version=version,
                    part_number=part_number,
                    rack=rack,
                    unit=unit,
                    floor=floor,
                    existing_device_id=existing_nb_id,
                )
                if created:
                    created_count += 1
                else:
                    updated_count += 1
                ok_count += 1

                # --- Phase 2: sync interfaces ---------------------------------
                # Fetch the latest GET_INTERFACES job result from the backend.
                # If no interface data exists (never collected), skip silently.
                # site_name → site_id is needed for VLAN creation.
                nb_site = nb.find_site(site)
                site_id = nb_site["id"] if nb_site else None
                if site_id is None:
                    logger.warning(
                        "[netbox-sync] device '%s' site '%s' not found in NetBox — "
                        "skipping interface sync",
                        name, site,
                    )
                    results.append({
                        "device": name,
                        "netconsoleId": netconsole_id,
                        "netboxDeviceId": nb_device.get("id"),
                        "ok": True,
                        "created": created,
                        "interfaces": None,
                    })
                    continue

                interfaces = self._fetch_device_interfaces(dev_id)
                if not interfaces:
                    results.append({
                        "device": name,
                        "netconsoleId": netconsole_id,
                        "netboxDeviceId": nb_device.get("id"),
                        "ok": True,
                        "created": created,
                        "interfaces": {"ok": True, "created": 0, "updated": 0, "skipped": 0},
                    })
                    continue

                iface_result = nb.sync_device_interfaces(
                    device_id=nb_device["id"],
                    device_name=name,
                    interfaces=interfaces,
                    site_id=site_id,
                )
                total_iface_created += iface_result.get("created", 0)
                total_iface_updated += iface_result.get("updated", 0)
                total_iface_skipped += iface_result.get("skipped", 0)
                total_vlans += len(iface_result.get("vlans", []))
                total_ips += len(iface_result.get("ips", []))

                results.append({
                    "device": name,
                    "netconsoleId": netconsole_id,
                    "netboxDeviceId": nb_device.get("id"),
                    "ok": True,
                    "created": created,
                    "interfaces": {
                        "ok": True,
                        "created": iface_result.get("created", 0),
                        "updated": iface_result.get("updated", 0),
                        "skipped": iface_result.get("skipped", 0),
                        "vlans": len(iface_result.get("vlans", [])),
                        "ips": len(iface_result.get("ips", [])),
                        "errors": iface_result.get("errors", []),
                    },
                })
            except NetBoxError as exc:
                fail_count += 1
                results.append({
                    "device": name or dev_id,
                    "ok": False,
                    "error": str(exc),
                })
                logger.warning("[netbox-sync] device '%s' failed: %s", name, exc)

        logger.info(
            "[netbox-sync] bulk sync complete: "
            "devices total=%d ok=%d failed=%d created=%d updated=%d | "
            "interfaces created=%d updated=%d skipped=%d vlans=%d ips=%d",
            len(devices), ok_count, fail_count, created_count, updated_count,
            total_iface_created, total_iface_updated, total_iface_skipped,
            total_vlans, total_ips,
        )

        return {
            "ok": True,
            "deviceCount": len(devices),
            "okCount": ok_count,
            "failedCount": fail_count,
            "createdCount": created_count,
            "updatedCount": updated_count,
            "interfaceSummary": {
                "created": total_iface_created,
                "updated": total_iface_updated,
                "skipped": total_iface_skipped,
                "vlans": total_vlans,
                "ips": total_ips,
            },
            "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "results": results,
        }

    def _fetch_all_devices(self) -> list[dict[str, Any]]:
        url = settings.api_base_url.rstrip("/")
        token = settings.worker_auth_token
        if not token:
            logger.warning("netbox-sync: WORKER_AUTH_TOKEN not set, cannot list devices")
            return []
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(
                    f"{url}/devices",
                    headers={"Authorization": f"Bearer {token}"},
                )
            if response.status_code == 200:
                body = response.json()
                return body if isinstance(body, list) else []
            logger.warning(
                "netbox-sync: GET /devices returned %d: %s",
                response.status_code, response.text[:200],
            )
        except Exception as exc:
            logger.warning("netbox-sync: GET /devices failed: %s", exc)
        return []

    def _fetch_device_interfaces(self, device_id: str) -> list[dict[str, Any]]:
        """Fetch the latest GET_INTERFACES job result for a device from the backend.

        Calls GET /api/interfaces/:deviceId — returns the full interfaces[] array
        from the most recent SUCCESS GET_INTERFACES job. Returns [] if no
        successful interface collection exists yet.
        """
        url = settings.api_base_url.rstrip("/")
        token = settings.worker_auth_token
        if not token:
            logger.debug(
                "netbox-sync: WORKER_AUTH_TOKEN not set, cannot fetch interfaces for device %s",
                device_id,
            )
            return []
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.get(
                    f"{url}/interfaces/{device_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
            if response.status_code == 200:
                body = response.json()
                interfaces = body.get("interfaces", [])
                if isinstance(interfaces, list):
                    logger.debug(
                        "netbox-sync: fetched %d interfaces for device %s",
                        len(interfaces), device_id,
                    )
                    return interfaces
                logger.warning(
                    "netbox-sync: /interfaces/%s returned interfaces=%r (not a list)",
                    device_id, body.get("interfaces"),
                )
            elif response.status_code == 404:
                logger.debug(
                    "netbox-sync: no interface data for device %s (404)",
                    device_id,
                )
            else:
                logger.warning(
                    "netbox-sync: GET /interfaces/%s returned %d",
                    device_id, response.status_code,
                )
        except Exception as exc:
            logger.warning(
                "netbox-sync: GET /interfaces/%s failed: %s",
                device_id, exc,
            )
        return []

    def stub_result(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        return {
            "implemented": True,
            "ok": False,
            "message": "NetBox sync requires NETBOX_URL and NETBOX_TOKEN env vars",
            "jobType": job.type,
        }
