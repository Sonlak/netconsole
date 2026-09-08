### 20:20 -- Config Studio 'Collect' / 'Commit' buttons failing with 'Device busy' / 'operation aborted'

**Symptom (recap from earlier today):**
- Clicking Collect in Config Studio -> "operation was aborted due to timeout"
- Clicking Commit -> spinner forever, then auto-dismiss after 3-4 minutes, ends in FAILED
- Backend logs showed GET_CONFIG jobs going to `junos-rest` (port 8443) instead of NETCONF (port 830) -- RESTCONF latency made the 20s frontend poll fire before the job returned

**Root cause:**
- `jobPriority()` collapsed both background sweeps (auto-scheduled every 60s) and user-triggered jobs into a single bucket (priority 100). When the user clicked "Collect" the auto-sweep was almost always holding the device lock, so `tryCreateDeviceJob()` returned 'Device busy' (HTTP 409).
- The 20s frontend poll (`waitForJobIfNeeded({ timeoutMs: 20000 })`) is too tight for a RESTCONF get-configuration when the worker is busy with five other Juniper devices in parallel.

**Fix (commit 16019cc):**
- `services/deviceOperations.ts` now distinguishes URGENT (200, user-driven UI actions: GET_CONFIG, APPLY_CONFIG, ROLLBACK_CONFIG, MANAGED_CHECK, INTERFACE_ACTION, CONNECT_TEST, DISCOVERY_PROBE) from HIGH (100, background GET_CONFIG / GET_INTERFACES sweeps). GET_ARP / GET_MAC stay at 0 (cheap, run everywhere).
- `tryCreateDeviceJob()` now pre-empts a blocking job when the incoming job is URGENT and the blocker has lower priority: PENDING rows are deleted, RUNNING rows are marked FAILED with `Pre-empted by <type> job (higher priority)` so the worker stops treating them as active when it goes to claim the next job.
- `services/deviceTabCollection.ts` and `services/interfaces.ts` no longer go through `jobPriority()` -- they hard-code priority 100 to make it visually obvious in code review that background sweeps must never inherit URGENT.
- Commit message also documents the rule "Config Studio chạy worker riêng, éo chạy chung với thằng nào khác" so the next agent does not revert.

**Verification:**
- Pushed commit, GitHub Actions auto-deploys (self-hosted runner on VPS).
- After deploy, manual `POST /api/devices/{f2-as-01}/config` as admin returned a job with priority 200 that completed SUCCESS via `junos-rest` -- no 409, no 20s timeout.
- Auto GET_CONFIG jobs in the same window still show priority 100, confirming the two tiers are now distinct.

**Also pushed earlier today (commit c7dae60):**
- `worker/netconsole_worker/backends/juniper.py` now exposes `netconfFallbackError` in the APPLY result when NETCONF SSH fails and we fall back to RESTCONF -- gives operators a real reason instead of the silent `junos-rest` source they saw before.

**NETCONF coverage on the lab (6/6 MANAGED Junipers):**
- LAB-F2-AS-01, LAB-F6-CORE-01, LAB-F6-CORE-02, LAB-F6-DS-01 -- NETCONF SSH works (`junos-netconf-ssh`).
- LAB-F3-AS-01, LAB-F6-DS-02 -- NETCONF SSH fails on those two, fell back to RESTCONF. `netconfFallbackError` will surface the reason on the next deploy + APPLY run so we can decide whether to fix device-side `netconf ssh` config or accept RESTCONF.

**Open follow-ups (not started):**
- NetCONF fallback error visible to operator on Jobs page once `netconfFallbackError` field is wired through the Logs UI (currently only in the JSON `result` blob).
- Decide whether to extend the 20s frontend poll to 240s for jobs we know can legitimately take that long (Junos commit under load) instead of leaning on `waitForJobWithNotification`.
