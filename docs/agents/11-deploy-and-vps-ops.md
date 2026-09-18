# Deploy & VPS Operations Reference

> Read this before any deploy / rollback / CI-status / VPS-state task.
> Quick-reference for the operational commands the agent uses to verify
> the deploy pipeline is healthy, test auto-rollback, and check VPS state.

---

## Auto-rollback: how it works (since 2026-09-16)

`rollback.yml` runs as a `workflow_run` triggered by `deploy.yml` failure.
The runner IS the VPS, so it reads deploy markers via local file ops
(no SSH). Marker resolution priority:

| # | Source | When used |
|---|--------|-----------|
| 0 | `workflow_dispatch` input `ref` | Manual rollback from Actions UI |
| 1 | `/opt/netconsole/.rollback-before-deploy-sha` | Normal auto path (anchor from previous good deploy) |
| 2 | `/opt/netconsole/.last-deploy-sha` | Backup if anchor missing |
| 3 | `git -C /opt/netconsole rev-parse HEAD` | Fresh VPS, no marker |
| 4 | `env.FALLBACK_SHA` hardcoded in rollback.yml | Last resort |

The rollback workflow has a 3-tier build fallback: (a) `up -d --build`
(normal), (b) `up -d` from cached image (if build fails), (c) `restart`
(last resort). All three keep the service up.

**Verified working:** Rollback #19 (v9 test), #21 (v10 test), both ~1m 54s.

---

## Auto-rollback TEST recipe (inject TS error, verify recovery)

Use this when you want to confirm the auto-rollback pipeline still works.
Three rounds of this test have passed (v8 pre-fix was the silent-fail case).

```bash
# 1. Inject a deliberate TS error into any backend file.
#    Place it near top so it surfaces early in the build:
#      const brokenVar: number = "this is a string";

# 2. Commit + push. CI/Deploy will FAIL.
git add backend/src/index.ts
git commit -m "test: rollback v<N> - inject TS error to verify auto-rollback fix"
git push origin main

# 3. Wait ~90s, then verify via API (see "Check CI status" below).
#    Expected:
#      Deploy #X        — failure
#      Rollback #Y      — success (auto-triggered ~60s after deploy fails)

# 4. Revert the bad commit (so future deploys don't keep failing):
git revert --no-edit HEAD
git push origin main

# 5. Wait ~120s, verify normal Deploy of revert succeeds, Rollback is skipped.
```

Total test cycle: ~15 minutes. The auto-rollback itself completes in
~1m 54s. Outage window from bad-push to fully-restored is ~3 minutes.

---

## Check CI status without `gh` CLI (PowerShell)

`gh` CLI is **not authenticated** on this Windows host. The repo is public,
so use the GitHub REST API directly via `curl.exe` (PowerShell aliases
`curl` to `Invoke-WebRequest` which has different flags — use `curl.exe`).

### List recent runs (status + conclusion)

```powershell
curl.exe -sS "https://api.github.com/repos/Sonlak/netconsole/actions/runs?per_page=10" ^
  | python "D:/NetConsole/.tmp-cfg/gh-runs.py"
```

Helper script `gh-runs.py`:
```python
import json, sys
data = json.load(sys.stdin)
for r in data["workflow_runs"]:
    n = r["run_number"]
    s = r["status"]
    c = r.get("conclusion") or "-"
    name = r["name"]
    sha = r["head_sha"][:7]
    ev = r["event"]
    created = r["created_at"][:19].replace("T", " ")
    print(f"#{n:>4} [{s:>9}/{c:>7}] {name:20s} {sha} {created} event={ev}")
```

Output:
```
# 377 [completed/failure] Deploy               1da496e 2026-09-16 01:28:37 event=push
# 390 [completed/success] CI                   1da496e 2026-09-16 01:28:37 event=push
#  21 [completed/success] Rollback             1da496e 2026-09-16 01:29:36 event=workflow_run
```

### Get jobs + steps for a specific run

```powershell
# Replace <RUN_ID> with the integer id from the runs list output
curl.exe -sS "https://api.github.com/repos/Sonlak/netconsole/actions/runs/<RUN_ID>/jobs" ^
  | python "D:/NetConsole/.tmp-cfg/gh-jobs.py"
```

Helper script `gh-jobs.py`:
```python
import json, sys
data = json.load(sys.stdin)
for j in data["jobs"]:
    print(f"JOB: {j['name']} | {j['conclusion']}")
    print(f"  started:   {j['started_at']}")
    print(f"  completed: {j['completed_at']}")
    for s in j["steps"]:
        print(f"  STEP: [{s['conclusion'] or s['status']:>9}] {s['name']}")
```

### Get step logs (rarely needed)

The `logs` field is empty in the jobs API. To get raw logs you need a
token, OR open the run in the browser. For 99% of cases, the
conclusion + step names above are enough to debug a failed workflow.

---

## Check live site health

The site is HTTPS on port 8443, not 443:

```powershell
curl.exe -sS --max-time 5 http://42.119.165.109:8443/api/health
```

Expected JSON response includes `status: "ok"` and a `modules` array
of length 15 (devices, jobs, fabric, dhcp, terminal, etc.).

If `status` is `"shutting_down"` or the request times out, the backend
container is restarting — usually mid-deploy. Wait 30s and retry.

---

## VPS SSH access

Public NIC (`ens33`) blocks port 22 (firewalld inactive, raw iptables).
SSH only via Tailscale:

```powershell
ssh sonnx@100.102.133.86
```

Once on VPS:

| Action | Command |
|--------|---------|
| Check current deploy SHA | `cat /opt/netconsole/.last-deploy-sha` |
| Check rollback anchor | `cat /opt/netconsole/.rollback-before-deploy-sha` |
| Check container status | `cd /opt/netconsole && docker compose -p netconsole -f docker-compose.app.yml ps` |
| Tail backend logs | `docker logs --tail 50 -f netconsole-backend` |
| Tail frontend logs | `docker logs --tail 50 -f netconsole-frontend` |
| Manual rebuild | `cd /opt/netconsole && docker compose -p netconsole -f docker-compose.app.yml up -d --build --no-deps backend worker frontend` |

---

## Marker state expectations after a successful deploy

After Deploy #X (commit SHA) succeeds, deploy.yml writes:

```
/opt/netconsole/.last-deploy-sha             = <SHA>     (current state)
/opt/netconsole/.last-deploy-ref             = main
/opt/netconsole/.rollback-before-deploy-sha  = <SHA>     (next rollback target)
/opt/netconsole/.rollback-before-deploy-ref  = main
```

Both `.last-deploy-sha` and `.rollback-before-deploy-sha` point at the
SAME good SHA. The next failure will roll back to this SHA.

---

## When to update FALLBACK_SHA in rollback.yml

`FALLBACK_SHA` is a hardcoded env var in `.github/workflows/rollback.yml`,
used only when ALL marker sources fail. Update it after each **confirmed
known-good** deploy:

1. Confirm the latest deploy has been live and stable for 1+ day.
2. Edit `rollback.yml`, change `FALLBACK_SHA: <old>` to the new SHA.
3. Commit + push (triggers a normal deploy — deploy.yml is unaffected
   by this change since it doesn't read FALLBACK_SHA).

Current `FALLBACK_SHA` = `2341643` (commit 2026-09-16 08:20, "fix(rollback):
use local file ops + FALLBACK_SHA"). Bump when a newer known-good is stable.

---

## Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `gh: To get started with GitHub CLI...` | `gh` not auth'd | Use `curl.exe` API path (above) |
| `Invoke-WebRequest` missing `-sS` | PowerShell aliased `curl` | Use `curl.exe` explicitly |
| `head` not found | PowerShell has no `head` | Use `python -c "..."` or `Select-Object -First N` |
| Rollback workflow shows `skipped` for a Deploy that failed | Job-level `if:` rejected | Check if Deploy conclusion was `failure` not `cancelled` |
| Rollback shows `<1s completed/skipped` | Pre-fix bug — SSH from runner to itself | Fixed in commit `2341643`; never recurs |
| `prisma db push` fails during rollback | Schema drift between rolled-back schema.prisma and current DB | Backend uses `scripts/docker-start.sh` with `--accept-data-loss`; container starts regardless |

---

## History of rollback.yml evolution

| Date | Commit | Change |
|------|--------|--------|
| 2026-09-15 | prior | SSH'd to VPS for marker read; **5 consecutive silent fails** (Rollback #6/#8/#11/#13/#16) |
| 2026-09-15 | `ccd369b` | Added `workflow_dispatch` escape hatch — but `if:` still rejected it silently |
| 2026-09-16 | `2341643` | **Full fix**: local file ops, hardcoded FALLBACK_SHA, fixed `if:`, 3-tier build fallback. Verified by Rollback #19 (v9) and #21 (v10) |
