"""NetBox startup script for the second NetBox instance (netbox2).

Runs on container boot via the official `netboxcommunity/netbox` image's
startup_scripts mechanism.

Purpose (same as 01-init.py for production NetBox, but for netbox2):
  1. Create a fixed API token for the `admin` superuser.
  2. Create the `netconsole_id` and `os_version` CustomFields on dcim.Device.
  3. Create the `source-netconsole` tag.

This file is idempotent — running it twice is safe.
"""

import sys
from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.contenttypes.models import ContentType
from extras.models import CustomField, Tag
from users.models import Token

# Token for netbox2 — different from production token.
# Rotate via `manage.py drf_create_token admin` in the netbox2 container.
NETBOX2_API_TOKEN = "fedcba9876543210fedcba9876543210fedcba98"


def _device_object_type() -> Any:
    """Return the dcim.device ObjectType record for v4.x compatibility."""
    try:
        from extras.models import ObjectType
        return ObjectType.objects.get(app_label="dcim", model="device")
    except (ImportError, AttributeError):
        return ContentType.objects.get(app_label="dcim", model="device")


def main() -> None:
    User = get_user_model()
    try:
        admin = User.objects.get(username="admin")
    except User.DoesNotExist:
        print("[netbox2-init] admin superuser not found yet, skipping", file=sys.stderr)
        return

    # 1. API token
    Token.objects.filter(user=admin).delete()
    Token.objects.create(user=admin, key=NETBOX2_API_TOKEN)
    print(f"[netbox2-init] admin API token set: {NETBOX2_API_TOKEN}")

    device_ot = _device_object_type()

    # 2. Custom fields on dcim.Device
    for cf_name, cf_label, cf_desc in [
        ("netconsole_id", "NetConsole Device ID",
         "UUID of the NetConsole Device row that this NetBox device was synced from."),
        ("os_version", "OS Version",
         "Device OS version string (e.g. 18.4R1.5) — synced from NetConsole."),
    ]:
        field, created = CustomField.objects.get_or_create(
            name=cf_name,
            defaults={"type": "text", "label": cf_label, "description": cf_desc},
        )
        if created:
            field.object_types.add(device_ot)
            print(f"[netbox2-init] created custom field '{cf_name}' on dcim.device")
        else:
            if not field.object_types.filter(id=device_ot.id).exists():
                field.object_types.add(device_ot)
            print(f"[netbox2-init] custom field '{cf_name}' already exists")

    # 3. Tags
    for tag_name, tag_slug, tag_desc in [
        ("source-netconsole", "source-netconsole",
         "Object was synced from NetConsole."),
        ("source-netbox2", "source-netbox2",
         "Object was created in the netbox2 (import target) instance."),
    ]:
        tag, created = Tag.objects.get_or_create(
            name=tag_name,
            defaults={"slug": tag_slug, "description": tag_desc},
        )
        if created:
            print(f"[netbox2-init] created tag '{tag_name}'")
        else:
            print(f"[netbox2-init] tag '{tag_name}' already exists")


main()
