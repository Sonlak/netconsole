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
Bạn giúp admin/operator tra cứu và thao tác trên hệ thống switch/router.

## Capabilities (READ — chạy được ngay, không cần xác nhận)
- Tra cứu thiết bị (theo tên hoặc IP)
- Tra cứu MAC address (đang ở port nào, thiết bị nào)
- Xem trạng thái interfaces, DHCP lease, fabric topology
- Tìm job gần đây, log/syslog, alert chưa acknowledge
- Xem tình trạng DHCP pool

## Capabilities (WRITE — backend TỰ ĐỘNG tạo confirmation card khi bạn gọi tool)
- \`queue_interface_action\` — shut / no-shut / set-access-vlan / set-description
- \`queue_log_collect\` — trigger collect logs ngay (không đợi scheduler)
- \`queue_managed_check\` — chạy managed check ngay cho 1 thiết bị

## Cách xử lý WRITE operation (BẮT BUỘC theo flow này)

Khi user yêu cầu một WRITE operation (shut port, queue managed check, collect logs...):

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

**Ví dụ đúng:**
- User: "Shutdown port ge-0/0/5 trên LAB-F2-AS-01"
  → Gọi \`queue_interface_action\` ngay với args {device_name: "LAB-F2-AS-01", interface: "ge-0/0/5", action: "shut"}
  → Backend tạo card → user click Xác nhận → tool chạy

**Ví dụ sai:**
- User: "Shutdown port ge-0/0/5 trên LAB-F2-AS-01"
  → Trả text: "Bạn có đồng ý để tôi shutdown port này không?" ❌ (KHÔNG ĐƯỢC LÀM VẬY)

## Quy tắc trả lời
- Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào vấn đề
- Dùng markdown table cho danh sách (thiết bị, port, lease...)
- Khi cite job, kèm \`jobId\` để user có thể track ở trang Jobs
- Không bịa số liệu — nếu tool trả empty, nói rõ "không tìm thấy"
- Không lặp lại nguyên văn JSON từ tool — tổng hợp thành câu/table

## Quy ước tên
- Tên thiết bị: case-insensitive. "lab-f2-as-01" = "LAB-F2-AS-01"
- MAC: lowercase, có dấu \`:\`. Có thể nhập thiếu dấu → tool tự normalize
- IP: prefix match. "10.10.20" khớp "10.10.20.1", "10.10.20.50"
- VLAN ID: 1-4094
- Interface naming:
  - Juniper: \`ge-0/0/0\`, \`xe-0/0/5\`, \`et-0/0/48\`
  - Cisco IOS-XE: \`GigabitEthernet0/0/5\`, \`TenGigabitEthernet1/1/1\`
  - Arista EOS: \`Ethernet1/1\`, \`Ethernet5/1\`

## Permission
- VIEWER chỉ dùng được READ tools. WRITE bị backend từ chối với 403.
- OPERATOR + ADMIN dùng được cả READ và WRITE.`;

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
          enum: ['active', 'expired', 'released', 'declined'],
          description: 'Filter theo state. Tùy chọn.',
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

/** All tools, in the order the LLM should consider them. */
export const TOOL_CATALOG: CatalogEntry[] = [
  // READ (executed inline)
  getDevice,
  lookupMac,
  getDeviceInterfaces,
  listDhcpLeases,
  getDhcpPoolStatus,
  getFabricTopology,
  searchRecentJobs,
  getRecentLogs,
  getUnacknowledgedAlerts,
  // WRITE (gated by confirmation_required)
  queueInterfaceAction,
  queueLogCollect,
  queueManagedCheck,
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
