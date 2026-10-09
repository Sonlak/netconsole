/**
 * One chat message in the assistant drawer.
 *
 * Renders the four things the assistant can emit:
 *  - Plain markdown text (LLM prose)
 *  - A "tool call happened" pill (collapsed, hover to expand)
 *  - A confirmation card for WRITE actions
 *  - A usage footer (token + cost summary, admin-only)
 *
 * Kept small on purpose — the heavy lifting (markdown rendering)
 * happens in `MarkdownText`.
 */

import { Badge, Space, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  CodeOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { MarkdownText } from './MarkdownText';
import { ConfirmationCard } from './ConfirmationCard';

export type AssistantMessageRole = 'user' | 'assistant' | 'system';

export type AssistantMessageView = {
  id: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: { ok: boolean; preview?: unknown; error?: string };
  }>;
  pendingConfirmation?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    summary: string;
  };
  isStreaming?: boolean;
};

type Props = {
  message: AssistantMessageView;
  onConfirm: (toolCallId: string) => void;
  onCancel: (toolCallId: string) => void;
  showUsage: boolean;
};

const TOOL_LABELS: Record<string, { label: string; color: string }> = {
  lookup_mac: { label: 'MAC lookup', color: 'blue' },
  get_device: { label: 'Device lookup', color: 'blue' },
  get_device_interfaces: { label: 'Interface list', color: 'blue' },
  list_dhcp_leases: { label: 'DHCP leases', color: 'blue' },
  get_dhcp_pool_status: { label: 'DHCP pool', color: 'blue' },
  get_fabric_topology: { label: 'Fabric topology', color: 'blue' },
  search_recent_jobs: { label: 'Job search', color: 'blue' },
  get_recent_logs: { label: 'Device logs', color: 'blue' },
  get_unacknowledged_alerts: { label: 'Active alerts', color: 'blue' },
  queue_interface_action: { label: 'Interface action', color: 'orange' },
  queue_log_collect: { label: 'Log collect', color: 'orange' },
  queue_managed_check: { label: 'Managed check', color: 'orange' },
};

function ToolCallPill({
  name,
  result,
}: {
  name: string;
  result?: { ok: boolean; error?: string };
}) {
  const meta = TOOL_LABELS[name] ?? { label: name, color: 'default' };
  const statusIcon = result === undefined ? (
    <InfoCircleOutlined />
  ) : result.ok ? (
    <CheckCircleTwoTone twoToneColor="#52c41a" />
  ) : (
    <CloseCircleTwoTone twoToneColor="#f5222d" />
  );
  return (
    <Tooltip
      title={result?.error ?? `Tool: ${name}`}
      placement="topLeft"
    >
      <Tag color={meta.color} style={{ marginRight: 0, fontSize: 11 }}>
        <Space size={4}>
          <CodeOutlined />
          {meta.label}
          {statusIcon}
        </Space>
      </Tag>
    </Tooltip>
  );
}

export function MessageBubble({ message, onConfirm, onCancel, showUsage: _showUsage }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div style={{ padding: '4px 0' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {message.content}
        </Typography.Text>
      </div>
    );
  }

  if (isUser) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 12,
        }}
      >
        <div
          style={{
            maxWidth: '85%',
            padding: '10px 14px',
            borderRadius: 12,
            background: 'var(--ant-color-primary, #1677ff)',
            color: '#fff',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div style={{ marginBottom: 16 }}>
      {/* Tool calls row (collapsible) */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div style={{ marginBottom: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {message.toolCalls.map((tc) => (
            <ToolCallPill key={tc.id} name={tc.name} result={tc.result} />
          ))}
        </div>
      )}

      {/* Pending confirmation card */}
      {message.pendingConfirmation && (
        <div style={{ marginBottom: 8 }}>
          <ConfirmationCard
            toolCallId={message.pendingConfirmation.id}
            name={message.pendingConfirmation.name}
            arguments={message.pendingConfirmation.arguments}
            summary={message.pendingConfirmation.summary}
            onConfirm={() => onConfirm(message.pendingConfirmation!.id)}
            onCancel={() => onCancel(message.pendingConfirmation!.id)}
          />
        </div>
      )}

      {/* Text content */}
      {message.content && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--ant-color-fill-tertiary, #f5f5f5)',
            maxWidth: '95%',
          }}
        >
          <MarkdownText content={message.content} />
          {message.isStreaming && (
            <Badge status="processing" style={{ marginLeft: 4 }} />
          )}
        </div>
      )}
    </div>
  );
}
