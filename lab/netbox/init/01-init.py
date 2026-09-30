"""NetBox startup script — runs on container boot via the official
`netboxcommunity/netbox` image's `startup_scripts` mechanism.

Purpose:
  1. Create (or re-print) a fixed API token for the `admin` superuser so
     the NetConsole worker can authenticate against NetBox.
  2. Create a `netconsole_id` CustomField on dcim.Device for the
     NetConsole → NetBox mapping.
  3. Create a `source-netconsole` tag that we stamp on every synced object.
  4. Print the token to stdout so the operator can grab it from
     `docker logs netbox-netbox` on first boot.

This file is idempotent — running it twice is safe. The script is mounted
at /opt/netbox/startup_scripts/01-init.py and runs once per container boot.

NetBox 4.x note: the M2M relation on CustomField is `object_types`
(not `content_types` as in v3.x). Using the v3 name silently leaves the
field with no associated content types, which surfaces downstream as
"Unknown field name 'netconsole_id' in custom field data" when the
worker POSTs a device. Always use `object_types` on v4.x.
"""

import sys
from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.contenttypes.models import ContentType
from extras.models import CustomField, Tag
from users.models import Token

# Token literal — keep in sync with the WORKER_AUTH_TOKEN pattern in
# docker-compose.app.yml. For a real deployment rotate this via
# `manage.py drf_create_token admin` and re-inject via env.
NETBOX_API_TOKEN = "0123456789abcdef0123456789abcdef01234567"


def _device_object_type() -> Any:
    """Return the dcim.device ObjectType record for v4.x compatibility.

    NetBox 4.x renamed `ContentType` (Django's contrib.contenttypes) to
    `ObjectType` (a netbox-local model). The DB primary key is still the
    same, but the field name on CustomField is `object_types` instead of
    `content_types`.
    """
    try:
        # NetBox v4 — use the netbox.extras.models.ObjectType
        from extras.models import ObjectType  # type: ignore[attr-defined]

        return ObjectType.objects.get(app_label="dcim", model="device")
    except (ImportError, AttributeError):
        # v3 fallback — Django's ContentType
        return ContentType.objects.get(app_label="dcim", model="device")


def main() -> None:
    User = get_user_model()
    try:
        admin = User.objects.get(username="admin")
    except User.DoesNotExist:
        print("[netbox-init] admin superuser not found yet, skipping", file=sys.stderr)
        return

    # 1. API token — DRF tokens are 1:1 with the user. If admin already has
    # one, rotate it to the configured literal so the worker always uses
    # the same token.
    Token.objects.filter(user=admin).delete()
    Token.objects.create(user=admin, key=NETBOX_API_TOKEN)
    print(f"[netbox-init] admin API token set: {NETBOX_API_TOKEN}")

    # 2. Custom field on dcim.Device. NetBox 4.x uses ObjectType via the
    # `object_types` M2M field. We look it up by app_label + model to
    # avoid an import-time cycle on the Device model.
    device_ot = _device_object_type()
    field, created = CustomField.objects.get_or_create(
        name="netconsole_id",
        defaults={
            "type": "text",
            "label": "NetConsole Device ID",
            "description": "UUID of the NetConsole Device row that this NetBox device was synced from. Set by the NetConsole NetBox sync job.",
        },
    )
    if created:
        # Set M2M after creation (get_or_create can't set it via defaults
        # because it's a relation, not a field).
        field.object_types.add(device_ot)
        print("[netbox-init] created custom field 'netconsole_id' on dcim.device")
    else:
        if not field.object_types.filter(id=device_ot.id).exists():
            field.object_types.add(device_ot)
        print("[netbox-init] custom field 'netconsole_id' already exists")

    # 3. Tag — for filter-by-source in the NetBox UI. NetBox tag names
    # cannot contain spaces.
    tag, created = Tag.objects.get_or_create(
        name="source-netconsole",
        defaults={
            "slug": "source-netconsole",
            "description": "Object was synced from NetConsole via the periodic NETBOX_SYNC job.",
        },
    )
    if created:
        print("[netbox-init] created tag 'source-netconsole'")
    else:
        print("[netbox-init] tag 'source-netconsole' already exists")


main()
