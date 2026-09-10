### 22:31 — Floor 1/2/3 "missing L3 link" fixed via box.x clamp

- Symptom: Floor 1/2/3 render thiếu link CORE-01 → DS-01 (và đối xứng CORE-02 → DS-02). Header vẫn ghi `5 devices · 8 links` nhưng trên canvas chỉ thấy 7 line, một line L3 bị vẽ ở X âm nên không hiện.
- Root cause: `frontend/src/features/fabric/FabricDiagram.tsx` axis-shift step (lines 611-648) re-centre rank 0/1 quanh rank-2 centre, nhưng dagre raw X của CORE-01 có thể âm (-69px trong Floor 1). Sau shift, CORE-01 box.x vẫn âm. Port 0 của CORE-01 ở X = box.x + 18 = -51. Line L3 từ port 0 đi vào vùng âm → user không thấy.
- Fix: thêm 1 clamp ngay sau axis-shift: shift tất cả node sao cho `min(box.x) >= MARGIN_X`. Giữ relative geometry (CORE-01 vẫn ở trái CORE-02, etc.) nhưng không có node tràn ra ngoài canvas trái.
- Verify: Floor 1 hiện đủ 8 link (CORE-CORE peer + DS-DS peer + 4 CORE↔DS L3 + 2 DS↔F1 trunk); Floor 2 tương tự; Floor 3 đủ 10 link bao gồm tier ACCESS L2 cho rank-3 nodes. All-floors vẫn đủ 14 link.
- Commit: 5b3f874 on main, CI passed, frontend deployed lúc 11:23 ET.
- Open: chưa viết test cho layout. Nếu thêm floor khác và rank-2 layout rộng hơn (vd 5 access/floor), có thể box.x của rank-0 vẫn lệch — nhưng clamp sẽ tự xử lý.

Rule cho next agent: bất kỳ layout mới nào thêm node ở rank 0/1 phải re-check `min(box.x) >= MARGIN_X`. Đã có sẵn clamp; chỉ cần giữ.

---

### 23:17 — MAC/ARP pages: 3.5s → 0.4s via DISTINCT ON + composite index

Same anti-pattern as the fabric/floor round, but in the data layer.

- **Symptom**: MAC page cold 3.47s, ARP page cold 1.53s. Both pulled JSON ~13KB for 8 lab devices.
- **Root cause**: `getMacAddressInventory()` and `getArpInventory()` looped N devices calling `getLatestJobResult()` (= `prisma.job.findFirst({where:{deviceId, type, status:SUCCESS}, orderBy:updatedAt desc})`). With no matching index, each call Parallel Seq Scanned the GET_MAC/GET_ARP table (~46k rows) at ~95ms. 9 devices × 2 types ≈ 1.7s; MAC page is heavier because `buildArpIpLookup()` adds a 3rd loop.
- **Fix**:
  - `backend/prisma/schema.prisma` — added `@@index([deviceId, type, status, updatedAt(sort: Desc)])` for the (deviceId, type, status, updatedAt) pattern. Plan 9 explains why.
  - `backend/src/services/arpAddress.ts` — single `fetchLatestArpJobsByDevice()` raw query using `DISTINCT ON("deviceId") ... IN(...)`, replaced 9-loop.
  - `backend/src/services/macAddress.ts` — new `fetchLatestJobResultsByDevice(deviceIds, type)` helper, reused for both GET_MAC and GET_ARP. MAC page now does both queries in `Promise.all` (was serial).
- **Measured** on VPS after auto-deploy (commit 57ef3c5):
  - MAC page: 3.47s → 0.42–0.51s (~7× faster).
  - ARP page: 1.53s → 0.33–0.36s (~5× faster).
  - Payload sanity: MAC 47 rows / 8 devices, ARP 26 rows / 8 devices — same data, same `withData` counts.
  - Index new `Job_deviceId_type_status_updatedAt_idx` confirmed present; planner chose Seq Scan over index scan because lab table is hot in buffer cache (9 IDs vs 46k rows). At prod scale (~500 devices) the index will start winning. Acceptable trade-off.
- **Commit**: 57ef3c5 on main, CI + Deploy both passed.
- **Open**: none — leave as is. If user wants to squeeze the last ~100ms we can `SET enable_seqscan = off` per session, but not worth the hack for 9-device LAB.

Lesson cho next agent: bất kỳ service nào lặp `getLatestJobResult(deviceId, type)` cho N devices → flag. Bất kỳ index `(deviceId, status, ...)` không match query pattern `(deviceId, type, status, updatedAt)` → index sẽ bị bỏ qua → Seq Scan. INDEX nên bám sát WHERE+ORDER BY.
