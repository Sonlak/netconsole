## 5. Known Gotchas

> Read these BEFORE debugging. See `AGENTS.md` gotcha table for the 30-second summary.

## 5. Known Gotchas (read these before debugging)

1. **`mustChangePassword` flow is partial** — backend sets the flag in seed,
   `/api/auth/login` returns it, but **frontend `ProtectedRoute` does not
   yet redirect to a forced change-password page**. So a fresh admin login
   hits the dashboard with a warning flag but no enforcement. TODO: build
   `ChangePasswordRequiredPage` and wire it into `ProtectedRoute`.
2. **Firewall on VPS** — netconsole-vps dùng firewalld config trên disk
   nhưng **firewalld daemon không chạy** (inactive dead). Layer thực thi
   là raw `iptables`/`ip6tables` (nftables backend). Port 22 public
   (`ens33`, IP `42.119.165.109`) đã bị khóa bằng rule
   `DROP tcp -- ens33 * 0.0.0.0/0 tcp dpt:22` via unit
   `netconsole-lock-ssh.service` (persistent qua reboot, idempotent).
   SSH chỉ còn hoạt động qua Tailscale (`100.102.133.86`) hoặc lab
   NIC (`ens34`, `10.10.20.20`). Nếu cần sửa firewall: dùng
   `iptables -I INPUT 1 ...` hoặc `ip6tables` trực tiếp.
3. **Windows line endings** — any `.sh` written from PowerShell must use
   `newline="\n"` when written via `Path.write_text`; otherwise bash on
   Linux sees `set -eu\r` and errors.
4. **paramiko vs OpenSSH CLI** — the deploy script switched from paramiko
   (which fails on OpenSSH 10 due to key-exchange algorithm mismatch) to
   native Windows OpenSSH at `C:\Windows\System32\OpenSSH\ssh.exe`.
5. **`docker compose` output is not always UTF-8** — decode with
   `errors="replace"` to avoid `UnicodeDecodeError` on cp1252 console.
6. **Compose IPAM** — backend talks to kea at fixed `172.31.0.10`/`.11`,
   not via service name. Don't change the subnet without a deploy dry-run.
7. **Worker auth token** is a long-lived JWT committed in
   `docker-compose.app.yml` for the `worker → backend` link. Treat as a
   secret; rotate via `scripts/rotate_secrets.sh`.
8. **Dagre rank ignores the `rank` node field** — `frontend/src/features/fabric/FabricDiagram.tsx`
   derives rank via BFS only as *labels/tone*; dagre always recomputes
   ranks from edge direction. So **edge direction in DB must be
   parent→child (higher-tier → lower-tier)**. If a link is stored as
   `access → core`, the access will end up at rank 0 (top of the canvas)
   and the rest of the layout collapses. Normalize direction in the
   FabricTopology loader if this happens.
9. **`FabricNode.floor` must be set on every access device** — the floor
   grouping in `layoutNodes` keys columns by `node.floor`. A missing
   `floor` falls back to `node.id`, which gets its own column and looks
   like a layout bug. If you ever see a stray access node sitting alone
   at the right edge of the canvas, the device record is missing a
   `floor` value.
10. **Same-rank peer edges must NOT be fed to dagre** — feeding
    `CORE-02 → CORE-01` (or `DS-01 → DS-02`, `ACCESS → ACCESS`) makes
    dagre rank the sink one tier below the source. Both cores (or both
    dists) must sit side by side at the same rank. Skip same-rank edges
    when building the dagre graph; the SVG link rendering reads
    `link.fromDeviceId` / `link.toDeviceId` directly so the link is still
    drawn, it just does not influence rank. See commit `9b58053`.
11. **`TierLayout.y` is a pixel Y, not a rank integer** — the dagre
    rewrite changed `y` from rank-integer to top-left pixel Y. Any
    filter like `layout.tiers.find((tl) => tl.y === t.rank)` is a
    silently-broken regression (it always returns 0 results because
    pixel-y ≠ rank-number). If you ever see tier bands or tier rail
    labels disappear, that filter pattern is the first place to look.
    See commit `330b7f0`.
12. **No fixed-offset arrays in layout code** — the old
    `SH_OFFSETS = [-60, 0, 60, ...]` and `FH_OFFSETS = [-50, 0, 50, ...]`
    patterns silently broke when the user added more nodes than the
    array length, because the offsets were smaller than `NODE_W = 228`.
    The dagre-based layout (`FabricDiagram.tsx`) now uses purely
    dynamic spacing: rank-3 anchored under rank-2 parent + vertical
    stack with `RANK3_STEP_Y = rank3NodeH + 16`, rank-2 spread =
    `(FLOOR_COL_WIDE - NODE_W) / (fhCount - 1)` so every box stays
    inside its column. When you add a new device, **no code change
    should be needed**. If you find yourself writing
    `const SOME_OFFSETS = [...]` for layout, refactor to dynamic
    instead. See commits `88719a3` + `7907866` and the
    `frontend/sanity-rank3.mjs` test that asserts "no rank-3 overlap"
    + "no column overflow" for 1/2/3/5/7 second-hop per floor.
13. **`tsc --noEmit` (CI advisory) does NOT catch duplicate `const` declarations** —
    `fabric/src/features/fabric/FabricDiagram.tsx` once had `const allBoxes = ...`
    declared twice (one for the centering pass, one for the canvas-bbox pass).
    The advisory `tsc -b` step in CI ran clean because it stopped at the
    type-check phase. But `vite build` re-runs `tsc` with `--noEmit false`
    and FAILED with `TS2451: Cannot redeclare block-scoped variable
    'allBoxes'`. Result: **CI green, but Deploy still failed** because
    the Build step in the Frontend (build) job exit-coded non-zero. The
    self-hosted runner's deploy job never ran.
    **Lesson for next agent**:
    - `npm run build` (= `tsc -b && vite build`) catches everything
      `tsc --noEmit` does AND module-resolution errors and emit-time
      errors. ALWAYS run `npm run build` before committing any TSX
      change, not just `tsc --noEmit`.
    - Before claiming "done" on a frontend change, check the latest
      GitHub Actions run for **Frontend (build)** conclusion — `success`
      is required, not just CI overall.
    - If you see the live site still showing old behaviour after a push,
      check `https://github.com/Sonlak/netconsole/actions` for a red
      build job — the user's previous complaint ("đéo thấy git báo lỗi
      à") is exactly this scenario. See commit `ee74cca`.

---

