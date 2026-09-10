### 20:40 -- EOS modular LLDP port coerce + live refresh trigger

**Context**: User reported that on Arista EOS modular chassis (e.g. 7280),
LLDP neighbor port values came back as bare integers (`521`, `524`)
instead of `Ethernet<N>` strings. The diagram was rendering `521`/`524`
on the neighbor side instead of `et521`/`et524`.

**Root cause**: Worker `eos.py` parses `show lldp neighbors` output.
On modular platforms (intfId > 99), EOS eAPI returns port fields as
numeric types (521, 524) rather than `Ethernet<N>` strings. Fixed
platforms already emit the string form. Our previous worker code
preserved the numeric type as-is, and the backend `normalizeLldpPort`
only converts `Ethernet<N>` → `et<N>` (no fallback for bare ints).

**Fix — commit `f32d131`** (`worker/netconsole_worker/eos.py`):
- New `_coerce_eos_port(value)` helper: if value is digit-only
  (int, or string of pure digits), return `"Ethernet" + str(value)`;
  otherwise return value unchanged.
- All four port fields in `LldpNeighbor` (`localPort`, `remotePort`)
  + interface `name` now pass through this helper before being
  stored in `Job.result`.
- Backend `normalizeLldpPort` then runs its existing
  `Ethernet<N>` → `et<N>` rule → renders `et521` / `et524`.

**Deploy**:
- CI ✅ Deploy ✅ (run 34479528049, head_sha f32d131)
- Worker container restarted, picking up new image.

**Live verification — post-deploy**:
Enqueued `GET_INTERFACES` for all 9 Arista devices via backend-internal
HTTP (auth login + `POST /api/jobs`). 17 jobs SUCCESS, 3 FAILED:
- `8d47e280` (10.10.20.213): `Unable to connect to port 22` → device offline
- `f070d911`, `2cfba85c` (device `48301ed8`): `Authentication failed` →
  shared `EOS_API_PASSWORD` doesn't match this device. **Pre-existing
  credential issue, unrelated to this fix** — needs per-device creds
  (Phase 2 backlog item).
- For successful job `62b849dd` (F1-AS-01), LLDP result now contains
  `["Ethernet521","Ethernet1","Ethernet524","Ethernet4"]` → after
  backend normalize → `et521`, `et1`, `et524`, `et4` on diagram.

**Diagram**: cache will refresh on next `getFabricTopology` request
(`fabric:` cache key, 60s TTL). After that, `et1`/`et4` on F1-AS-01
ends + `et521`/`et524` on LAB-F6-DS-01/02 ends.

**Tools/scripts left behind** (will clean up later):
- `_refresh_lldp.js` — POST jobs to backend
- `_check_jobs2.js` — verify job status + raw port values
- `_run_refresh.ps1`, `_check_jobs2.ps1` — wrappers

**Backlog (unchanged)**: per-device EOS credentials so the `Authentication
failed` device starts collecting again.
