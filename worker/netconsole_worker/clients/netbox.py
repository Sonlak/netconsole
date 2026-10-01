"""NetBox REST API client.

Wraps httpx for the NetBox v4 REST API. Provides typed helpers for the
objects we care about (sites, manufacturers, device-types, devices, tags)
and a generic `_request` that handles auth, JSON encoding, and error
formatting.

Token lives in NETBOX_TOKEN config. URL in NETBOX_URL (default
http://localhost:8001/api/).

Idempotency note: all write helpers (create / update / find-or-create) look
up by the external key (custom field `netconsole_id`) BEFORE creating or
updating, so running the sync job twice on the same device produces the same
result — no duplicates.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from netconsole_worker.config import settings

logger = logging.getLogger(__name__)

# Module-level cache for custom field IDs — avoids repeated lookups per sync.
# Keyed by (name, object_type) so the same field attached to different models
# gets separate cache entries.
_cf_cache: dict[tuple[str, str], int] = {}


class NetBoxError(Exception):
    """Raised when the NetBox API returns a non-2xx status we can't handle."""


class NetBoxClient:
    # NetBox API base path
    API = "/api"

    def __init__(
        self,
        url: str | None = None,
        token: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.url = (url or settings.netbox_url or "http://localhost:8001/api/").rstrip("/")
        self.token = token or settings.netbox_token or ""
        self.timeout = httpx.Timeout(timeout, connect=5.0)
        self._headers = {
            "Authorization": f"Token {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    # ------------------------------------------------------------------
    # Low-level request helpers
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        retry_on: tuple[int, ...] = (429, 502, 503, 504),
        max_retries: int = 3,
    ) -> dict[str, Any]:
        """Fire an HTTP request with retry on transient errors.

        Returns the parsed JSON body as a dict. Raises NetBoxError on
        persistent 4xx/5xx failures.
        """
        url = f"{self.url}{path}"
        headers = dict(self._headers)

        for attempt in range(max_retries):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.request(
                        method=method,
                        url=url,
                        headers=headers,
                        params=params,
                        json=json,
                    )
            except httpx.TimeoutException as exc:
                if attempt < max_retries - 1:
                    logger.warning("netbox %s %s timeout (attempt %d/%d)", method, path, attempt + 1, max_retries)
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise NetBoxError(f"timeout after {max_retries} attempts: {exc}") from exc
            except httpx.RequestError as exc:
                if attempt < max_retries - 1:
                    logger.warning("netbox %s %s network error (attempt %d/%d): %s", method, path, attempt + 1, max_retries, exc)
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise NetBoxError(f"network error after {max_retries} attempts: {exc}") from exc

            if response.status_code in retry_on:
                sleep = float(response.headers.get("Retry-After", 2 * (attempt + 1)))
                logger.warning(
                    "netbox %s %s → %d (attempt %d/%d), retrying in %ss",
                    method, path, response.status_code, attempt + 1, max_retries, sleep,
                )
                time.sleep(sleep)
                continue

            if response.status_code == 404:
                return {"count": 0, "results": [], "detail": "not found"}

            if response.status_code == 204:
                return {"ok": True}

            if 200 <= response.status_code < 300:
                if not response.text:
                    return {"ok": True}
                return response.json()

            # Persistent 4xx/5xx
            try:
                body = response.json()
            except Exception:
                body = {"detail": response.text[:200]}
            raise NetBoxError(
                f"netbox {method} {path} → {response.status_code}: "
                f"{body.get('detail', body)}",
            )

        raise NetBoxError(f"netbox {method} {path}: exhausted retries")

    def get(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request("GET", path, params=params)

    def post(self, path: str, *, json: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", path, json=json)

    def patch(self, path: str, *, json: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", path, json=json)

    # ------------------------------------------------------------------
    # Tag helpers (needed for "source-netconsole" tag)
    # ------------------------------------------------------------------
    def find_tag(self, name: str) -> dict[str, Any] | None:
        """Return the tag object if it exists, else None."""
        result = self.get("/extras/tags/", params={"name": name})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_tag(self, name: str, slug: str, description: str = "") -> int:
        """Return the tag id. Creates it if missing."""
        tag = self.find_tag(name)
        if tag:
            return tag["id"]
        created = self.post("/extras/tags/", json={
            "name": name,
            "slug": slug,
            "description": description,
        })
        return created["id"]

    def ensure_custom_field(
        self,
        name: str,
        label: str,
        type_str: str,
        object_type: str,
        *,
        description: str = "",
        weight: int = 100,
    ) -> int | None:
        """Idempotently create a custom field; return its id, or None on failure.

        Uses a module-level cache keyed by (name, object_type) to avoid
        redundant lookups on every device sync.
        """
        cache_key = (name, object_type)
        if cache_key in _cf_cache:
            return _cf_cache[cache_key]

        # Check if it already exists
        try:
            result = self.get("/extras/custom-fields/", params={"name": name})
            for cf in result.get("results", []):
                if cf.get("name") != name:
                    continue
                obj_types = [str(t) for t in cf.get("object_types", [])]
                if any(object_type in t for t in obj_types):
                    _cf_cache[cache_key] = cf["id"]
                    logger.debug(
                        "netbox: custom field '%s' already exists (id=%d)",
                        name, cf["id"],
                    )
                    return cf["id"]
        except NetBoxError:
            pass  # fall through to create

        try:
            created = self.post("/extras/custom-fields/", json={
                "name": name,
                "label": label,
                "type": type_str,
                "object_types": [object_type],
                "required": False,
                "weight": weight,
                "description": description or f"{label} — synced from NetConsole",
            })
            logger.info(
                "netbox: created custom field '%s' (id=%d) on %s",
                name, created["id"], object_type,
            )
            _cf_cache[cache_key] = created["id"]
            return created["id"]
        except NetBoxError as exc:
            logger.warning("netbox: failed to create custom field '%s': %s", name, exc)
            return None

    # ------------------------------------------------------------------
    # Site helpers
    # ------------------------------------------------------------------
    def find_site(self, name: str) -> dict[str, Any] | None:
        result = self.get("/dcim/sites/", params={"name": name})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_site(self, name: str, netconsole_id: str) -> int:
        """Return the site id. Creates with source tag if missing."""
        site = self.find_site(name)
        if site:
            return site["id"]
        tag_id = self.get_or_create_tag(
            name="source-netconsole",
            slug="source-netconsole",
            description="Synced from NetConsole",
        )
        created = self.post("/dcim/sites/", json={
            "name": name,
            "slug": name.lower().replace(" ", "-").replace("_", "-"),
            "status": "active",
            "tags": [tag_id],
            "description": f"Site managed by NetConsole (netconsole_id={netconsole_id})",
        })
        logger.info("netbox: created site '%s' (id=%d)", name, created["id"])
        return created["id"]

    # ------------------------------------------------------------------
    # Manufacturer helpers
    # ------------------------------------------------------------------
    def find_manufacturer(self, name: str) -> dict[str, Any] | None:
        result = self.get("/dcim/manufacturers/", params={"name": name})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_manufacturer(self, name: str) -> int:
        """Return the manufacturer id. Creates if missing.

        NetBox requires a unique `slug` for new manufacturers — derive it
        from the name (lowercased, non-alphanum → '-'). We don't get to
        choose between slug derived from `name` and `id` here, but the
        caller passes `name` as the human display string and we always
        normalize that.
        """
        mfg = self.find_manufacturer(name)
        if mfg:
            return mfg["id"]
        # Normalize: first letter upper-case, rest lower-case
        normalized = name.strip().title()
        if not normalized:
            raise NetBoxError("manufacturer name is empty")
        slug = (
            normalized.lower()
            .replace(" ", "-")
            .replace("_", "-")
        )
        # Strip anything that isn't [a-z0-9-]
        slug = "".join(c for c in slug if c.isalnum() or c == "-")
        if not slug:
            # Fall back to a generic slug — should never happen for a
            # sane vendor name (e.g. "Juniper Networks", "Arista", etc.).
            slug = "unknown-vendor"
        created = self.post("/dcim/manufacturers/", json={
            "name": normalized,
            "slug": slug,
        })
        logger.info("netbox: created manufacturer '%s' (id=%d)", normalized, created["id"])
        return created["id"]

    # ------------------------------------------------------------------
    # Device type helpers (represents part-number / model in NetBox)
    # ------------------------------------------------------------------
    def find_device_type(self, model: str, manufacturer_id: int) -> dict[str, Any] | None:
        result = self.get("/dcim/device-types/", params={
            "model": model,
            "manufacturer_id": manufacturer_id,
        })
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_device_type(
        self,
        model: str,
        manufacturer_id: int,
        part_number: str | None = None,
    ) -> int:
        """Return the device-type id. Creates if missing."""
        dt = self.find_device_type(model, manufacturer_id)
        if dt:
            return dt["id"]
        created = self.post("/dcim/device-types/", json={
            "manufacturer": manufacturer_id,
            "model": model,
            "part_number": part_number or "",
            "slug": f"{manufacturer_id}-{model}".lower()[:50].replace(" ", "-").replace("_", "-"),
            "u_height": 1,
        })
        logger.info("netbox: created device-type '%s' (id=%d)", model, created["id"])
        return created["id"]

    # ------------------------------------------------------------------
    # Device role helpers
    # ------------------------------------------------------------------
    def find_device_role(self, name: str) -> dict[str, Any] | None:
        result = self.get("/dcim/device-roles/", params={"name": name})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_device_role(self, name: str, color: str = "9e9e9e") -> int:
        """Return the device-role id. Creates if missing."""
        role = self.find_device_role(name)
        if role:
            return role["id"]
        normalized = name.strip().title()
        slug = normalized.lower().replace(" ", "-").replace("_", "-")
        created = self.post("/dcim/device-roles/", json={
            "name": normalized,
            "slug": slug,
            "color": color,
        })
        logger.info("netbox: created device-role '%s' (id=%d)", normalized, created["id"])
        return created["id"]

    # ------------------------------------------------------------------
    # Rack helpers
    # ------------------------------------------------------------------
    # Default rack height in NetBox "U" units (42U is the industry standard).
    DEFAULT_RACK_HEIGHT = 42

    def find_rack(self, name: str, site_id: int) -> dict[str, Any] | None:
        """Look up a rack by name within a site."""
        result = self.get("/dcim/racks/", params={
            "name": name,
            "site_id": site_id,
        })
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_rack(
        self,
        name: str,
        site_id: int,
        *,
        u_height: int = DEFAULT_RACK_HEIGHT,
        description: str = "",
    ) -> int | None:
        """Return the rack id, creating it if missing.

        The rack name is the canonical key — we look it up by (name, site_id)
        before creating so the same rack name in the same site never duplicates.
        """
        rack = self.find_rack(name, site_id)
        if rack:
            return rack["id"]
        try:
            created = self.post("/dcim/racks/", json={
                "name": name,
                "site": site_id,
                "status": "active",
                "u_height": u_height,
                "description": description or "Synced from NetConsole",
            })
            logger.info(
                "netbox: created rack '%s' (id=%d, site_id=%d, u_height=%d)",
                name, created["id"], site_id, u_height,
            )
            return created["id"]
        except NetBoxError as exc:
            logger.warning("netbox: failed to create rack '%s': %s", name, exc)
            return None

    def _resolve_rack_id(
        self,
        rack_name: str | None,
        site_id: int,
    ) -> int | None:
        """Resolve a rack name to a NetBox rack id. Returns None if rack_name is empty."""
        if not rack_name:
            return None
        return self.get_or_create_rack(
            rack_name,
            site_id,
            u_height=self.DEFAULT_RACK_HEIGHT,
        )

    # ------------------------------------------------------------------
    # Platform helpers — map NetConsole vendor → NetBox platform
    # ------------------------------------------------------------------
    # Canonical slug→display-name map. NetBox platforms use slug as the
    # lookup key (case-insensitive). We normalise vendor to lowercase slug
    # before matching so "Cisco", "CISCO", "cisco" all hit the same entry.
    _PLATFORM_MAP: dict[str, str] = {
        "juniper": "juniper-junos",
        "cisco": "cisco-ios-xe",
        "arista": "arista-eos",
        "aruba": "aruba-os",
        "hp": "hp-procurve",
        "huawei": "huawei-vrp",
        "dell": "dell-os10",
        "vyos": "vyos",
        "linux": "linux",
        "ubuntu": "linux",
        "centos": "linux",
        "freebsd": "freebsd",
    }

    def _vendor_to_platform_slug(self, vendor: str) -> str | None:
        """Return the NetBox platform slug for a vendor name, or None if unknown."""
        key = vendor.strip().lower() if vendor else ""
        return self._PLATFORM_MAP.get(key)

    def find_platform(self, slug: str) -> dict[str, Any] | None:
        result = self.get("/dcim/platforms/", params={"slug": slug})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_platform(
        self,
        slug: str,
        name: str,
        *,
        manufacturer_id: int | None = None,
    ) -> int | None:
        """Return the platform id, creating it if missing.

        If manufacturer_id is provided, the new platform is linked to it.
        """
        plat = self.find_platform(slug)
        if plat:
            return plat["id"]
        try:
            payload: dict[str, Any] = {
                "name": name,
                "slug": slug,
            }
            if manufacturer_id is not None:
                payload["manufacturer"] = manufacturer_id
            created = self.post("/dcim/platforms/", json=payload)
            logger.info("netbox: created platform '%s' (id=%d)", slug, created["id"])
            return created["id"]
        except NetBoxError as exc:
            logger.warning("netbox: failed to create platform '%s': %s", slug, exc)
            return None

    # ------------------------------------------------------------------
    # IPAM helpers — prefixes, IP addresses, interface assignment
    # ------------------------------------------------------------------

    def _ip_to_prefix_24(self, ip: str) -> str | None:
        """Derive a /24 prefix from an IP, e.g. '10.10.20.131' → '10.10.20.0/24'."""
        parts = ip.strip().split(".")
        if len(parts) != 4:
            return None
        try:
            return f"{parts[0]}.{parts[1]}.{parts[2]}.0/24"
        except (ValueError, IndexError):
            return None

    def find_prefix(self, prefix: str) -> dict[str, Any] | None:
        result = self.get("/ipam/prefixes/", params={"prefix": prefix})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_prefix(self, prefix: str, site_id: int, status: str = "active") -> int | None:
        """Return the prefix id, creating it if missing."""
        pfx = self.find_prefix(prefix)
        if pfx:
            return pfx["id"]
        try:
            created = self.post("/ipam/prefixes/", json={
                "prefix": prefix,
                "site": site_id,
                "status": status,
                "description": "Synced from NetConsole",
            })
            logger.info("netbox: created prefix '%s' (id=%d)", prefix, created["id"])
            return created["id"]
        except NetBoxError as exc:
            logger.warning("netbox: failed to create prefix '%s': %s", prefix, exc)
            return None

    def find_ip_address(self, address: str) -> dict[str, Any] | None:
        """Look up an IP address by its 'x.x.x.x/N' representation."""
        result = self.get("/ipam/ip-addresses/", params={"address": address})
        results = result.get("results", [])
        return results[0] if results else None

    def get_or_create_ip_address(
        self,
        address: str,
        prefix_id: int | None = None,
        status: str = "active",
    ) -> dict[str, Any] | None:
        """Return the IP address dict (with 'id'), creating it if missing."""
        ip = self.find_ip_address(address)
        if ip:
            return ip
        payload: dict[str, Any] = {
            "address": address,
            "status": status,
            "description": "Management IP — synced from NetConsole",
        }
        if prefix_id is not None:
            payload["prefix"] = prefix_id
        try:
            created = self.post("/ipam/ip-addresses/", json=payload)
            logger.info("netbox: created IP address '%s' (id=%d)", address, created["id"])
            return created
        except NetBoxError as exc:
            logger.warning("netbox: failed to create IP '%s': %s", address, exc)
            return None

    def _find_mgmt_interface(self, device_id: int, vendor: str) -> dict[str, Any] | None:
        """Find a management interface on a device by name pattern."""
        name_patterns = ["mgmt", "mgmt0", "management", "management0", "fxp0", "em0", "ge-0/0/0"]
        result = self.get("/dcim/interfaces/", params={"device_id": device_id, "limit": 50})
        for iface in result.get("results", []):
            name = iface.get("name", "").lower()
            for pat in name_patterns:
                if pat in name:
                    return iface
        return None

    def _get_or_create_interface(
        self,
        device_id: int,
        device_name: str,
        name: str,
        interface_type: str = "other",
    ) -> int | None:
        """Return the interface id, creating it with minimal config if missing."""
        result = self.get("/dcim/interfaces/", params={
            "device_id": device_id,
            "name": name,
        })
        results = result.get("results", [])
        if results:
            return results[0]["id"]
        try:
            created = self.post("/dcim/interfaces/", json={
                "device": device_id,
                "name": name,
                "type": interface_type,
                "enabled": True,
            })
            logger.info(
                "netbox: created interface '%s' on device '%s' (id=%d)",
                name, device_name, created["id"],
            )
            return created["id"]
        except NetBoxError as exc:
            logger.warning(
                "netbox: failed to create interface '%s' on device '%s': %s",
                name, device_name, exc,
            )
            return None

    def assign_ip_to_interface(
        self,
        ip_id: int,
        interface_id: int,
        device_id: int,
    ) -> bool:
        """Assign an IP address to an interface. Returns True on success."""
        try:
            # NetBox v4 uses assigned_object_type + assigned_object_id instead of
            # the deprecated 'interface' field. 'interface' returns 200 but does
            # not actually update the assignment.
            self.patch(f"/ipam/ip-addresses/{ip_id}/", json={
                "assigned_object_type": "dcim.interface",
                "assigned_object_id": interface_id,
            })
            return True
        except NetBoxError as exc:
            logger.warning(
                "netbox: failed to assign IP %d to interface %d: %s",
                ip_id, interface_id, exc,
            )
            return False

    # ------------------------------------------------------------------
    # Device helpers — the core of Phase 1 sync
    # ------------------------------------------------------------------
    def find_device_by_netconsole_id(self, netconsole_id: str) -> dict[str, Any] | None:
        """Look up a device by the netconsole_id custom field."""
        result = self.get("/dcim/devices/", params={
            "cf_netconsole_id": netconsole_id,
        })
        results = result.get("results", [])
        return results[0] if results else None

    def find_device_by_serial(self, serial: str) -> dict[str, Any] | None:
        result = self.get("/dcim/devices/", params={"serial": serial})
        results = result.get("results", [])
        return results[0] if results else None

    def _find_device_by_ip(self, ip_address: str) -> dict[str, Any] | None:
        """Find which device has the given IP address as primary_ip4.

        Searches IPAM for the address and checks:
        1. assigned_object.device — normal NetBox assignment
        2. description field — legacy format "Management IP for <name>"

        Returns {"id": ..., "name": ...} if found, else None.
        """
        result = self.get("/ipam/ip-addresses/", params={"address": ip_address})
        for ip in result.get("results", []):
            assigned = ip.get("assigned_object")
            if assigned and isinstance(assigned, dict):
                dev = assigned.get("device")
                if dev and isinstance(dev, dict) and dev.get("id"):
                    return {"id": dev["id"], "name": dev.get("name")}

            # Legacy description format: "Management IP for <device_name> — synced from NetConsole"
            desc = ip.get("description") or ""
            if "Management IP for " in desc:
                # Extract device name between "Management IP for " and " —"
                prefix = "Management IP for "
                suffix = " — synced from NetConsole"
                if desc.startswith(prefix) and desc.endswith(suffix):
                    device_name = desc[len(prefix):-len(suffix)]
                    # Look up the device by name to get its id
                    dev_result = self.get("/dcim/devices/", params={"name": device_name})
                    for dev in dev_result.get("results", []):
                        if dev.get("id"):
                            return {"id": dev["id"], "name": device_name}
        return None

    def _build_device_payload(
        self,
        site_id: int,
        device_type_id: int,
        role_id: int,
        *,
        netconsole_id: str,
        name: str,
        serial: str,
        status: str,
        description: str | None = None,
        platform_id: int | None = None,
        version: str | None = None,
        rack_id: int | None = None,
        unit: str | None = None,
    ) -> dict[str, Any]:
        """Build the NetBox device upsert payload (used for both POST and PATCH).

        NOTE: primary_ip4 is intentionally NOT set here. NetBox requires the
        IP address to be (1) created in IPAM, (2) assigned to a device interface,
        before it can be set as primary_ip4 on the device. That flow is handled
        separately in upsert_device after the device is created/updated.

        - platform_id: NetBox platform record id (version is the platform name).
        - version: stored in custom field `os_version` (the raw OS version string).
        - rack_id + unit: physical location — rack record and U-position.
        - description: kept clean — just the operator-supplied description.
        """
        payload: dict[str, Any] = {
            "name": name,
            "device_type": device_type_id,
            "role": role_id,
            "site": site_id,
            "serial": serial,
            "status": self._map_status(status),
            "tags": [],  # caller adds tag id
            "custom_fields": {
                "netconsole_id": netconsole_id,
            },
        }
        if description:
            payload["description"] = description
        if platform_id is not None:
            payload["platform"] = platform_id
        if version:
            payload["custom_fields"]["os_version"] = version
        if rack_id is not None:
            payload["rack"] = rack_id
        if unit is not None:
            try:
                payload["position"] = int(unit)
                payload["face"] = "front"  # NetBox v4 requires a string choice; "front" = front of rack
            except (ValueError, TypeError):
                logger.warning(
                    "netbox: invalid unit '%s' for device '%s' — skipping position",
                    unit, name,
                )
        return payload

    def _map_status(self, netconsole_status: str) -> str:
        """Map NetConsole DeviceStatus to NetBox device status string."""
        mapping = {
            "ONLINE": "active",
            "MANAGED": "active",
            "OFFLINE": "offline",
            "MAINTENANCE": "maintenance",
            "UNKNOWN": "planned",
        }
        return mapping.get(netconsole_status.upper(), "offline")

    def upsert_device(
        self,
        netconsole_id: str,
        name: str,
        serial: str,
        site: str,
        vendor: str,
        model: str,
        status: str,
        *,
        description: str | None = None,
        management_ip: str | None = None,
        version: str | None = None,
        part_number: str | None = None,
        rack: str | None = None,
        unit: str | None = None,
        existing_device_id: int | None = None,
    ) -> dict[str, Any]:
        """Create or update a NetBox device record.

        Resolution order for an existing device:
          1. `existing_device_id` — passed directly from netboxDeviceId column
          2. `netconsole_id` custom field — used as the canonical external key
          3. `serial` — fallback for devices created before the custom field existed

        On creation/update, the management IP is set as `primary_ip4` (NetBox
        v4 auto-creates the IPAM entry from the CIDR string). The OS version
        is stored in custom field `os_version`.

        Physical location (rack + unit): the rack is resolved by name within the
        site and auto-created if missing. The unit is the U-position (integer 1-42).

        Returns the NetBox device dict and a boolean `created` indicating whether
        it was newly created (vs updated).
        """
        tag_id = self.get_or_create_tag(
            name="source-netconsole",
            slug="source-netconsole",
            description="Synced from NetConsole",
        )

        # Determine target device id
        target_id: int | None = existing_device_id
        if target_id is None:
            nb_device = self.find_device_by_netconsole_id(netconsole_id)
            if nb_device:
                target_id = nb_device["id"]

        # Resolve related objects
        site_id = self.get_or_create_site(site, netconsole_id)
        mfg_id = self.get_or_create_manufacturer(vendor)
        dt_id = self.get_or_create_device_type(model, mfg_id, part_number)
        role_name = "Network" if vendor.lower() in ("juniper", "cisco", "arista", "aruba", "hp") else "Other"
        role_id = self.get_or_create_device_role(role_name)

        # Resolve NetBox platform.
        # Priority: version string (e.g. "18.4R1.5") → vendor-based canonical slug.
        # When version is provided it becomes the platform name so operators can
        # filter/view devices by exact OS release in NetBox.
        platform_id: int | None = None
        if version:
            # Build a slug like "junos-18-4r1-5" from the version string.
            # Non-alphanumeric chars (dots, slashes, parens) → hyphens, then collapse runs.
            import re as _re

            slug_base = vendor.lower().replace(" ", "") if vendor else ""
            ver_clean = _re.sub(r"[^a-z0-9]", "-", version.strip().lower())
            platform_slug = f"{slug_base}-{ver_clean}"
            # Collapse any runs of hyphens
            while "--" in platform_slug:
                platform_slug = platform_slug.replace("--", "-")
            platform_id = self.get_or_create_platform(
                slug=platform_slug,
                name=version,
                manufacturer_id=mfg_id,
            )
        if platform_id is None:
            # Fall back to the canonical vendor→platform mapping
            platform_slug = self._vendor_to_platform_slug(vendor)
            if platform_slug:
                platform_id = self.get_or_create_platform(
                    slug=platform_slug,
                    name=platform_slug.replace("-", " ").title(),
                    manufacturer_id=mfg_id,
                )

        # Resolve rack (physical location)
        rack_id = self._resolve_rack_id(rack, site_id)

        payload = self._build_device_payload(
            site_id=site_id,
            device_type_id=dt_id,
            role_id=role_id,
            netconsole_id=netconsole_id,
            name=name,
            serial=serial,
            status=status,
            description=description,
            platform_id=platform_id,
            version=version,
            rack_id=rack_id,
            unit=unit,
        )
        payload["tags"] = [tag_id]

        nb_device: dict[str, Any]

        if target_id is not None:
            nb_device = self.patch(f"/dcim/devices/{target_id}/", json=payload)
            logger.info(
                "netbox: updated device '%s' (id=%d, netconsole_id=%s)",
                name, target_id, netconsole_id,
            )
        else:
            nb_device = self.post("/dcim/devices/", json=payload)
            logger.info(
                "netbox: created device '%s' (id=%d, netconsole_id=%s)",
                name, nb_device["id"], netconsole_id,
            )

        # ------------------------------------------------------------------
        # Phase 2 IPAM: set primary_ip4 if management_ip is available.
        #
        # NetBox requires a 3-step dance before primary_ip4 can be set:
        #   1. Create the IP address entry in IPAM (or find existing)
        #   2. Assign that IP to a management interface on the device
        #   3. Then set primary_ip4 on the device (PATCH with ip id)
        #
        # We derive the /24 prefix from the management IP so each subnet
        # gets its own IPAM prefix automatically.
        # ------------------------------------------------------------------
        if management_ip:
            cidr = management_ip if "/" in management_ip else f"{management_ip}/32"
            device_id = nb_device["id"]
            try:
                # Step 1: get or create the /24 prefix (e.g. 10.10.20.0/24)
                prefix_24 = self._ip_to_prefix_24(management_ip)
                prefix_id: int | None = None
                if prefix_24:
                    prefix_id = self.get_or_create_prefix(prefix_24, site_id)

                # Step 2: create/find the IP address in IPAM
                nb_ip = self.get_or_create_ip_address(cidr, prefix_id=prefix_id)
                if not nb_ip:
                    raise NetBoxError(f"could not create or find IP {cidr} in IPAM")

                # Step 2b: Determine whether we can safely assign this IP.
                #
                # Two checks protect against IPAM conflicts:
                #   (a) Device already has this IP as primary_ip4 → skip the IPAM dance
                #       entirely (the IP is already correctly set).
                #   (b) IP is already assigned to a DIFFERENT device → skip (non-fatal;
                #       the IP stays on the correct device; we cannot steal it).
                #
                # NetBox IP addresses are globally unique — one IP can belong to only
                # one device. We MUST NOT try to reassign an IP that is already
                # correctly placed on another device.
                current_device = self.get(f"/dcim/devices/{device_id}/")
                current_primary_ip = (
                    current_device.get("primary_ip4", {}).get("id")
                    if isinstance(current_device.get("primary_ip4"), dict)
                    else None
                )
                if current_primary_ip == nb_ip["id"]:
                    # Device already has this IP as primary — nothing to do
                    logger.info(
                        "netbox: device '%s' already has primary_ip4=%s — skipping IPAM",
                        name, cidr,
                    )
                elif nb_ip.get("assigned_object"):
                    ip_device_id = (
                        nb_ip["assigned_object"].get("device", {}).get("id")
                        if isinstance(nb_ip["assigned_object"], dict)
                        else None
                    )
                    if ip_device_id is not None and ip_device_id != device_id:
                        raise NetBoxError(
                            f"IP {cidr} is already assigned to device id={ip_device_id}; "
                            f"cannot share IP across devices — skipping primary_ip4 for '{name}'",
                        )
                    # IP is assigned to our device (or unassigned) — proceed below
                    mgmt_iface = self._find_mgmt_interface(device_id, vendor)
                    if mgmt_iface:
                        iface_id = mgmt_iface["id"]
                        iface_name = mgmt_iface.get("name", "mgmt0")
                    else:
                        # No management interface found — create a generic one
                        iface_id = self._get_or_create_interface(
                            device_id, name, "mgmt0", interface_type="other",
                        )
                        iface_name = "mgmt0"

                    if iface_id is None:
                        raise NetBoxError("could not find or create management interface")

                    # Step 4: assign the IP to the management interface
                    if not self.assign_ip_to_interface(nb_ip["id"], iface_id, device_id):
                        raise NetBoxError(f"could not assign IP {cidr} to interface {iface_name}")

                    # Step 5: set primary_ip4 on the device (requires IP assigned to interface first)
                    self.patch(f"/dcim/devices/{device_id}/", json={
                        "primary_ip4": nb_ip["id"],
                    })
                    logger.info(
                        "netbox: primary_ip4 set on device '%s': IP=%s (id=%d), interface=%s",
                        name, cidr, nb_ip["id"], iface_name,
                    )
                elif nb_ip.get("assigned_object_id"):
                    # IP has assigned_object_id but assigned_object is null (stale API
                    # response). If it points to a different device, skip to avoid stealing it.
                    if nb_ip["assigned_object_id"] != device_id:
                        raise NetBoxError(
                            f"IP {cidr} is already assigned to interface id={nb_ip['assigned_object_id']}; "
                            f"cannot share IP across devices — skipping primary_ip4 for '{name}'",
                        )
                    # Assigned to our device — assign interface and set primary
                    mgmt_iface = self._find_mgmt_interface(device_id, vendor)
                    iface_id = mgmt_iface["id"] if mgmt_iface else self._get_or_create_interface(
                        device_id, name, "mgmt0", interface_type="other",
                    )
                    iface_name = mgmt_iface.get("name", "mgmt0") if mgmt_iface else "mgmt0"
                    if iface_id is None:
                        raise NetBoxError("could not find or create management interface")
                    if not self.assign_ip_to_interface(nb_ip["id"], iface_id, device_id):
                        raise NetBoxError(f"could not assign IP {cidr} to interface {iface_name}")
                    self.patch(f"/dcim/devices/{device_id}/", json={"primary_ip4": nb_ip["id"]})
                    logger.info(
                        "netbox: primary_ip4 set on device '%s': IP=%s (id=%d), interface=%s",
                        name, cidr, nb_ip["id"], iface_name,
                    )
                else:
                    # IP has no interface assignment. Use description ("Management IP for <name>")
                    # to determine which device this IP belongs to. If it belongs to a DIFFERENT
                    # device, skip (we cannot steal it). If it belongs to THIS device or is
                    # unclaimed, proceed to assign it.
                    ip_owner = self._find_device_by_ip(cidr)
                    if ip_owner and ip_owner["id"] != device_id:
                        raise NetBoxError(
                            f"IP {cidr} is already the primary IP of device '{ip_owner['name']}' "
                            f"(id={ip_owner['id']}); cannot share IP — skipping primary_ip4 for '{name}'",
                        )
                    # IP is either for this device or unclaimed — safe to assign
                    mgmt_iface = self._find_mgmt_interface(device_id, vendor)
                    iface_id = mgmt_iface["id"] if mgmt_iface else self._get_or_create_interface(
                        device_id, name, "mgmt0", interface_type="other",
                    )
                    iface_name = mgmt_iface.get("name", "mgmt0") if mgmt_iface else "mgmt0"
                    if iface_id is None:
                        raise NetBoxError("could not find or create management interface")
                    if not self.assign_ip_to_interface(nb_ip["id"], iface_id, device_id):
                        raise NetBoxError(f"could not assign IP {cidr} to interface {iface_name}")
                    self.patch(f"/dcim/devices/{device_id}/", json={"primary_ip4": nb_ip["id"]})
                    logger.info(
                        "netbox: primary_ip4 set on device '%s': IP=%s (id=%d), interface=%s",
                        name, cidr, nb_ip["id"], iface_name,
                    )
            except NetBoxError as exc:
                # Non-fatal: log and continue without primary_ip4
                logger.warning(
                    "netbox: IPAM link failed for '%s' (IP=%s): %s",
                    name, management_ip, exc,
                )

        return nb_device, target_id is None

    # ------------------------------------------------------------------
    # Health check — used by the sync task to verify connectivity
    # ------------------------------------------------------------------
    def health_check(self) -> bool:
        """Return True if the NetBox API is reachable."""
        try:
            result = self.get("/dcim/sites/", params={"limit": 1})
            return isinstance(result, dict) and "results" in result
        except Exception as exc:
            logger.warning("netbox health check failed: %s", exc)
            return False


# Module-level singleton so tasks can just `from netconsole_worker.clients.netbox import nb_client`
_nb_client: NetBoxClient | None = None


def get_netbox_client() -> NetBoxClient:
    global _nb_client
    if _nb_client is None:
        _nb_client = NetBoxClient()
    return _nb_client
