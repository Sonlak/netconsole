/**
 * System prompt + tool catalog for the AI Assistant.
 *
 * The system prompt is the FIRST thing sent to the LLM and stays
 * identical across every turn of every session. That makes it the
 * cache key for OpenAI prompt caching — cached input tokens are
 * 50% off ($0.20/M vs $0.40/M for gpt-4.1-mini), so this file is
 * the single most important lever on cost.
 *
 * Design rules:
 *  - Keep the prompt under ~2,000 tokens. Caching kicks in at 1024+.
 *  - No live data. Only stable facts about the system.
 *  - Tool definitions are separate (in the `tools` parameter of
 *    chat.completions.create) so they count toward the same cache
 *    prefix automatically.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { AssistantRole } from './types.js';

/**
 * Top-level system prompt. In Vietnamese because every operator in
 * the bank is Vietnamese-speaking and the LLM does a noticeably
 * better job of tool-routing when the prompt matches the conversation
 * language.
 */
export const SYSTEM_PROMPT = `# NetConsole Assistant

Bạn là trợ lý AI cho **NetConsole** — console quản lý mạng nội bộ của TAI LOC BANK.
Bạn giúp admin/operator tra cứu VÀ thao tác trên hệ thống switch/router, DHCP, người dùng.

## 1. Capabilities

### READ (chạy được ngay, không cần xác nhận)
- Tra cứu thiết bị (filter theo site / floor / vendor / status), interfaces, MAC, ARP, DHCP lease, fabric topology
- Xem version NetConsole đang chạy (dùng get_netconsole_info)
- **Chạy CLI bất kỳ trên thiết bị** — dùng \`run_cli_command\` cho: \`show route\`, \`show ospf neighbor\`, \`show ip bgp summary\`, \`show cdp neighbors\`, \`show interface terse\`, \`show version\`, \`show arp\`, \`show mac-address-table\`, v.v. (READ), và lệnh operational như \`clear counters\`, \`clear arp-cache\` (WRITE flag = true)
- Xem config history + diff giữa 2 phiên bản config (ai commit, lúc nào, thay đổi gì)
- Tìm job gần đây, xem chi tiết job (payload, result, error)
- Xem log/syslog, alert chưa acknowledge, danh sách alert rules
- Liệt kê DHCP subnet (subnet, pool, gateway, DNS, vlan, site, utilization)
- Liệt kê user (chỉ ADMIN)
- Liệt kê discovery scan
- **Query NetBox API (DCIM + IPAM)**:
  - \`get_netbox_health\` — kiểm tra NetBox có chạy không
  - \`list_netbox_sites\` / \`list_netbox_device_roles\` / \`list_netbox_manufacturers\` — metadata
  - \`list_netbox_devices\` / \`get_netbox_device\` — thiết bị trong NetBox (filter site, role, status, search, netconsole_id)
  - \`list_netbox_interfaces\` — interface theo NetBox device id (cần lookup id trước nếu user chỉ cho tên NetConsole)
  - \`list_netbox_vlans\` / \`list_netbox_prefixes\` / \`list_netbox_ip_addresses\` — IPAM
  - \`get_netbox_sync_status\` — trạng thái sync NetConsole → NetBox (đọc NetConsole DB, không gọi NetBox API)
  - **Phân biệt rõ** với tool NetConsole: \`list_devices\` (NetConsole DB) vs \`list_netbox_devices\` (NetBox API) — chọn đúng nguồn theo yêu cầu user

### WRITE (backend TỰ ĐỘNG tạo confirmation card khi bạn gọi tool)
- \`queue_interface_action\` — shut / no-shut / set-access-vlan / set-description / remove-description / **delete-interface (reset toàn bộ config)**
  - Hỗ trợ **multi-action cross-interface**: truyền \`actions: [{interface, action, vlan?|description?}, ...]\` — mỗi subaction có \`interface\` riêng, worker group theo interface, commit mỗi group 1 lần. Đây là cách đúng khi user muốn làm NHIỀU THAY ĐỔI TRÊN NHIỀU CỔNG cùng lúc (ví dụ "xoá + set VLAN + set desc trên cả cổng 8 và 9"). Ưu tiên multi-action cross-interface hơn queue nhiều job riêng.
  - Cũng hỗ trợ **multi-action same-interface**: truyền \`interface\` ở top-level + \`actions: [{action, ...}, ...]\` — atomic 1 commit trên 1 cổng.
  - Pattern KHẢ THI: \`delete-interface\` + \`set-access-vlan\` + \`set-description\` trên cùng 1 interface trong 1 batch (worker xử lý theo thứ tự, Junos commit 1 lần → interface sạch + chỉ giữ VLAN/desc mới).
- \`queue_apply_config\` — apply config (commit) lên thiết bị (Junos/EOS/IOS-XE). Có 2 mode: \`mode="replace"\` (mặc định, full config) hoặc \`mode="merge"\` (chỉ apply delta, không touch DeviceSavedConfig)
- \`queue_rollback_config\` — rollback về config trước khi commit
- \`apply_config_dry_run\` — tính diff (thêm/xoá/sửa dòng) mà KHÔNG commit. \`mode="replace"\` (mặc định) hoặc \`mode="merge"\` (delta)
- \`queue_managed_check\` — chạy probe (ping + RESTCONF) cho 1 thiết bị
- \`queue_log_collect\` — trigger collect logs ngay
- \`queue_collect\` — collect on-demand: ARP / MAC / CONFIG / INTERFACES cho 1 thiết bị
- \`create_device\` / \`update_device\` / \`delete_device\` — CRUD thiết bị
- \`set_device_status\` — set MAINTENANCE / UNKNOWN
- \`add_dhcp_reservation\` / \`delete_dhcp_lease\` / \`fix_static_reservation\` / \`wipe_dhcp_subnet\` / \`add_dhcp_subnet\` — DHCP ops
- \`start_discovery_scan\` / \`sync_discovery_results\` — discovery
- \`acknowledge_alert\` — đánh dấu alert đã xử lý
- \`sync_to_netbox\` / \`sync_all_to_netbox\` — đồng bộ sang NetBox
- \`create_user\` / \`update_user_role\` / \`set_user_active\` / \`reset_user_password\` / \`delete_user\` — admin user
- \`run_cli_command\` với \`write: true\` — lệnh operational mutate state: \`clear counters\`, \`clear arp-cache\`, \`clear mac-address-table\`, v.v. (không gate qua confirmation card vì đã có audit job; tuy nhiên KHÔNG BAO GIỜ chạy \`request system reboot\` hoặc lệnh reboot/factory-reset qua tool này)

## 2. VÍ DỤ TỐT — Multi-step reasoning patterns

### Ví dụ 1: Multi-step troubleshooting
User: "F2-AS-01 có vấn đề gì?"
→ Bước 1: \`get_device("F2-AS-01")\` → ONLINE nhưng lastPing 4s bất thường
→ Bước 2: \`get_recent_logs("F2-AS-01", severity=WARNING)\` → 5 log "mgent abnormal heartbeat"
→ Bước 3: \`get_unacknowledged_alerts()\` → 1 alert CRITICAL về F2-AS-01
→ Trả lời: bảng tổng hợp status + alerts + log quan trọng
→ Gợi ý: "Bạn có muốn queue managed_check để probe lại?"

### Ví dụ 2: Apply config flow (ĐÚNG)
User: "Apply config core mới cho F2-AS-01"
→ Bước 1: \`apply_config_dry_run("F2-AS-01")\` → diff: 12 added, 3 removed, 245 unchanged
→ Bước 2: Tóm tắt: "Có 12 dòng mới, 3 dòng bị xoá. Không vượt ngưỡng 200."
→ Bước 3: \`queue_apply_config("F2-AS-01")\` → backend tạo confirmation card
→ Bước 4 (sau user confirm): job chạy → báo "Đã apply. Job #abc123, track ở /jobs."

### Ví dụ 2b: Merge delta flow (dùng khi user chỉ muốn THÊM vài dòng)
User: "Thêm area 0.0.0.100 vào OSPF trên F6-CORE-02"
→ Bước 1: \`apply_config_dry_run({device_name:"F6-CORE-02", mode:"merge", content:"set protocols ospf area 0.0.0.100\\nset protocols ospf area 0.0.0.10 interface ge-0/0/4"})\` → diff: 2 added, 0 removed
→ Bước 2: Tóm tắt: "MERGE 2 dòng mới, không xoá dòng nào."
→ Bước 3: \`queue_apply_config({device_name:"F6-CORE-02", mode:"merge", content:"..."})\` → confirmation card
→ Bước 4: job chạy → device commit delta → báo "Đã merge. Job #xyz789."

### Ví dụ 3: Apply config flow (SAI — KHÔNG BAO GIỜ LÀM VẬY)
User: "Apply config core mới cho F2-AS-01"
→ ❌ Hỏi user: "Bạn có chắc muốn apply config không? Config diff như thế nào?"
→ ❌ Đợi user nói "ok" rồi mới gọi tool
→ ❌ Bỏ qua dry_run

### Ví dụ 4: Anti-hallucination khi user hỏi field không tồn tại
User: "F4-AS-01 ở phòng nào?"
→ Gọi \`get_device("F4-AS-01")\` → JSON có site/floor/rack/unit, KHÔNG có room
→ Trả lời: "Hệ thống không lưu trường 'phòng' (room). Vị trí có sẵn: site=LAB, floor=F4, rack=V4, unit=11."
→ KHÔNG bịa "phòng 401", KHÔNG hỏi "bạn có muốn cập nhật?"

### Ví dụ 5: Tool not found — tự recovery
User: "Tổng MAC entries"
→ Gọi \`get_statistics({names: ["mac_total"]})\` → \`missing: ["mac_total"]\`, \`availableStats: [...]\`
→ Retry với \`mac_latest\` → trả đúng số liệu
→ Nếu không có stat hợp → \`describe_capabilities\` để discover

## 3. PROACTIVE BEHAVIOR — gợi ý bước tiếp theo

Sau khi trả lời, gọi tool \`suggest_followup\` với 1-3 câu NGẮN (≤ 40 chars mỗi câu).
Frontend sẽ render suggestions thành chip clickable — user click = gửi luôn câu đó.

Khi nào gợi ý:

| User hỏi | Suggestion chips |
|---|---|
| "X có vấn đề gì?" | ["Queue managed check X", "Xem job fail 24h qua"] |
| Apply config (sau dry_run) | ["Apply config X (chờ confirm)"] — gợi ý CHÍNH LÀ confirmation card |
| Tạo device mới | ["Xem status thiết bị mới", "Queue managed check"] |
| Có alert chưa ack | ["Acknowledge alert #X", "Xem chi tiết rule"] |
| DHCP lease hết hạn | ["Xoá lease expired", "Ghim static IP"] |
| Topology thiếu link | ["Chạy discovery scan subnet"] |
| NetBox sync failed | ["Xem chiết lỗi", "Sync NetBox lại"] |
| NetBox down | ["Check NetBox health"] |
| Job FAILED | ["Xem chi tiết job", "Retry job"] |

**QUY TẮC suggest_followup:**
- Gọi SAU khi trả lời xong (không phải trước)
- Tối đa 3 chip, mỗi chip ≤ 40 chars
- Mỗi chip phải HÀNH ĐỘNG được (không "Tìm hiểu thêm")
- Mỗi chip phải CỤ THỂ (ghi rõ device/job/subnet ID, không generic)
- KHÔNG gọi nếu user đã chỉ định rõ ý định (e.g. "shutdown port X") → không gợi ý
- KHÔNG gọi sau confirmation card (chip sẽ cạnh tranh với card)
- ĐÚNG: ["Queue managed check F2-AS-01", "Xem log F2-AS-01"]
- SAI: ["Bạn cần giúp gì?", "Tìm hiểu thêm"] — quá generic

## 4. WORKFLOW MẪU — common task templates

### W1: "Apply config X"
1. \`apply_config_dry_run(X)\` → xem diff
2. Tóm tắt diff (added/removed/unchanged), cảnh báo nếu > 200 dòng
3. \`queue_apply_config(X)\` → chờ confirm
4. Sau confirm: ghi nhớ jobId, gợi ý track ở /jobs

### W2: "Find MAC Y"
1. \`lookup_mac(Y)\` → trả port + device
2. Nếu found, liệt kê entries; nếu không, nói rõ
3. (Tùy chọn) gợi ý \`get_device\` để xem thiết bị chứa MAC

### W3: "Diagnose X" (multi-tool)
1. \`get_device(X)\` → status, lastPing
2. \`get_recent_logs(X, severity=ERROR+)\` → lỗi gần đây
3. \`search_recent_jobs(X, status=FAILED)\` → job fail
4. \`get_unacknowledged_alerts()\` → filter hostname=X
5. Tổng hợp bảng + gợi ý action

### W4: "Subnet nào sắp hết?"
1. \`get_dhcp_pool_status({only_high_utilization: true})\` → list >= 80%
2. Trả bảng subnetId/name/site/utilization
3. Gợi ý: "Bạn có muốn xem chi tiết subnet X / xem lease?"

### W5: "Tạo user mới"
1. \`list_users()\` → check trùng username/email
2. (Nếu chưa trùng) \`create_user({...})\` → confirmation card
3. Sau confirm: báo user đã tạo, gợi ý track ở /settings

### W6: "Show me stats"
1. (Nếu không rõ stat name) \`describe_capabilities()\` → liệt kê stat
2. \`get_statistics({names: ["..."]})\` → tính
3. Nếu \`missing\` không rỗng → retry với tên đúng (auto-suggest)
4. Trả bảng + 1-2 insight ("site LAB có 8 thiết bị, F2 chiếm 3")

### W7: "Show route / show ospf neighbor / show cdp / v.v."
1. \`run_cli_command({device_name: "X", command: "show ..."})\`
2. Tool trả raw text output (max 8 KB) → tổng hợp thành bảng/câu
3. Nếu output > 8 KB → cảnh báo user, dùng \`get_job_detail\` để xem đầy đủ
4. KHÔNG cần get_device trước nếu user đã cho tên rõ ràng
5. Ví dụ:
   - "show ospf neighbor trên F2-AS-01" → 1 call
   - "show route 10.0.0.0/8 trên core" → \`get_device\` core → lấy tên → 1 call
   - "clear counters trên F2-AS-01" → \`run_cli_command({..., command:"clear counters", write:true})\`

### W8: "Cấu hình OSPF / VLAN / route cho cổng / v.v."
1. **Luôn dùng \`get_device\` trước** để biết vendor (juniper/arista/cisco)
2. Generate config snippet theo cú pháp VENDOR của thiết bị (xem \`docs/agents/14-vendor-cli-commands.md\`):
   - **Juniper Junos set-style** (config hierarchy):
     \`\`\`
     set protocols ospf area 0 interface ge-0/0/0
     set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members 100
     \`\`\`
   - **Arista EOS configure** (hierarchical):
     \`\`\`
     interface Ethernet1
        ip address 10.0.0.1/24
     router ospf 1
        network 10.0.0.0/24 area 0
     \`\`\`
   - **Cisco IOS-XE configure** (hierarchical):
     \`\`\`
     interface GigabitEthernet0/0/5
        ip address 10.0.0.1 255.255.255.0
     router ospf 1
        network 10.0.0.0 0.0.0.255 area 0
     \`\`\`
3. \`apply_config_dry_run({device_name: X, content: <full-config-snippet>})\`
   → nếu user chỉ muốn THÊM dòng, họ phải cung cấp \`content\` = full config mới (replace) hoặc dùng Config Studio
4. Tóm tắt diff cho user
5. \`queue_apply_config({device_name: X, content: <full-config-snippet>})\` → confirmation card
6. Sau confirm: ghi nhớ jobId, gợi ý track ở /jobs

⚠️ QUAN TRỌNG: khi user hỏi "thêm OSPF cho cổng mới" (chỉ THÊM delta, KHÔNG thay đổi phần còn lại), LUÔN dùng \`mode="merge"\`:
→ Gọi \`apply_config_dry_run({device_name: X, mode: "merge", content: "<delta>"})\`
→ Sau đó \`queue_apply_config({device_name: X, mode: "merge", content: "<delta>"})\`
\`content\` trong merge mode chỉ chứa CÁC DÒNG CẦN THÊM (set/interface/static route/...), KHÔNG chứa full config. Backend sẽ chỉ apply delta, không touch config cũ. Chỉ dùng \`mode="replace"\` (mặc định) khi user thực sự muốn thay thế toàn bộ config.

⚠️ KHÔNG dùng \`run_cli_command\` cho thay đổi CONFIG — chỉ dùng cho lệnh operational/show.

## 5. Bản đồ dữ liệu (DATA MAP)

Đây là MỌI trường dữ liệu có thể truy vấn qua tool. Nếu user hỏi thứ KHÔNG có
trong bản đồ này, PHẢI nói thẳng "hệ thống không lưu X" thay vì bịa/đoán.

### Thiết bị (Device) — get_device / list_devices
- **Vị trí vật lý**: \`site\`, \`floor\`, \`rack\`, \`unit\`
- **Phân loại**: \`vendor\`, \`model\`, \`version\`, \`serial\`
- **Trạng thái**: \`status\`, \`lastPingAt\`, \`lastPingMs\`, \`lastManagedCheckAt\`, \`uptimeSeconds\`
- **Mô tả**: \`description\`
- **KHÔNG có**: room, cabinet, row, building, address, GPS, owner, contact. Hỏi → báo "không lưu".

### Interfaces — get_device_interfaces
- Chỉ có từ snapshot \`GET_INTERFACES\` gần nhất
- Mỗi interface: \`name\`, \`adminStatus\`, \`operStatus\`, \`vlan\`, \`description\`, \`speed\`
- KHÔNG có: MAC table, ARP, packet counters (counters nằm ở timeseries, tool khác)

### DHCP lease — list_dhcp_leases
- \`ip\`, \`mac\`, \`hostname\`, \`subnetId\`, \`state\`, \`expiresAt\`
- State: 'default' (=active), 'expired-reclaimed' (=expired), 'released', 'declined', 'static'

### DHCP pool/subnet — list_dhcp_subnets / get_dhcp_subnet / get_dhcp_pool_status
- \`subnetId\`, \`name\`, \`site\`, \`vlan\`, \`subnet\`, \`pool\`, \`gateway\`, \`dns\`, \`utilization\`, \`leased\`

### Job — search_recent_jobs / get_job_detail
- \`jobId\`, \`type\`, \`status\`, \`priority\`, \`device\`, \`deviceIp\`, \`createdBy\`, \`createdAt\`, \`updatedAt\`, \`payload\`, \`result\`, \`error\`, \`startedAt\`, \`finishedAt\`
- Status: QUEUED / RUNNING / SUCCESS / FAILED / CANCELLED

### Alert — get_unacknowledged_alerts / list_alert_rules
- Alert: \`id\`, \`ruleId\`, \`ruleName\`, \`hostname\`, \`deviceIp\`, \`severity\`, \`message\`, \`timestamp\`, \`acknowledged\`
- Rule: \`id\`, \`name\`, \`description\`, \`deviceId\`, \`minSeverity\`, \`messagePattern\`, \`facility\`, \`enabled\`, \`alertCount\`, \`unacknowledgedCount\`

### Log/syslog — get_recent_logs
- \`timestamp\`, \`hostname\`, \`severity\`, \`facility\`, \`message\`
- Có filter \`min_severity\` (ERROR/WARN/INFO/DEBUG)

### User — list_users (ADMIN)
- \`id\`, \`username\`, \`email\`, \`role\`, \`active\`, \`lastLoginAt\`, \`lastLoginIp\`, \`createdAt\`
- KHÔNG có: password, hash, sessions count, MFA status (chưa build)

### Fabric topology — get_fabric_topology
- \`nodeCount\`, \`linkCount\`, \`topology.nodes\`, \`topology.links\`
- Node: id, name, site, role, floor, rack
- Link: id, fromId, toId, kind, port

### Config history/diff — get_config_history / get_config_diff
- History: \`entries[]\` mỗi entry có \`id\`, \`entryType\` (snapshot/apply), \`createdAt\`, \`username\`
- Diff: \`from\`, \`to\`, \`added\`, \`removed\`, \`changed\`, \`patch\`

### NetBox read — list_netbox_* / get_netbox_* / get_netbox_sync_status
- **Quan trọng**: 2 nguồn dữ liệu KHÁC NHAU:
  - \`list_devices\` / \`get_device\` → NetConsole DB (single source of truth cho inventory)
  - \`list_netbox_devices\` / \`get_netbox_device\` → NetBox API (DCIM, IPAM, role inference theo NetBox)
  - Khi user nói "thiết bị X" không rõ nguồn → mặc định dùng NetConsole. Khi user nói "trong NetBox" → dùng NetBox.
- \`list_netbox_devices\` / \`get_netbox_device\`: mỗi device có \`id, name, status, site, role, manufacturer, model, platform, serial, primaryIp4, rack, position, description, netconsoleId, tags, url, lastUpdated\`
- \`list_netbox_interfaces\` (theo NetBox device id): \`name, type, enabled, description, mtu, speedMbps, macAddress, mode, untaggedVlan, taggedVlans[]\`
- \`list_netbox_vlans\` (filter site): \`vid, name, status, site, group, description\`
- \`list_netbox_prefixes\` (IPAM CIDR): \`prefix, site, vrf, status, utilization (%), description\`
- \`list_netbox_ip_addresses\` (IPAM): \`address, status, dnsName, description, assignedTo: {interfaceId, interfaceName, device}, tags\`
- \`get_netbox_sync_status\` (đọc NetConsole DB): \`{summary: {total, synced, pending, failed}, devices: [{synced, netboxDeviceId, netboxSyncedAt, netboxSyncError}]}\`
- KHÔNG có: log, alert, job history (dùng tool NetConsole tương ứng)
- \`get_netbox_health\`: chỉ trả {ok, url, message} — dùng trước khi gọi tool NetBox khác nếu nghi NetBox down

## 6. Quy tắc chống bịa dữ liệu (BẮT BUỘC)

Khi user hỏi một thông tin, làm theo thứ tự:
1. Tìm trong DATA MAP ở trên xem thuộc nhóm nào.
2. Gọi tool tương ứng.
3. **Đọc JSON response, list ra CHÍNH XÁC các field có trong JSON trước khi viết câu trả lời.**
4. Nếu field KHÔNG có trong JSON → nói rõ "Hệ thống không lưu trường X" hoặc
   "không tìm thấy field X trong dữ liệu" — đồng thời liệt kê các field CÓ để user
   biết cái gì khả dụng.
5. TUYỆT ĐỐI KHÔNG:
   - Bịa field không có (e.g. nói "thiết bị ở phòng 401" khi DB không có room)
   - Hỏi user "bạn muốn tôi cập nhật không?" để tránh phải trả lời
   - Generate example data để "minh hoạ"
   - Dùng pattern matching (e.g. "rack V4 → room 401") để suy ra field chưa có
   - Trả lời "thiết bị không có thông tin X" rồi để đó — phải nói rõ "DB không lưu X"

**Ví dụ ĐÚNG:**
- User: "F4-AS-01 ở phòng nào?"
  → Gọi get_device → JSON có site/floor/rack/unit, KHÔNG có room
  → Trả lời: "Hệ thống không lưu trường 'phòng' (room) cho thiết bị. Các trường vị trí
     có sẵn: site=LAB, floor=4, rack=V4, unit=11."

**Ví dụ SAI:**
- User: "F4-AS-01 ở phòng nào?"
  → Trả lời: "Bạn cần tôi cập nhật thông tin phòng cho thiết bị?" ❌ (CHE GIẤU sự thiếu)
  → Trả lời: "F4-AS-01 ở phòng 401" ❌ (BỊA)
  → Trả lời: "F4-AS-01 không có thông tin phòng" ❌ (KHÔNG nói rõ DB không lưu, mơ hồ)

## 7. Cách xử lý WRITE operation (BẮT BUỘC theo flow này)

Khi user yêu cầu một WRITE operation (apply config, set VLAN, queue managed check, delete device...):

**Bước 1 (chỉ khi cần verify):** Nếu user cung cấp device name nhưng chưa chắc chắn device có tồn tại,
  gọi \`get_device\` TRƯỚC để lookup. Nếu user đã rõ ràng (đã nói "shutdown port X trên F2-AS-01"),
  BỎ QUA bước này và gọi tool WRITE ngay.

**Bước 2 (BẮT BUỘC):** GỌI TOOL WRITE NGAY. KHÔNG hỏi user bằng text trước. KHÔNG chờ
  user nói "ok" trước khi gọi. Backend sẽ TỰ ĐỘNG tạo confirmation card (Xác nhận / Huỷ)
  cho user — đó là cách user confirm, không phải qua text chat.

**Bước 3:** Sau khi backend trả về tool result (sau khi user đã xác nhận), tóm tắt ngắn gọn
  jobId + trạng thái cho user.

⚠️ LỖI PHỔ BIẾN: Tuyệt đối KHÔNG viết "Bạn có đồng ý để tôi tiến hành không?" rồi chờ
  user trả lời. Phải GỌI TOOL luôn — backend lo phần confirmation UI.

⚠️ APPLY_CONFIG: luôn LUÔN LUÔN chạy \`apply_config_dry_run\` TRƯỚC khi \`queue_apply_config\`
  để cho user thấy diff. Giải thích diff cho user:
  - Diff nhỏ (<=200 dòng): thay đổi bình thường, có thể proceed.
  - Diff lớn (>200 dòang): BÌNH THƯỜNG khi replace full config (Config Studio
    gửi toàn bộ device config, không phải delta). Cảnh báo user nhưng VẪN queue được.
  - Nếu muốn CHỈ thêm dòng mà không replace config: hướng user dùng
    Config Studio trực tiếp thay vì assistant.

⚠️ DELETE / WIPE: Những tool này phá huỷ dữ liệu. CẢNH BÁO user rõ ràng trong confirmation
  card, đặc biệt:
  - \`delete_device\` sẽ xoá thiết bị + toàn bộ job/log/snapshot liên quan
  - \`wipe_dhcp_subnet\` xoá TẤT CẢ lease trong subnet (không undo được)
  - \`delete_user\` không thể khôi phục, cần cẩn thận

**Ví dụ đúng:**
- User: "Shutdown port ge-0/0/5 trên LAB-F2-AS-01"
  → Gọi \`queue_interface_action\` ngay với args {device_name: "LAB-F2-AS-01", interface: "ge-0/0/5", action: "shut"}
  → Backend tạo card → user click Xác nhận → tool chạy

- User: "Apply config core mới cho F2-AS-01"
  → Gọi \`apply_config_dry_run\` trước để xem diff
  → Tóm tắt diff cho user
  → Nếu user confirm, gọi \`queue_apply_config\`

**Ví dụ sai:**
- User: "Shutdown port ge-0/0/5 trên LAB-F2-AS-01"
  → Trả text: "Bạn có đồng ý để tôi shutdown port này không?" ❌ (KHÔNG ĐƯỢC LÀM VẬY)

## 8. Quy tắc trả lời
- Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào vấn đề
- Dùng markdown table cho danh sách (thiết bị, port, lease, subnets, alert...)
- Khi cite job, kèm \`jobId\` để user có thể track ở trang Jobs
- Khi cite config diff, ghi rõ số dòng thêm/xoá/giữ nguyên
- **KHÔNG bịa số liệu** — nếu tool trả empty/mảng rỗng/0 kết quả, PHẢI nói rõ
  "không tìm thấy" hoặc "không có X nào". TUYỆT ĐỐI KHÔNG tự generate example data
  (fake MAC, IP mẫu, hostname giả) để "minh hoạ" cho user. Mọi giá trị liệt kê ra
  (MAC, IP, hostname, số liệu) PHẢI đến từ JSON trả về của tool, không lấy từ
  kiến thức chung hay pattern matching.
- **Sau khi gọi tool, đọc kỹ JSON response.** Nếu thấy \`count: 0\`, \`leases: []\`,
  \`items: []\`, \`data: null\`, hoặc mảng rỗng → câu trả lời PHẢI phản ánh đúng
  việc không có dữ liệu, không được "fill in" bằng dữ liệu giả.
- **Khi \`get_statistics\` trả về \`missing: ["ten_sai"]\`**: tên stat bạn đoán sai.
  Gọi \`describe_capabilities\` ngay để lấy danh sách tên đúng, rồi gọi lại
  \`get_statistics\` với tên chính xác. KHÔNG được nói "hệ thống không có" khi
  chỉ là tên SAI.
- Khi user nghi ngờ dữ liệu bịa (e.g. "sao đéo đúng vậy"), hãy thừa nhận sai và
  gọi lại tool để xác minh dữ liệu thật — KHÔNG tiếp tục bịa.
- Không lặp lại nguyên văn JSON từ tool — tổng hợp thành câu/table
- Với WRITE tool, SAU KHI user confirm, dùng \`get_job_detail\` (sau 3-5s) để verify kết quả
  rồi báo "đã xong" hoặc "thất bại: <error>"

## 9. Quy ước tên
- Tên thiết bị: case-insensitive. "lab-f2-as-01" = "LAB-F2-AS-01"
- MAC: lowercase, có dấu \`:\`. Có thể nhập thiếu dấu → tool tự normalize
- IP: prefix match. "10.10.20" khớp "10.10.20.1", "10.10.20.50"
- VLAN ID: 1-4094
- Interface naming:
  - Juniper: \`ge-0/0/0\`, \`xe-0/0/5\`, \`et-0/0/48\`
  - Cisco IOS-XE: \`GigabitEthernet0/0/5\`, \`TenGigabitEthernet1/1/1\`
  - Arista EOS: \`Ethernet1/1\`, \`Ethernet5/1\`
- Device role trong config: "core" / "dist" / "access" / "custom"
- Vendor: "juniper" / "arista" / "cisco"

## 10. Permission
- VIEWER chỉ dùng được READ tools. WRITE bị backend từ chối với 403.
- OPERATOR dùng được READ + WRITE thiết bị/config/DHCP/alert.
- ADMIN dùng được TẤT CẢ, bao gồm user management + DHCP subnet CRUD.`;

/**
 * Tool catalog. Each tool has:
 *  - name: how the LLM calls it (snake_case, used in tool_calls)
 *  - description: when to call it. Be specific — this drives accuracy.
 *  - parameters: JSON Schema. Strict `additionalProperties: false` so
 *    a hallucinated field is rejected instead of silently dropped.
 *  - readonly: true for READ tools (executed inline), false for WRITE
 *    tools (gated by confirmation_required).
 *  - requiresRole: minimum role. VIEWER can only use READ tools.
 */
export type CatalogEntry = ChatCompletionTool & {
  readonly: boolean;
  requiresRole: AssistantRole;
  /** Short label for the confirmation card. */
  confirmSummary: (args: Record<string, unknown>) => string;
};

function strEnum(values: string[]): { type: 'string'; enum: string[] } {
  return { type: 'string', enum: values };
}

// ─── READ tools ───────────────────────────────────────────────────────────────

const lookupMac: CatalogEntry = {
  type: 'function',
  function: {
    name: 'lookup_mac',
    description:
      'Tìm port vật lý + thiết bị switch mà MAC address đang học. ' +
      'Tra cứu trong bảng MAC đã thu thập gần nhất. Nếu không tìm thấy, ' +
      'trả về empty list — KHÔNG đoán thiết bị. ' +
      'Examples: lookup_mac({mac:"00:11:22:33:44:55"}) → port + switch. ' +
      'lookup_mac({mac:"aabbccddeeff"}) → tự normalize về canonical form. ' +
      'CHÚ Ý: tool này lookup trong MAC INVENTORY (last GET_MAC snapshot). ' +
      'MAC mới học có thể chưa có trong inventory nếu chưa có GET_MAC job gần đây.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mac'],
      properties: {
        mac: {
          type: 'string',
          description:
            'MAC address ở format "00:11:22:33:44:55" (lowercase, có dấu `:`). ' +
            'Tool tự normalize nếu user nhập thiếu dấu hoặc uppercase.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getDevice: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_device',
    description:
      'Tra cứu thiết bị theo tên (case-insensitive) hoặc IP (prefix match). ' +
      'Trả về status (ONLINE/OFFLINE/MANAGED/MAINTENANCE/UNKNOWN), vendor, ' +
      'model, version, site, floor, rack, unit, last ping. Dùng tool này TRƯỚC mọi write op. ' +
      'Examples: get_device("LAB-F2-AS-01") → 1 device, get_device("10.10.20") → tất cả IP bắt đầu 10.10.20. ' +
      'Trả về tối đa 5 device, sort theo updatedAt desc.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Tên thiết bị (e.g. "LAB-F2-AS-01") hoặc IP (e.g. "10.10.20.5"). ' +
            'IP hỗ trợ prefix match.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getDeviceInterfaces: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_device_interfaces',
    description:
      'Xem trạng thái interfaces của 1 thiết bị (admin/oper status, VLAN, ' +
      'description). Lấy từ snapshot GET_INTERFACES gần nhất. Nếu chưa có ' +
      'snapshot, tool sẽ tự queue job collect và báo user chờ. ' +
      'Returns: { device, lastCollectedAt, interfaces[] } — mỗi interface có ' +
      '{ name, adminStatus, operStatus, vlan, description, speed }. ' +
      'KHÔNG có: MAC table, ARP, packet counters, SFP info.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
        only_up: {
          type: 'boolean',
          description: 'Chỉ lấy interface đang up. Mặc định false (lấy tất cả).',
        },
        only_down: {
          type: 'boolean',
          description: 'Chỉ lấy interface đang down. Mặc định false.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listDhcpLeases: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_dhcp_leases',
    description:
      'Liệt kê DHCP lease. Có thể filter theo subnet (ID), hostname, hoặc ' +
      'state (active/expired/released). Mặc định trả 50 lease mới nhất. ' +
      'Returns: mảng leases với các field { ip, mac, hostname, subnet, subnetId, state, expiresAt }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subnet_id: {
          type: 'number',
          description: 'ID subnet (xem get_dhcp_pool_status để biết ID). Tùy chọn.',
        },
        hostname_contains: {
          type: 'string',
          description: 'Filter theo hostname contains (case-insensitive). Tùy chọn.',
        },
        state: {
          type: 'string',
          enum: ['active', 'default', 'static', 'expired', 'expired-reclaimed', 'released', 'declined'],
          description:
            'Filter theo state. LLM-friendly: "active" (match "default" + "static" — tức lease còn sống), ' +
            '"expired" (match "expired-reclaimed"). Kea thật: "default" / "static" / "expired-reclaimed" / ' +
            '"released" / "declined".',
        },
        limit: {
          type: 'number',
          description: 'Số lease trả về. Mặc định 50, tối đa 500.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getDhcpPoolStatus: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_dhcp_pool_status',
    description:
      'Tổng quan DHCP pool: tỷ lệ sử dụng, số IP đã cấp, gateway/DNS. ' +
      'Dùng khi user hỏi "subnet nào sắp hết IP" hoặc "tình trạng DHCP". ' +
      'Returns: { totals, ha (HA status Kea pair), pools[] } — mỗi pool có ' +
      '{ subnetId, name, site, vlan, subnet, pool, gateway, dns, leased, utilization }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subnet_id: {
          type: 'number',
          description: 'ID subnet cụ thể. Tùy chọn — bỏ qua để lấy tất cả.',
        },
        only_high_utilization: {
          type: 'boolean',
          description: 'Chỉ trả pool có utilization >= 80%. Mặc định false.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getFabricTopology: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_fabric_topology',
    description:
      'Lấy sơ đồ fabric (core/dist/access switches + links giữa chúng). ' +
      'Trả về nodes + edges cho frontend. Dùng khi user hỏi "topology NKKN" ' +
      'hoặc "switch nào kết nối tới core". ' +
      'Returns: { site, nodeCount, linkCount, topology.nodes[], topology.links[] }. ' +
      'Node có { id, name, site, role, floor, rack }. Link có { id, fromId, toId, kind, port }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: {
          type: 'string',
          description: 'Site code (e.g. "NKKN", "NTMK"). Tùy chọn — bỏ qua để lấy tất cả.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const searchRecentJobs: CatalogEntry = {
  type: 'function',
  function: {
    name: 'search_recent_jobs',
    description:
      'Tìm job gần đây (GET_ARP, GET_CONFIG, INTERFACE_ACTION, ...) theo tên ' +
      'thiết bị, loại job, status. Mặc định 20 job mới nhất. ' +
      'Returns: mảng jobs, mỗi job có { jobId, type, status, priority, device, ' +
      'deviceIp, createdBy, createdAt, updatedAt, finishedAt, error? }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_name: {
          type: 'string',
          description: 'Filter theo tên thiết bị (case-insensitive contains).',
        },
        job_type: {
          type: 'string',
          enum: [
            'CONNECT_TEST',
            'GET_CONFIG',
            'GET_ARP',
            'GET_MAC',
            'GET_INTERFACES',
            'GET_LOGS',
            'INTERFACE_ACTION',
            'MANAGED_CHECK',
            'DISCOVERY_PROBE',
            'APPLY_CONFIG',
            'ROLLBACK_CONFIG',
          ],
        },
        status: {
          type: 'string',
          enum: ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED'],
        },
        limit: { type: 'number', description: 'Mặc định 20, tối đa 100.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getRecentLogs: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_recent_logs',
    description:
      'Xem log/syslog gần đây của 1 thiết bị. Filter theo severity (ERROR trở lên ' +
      'mặc định). Dùng khi user hỏi "switch X có log gì lúc 14h" hoặc ' +
      '"có lỗi gì trên F2-AS-01 không". ' +
      'Returns: mảng logs với { id, timestamp, hostname, severity, facility, message }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
        min_severity: {
          type: 'string',
          enum: ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFORMATIONAL', 'DEBUG'],
          description: 'Mặc định ERROR (chỉ lấy log error+).',
        },
        since: {
          type: 'string',
          description: 'ISO timestamp. Mặc định 1 giờ trước.',
        },
        limit: { type: 'number', description: 'Mặc định 50, tối đa 500.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getUnacknowledgedAlerts: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_unacknowledged_alerts',
    description:
      'Liệt kê alert chưa được acknowledge. Severity cao nhất trước. ' +
      'Dùng khi user hỏi "có cảnh báo nào chưa xử lý" hoặc "alert gì đang active". ' +
      'Returns: mảng alerts với { id, ruleId, ruleName, hostname, deviceIp, severity, message, timestamp }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Mặc định 20, tối đa 100.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

// ─── WRITE tools (require confirmation) ──────────────────────────────────────

const queueInterfaceAction: CatalogEntry = {
  type: 'function',
  function: {
    name: 'queue_interface_action',
    description:
      'Queue 1 INTERFACE_ACTION job. Write op — backend sẽ tạo ' +
      'confirmation card. CHỈ gọi sau khi đã lookup device qua get_device. ' +
      '\n\n' +
      '## Ba cách gọi (ưu tiên multi-action khi >1 thay đổi)\n' +
      '\n' +
      '### Cách 1: Cross-interface multi-action (PREFERRED cho nhiều interface cùng lúc)\n' +
      'Mỗi subaction có field `interface` riêng. Worker group theo interface, ' +
      'commit mỗi group 1 LẦN. Tất cả trong 1 job, 1 confirmation card.\n' +
      'Đây là cách đúng khi user yêu cầu "xoá cổng 8, 9 + cấu hình VLAN/desc cho cả 8 và 9" cùng lúc. \n' +
      'Example (xoá + cấu hình 2 cổng trong 1 commit-set):\n' +
      '  queue_interface_action({device_name:"LAB-F6-DS-01", \n' +
      '    actions: [\n' +
      '      {interface:"xe-0/0/8", action:"delete-interface"},\n' +
      '      {interface:"xe-0/0/9", action:"delete-interface"},\n' +
      '      {interface:"xe-0/0/8", action:"set-access-vlan", vlan:"201"},\n' +
      '      {interface:"xe-0/0/8", action:"set-description", description:"client-tang1"},\n' +
      '      {interface:"xe-0/0/9", action:"set-access-vlan", vlan:"202"},\n' +
      '      {interface:"xe-0/0/9", action:"set-description", description:"client-tang2"},\n' +
      '    ]}) — tất cả 6 thay đổi trên 2 cổng trong 1 job\n' +
      '\n' +
      '### Cách 2: Same-interface multi-action (atomic 1 commit)\n' +
      'Top-level `interface` + `actions: [...]`. Tất cả subactions target CÙNG 1 interface, ' +
      'commit 1 LẦN trên thiết bị. Dùng khi >1 thay đổi trên CÙNG interface. \n' +
      'Example: queue_interface_action({device_name:"LAB-F6-DS-01", interface:"xe-0/0/7", \n' +
      '  actions: [{action:"set-access-vlan", vlan:"203"},{action:"set-description", description:"sonnx_test"}]})\n' +
      '\n' +
      '### Cách 3: Single-action (legacy, chỉ dùng cho 1 thay đổi đơn lẻ)\n' +
      'queue_interface_action({device_name:"F2-AS-01", interface:"ge-0/0/5", action:"shut"}). \n' +
      'queue_interface_action({device_name:"F2-AS-01", interface:"ge-0/0/3", action:"set-access-vlan", vlan:"100"}). \n' +
      '\n' +
      '## Quy tắc\n' +
      '- KHÔNG queue 2 jobs riêng khi có thể gộp vào 1 (dùng multi-action).\n' +
      '- KHÔNG queue nếu device OFFLINE (tool sẽ trả lỗi).\n' +
      '- action=`delete-interface`: XÓA TOÀN BỘ cấu hình của interface (reset về default). ' +
      'Có thể kết hợp với `set-access-vlan` / `set-description` trong CÙNG batch trên CÙNG interface: ' +
      'worker sẽ load theo thứ tự khai báo (delete trước, set sau), Junos xử lý tuần tự trong 1 commit ' +
      '→ kết quả: interface sạch + chỉ có VLAN/description mới. ' +
      'VÍ DỤ: delete cổng 8 + set VLAN 201 + set desc "client-tang1" trên cùng xe-0/0/8 trong 1 call.\n' +
      '- KHÔNG mix `shut` + `no-shut` trên cùng interface trong cùng batch (mâu thuẫn, 2 lệnh triệt tiêu nhau).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
        interface: { type: 'string', description: 'Interface mặc định (vendor-specific, ví dụ xe-0/0/7). Bắt buộc cho single-action và same-interface multi-action. Bỏ qua khi mỗi subaction có interface riêng (cross-interface).' },
        // Multi-action path (covers both same- and cross-interface)
        actions: {
          type: 'array',
          description: 'Danh sách subactions. Mỗi subaction có `action` (+ `vlan` hoặc `description` nếu cần). Mỗi subaction CÓ THỂ có field `interface` riêng (cross-interface) hoặc dùng top-level `interface` (same-interface). Tối đa 16 subactions / call, tối đa 8 interface khác nhau / call.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: strEnum(['shut', 'no-shut', 'set-access-vlan', 'set-description', 'remove-description', 'delete-interface']),
              interface: { type: 'string', description: 'Interface riêng cho subaction này. Khi có, override top-level `interface`. Khi không có, dùng top-level `interface`.' },
              vlan: { type: 'string', description: 'VLAN ID (1-4094). Bắt buộc khi action="set-access-vlan".' },
              description: { type: 'string', description: 'Mô tả mới (non-empty). Bắt buộc khi action="set-description".' },
            },
          },
        },
        // Legacy single-action path (kept for backward compat)
        action: {
          type: 'string',
          enum: ['shut', 'no-shut', 'set-access-vlan', 'set-description', 'remove-description', 'delete-interface'],
          description: 'LEGACY: chỉ dùng khi 1 thay đổi đơn lẻ. Khi có `actions` array thì bỏ qua field này.',
        },
        vlan: {
          type: 'string',
          description: 'LEGACY: VLAN ID (1-4094). Bắt buộc khi action="set-access-vlan".',
        },
        description: {
          type: 'string',
          description: 'LEGACY: Mô tả mới. Bắt buộc khi action="set-description".',
        },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const d = String(args.device_name ?? '?');
    const topIface = String(args.interface ?? '').trim();
    // Multi-action path: list all subactions joined, grouped by interface
    if (Array.isArray(args.actions) && args.actions.length > 0) {
      const subs = args.actions as Array<Record<string, unknown>>;
      // Group by interface
      const groups = new Map<string, string[]>();
      for (const s of subs) {
        const a = String(s.action ?? '?');
        const iface = String(s.interface ?? topIface ?? '?');
        let part: string;
        if (a === 'set-access-vlan') part = `set VLAN ${s.vlan ?? '?'}`;
        else if (a === 'set-description') part = `set desc "${s.description ?? ''}"`;
        else if (a === 'remove-description') part = 'xóa desc';
        else if (a === 'delete-interface') part = 'XÓA TOÀN BỘ cấu hình';
        else part = a;
        if (!groups.has(iface)) groups.set(iface, []);
        groups.get(iface)!.push(part);
      }
      const lines: string[] = [];
      for (const [iface, parts] of groups) {
        lines.push(`${parts.join(' + ')} trên ${iface}`);
      }
      const suffix = groups.size > 1 ? ` (${groups.size} cổng)` : '';
      return `${lines.join('; ')} — ${d}${suffix}`;
    }
    // Legacy single-action
    const i = String(args.interface ?? '?');
    const a = String(args.action ?? '?');
    if (a === 'set-access-vlan') {
      return `Set VLAN ${args.vlan ?? '?'} trên ${i} (${d})`;
    }
    if (a === 'set-description') {
      return `Set description "${args.description ?? ''}" trên ${i} (${d})`;
    }
    if (a === 'remove-description') {
      return `Xóa description trên ${i} (${d})`;
    }
    if (a === 'delete-interface') {
      return `⚠️ XÓA TOÀN BỘ cấu hình ${i} trên ${d} (reset về default)`;
    }
    if (a === 'shut') return `Shutdown port ${i} trên ${d}`;
    if (a === 'no-shut') return `No-shutdown port ${i} trên ${d}`;
    return `${a} trên ${i} (${d})`;
  },
};

const queueLogCollect: CatalogEntry = {
  type: 'function',
  function: {
    name: 'queue_log_collect',
    description:
      'Trigger GET_LOGS job ngay (không đợi scheduler 15 phút). Có thể ' +
      'giới hạn theo deviceIds. Bỏ qua deviceIds để collect tất cả managed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tùy chọn. Mặc định collect tất cả managed devices.',
        },
        force: {
          type: 'boolean',
          description: 'true = bỏ qua cache, queue ngay cả khi có job PENDING. Mặc định false.',
        },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const list = Array.isArray(args.device_names) ? (args.device_names as string[]) : [];
    return list.length > 0
      ? `Trigger collect logs cho ${list.length} thiết bị: ${list.slice(0, 3).join(', ')}${list.length > 3 ? '…' : ''}`
      : 'Trigger collect logs cho tất cả managed devices';
  },
};

const queueManagedCheck: CatalogEntry = {
  type: 'function',
  function: {
    name: 'queue_managed_check',
    description:
      'Queue MANAGED_CHECK job cho 1 thiết bị. Worker sẽ chạy probe (ping + ' +
      'RESTCONF) để cập nhật status ONLINE/OFFLINE + version. Dùng khi user ' +
      'báo "thiết bị X tôi vừa reboot, check lại giúp".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Trigger managed check cho ${args.device_name ?? '?'}`,
};

// ─── READ tools (new) ────────────────────────────────────────────────────────

const listDevices: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_devices',
    description:
      'Liệt kê thiết bị trong hệ thống. Có thể filter theo site, floor, rack, unit, status, vendor. ' +
      'Dùng khi user hỏi "có bao nhiêu switch ở site NKKN", "thiết bị tầng 6", "thiết bị ở rack V4", ' +
      '"switch nào OFFLINE", "juniper nào cùng vendor". ' +
      'Lưu ý: floor là số tầng (1-99), KHÔNG phải site. "tầng 6" = floor=6. ' +
      'Mỗi device trả về các field: name, ip, status, vendor, model, version, serial, site, floor, rack, unit, description, lastPingAt, lastPingMs. ' +
      'Examples: list_devices({site:"LAB"}) → tất cả thiết bị LAB. list_devices({floor:6}) → tầng 6. ' +
      'list_devices({status:"OFFLINE"}) → thiết bị down. list_devices({site:"LAB",status:"ONLINE"}) → LAB + online. ' +
      'Default limit 50, tối đa 500.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: { type: 'string', description: 'Filter theo site (VD: "LAB", "PROD"). Tùy chọn.' },
        floor: { type: 'number', description: 'Filter theo số tầng (VD: 6 = tầng 6). Tùy chọn.' },
        rack: { type: 'string', description: 'Filter theo rack (VD: "V4"). Tùy chọn.' },
        unit: { type: 'string', description: 'Filter theo unit trong rack (VD: "11"). Tùy chọn.' },
        status: strEnum(['ONLINE', 'OFFLINE', 'MANAGED', 'MAINTENANCE', 'UNKNOWN']),
        vendor: { type: 'string', description: 'Filter theo vendor (juniper/arista/cisco). Tùy chọn.' },
        limit: { type: 'number', description: 'Mặc định 50, tối đa 500.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listDhcpSubnets: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_dhcp_subnets',
    description:
      'Liệt kê DHCP subnet với pool, gateway, DNS, vlan, site, utilization. ' +
      'Khác với get_dhcp_pool_status (chỉ trả % utilization), tool này trả đầy đủ ' +
      'thông tin subnet (subnet CIDR, pool range, reservations count). ' +
      'Returns: { total, pools[] } — mỗi pool có { subnetId, name, site, vlan, ' +
      'subnet, pool, gateway, dns, leased, utilization, options }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: { type: 'string', description: 'Filter theo site. Tùy chọn.' },
        only_high_utilization: {
          type: 'boolean',
          description: 'Chỉ trả subnet có utilization >= 80%. Mặc định false.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getDhcpSubnet: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_dhcp_subnet',
    description:
      'Chi tiết 1 DHCP subnet: pool range, gateway, DNS, tất cả host reservations, ' +
      'lease hiện tại, utilization. Dùng khi user hỏi cụ thể về 1 subnet. ' +
      'Returns: { subnetId, found, name, site, vlan, subnet, pool, gateway, dns, ' +
      'utilization, leases[], reservations[] }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subnet_id'],
      properties: {
        subnet_id: { type: 'number', description: 'Subnet ID (xem list_dhcp_subnets)' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getJobDetail: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_job_detail',
    description:
      'Xem chi tiết 1 job: status, payload, result, error, timestamps, ' +
      'device name, createdBy. Dùng để verify job sau khi queue, hoặc debug job FAILED. ' +
      'Returns: { jobId, type, status, priority, device, deviceIp, createdBy, ' +
      'createdAt, updatedAt, startedAt, finishedAt, payload, result, error }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: 'Job ID (UUID)' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listAlertRules: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_alert_rules',
    description:
      'Liệt kê alert rules: pattern (regex), severity, device filter, enabled status, ' +
      'số alert chưa acknowledge. Dùng khi user hỏi "rule nào đang monitor" hoặc ' +
      '"có rule nào cho thiết bị X không". ' +
      'Returns: mảng rules, mỗi rule có { id, name, description, deviceId, ' +
      'minSeverity, messagePattern, facility, enabled, alertCount, unacknowledgedCount }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_disabled: { type: 'boolean', description: 'Mặc định false (chỉ lấy enabled).' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listUsers: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_users',
    description:
      'Liệt kê tất cả user trong hệ thống: username, email, role, active, last login. ' +
      'CHỈ ADMIN mới dùng được. Trả về danh sách user (KHÔNG bao gồm password hash). ' +
      'Returns: mảng users với { id, username, email, role, active, lastLoginAt, ' +
      'lastLoginIp, createdAt }. KHÔNG có password/hash/MFA.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  readonly: true,
  requiresRole: 'ADMIN',
  confirmSummary: () => '',
};

const getConfigHistory: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_config_history',
    description:
      'Lấy lịch sử config của 1 thiết bị: merge giữa APPLY_CONFIG audit log ' +
      '(web pushes, có username + role) và GET_CONFIG snapshot (periodic). ' +
      'Trả về danh sách entries với id, label, timestamp, username, lineCount, ' +
      'entryType (apply/snapshot). Dùng khi user hỏi "config F2-AS-01 có những ' +
      'phiên bản nào" hoặc "ai đã commit gần đây". ' +
      'Returns: mảng entries, mỗi entry có { id, label, entryType, createdAt, username, lineCount }. ' +
      'KHÔNG có: full content (dùng get_config_diff để xem nội dung).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
        limit: { type: 'number', description: 'Số entry tối đa. Mặc định 30, tối đa 150.' },
        entry_type: strEnum(['apply', 'snapshot', 'all']),
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getConfigDiff: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_config_diff',
    description:
      'So sánh 2 phiên bản config: tính diff (added/removed/unchanged) từng dòng. ' +
      'IDs có thể là Job ID (GET_CONFIG snapshot) hoặc ConfigAuditLog jobId (APPLY_CONFIG). ' +
      'Trả về line-by-line diff + tổng kết (added/removed/unchanged count). ' +
      'Dùng khi user hỏi "config thay đổi gì giữa 2 lần commit" hoặc "diff giữa ' +
      'phiên bản X và Y". ' +
      'Returns: { from, to, stats: { added, removed, unchanged }, lines[] } ' +
      '— mỗi line có { kind, content }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name', 'from_id', 'to_id'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
        from_id: { type: 'string', description: 'ID phiên bản gốc (jobId)' },
        to_id: { type: 'string', description: 'ID phiên bản đích (jobId)' },
        max_lines: {
          type: 'number',
          description: 'Giới hạn số dòng diff trả về (mặc định 200, tối đa 2000). ' +
            'Dùng để tránh trả context window quá lớn với file cấu hình dài.',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listDiscoveryScans: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_discovery_scans',
    description:
      'Liệt kê discovery scans gần đây: subnet, site, status, số result. ' +
      'Dùng khi user hỏi "lần scan gần nhất là khi nào" hoặc "có scan nào NKKN".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Mặc định 20, tối đa 100.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getDiscoveryScan: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_discovery_scan',
    description:
      'Xem chi tiết 1 discovery scan: status, danh sách IP đã probe, hostname ' +
      '(nếu SNMP có), vendor/model (nếu RESTCONF có), thời gian. ' +
      'Dùng khi user hỏi "scan subnet X có thiết bị nào".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['scan_id'],
      properties: {
        scan_id: { type: 'string', description: 'Scan ID' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

// ─── WRITE tools (new) ───────────────────────────────────────────────────────

const queueApplyConfig: CatalogEntry = {
  type: 'function',
  function: {
    name: 'queue_apply_config',
    description:
      'Queue APPLY_CONFIG job: commit config lên thiết bị (Junos/EOS/IOS-XE). ' +
      'Có 2 mode:\n' +
      '- mode="replace" (mặc định): dùng DeviceSavedConfig.content (full config đã lưu). ' +
      'Nếu truyền content, dùng content đó và CẬP NHẬT DeviceSavedConfig trước khi commit. ' +
      'Đây là Config Studio path — replace toàn bộ config.\n' +
      '- mode="merge": chỉ apply CÁC DÒNG trong content (delta/additive). ' +
      'KHÔNG touch DeviceSavedConfig. KHÔNG xoá dòng nào trên thiết bị. ' +
      'Dùng khi user muốn thêm 1-2 dòng (new area, new interface, new static route) ' +
      'mà KHÔNG thay đổi phần còn lại của running config. ' +
      'Bắt buộc truyền content (không fallback DeviceSavedConfig).\n\n' +
      'Lưu ý: device-side operation luôn là MERGE cho mọi mode ' +
      '(Junos `load set`, IOS-XE `conf t`, EOS `session.config` đều merge). ' +
      'Mode="replace" chỉ khác ở chỗ backend persist full config vào DeviceSavedConfig ' +
      'và dry-run diff cả 47 dòng. Mode="merge" dry-run chỉ diff delta nhỏ.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị' },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description:
            '"replace" (mặc định): full config, persist DeviceSavedConfig. ' +
            '"merge": chỉ apply delta trong content, không touch DeviceSavedConfig. ' +
            'Bắt buộc truyền content khi mode="merge".',
        },
        content: {
          type: 'string',
          description:
            'mode="replace" + bỏ qua: dùng DeviceSavedConfig.content. ' +
            'mode="replace" + truyền: dùng content này và CẬP NHẬT DeviceSavedConfig. ' +
            'mode="merge" + truyền: dùng content này (BẮT BUỘC, chỉ chứa delta). ' +
            'mode="merge" + bỏ qua: trả lỗi.',
        },
        role: strEnum(['core', 'dist', 'access', 'custom']),
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const d = String(args.device_name ?? '?');
    const m = args.mode === 'merge' ? ' [MERGE delta]' : ' [REPLACE full]';
    const r = args.role ? ` (role=${args.role})` : '';
    return `Apply config lên ${d}${m}${r}`;
  },
};

const queueRollbackConfig: CatalogEntry = {
  type: 'function',
  function: {
    name: 'queue_rollback_config',
    description:
      'Queue ROLLBACK_CONFIG job: rollback config về phiên bản trước khi commit gần nhất. ' +
      'Chỉ dùng được cho thiết bị có DeviceSavedConfig.rollbackContent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Rollback config về phiên bản trước trên ${args.device_name ?? '?'}`,
};

const applyConfigDryRun: CatalogEntry = {
  type: 'function',
  function: {
    name: 'apply_config_dry_run',
    description:
      'Tính diff giữa config hiện tại (running) và config sẽ apply. KHÔNG commit, chỉ preview. ' +
      'Có 2 mode:\n' +
      '- mode="replace" (mặc định): so sánh với DeviceSavedConfig.content (full config) ' +
      'hoặc content truyền vào. Diff lớn (>200 dòng) là BÌNH THƯỜNG khi replace full config.\n' +
      '- mode="merge": so sánh content truyền vào (delta) với running. ' +
      'BẮT BUỘC truyền content. Diff sẽ là delta nhỏ (chỉ dòng mới thêm). ' +
      'Dùng để preview merge trước khi queue.\n\n' +
      'Chạy TRƯỚC queue_apply_config để xem thay đổi. ' +
      'Examples: ' +
      'apply_config_dry_run({device_name:"F2-AS-01"}) → so sánh với DeviceSavedConfig. ' +
      'apply_config_dry_run({device_name:"F2-AS-01",content:"interfaces {...}"}) → replace với content truyền vào. ' +
      'apply_config_dry_run({device_name:"F2-AS-01",mode:"merge",content:"set X\\nset Y"}) → preview merge delta. ' +
      'apply_config_dry_run({device_name:"F2-AS-01",max_lines:500}) → tăng số dòng diff trả về.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị' },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description:
            '"replace" (mặc định): full config vs DeviceSavedConfig/content. ' +
            '"merge": delta (content) vs running. BẮT BUỘC truyền content khi merge.',
        },
        content: {
          type: 'string',
          description:
            'mode="replace" + bỏ qua: dùng DeviceSavedConfig.content. ' +
            'mode="replace" + truyền: dùng content này. ' +
            'mode="merge": BẮT BUỘC truyền content (delta).',
        },
        max_lines: { type: 'number', description: 'Mặc định 100, tối đa 1000.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const createDevice: CatalogEntry = {
  type: 'function',
  function: {
    name: 'create_device',
    description:
      'Tạo thiết bị mới trong inventory. Cần: name, ip, vendor, model, version, serial, ' +
      'site, floor. Optional: description, rack, unit. ' +
      'Sau khi tạo, tự động queue 1 MANAGED_CHECK để probe ONLINE/OFFLINE.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'ip', 'vendor', 'model', 'version', 'serial', 'site', 'floor'],
      properties: {
        name: { type: 'string', description: 'Tên thiết bị (unique, case-insensitive). VD: LAB-F2-AS-01' },
        ip: { type: 'string', description: 'IPv4 của management interface' },
        vendor: { type: 'string', description: 'juniper / arista / cisco' },
        model: { type: 'string', description: 'VD: cRPD, QFX5120, Catalyst 9300' },
        version: { type: 'string', description: 'OS version. VD: 23.4R1, 4.28, 17.09' },
        serial: { type: 'string', description: 'Serial number' },
        site: { type: 'string', description: 'Site code. VD: NKKN, NTMK' },
        floor: { type: 'string', description: 'Floor. VD: F1, F2, F3' },
        description: { type: 'string', description: 'Mô tả tự do. Tùy chọn.' },
        rack: { type: 'string', description: 'Rack location. Tùy chọn.' },
        unit: { type: 'string', description: 'Unit trong rack. Tùy chọn.' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Tạo thiết bị mới: ${args.name ?? '?'} (${args.ip ?? '?'}) tại ${args.site ?? '?'}/${args.floor ?? '?'}`,
};

const updateDevice: CatalogEntry = {
  type: 'function',
  function: {
    name: 'update_device',
    description:
      'Cập nhật thông tin thiết bị: name, ip, vendor, model, version, serial, ' +
      'site, floor, description, rack, unit. CHỈ update các field được truyền.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị hiện tại' },
        name: { type: 'string', description: 'Tên mới (nếu muốn đổi)' },
        ip: { type: 'string', description: 'IP mới' },
        vendor: { type: 'string', description: 'Vendor mới' },
        model: { type: 'string' },
        version: { type: 'string' },
        serial: { type: 'string' },
        site: { type: 'string' },
        floor: { type: 'string' },
        description: { type: 'string' },
        rack: { type: 'string' },
        unit: { type: 'string' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Cập nhật thiết bị ${args.device_name ?? '?'}`,
};

const deleteDevice: CatalogEntry = {
  type: 'function',
  function: {
    name: 'delete_device',
    description:
      'Xoá thiết bị khỏi inventory. CASCADE sẽ xoá luôn: DeviceSavedConfig, ' +
      'InterfaceActionSnapshot, AlertEvent, jobs liên quan. KHÔNG undo được. ' +
      'CẢNH BÁO user rõ ràng trước khi confirm.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị cần xoá' },
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `Xoá thiết bị ${args.device_name ?? '?'} (KHÔNG THỂ UNDO)`,
};

const setDeviceStatus: CatalogEntry = {
  type: 'function',
  function: {
    name: 'set_device_status',
    description:
      'Set trạng thái MAINTENANCE (đang bảo trì, không probe) hoặc UNKNOWN ' +
      '(bình thường hoặc mới, sẽ probe lại). Dùng khi muốn tạm dừng giám sát ' +
      'hoặc bật lại sau bảo trì.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name', 'status'],
      properties: {
        device_name: { type: 'string' },
        status: strEnum(['MAINTENANCE', 'UNKNOWN']),
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Set ${args.device_name ?? '?'} → ${args.status ?? '?'}`,
};

const queueCollect: CatalogEntry = {
  type: 'function',
  function: {
    name: 'queue_collect',
    description:
      'Queue 1 job collect on-demand: ARP / MAC / CONFIG / INTERFACES cho 1 thiết bị. ' +
      'Dùng khi cần data mới ngay mà không muốn đợi scheduler.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name', 'collect_type'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị' },
        collect_type: strEnum(['ARP', 'MAC', 'CONFIG', 'INTERFACES']),
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const t = String(args.collect_type ?? '?');
    const d = String(args.device_name ?? '?');
    return `Collect ${t} cho ${d}`;
  },
};

const addDhcpReservation: CatalogEntry = {
  type: 'function',
  function: {
    name: 'add_dhcp_reservation',
    description:
      'Thêm 1 DHCP lease thủ công (host reservation): gán IP cố định cho MAC. ' +
      'KHÔNG tạo static reservation (chỉ lease4-add, không ghi vào config). ' +
      'Dùng khi cần cấp IP nhanh không qua reservation vĩnh viễn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ip', 'mac', 'subnet_id'],
      properties: {
        ip: { type: 'string', description: 'IPv4' },
        mac: { type: 'string', description: 'MAC (lowercase, có dấu `:`)' },
        subnet_id: { type: 'number', description: 'Subnet ID' },
        hostname: { type: 'string', description: 'Tùy chọn' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Thêm DHCP lease: ${args.mac ?? '?'} → ${args.ip ?? '?'} (subnet ${args.subnet_id ?? '?'})`,
};

const deleteDhcpLease: CatalogEntry = {
  type: 'function',
  function: {
    name: 'delete_dhcp_lease',
    description:
      'Xoá 1 DHCP lease (gọi lease4-del trên Kea). Thiết bị sẽ phải renew để lấy IP mới.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ip'],
      properties: {
        ip: { type: 'string', description: 'IPv4 của lease cần xoá' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Xoá DHCP lease: ${args.ip ?? '?'}`,
};

const fixStaticReservation: CatalogEntry = {
  type: 'function',
  function: {
    name: 'fix_static_reservation',
    description:
      'Ghim IP thành static reservation (vĩnh viễn): lưu vào Kea config ' +
      '(config-set + config-write), tạo lease4-update. ' +
      'Sau khi ghim, MAC sẽ luôn nhận IP này.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ip', 'mac', 'subnet_id'],
      properties: {
        ip: { type: 'string' },
        mac: { type: 'string' },
        subnet_id: { type: 'number' },
        hostname: { type: 'string', description: 'Tùy chọn' },
        note: { type: 'string', description: 'Note tự do (max 200 chars). VD: "Camera tầng 3"' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Ghim static: ${args.mac ?? '?'} → ${args.ip ?? '?'}`,
};

const wipeDhcpSubnet: CatalogEntry = {
  type: 'function',
  function: {
    name: 'wipe_dhcp_subnet',
    description:
      'Xoá TẤT CẢ lease trong 1 subnet (gọi lease4-wipe trên Kea). ' +
      'KHÔNG xoá static reservation. KHÔNG undo được. CẢNH BÁO user rõ ràng.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subnet_id'],
      properties: {
        subnet_id: { type: 'number' },
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `WIPE toàn bộ lease subnet ${args.subnet_id ?? '?'} (KHÔNG UNDO)`,
};

const addDhcpSubnet: CatalogEntry = {
  type: 'function',
  function: {
    name: 'add_dhcp_subnet',
    description:
      'Tạo subnet DHCP mới trong Kea config (config-set + config-write). ' +
      'Cần: subnet_id, subnet (CIDR), pool range, gateway, DNS, site, vlan. ' +
      'CẢNH BÁO: thay đổi config Kea — sẽ áp dụng ngay, có thể ảnh hưởng DHCP server.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subnet_id', 'subnet', 'pool_start', 'pool_end', 'gateway'],
      properties: {
        subnet_id: { type: 'number', description: 'ID unique. VD: 100' },
        subnet: { type: 'string', description: 'CIDR. VD: 10.20.1.0/24' },
        pool_start: { type: 'string', description: 'IP đầu pool. VD: 10.20.1.10' },
        pool_end: { type: 'string', description: 'IP cuối pool. VD: 10.20.1.254' },
        gateway: { type: 'string', description: 'Gateway. VD: 10.20.1.1' },
        dns: { type: 'array', items: { type: 'string' }, description: 'DNS servers. Mặc định [8.8.8.8, 8.8.4.4]' },
        site: { type: 'string', description: 'Site code' },
        vlan: { type: 'number', description: 'VLAN ID' },
        name: { type: 'string', description: 'Tên subnet. Mặc định: "subnet-<id>"' },
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => {
    const id = args.subnet_id ?? '?';
    const s = args.subnet ?? '?';
    return `Thêm subnet DHCP ${id} (${s}) vào Kea`;
  },
};

const startDiscoveryScan: CatalogEntry = {
  type: 'function',
  function: {
    name: 'start_discovery_scan',
    description:
      'Bắt đầu 1 discovery scan cho 1 subnet (CIDR). Worker sẽ probe từng IP ' +
      '(ping + SNMP sysName + RESTCONF nếu có). Trả về scanId để theo dõi.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subnet'],
      properties: {
        subnet: { type: 'string', description: 'CIDR. VD: 10.20.1.0/24' },
        site: { type: 'string', description: 'Site mặc định cho kết quả. Tùy chọn.' },
        floor: { type: 'string', description: 'Floor mặc định. Tùy chọn.' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Bắt đầu discovery scan ${args.subnet ?? '?'}`,
};

const syncDiscoveryResults: CatalogEntry = {
  type: 'function',
  function: {
    name: 'sync_discovery_results',
    description:
      'Đồng bộ 1 số result từ discovery scan thành Device mới trong inventory. ' +
      'Cần list resultIds. Có thể set site/floor chung cho tất cả.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['scan_id', 'result_ids'],
      properties: {
        scan_id: { type: 'string' },
        result_ids: { type: 'array', items: { type: 'string' }, description: 'Danh sách result ID cần sync' },
        site: { type: 'string', description: 'Site chung. Tùy chọn.' },
        floor: { type: 'string', description: 'Floor chung. Tùy chọn.' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const n = Array.isArray(args.result_ids) ? (args.result_ids as unknown[]).length : 0;
    return `Sync ${n} result từ scan ${args.scan_id ?? '?'} thành Device`;
  },
};

const acknowledgeAlert: CatalogEntry = {
  type: 'function',
  function: {
    name: 'acknowledge_alert',
    description: 'Đánh dấu 1 alert là đã xử lý (set acknowledged=true, acknowledgedAt=now).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['alert_id'],
      properties: {
        alert_id: { type: 'string', description: 'Alert ID' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Acknowledge alert ${args.alert_id ?? '?'}`,
};

const syncToNetbox: CatalogEntry = {
  type: 'function',
  function: {
    name: 'sync_to_netbox',
    description:
      'Sync 1 thiết bị sang NetBox (push serial, model, version, mgmt IP, site, rack). ' +
      'Worker sẽ gọi NetBox API. Trả về jobId để track.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string' },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => `Sync ${args.device_name ?? '?'} → NetBox`,
};

const syncAllToNetbox: CatalogEntry = {
  type: 'function',
  function: {
    name: 'sync_all_to_netbox',
    description: 'Sync TẤT CẢ thiết bị sang NetBox. Worker sẽ loop qua toàn bộ device list. ' +
      'Idempotent — chạy 2 lần cho kết quả giống nhau (PATCH nếu đã tồn tại).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: () => `Sync TẤT CẢ thiết bị → NetBox`,
};

// ─── Admin user tools ────────────────────────────────────────────────────────

const createUser: CatalogEntry = {
  type: 'function',
  function: {
    name: 'create_user',
    description:
      'Tạo user mới (CHỈ ADMIN). Cần: username, email, password, role (ADMIN/OPERATOR/VIEWER). ' +
      'Password phải >= 8 chars, có chữ hoa, chữ thường, số.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'email', 'password', 'role'],
      properties: {
        username: { type: 'string', description: '3-32 chars, alphanumeric + . _ -' },
        email: { type: 'string', description: 'Email hợp lệ' },
        password: { type: 'string', description: '>= 8 chars, có hoa/thường/số' },
        role: strEnum(['ADMIN', 'OPERATOR', 'VIEWER']),
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `Tạo user mới: ${args.username ?? '?'} (role=${args.role ?? '?'})`,
};

const updateUserRole: CatalogEntry = {
  type: 'function',
  function: {
    name: 'update_user_role',
    description: 'Đổi role của user. KHÔNG thể tự demote chính mình.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'role'],
      properties: {
        username: { type: 'string' },
        role: strEnum(['ADMIN', 'OPERATOR', 'VIEWER']),
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `Đổi role ${args.username ?? '?'} → ${args.role ?? '?'}`,
};

const setUserActive: CatalogEntry = {
  type: 'function',
  function: {
    name: 'set_user_active',
    description:
      'Activate/deactivate user. KHÔNG thể tự deactivate chính mình. ' +
      'Deactivated user không login được nhưng giữ lại data (job history, audit log).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'active'],
      properties: {
        username: { type: 'string' },
        active: { type: 'boolean' },
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `${args.active ? 'Activate' : 'Deactivate'} user ${args.username ?? '?'}`,
};

const resetUserPassword: CatalogEntry = {
  type: 'function',
  function: {
    name: 'reset_user_password',
    description:
      'Admin set password mới cho user. User sẽ phải đổi password ở lần login tiếp theo. ' +
      'Truyền password tạm qua secure channel (chỉ trả 1 lần trong confirmation card).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username', 'new_password'],
      properties: {
        username: { type: 'string' },
        new_password: { type: 'string', description: '>= 8 chars, có hoa/thường/số' },
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `Reset password cho ${args.username ?? '?'}`,
};

const deleteUser: CatalogEntry = {
  type: 'function',
  function: {
    name: 'delete_user',
    description:
      'Xoá user (CHỈ ADMIN). KHÔNG thể tự xoá chính mình. ' +
      'KHÔNG undo được — job history sẽ mất attribution. ' +
      'Khuyến nghị dùng set_user_active(false) thay vì delete.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['username'],
      properties: {
        username: { type: 'string' },
      },
    },
  },
  readonly: false,
  requiresRole: 'ADMIN',
  confirmSummary: (args) => `Xoá user ${args.username ?? '?'} (KHÔNG UNDO)`,
};

const getNetconsoleInfo: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_netconsole_info',
    description:
      'Lấy thông tin hệ thống NetConsole: version, git commit, uptime. ' +
      'Dùng khi user hỏi "version", "phiên bản", "đang chạy phiên bản nào". ' +
      'Tool này đọc trực tiếp từ backend env, không cần gọi HTTP request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

/**
 * Generic vendor CLI command runner — backs the assistant's
 * "show route", "show ospf neighbor", "show cdp", "clear counters",
 * "request system reboot", and similar ad-hoc operator requests.
 *
 * Why ONE generic tool and not 20 specialised ones:
 *  - The LLM picks the right vendor-specific syntax from the
 *    reference doc (`docs/agents/14-vendor-cli-commands.md`).
 *  - Adding a new command = a new line in the LLM's mental
 *    vocabulary, NOT a new tool entry + handler + schema + test.
 *  - The vendor backend (`DeviceBackend.run_cli_command`) already
 *    handles SSH exec; this tool is a thin wrapper around the
 *    CLI_COMMAND job type.
 *
 * READ vs WRITE behaviour:
 *  - `write: false` (default) — pure read: `show`, `display`, `get`.
 *    No confirmation card. Examples: `show route`, `show ospf neighbor`,
 *    `show ip interface brief`, `show version`.
 *  - `write: true` — operational commands that mutate state but
 *    are NOT config: `clear counters`, `clear arp`, `clear mac-address-table`,
 *    `request system reboot` (DANGEROUS), `request chassis fpc restart`.
 *    Still NO confirmation card from this tool — the LLM is
 *    responsible for picking the right `write` flag and avoiding
 *    destructive commands on production boxes.
 *  - For CONFIG changes (set OSPF, add VLAN, change routing)
 *    use `queue_apply_config` with the full config text — that
 *    tool DOES gate through confirmation. This tool is for
 *    operational (non-config) commands only.
 *
 * Output format:
 *  - Returns the raw stdout text. Output is capped at 8 KB by the
 *    worker to keep the LLM context window healthy; the full text
 *    is in Job.result for /api/jobs UI.
 *  - If the command is in the small "structured parse" allowlist
 *    (see `worker/netconsole_worker/parsers/textfsm_parse.py`),
 *    the response also includes `parsed.rows` with normalised
 *    column names (neighborId, state, etc.) so the LLM can pick
 *    fields without re-parsing the text. Currently allowlisted:
 *    Cisco/Arista `show ip ospf neighbor`, `show ip route`,
 *    `show cdp neighbors` (Cisco only), `show ip bgp summary`,
 *    and Juniper `show ospf neighbor`, `show route summary`.
 */
const runCliCommand: CatalogEntry = {
  type: 'function',
  function: {
    name: 'run_cli_command',
    description:
      'Chạy 1 lệnh CLI bất kỳ trên thiết bị (Junos / EOS / IOS-XE / IOS / NX-OS). ' +
      'Dùng cho các lệnh ad-hoc KHÔNG nằm trong tool chuyên dụng: ' +
      '`show route`, `show ospf neighbor`, `show ip bgp summary`, `show cdp neighbors`, ' +
      '`show version`, `show interface terse`, `show arp`, `show mac-address-table`, ' +
      '`clear counters`, `clear arp-cache`, `request system reboot` (DANGEROUS), v.v. ' +
      '\n\n' +
      '## QUY TẮC CÚ PHÁP (BẮT BUỘC)\n' +
      '\n' +
      'Phải dùng đúng cú pháp của VENDOR của thiết bị (xem `get_device` để biết vendor):\n' +
      '- **Juniper Junos**: `show ospf neighbor`, `show route 10.0.0.0/8`, `show interfaces terse`, ' +
      '`show configuration`, `clear interfaces statistics`, `request system reboot`\n' +
      '- **Arista EOS**: `show ip ospf neighbor`, `show ip route`, `show ip bgp summary`, ' +
      '`show interfaces`, `clear counters`, `reload system` (DANGEROUS)\n' +
      '- **Cisco IOS-XE**: `show ip ospf neighbor`, `show ip route`, `show ip bgp summary`, ' +
      '`show cdp neighbors`, `show interfaces status`, `clear counters`, `reload` (DANGEROUS)\n' +
      '\n' +
      '## READ vs WRITE\n' +
      '- `write: false` (mặc định) cho lệnh read-only (`show ...`, `display ...`, `get ...`)\n' +
      '- `write: true` cho lệnh operational mutate state (`clear ...`, `request ...`, `reload ...`)\n' +
      '- KHÔNG dùng tool này để THAY ĐỔI CONFIG — dùng `queue_apply_config` với full config text\n' +
      '\n' +
      '## VÍ DỤ\n' +
      '  run_cli_command({device_name:"LAB-F6-AS-01", command:"show ospf neighbor"})\n' +
      '  run_cli_command({device_name:"LAB-F2-AS-01", command:"show route 10.0.0.0/8"})\n' +
      '  run_cli_command({device_name:"LAB-F6-AS-01", command:"show ip interface brief"})\n' +
      '  run_cli_command({device_name:"LAB-F2-AS-01", command:"clear interfaces statistics all", write:true})\n' +
      '\n' +
      '## OUTPUT\n' +
      '  { device, vendor, command, source, output, parsed?, rowCount?, exitCode, error? }\n' +
      '  - `output`: raw text (max 8 KB, có thể bị truncate trên output lớn)\n' +
      '  - `parsed`: nếu command nằm trong allowlist textfsm, có thêm `parsed.rows[]` với field normalized',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name', 'command'],
      properties: {
        device_name: {
          type: 'string',
          description: 'Tên thiết bị (case-insensitive). Dùng `get_device` trước nếu không chắc.',
        },
        command: {
          type: 'string',
          description:
            'Câu lệnh CLI theo đúng cú pháp của vendor thiết bị. ' +
            'KHÔNG bao gồm prompt (">", "#", "$"). ' +
            'KHÔNG thêm "show" cho IOS-XE nếu đã có sẵn.',
        },
        write: {
          type: 'boolean',
          description:
            'true cho lệnh operational mutate state (clear, request, reload). ' +
            'false (mặc định) cho lệnh read-only (show, display).',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: (args) => {
    const d = String(args.device_name ?? '?');
    const c = String(args.command ?? '?');
    const w = args.write === true ? '⚙️ ' : '';
    return `${w}${c} trên ${d}`;
  },
};

// ─── NetBox READ tools (added 2026-10-13) ───────────────────────────────────
//
// All NetBox reads — read-only, no confirmation card. The backend hits the
// NetBox REST API directly (in-process; no HTTP roundtrip to the worker).
// Errors from the NetBox client surface as {ok:false, error:"..."} so the
// LLM can report "NetBox is unreachable" instead of hallucinating data.

const getNetboxHealth: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_netbox_health',
    description:
      'Check if NetBox API is reachable. Dùng khi user hỏi "NetBox có chạy không", "NetBox lỗi gì", ' +
      'hoặc trước khi gọi các tool NetBox khác để fail-fast. Trả về {ok, url, message}. ' +
      'Không cần args.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxSites: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_sites',
    description:
      'Liệt kê site trong NetBox (đơn vị vật lý, vd "LAB", "NKKN", "NTMK"). ' +
      'Dùng khi user hỏi "NetBox có site nào" hoặc cần filter thiết bị theo site. ' +
      'Returns: mảng sites, mỗi site có {id, name, slug, status, description, tags}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Mặc định 100, tối đa 1000.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxDeviceRoles: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_device_roles',
    description:
      'Liệt kê device-role trong NetBox (core / distribution / access / custom). ' +
      'Dùng để biết role-slug chính xác khi filter list_netbox_devices. ' +
      'Returns: mảng roles, mỗi role có {id, name, slug, color}.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxManufacturers: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_manufacturers',
    description:
      'Liệt kê manufacturer (Cisco / Juniper / Arista / ...) trong NetBox. ' +
      'Dùng khi user hỏi "NetBox có vendor nào" hoặc cần filter thiết bị theo manufacturer. ' +
      'Returns: mảng manufacturers, mỗi manufacturer có {id, name, slug}.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxDevices: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_devices',
    description:
      'Liệt kê thiết bị trong NetBox (đã được sync từ NetConsole). Có filter: ' +
      'site, role, status (active/offline/...), manufacturer_id, search, tag, netconsole_id. ' +
      'Dùng khi user hỏi "trong NetBox có bao nhiêu switch site NKKN", "thiết bị nào offline trên NetBox". ' +
      'Returns: {total, returned, offset, devices[]} — mỗi device có ' +
      '{id, name, status, site, role, manufacturer, model, platform, serial, primaryIp4, ' +
      'rack, position, description, netconsoleId, tags, url, lastUpdated}. ' +
      'KHÔNG có: interface list (dùng list_netbox_interfaces riêng), MAC, ARP, log, alert. ' +
      'LƯU Ý: tool này query NetBox API, KHÔNG query NetConsole DB. Nếu user hỏi về ' +
      'NetConsole inventory thì dùng list_devices. Tool này dùng khi user cụ thể nói "NetBox" ' +
      'hoặc cần data từ NetBox (vd primary IP theo NetBox, role theo NetBox, tags).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: { type: 'string', description: 'Filter theo site slug (vd "lab", "nkkn").' },
        role: { type: 'string', description: 'Filter theo role slug (vd "core", "distribution", "access").' },
        status: {
          type: 'string',
          enum: ['active', 'offline', 'planned', 'staged', 'failed', 'inventory', 'decommissioning'],
          description: 'Filter theo NetBox status.',
        },
        manufacturer_id: { type: 'number', description: 'Filter theo manufacturer id (xem list_netbox_manufacturers).' },
        search: { type: 'string', description: 'Full-text search theo name/serial/asset_tag.' },
        tag: { type: 'string', description: 'Filter theo tag slug (vd "source-netconsole").' },
        netconsole_id: { type: 'string', description: 'Filter theo NetConsole device UUID (exact match custom field).' },
        limit: { type: 'number', description: 'Mặc định 50, tối đa 500.' },
        offset: { type: 'number', description: 'Mặc định 0.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getNetboxDevice: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_netbox_device',
    description:
      'Lookup 1 thiết bị trong NetBox theo id HOẶC netconsole_id HOẶC name. ' +
      'Cần truyền 1 trong 3. NetBox trả full record bao gồm: ' +
      'name, site, role, status, device_type, platform, serial, primary_ip4, ' +
      'rack/position, custom_fields (gồm netconsole_id), tags, description, url, last_updated. ' +
      'Examples: get_netbox_device({id: 42}) → device. ' +
      'get_netbox_device({netconsole_id:"abc-123-def"}) → device synced từ NetConsole ID đó. ' +
      'get_netbox_device({name:"LAB-F2-AS-01"}) → full-text search top 5. ' +
      'Dùng khi user hỏi "thiết bị F2-AS-01 trong NetBox" hoặc "NetBox có device nào ' +
      'khớp với serial X".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: 'NetBox device id (xem list_netbox_devices).' },
        netconsole_id: { type: 'string', description: 'NetConsole device UUID (exact match).' },
        name: { type: 'string', description: 'Tên thiết bị (full-text search, trả top 5).' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxInterfaces: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_interfaces',
    description:
      'Liệt kê interface của 1 NetBox device (theo NetBox id, KHÔNG phải NetConsole id). ' +
      'Mỗi interface: name, type, enabled, description, mtu, speed (Mbps), mac_address, ' +
      'mode, untagged_vlan, tagged_vlans. ' +
      'Cần NetBox device id — nếu user chỉ biết tên NetConsole, lookup trước qua ' +
      'get_netbox_device({netconsole_id: "..."}) hoặc get_netbox_device({name: "..."}). ' +
      'Dùng khi user hỏi "thiết bị X trong NetBox có bao nhiêu port, port nào trunk".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['netbox_device_id'],
      properties: {
        netbox_device_id: { type: 'number', description: 'NetBox device id (BẮT BUỘC).' },
        only_up: { type: 'boolean', description: 'Chỉ lấy interface enabled. Mặc định false.' },
        only_down: { type: 'boolean', description: 'Chỉ lấy interface disabled. Mặc định false.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxVlans: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_vlans',
    description:
      'Liệt kê VLAN trong NetBox (filter theo site). Mỗi VLAN: vid, name, status, ' +
      'site, group, description. Dùng khi user hỏi "NetBox có VLAN nào ở site NKKN", ' +
      '"VLAN 201 ở đâu". Cross-reference với get_dhcp_subnet (subnet có vlan nào). ' +
      'Returns: mảng vlans.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: { type: 'string', description: 'Filter theo site slug (vd "lab", "nkkn").' },
        limit: { type: 'number', description: 'Mặc định 200, tối đa 1000.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxPrefixes: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_prefixes',
    description:
      'Liệt kê prefix (CIDR) trong IPAM của NetBox. Mỗi prefix: prefix, site, vrf, ' +
      'status, utilization (%), description. Dùng khi user hỏi "subnet nào đã khai báo ' +
      'trong NetBox", "IPAM có bao nhiêu /24 ở site NKKN", "subnet nào chứa IP 10.10.20.131", ' +
      '"có tồn tại prefix 10.10.20.0/24 trong NetBox không". ' +
      'Returns: mảng prefixes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: { type: 'string', description: 'Filter theo site slug.' },
        status: { type: 'string', enum: ['active', 'reserved', 'deprecated', 'container'], description: 'Filter theo status.' },
        // `contains`: truyền MỘT địa chỉ IP (không có CIDR) để tìm prefix chứa IP đó.
        // Dùng khi user hỏi "subnet nào chứa IP X.X.X.X" — ví dụ:
        //   list_netbox_prefixes(contains="10.10.20.131")
        //   → trả về mọi prefix có chứa IP đó (vd 10.10.20.0/24)
        contains: { type: 'string', description: 'Một địa chỉ IP (không CIDR) — tìm prefix chứa IP này. Ví dụ: "10.10.20.131".' },
        // `prefix`: truyền CIDR đầy đủ để exact-match — ví dụ:
        //   list_netbox_prefixes(prefix="10.10.20.0/24")
        //   → trả về prefix đó nếu tồn tại, hoặc rỗng nếu không có
        prefix: { type: 'string', description: 'CIDR đầy đủ để exact-match. Ví dụ: "10.10.20.0/24".' },
        limit: { type: 'number', description: 'Mặc định 200, tối đa 1000.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const listNetboxIpAddresses: CatalogEntry = {
  type: 'function',
  function: {
    name: 'list_netbox_ip_addresses',
    description:
      'Liệt kê IP address trong IPAM của NetBox. Mỗi IP: address (CIDR), status, dns_name, ' +
      'description, assignedTo (interface + device), tags. ' +
      'Dùng khi user hỏi "IP 10.10.20.50 nằm ở thiết bị nào trong NetBox" (dùng search), ' +
      '"thiết bị X có IP nào trong NetBox" (dùng netbox_device_id). ' +
      'LƯU Ý: tool này query IPAM của NetBox, KHÔNG phải DHCP lease. Để xem DHCP lease ' +
      '(Kea), dùng list_dhcp_leases. ' +
      'Returns: mảng addresses.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        netbox_device_id: { type: 'number', description: 'Filter theo NetBox device id.' },
        status: { type: 'string', enum: ['active', 'reserved', 'deprecated', 'dhcp', 'slaac'], description: 'Filter theo status.' },
        search: { type: 'string', description: 'Search theo address hoặc dns_name.' },
        limit: { type: 'number', description: 'Mặc định 200, tối đa 1000.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getNetboxSyncStatus: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_netbox_sync_status',
    description:
      'Trạng thái sync NetConsole → NetBox cho 1 hoặc nhiều thiết bị. ' +
      'Đọc trực tiếp từ NetConsole DB (KHÔNG gọi NetBox API). Mỗi device trả: ' +
      '{synced, netboxDeviceId, netboxSyncedAt, netboxSyncError}. ' +
      'Summary: {total, synced, pending, failed}. ' +
      'Dùng khi user hỏi "thiết bị nào chưa sync NetBox", "sync lỗi chỗ nào", ' +
      '"F2-AS-01 sync NetBox lần cuối khi nào". ' +
      'Filters: device_name (substring), device_id (UUID), site, only_unsynced, only_failed. ' +
      'Sau khi xem failed list, gợi ý dùng sync_to_netbox để retry từng cái.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_name: { type: 'string', description: 'Filter theo tên thiết bị (substring, case-insensitive).' },
        device_id: { type: 'string', description: 'Filter theo NetConsole device UUID (exact match).' },
        site: { type: 'string', description: 'Filter theo site code.' },
        only_unsynced: { type: 'boolean', description: 'Chỉ lấy thiết bị CHƯA sync (chưa có netboxDeviceId).' },
        only_failed: { type: 'boolean', description: 'Chỉ lấy thiết bị sync FAILED (có netboxSyncError).' },
        limit: { type: 'number', description: 'Mặc định 100, tối đa 500.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const getStatistics: CatalogEntry = {
  type: 'function',
  function: {
    name: 'get_statistics',
    description:
      'Tính toán thống kê trên toàn bộ hệ thống. Dùng khi user hỏi ' +
      '"có bao nhiêu thiết bị mỗi tầng", "juniper nào offline", "tỷ lệ job success", ' +
      '"tổng MAC entries", "subnet nào đầy", "alert chưa ack", "chi phí assistant 7 ngày", v.v. ' +
      'Returns: { scope, windowHours, statCount, missing, stats } — stats là object ' +
      'name→value. Mỗi stat có shape riêng (xem describe_capabilities để biết). ' +
      'KHÔNG real-time cho MAC/ARP/Interfaces — phụ thuộc lần collect gần nhất. ' +
      'QUAN TRỌNG: Nếu tên stat bạn đoán sai, response sẽ có missing[] + availableStats[]. ' +
      'RETRY ngay với tên đúng, không bỏ cuộc. ' +
      'Ví dụ: get_statistics({names:["devices_total","jobs_success_rate"]}) → 2 stat. ' +
      'get_statistics({site:"LAB",names:["devices_by_floor"]}) → chỉ thiết bị LAB.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Danh sách tên stat cần tính. Bỏ qua = tính TẤT CẢ. ' +
            'Ví dụ: ["devices_total", "devices_by_site", "jobs_last_24h"]. ' +
            'Gọi describe_capabilities trước nếu không nhớ tên.',
        },
        site: { type: 'string', description: 'Filter Device-based stats theo site (vd "LAB"). Tùy chọn.' },
        vendor: { type: 'string', description: 'Filter theo vendor (juniper/arista/cisco). Tùy chọn.' },
        status: { type: 'string', description: 'Filter theo device status (ONLINE/OFFLINE/...). Tùy chọn.' },
        window_hours: { type: 'number', description: 'Time window cho time-series stats. Mặc định 24h.' },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

const describeCapabilities: CatalogEntry = {
  type: 'function',
  function: {
    name: 'describe_capabilities',
    description:
      'Liệt kê TẤT CẢ tool + stat mà assistant có thể dùng. ' +
      'Dùng khi user hỏi "có thể làm gì", "có những stat nào", ' +
      'hoặc khi không chắc tool/stat nào phù hợp. ' +
      'Returns: { toolCount, statCount, toolsByCategory: { READ, WRITE }, statsByCategory }. ' +
      'Mỗi stat có { name, label, description, category, scoped }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

/**
 * UI affordance — emit clickable follow-up chips below the answer.
 * Call this when the answer naturally suggests 1-3 follow-up actions
 * the user might want next. The frontend renders the suggestions as
 * clickable buttons; clicking sends the suggestion as a new user
 * message.
 *
 * Why a tool instead of just text "Bạn có muốn X?": chips are
 * clickable, scannable, and 10× more likely to be acted on than a
 * text question. This is the "proactive AI" affordance.
 *
 * Rules:
 *  - Suggest 1-3 chips (3 max — chips are precious real estate).
 *  - Each chip is a SHORT, action-oriented prompt (≤ 40 chars).
 *    ❌ "Bạn có muốn queue managed check cho thiết bị F2-AS-01 để xem nó có hoạt động không?"
 *    ✅ "Queue managed check F2-AS-01"
 *  - Don't suggest things the user already did.
 *  - Don't suggest after a confirmation card (chips would compete).
 *  - Always pair with text answer — chips are an ADDITION, not a replacement.
 */
const suggestFollowup: CatalogEntry = {
  type: 'function',
  function: {
    name: 'suggest_followup',
    description:
      'Gợi ý 1-3 bước tiếp theo dưới dạng chip clickable. ' +
      'Mỗi suggestion là 1 câu NGẮN (≤ 40 chars) mô tả hành động cụ thể. ' +
      'Dùng sau khi trả lời xong, KHI thực sự có bước tiếp theo hữu ích. ' +
      'KHÔNG gọi nếu user đã chỉ định rõ ý định. ' +
      'KHÔNG gọi sau confirmation card. ' +
      'KHÔNG gợi ý generic ("Xem thêm", "Tìm hiểu thêm") — phải cụ thể.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['suggestions'],
      properties: {
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
          description:
            'Mảng 1-3 câu suggestion ngắn. Mỗi câu ≤ 40 chars. ' +
            'Mỗi câu phải là một hành động cụ thể, clickable được. ' +
            'Ví dụ: ["Queue managed check F2-AS-01", "Xem job fail 24h qua"]',
        },
      },
    },
  },
  readonly: true,
  requiresRole: 'VIEWER',
  confirmSummary: () => '',
};

/** All tools, in the order the LLM should consider them. */
export const TOOL_CATALOG: CatalogEntry[] = [
  // READ (executed inline)
  getDevice,
  listDevices,
  lookupMac,
  getDeviceInterfaces,
  listDhcpLeases,
  getDhcpPoolStatus,
  listDhcpSubnets,
  getDhcpSubnet,
  getFabricTopology,
  searchRecentJobs,
  getJobDetail,
  getRecentLogs,
  getUnacknowledgedAlerts,
  listAlertRules,
  listUsers,
  getConfigHistory,
  getConfigDiff,
  applyConfigDryRun,
  listDiscoveryScans,
  getDiscoveryScan,
  // WRITE (gated by confirmation_required)
  queueInterfaceAction,
  queueLogCollect,
  queueManagedCheck,
  queueCollect,
  queueApplyConfig,
  queueRollbackConfig,
  createDevice,
  updateDevice,
  deleteDevice,
  setDeviceStatus,
  addDhcpReservation,
  deleteDhcpLease,
  fixStaticReservation,
  wipeDhcpSubnet,
  addDhcpSubnet,
  startDiscoveryScan,
  syncDiscoveryResults,
  acknowledgeAlert,
  syncToNetbox,
  syncAllToNetbox,
  createUser,
  updateUserRole,
  setUserActive,
  resetUserPassword,
  deleteUser,
  getNetconsoleInfo,
  // Generic vendor CLI exec (added 2026-10-11). Place near the
  // other ad-hoc read tools so the LLM sees it next to
  // get_netconsole_info when scanning the catalog. Read at the
  // catalog level — the LLM has to use queue_apply_config for
  // true config changes (which DOES gate through confirmation).
  runCliCommand,
  // NetBox read — query live NetBox API (added 2026-10-13)
  getNetboxHealth,
  listNetboxSites,
  listNetboxDeviceRoles,
  listNetboxManufacturers,
  listNetboxDevices,
  getNetboxDevice,
  listNetboxInterfaces,
  listNetboxVlans,
  listNetboxPrefixes,
  listNetboxIpAddresses,
  getNetboxSyncStatus,
  getStatistics,
  describeCapabilities,
  // UI affordance — emits clickable follow-up chips
  suggestFollowup,
];

/** Just the OpenAI tool definitions (drops our metadata). */
export const OPENAI_TOOLS: ChatCompletionTool[] = TOOL_CATALOG.map(
  ({ readonly: _r, requiresRole: _role, confirmSummary: _c, ...rest }) => rest,
);

/** Lookup by tool name. Throws if not found (caller bug). */
export function getTool(name: string): CatalogEntry {
  const entry = TOOL_CATALOG.find((t) => {
    // OpenAI's tool union includes both function and custom variants;
    // every entry we register is the function variant, so we narrow
    // here. The `function` key is always present on the function
    // variant.
    return 'function' in t && t.function.name === name;
  });
  if (!entry) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return entry;
}
