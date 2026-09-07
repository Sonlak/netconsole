### 2026-09-08 01:44 -- Config Studio: backend validate Juniper set-syntax + recover-junos endpoint

User báo: commit fail với chuỗi lỗi `unknown command: vlans / interfaces /
protocols` (xuất hiện nhiều lần) + cuối cùng `configuration database
modified`. Căn nguyên: `DeviceSavedConfig.content` chứa các dòng thiếu
verb `set` (vd `vlans`, `interfaces`, `protocols` rời rạc). Worker
`_set_commands` đã silently skip các dòng đó (đúng spec whitelist) nhưng
Junos vẫn nhận được `vlans` từ một số dòng khác (vd `deactivate vlans`),
gây ra syntax error dây chuyền, candidate database modified, commit
fail.

**Fix `validateConfigPayload`** (`backend/src/routes/generateConfig.ts`):

- Thêm export `JUNIPER_SET_VERBS` mirror đúng whitelist của worker
  (`set/delete/deactivate/activate/edit/commit/rollback/...`).
- Helper `stripJuniperNoise(content)` strip `#`, `!`, `/* … */` block +
  inline — khớp 1:1 với `_set_commands` để pre-check có cùng tập dòng
  với worker.
- Helper `validateJuniperSetLines(content)` sau khi strip, mỗi dòng phải
  bắt đầu bằng 1 verb trong whitelist. Nếu vi phạm, trả 400 kèm số dòng
  + sample 3 dòng đầu + "... và N dòng khác".
- Smoke test 12/12 pass (kể cả input gốc `vlans\ninterfaces\nprotocols`
  → reject; `set vlans vlan-id 100\nvlans\nset protocols ospf area 0` →
  reject đúng 1 dòng).

**Fix recover cho device kẹt `modified`**:

- Backend route mới `POST /api/config/devices/:id/recover-junos`
  (chỉ Juniper), enqueue `APPLY_CONFIG` với
  `payload.recover = 'discard-junos'`.
- Worker `ApplyConfigTask.run` detect sentinel **trước** khi strip, để
  comment-trimming không nuốt mất flag.
- `DeviceBackend.recover_junos(device)` (base default raises
  `NotImplementedError`) + `JuniperBackend.recover_junos` POST
  `<discard-changes/>` qua pooled RESTCONF client, fallback SSH.
  Xử lý "nothing to discard" như no-op success.

**Build**: `npm run build` ở backend pass (`tsc`). Worker
`py_compile` pass, import registry + backends pass.

**Lesson**:

- **Mirror whitelist, đừng duplicate**. Worker whitelist là single
  source of truth; backend `validateConfigPayload` phải dùng cùng tập
  verb, cùng noise-stripping rule. Khi mở rộng whitelist (vd thêm
  `wildcard-delete`) phải update cả 2 chỗ trong cùng 1 commit.
- **Pre-check ở backend là "stop the bleeding", không phải
  validator đầy đủ**. Worker vẫn phải defensive (silent-skip + log
  warning) vì bulk-deploy literal có thể đi qua path khác (vd
  script trực tiếp vào DB). Khi nào có test e2e, thêm test cho
  case `_set_commands` skip nhiều dòng → command list trống →
  backend raise "APPLY_CONFIG has no set/delete commands".
- **Recovery endpoint pattern**: dùng sentinel trong payload của
  existing job type, không thêm enum value. Tránh schema migration
  cho scope audit. Nếu sau này recovery phổ biến cho nhiều vendor
  (EOS rollback rescue, IOS-XE archive), chuyển sang enum value +
  migration mới để audit log rõ ràng hơn.
- **Backend route handler trong `generateConfig.ts` không phải lúc
  nào cũng có `authMiddleware`?** — đã có sẵn (mount qua
  `app.use('/api/config', authMiddleware, generateConfigRouter)` —
  confirm trước khi đẩy lên prod). Recover endpoint không bypass
  auth vì nó tạo job có thể đụng device thật.

**TODO follow-up** (không làm trong session này):

- Wire nút "Recover Junos" vào `frontend/src/pages/GenerateConfigPage.tsx`
  — backend endpoint sẵn sàng, frontend chưa có nút. Đặt cạnh nút
  Rollback trong Device Detail Card.
- Bulk-deploy literal mode: nếu skip 1 device thì
  `DeviceSavedConfig` của device đó vẫn bị upsert trước (theo design
  note cũ 2026-09-06 — cho phép rollback). Confirm giữ nguyên hay đổi.
- Test e2e: thêm vitest case cho `validateJuniperSetLines` ở backend
  + pytest case cho `_set_commands` ở worker — cùng input, cùng
  expected output.