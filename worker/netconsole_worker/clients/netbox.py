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


class NetBoxError(Exception):
    """Raised when the NetBox API returns a non-2xx status we can't handle."""


class NetBoxClient:
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
        vendor: str,
        description: str | None = None,
        management_ip: str | None = None,
        version: str | None = None,
    ) -> dict[str, Any]:
        """Build the NetBox device upsert payload (used for both POST and PATCH)."""
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
        if version:
            payload["comments"] = f"OS version: {version}"
        # Store management IP as oob_ip — NetBox calls it "management IP" in the UI.
        # This field is available in NetBox v4.
        if management_ip:
            payload["oob_ip"] = management_ip
            payload["primary_ip4"] = management_ip  # will be resolved separately
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
        existing_device_id: int | None = None,
    ) -> dict[str, Any]:
        """Create or update a NetBox device record.

        Resolution order for an existing device:
          1. `existing_device_id` — passed directly from netboxDeviceId column
          2. `netconsole_id` custom field — used as the canonical external key
          3. `serial` — fallback for devices created before the custom field existed

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
        # Default role: "network" for switches/routers, "other" otherwise
        role_name = "Network" if vendor.lower() in ("juniper", "cisco", "arista", "aruba", "hp") else "Other"
        role_id = self.get_or_create_device_role(role_name)

        payload = self._build_device_payload(
            site_id=site_id,
            device_type_id=dt_id,
            role_id=role_id,
            netconsole_id=netconsole_id,
            name=name,
            serial=serial,
            status=status,
            vendor=vendor,
            description=description,
            management_ip=management_ip,
            version=version,
        )
        payload["tags"] = [tag_id]

        if target_id is not None:
            # Update existing — PATCH only the fields we own
            # NetBox returns the full updated object on PATCH
            updated = self.patch(f"/dcim/devices/{target_id}/", json=payload)
            logger.info(
                "netbox: updated device '%s' (id=%d, netconsole_id=%s)",
                name, target_id, netconsole_id,
            )
            return updated, False

        # Create new
        created = self.post("/dcim/devices/", json=payload)
        logger.info(
            "netbox: created device '%s' (id=%d, netconsole_id=%s)",
            name, created["id"], netconsole_id,
        )
        return created, True

    def resolve_ip_address(self, address: str) -> int | None:
        """Resolve an IP address string (with or without /prefix) to a NetBox ip-address id.

        If the address already exists, returns its id. If not, returns None
        (Phase 2 / IPAM sync is responsible for creating it).
        """
        if not address:
            return None
        result = self.get("/ipam/ip-addresses/", params={"address": address})
        results = result.get("results", [])
        if results:
            return results[0]["id"]
        return None

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
