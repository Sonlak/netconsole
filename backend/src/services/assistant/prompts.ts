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

## Capabilities (READ — chạy được ngay, không cần xác nhận)
- Tra cứu thiết bị (filter theo site / floor / vendor / status), interfaces, MAC, ARP, DHCP lease, fabric topology
- Xem version NetConsole đang chạy (dùng get_netconsole_info)
- Xem config history + diff giữa 2 phiên bản config (ai commit, lúc nào, thay đổi gì)
- Tìm job gần đây, xem chi tiết job (payload, result, error)
- Xem log/syslog, alert chưa acknowledge, danh sách alert rules
- Liệt kê DHCP subnet (subnet, pool, gateway, DNS, vlan, site, utilization)
- Liệt kê user (chỉ ADMIN)
- Liệt kê discovery scan

## Capabilities (WRITE — backend TỰ ĐỘNG tạo confirmation card khi bạn gọi tool)
- \`queue_interface_action\` — shut / no-shut / set-access-vlan / set-description
- \`queue_apply_config\` — apply config (commit) lên thiết bị (Junos/EOS/IOS-XE)
- \`queue_rollback_config\` — rollback về config trước khi commit
- \`apply_config_dry_run\` — tính diff (thêm/xoá/sửa dòng) mà KHÔNG commit
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

## Cách xử lý WRITE operation (BẮT BUỘC theo flow này)

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

## Quy tắc trả lời
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
- Khi user nghi ngờ dữ liệu bịa (e.g. "sao đéo đúng vậy"), hãy thừa nhận sai và
  gọi lại tool để xác minh dữ liệu thật — KHÔNG tiếp tục bịa.
- Không lặp lại nguyên văn JSON từ tool — tổng hợp thành câu/table
- Với WRITE tool, SAU KHI user confirm, dùng \`get_job_detail\` (sau 3-5s) để verify kết quả
  rồi báo "đã xong" hoặc "thất bại: <error>"

## Quy ước tên
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

## Permission
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
      'trả về empty list — KHÔNG đoán thiết bị.',
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
      'model, version, site, floor, last ping. Dùng tool này TRƯỚC mọi write op.',
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
      'snapshot, tool sẽ tự queue job collect và báo user chờ.',
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
      'state (active/expired/released). Mặc định trả 50 lease mới nhất.',
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
      'Dùng khi user hỏi "subnet nào sắp hết IP" hoặc "tình trạng DHCP".',
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
      'hoặc "switch nào kết nối tới core".',
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
      'thiết bị, loại job, status. Mặc định 20 job mới nhất.',
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
      '"có lỗi gì trên F2-AS-01 không".',
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
      'Dùng khi user hỏi "có cảnh báo nào chưa xử lý" hoặc "alert gì đang active".',
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
      'Queue 1 INTERFACE_ACTION job (shut / no-shut / set-access-vlan / ' +
      'set-description / remove-description). Write op — backend sẽ tạo ' +
      'confirmation card. CHỈ gọi sau khi đã lookup device qua get_device.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name', 'interface', 'action'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị (case-insensitive)' },
        interface: { type: 'string', description: 'Tên interface (vendor-specific)' },
        action: strEnum(['shut', 'no-shut', 'set-access-vlan', 'set-description', 'remove-description']),
        vlan: {
          type: 'string',
          description: 'VLAN ID (1-4094). Bắt buộc khi action="set-access-vlan".',
        },
        description: {
          type: 'string',
          description: 'Mô tả mới. Bắt buộc khi action="set-description".',
        },
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const a = String(args.action ?? '?');
    const i = String(args.interface ?? '?');
    const d = String(args.device_name ?? '?');
    if (a === 'set-access-vlan') {
      return `Set VLAN ${args.vlan ?? '?'} trên ${i} (${d})`;
    }
    if (a === 'set-description') {
      return `Set description "${args.description ?? ''}" trên ${i} (${d})`;
    }
    if (a === 'remove-description') {
      return `Xóa description trên ${i} (${d})`;
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
      'Liệt kê thiết bị trong hệ thống. Có thể filter theo site, floor, status, vendor. ' +
      'Dùng khi user hỏi "có bao nhiêu switch ở site NKKN", "thiết bị tầng 6", "switch nào OFFLINE". ' +
      'Lưu ý: floor là số tầng (1-99), KHÔNG phải site. "tầng 6" = floor=6.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        site: { type: 'string', description: 'Filter theo site (VD: "LAB", "PROD"). Tùy chọn.' },
        floor: { type: 'number', description: 'Filter theo số tầng (VD: 6 = tầng 6). Tùy chọn.' },
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
      'thông tin subnet (subnet CIDR, pool range, reservations count).',
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
      'lease hiện tại, utilization. Dùng khi user hỏi cụ thể về 1 subnet.',
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
      'device name, createdBy. Dùng để verify job sau khi queue, hoặc debug job FAILED.',
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
      '"có rule nào cho thiết bị X không".',
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
      'CHỈ ADMIN mới dùng được. Trả về danh sách user (KHÔNG bao gồm password hash).',
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
      'phiên bản nào" hoặc "ai đã commit gần đây".',
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
      'phiên bản X và Y".',
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
      'Queue APPLY_CONFIG job: commit config mới lên thiết bị (Junos/EOS/IOS-XE). ' +
      'Mặc định dùng DeviceSavedConfig.content (config đã lưu trên web). ' +
      'Nếu truyền content, sẽ dùng content đó (sau khi validate). ' +
      'Config Studio GHI ĐÈN toàn bộ running-config = full config replacement. ' +
      'Diff lớn là BÌNH THƯỜNG — không phải lỗi. ' +
      'Nếu chỉ muốn thêm dòng (merge chứ không replace), dùng Config Studio.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị' },
        content: {
          type: 'string',
          description:
            'Tùy chọn. Nếu bỏ qua, dùng DeviceSavedConfig.content (đã lưu trên web). ' +
            'Nếu truyền, dùng content này và CẬP NHẬT DeviceSavedConfig trước khi commit.',
        },
        role: strEnum(['core', 'dist', 'access', 'custom']),
      },
    },
  },
  readonly: false,
  requiresRole: 'OPERATOR',
  confirmSummary: (args) => {
    const d = String(args.device_name ?? '?');
    const r = args.role ? ` (role=${args.role})` : '';
    return `Apply config lên ${d}${r}`;
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
      'Tính diff giữa config hiện tại (running) và config sẽ apply (DeviceSavedConfig.content ' +
      'hoặc content truyền vào). KHÔNG commit, chỉ preview. Trả về added/removed/unchanged count ' +
      'và first N diff lines. Chạy TRƯỚC queue_apply_config để xem thay đổi. ' +
      'NOTE: DeviceSavedConfig chứa FULL device config (không phải delta). ' +
      'Diff lớn (>200 dòng) là BÌNH THƯỜNG khi replace toàn bộ config. ' +
      'Nếu chỉ muốn thêm dòng mà không replace, dùng Config Studio thay vì assistant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['device_name'],
      properties: {
        device_name: { type: 'string', description: 'Tên thiết bị' },
        content: {
          type: 'string',
          description:
            'Tùy chọn. Nếu bỏ qua, dùng DeviceSavedConfig.content. ' +
            'Nếu truyền, dùng để so sánh với running-config.',
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
