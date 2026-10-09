/**
 * One chat message in the assistant drawer.
 *
 * Design follows modern AI assistant conventions (ChatGPT / Claude /
 * Vercel AI Chat):
 *
 *   - User: right-aligned text, NO bubble. Subtle differentiation
 *     comes from a faint surface bg and the text color. Heavy
 *     solid-color bubbles (the old blue) feel like IM and dominate
 *     the conversation.
 *
 *   - Assistant: small gradient avatar on the left + a content card
 *     with a very soft surface color and a hairline border. The card
 *     reads as "this is the AI's reply" without shouting.
 *
 *   - Tool calls: small inline chips above the content. They feel
 *     like inline references, not badges.
 *
 *   - Streaming: a 3-dot pulse + blinking caret at the end of text.
 *
 * Heavy lifting (markdown rendering) lives in `MarkdownText`.
 */

import { Tooltip, Typography, theme } from 'antd';
import {
  ApiOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  InfoCircleOutlined,
  RobotFilled,
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

function ToolCallChip({
  name,
  result,
}: {
  name: string;
  result?: { ok: boolean; error?: string };
}) {
  const { token } = theme.useToken();
  const meta = TOOL_LABELS[name] ?? { label: name, color: 'default' };
  const statusIcon = result === undefined ? (
    <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 11 }} />
  ) : result.ok ? (
    <CheckCircleTwoTone twoToneColor={token.colorSuccess} style={{ fontSize: 12 }} />
  ) : (
    <CloseCircleTwoTone twoToneColor={token.colorError} style={{ fontSize: 12 }} />
  );
  return (
    <Tooltip
      title={result?.error ?? `Tool: ${name}`}
      placement="topLeft"
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 500,
          color: token.colorTextSecondary,
          background: token.colorFillTertiary,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <ApiOutlined style={{ fontSize: 10 }} />
        {meta.label}
        {statusIcon}
      </span>
    </Tooltip>
  );
}

function AssistantAvatar() {
  const { token } = theme.useToken();
  return (
    <div
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        flexShrink: 0,
        background: `linear-gradient(135deg, ${token.colorPrimary} 0%, ${token.colorPrimaryActive} 100%)`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        boxShadow: `0 2px 6px ${token.colorPrimary}33`,
        marginTop: 2,
      }}
    >
      <RobotFilled style={{ fontSize: 14 }} />
    </div>
  );
}

function StreamingCursor() {
  const { token } = theme.useToken();
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 2,
        height: 14,
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        background: token.colorPrimary,
        animation: 'nc-cursor-blink 1s steps(2) infinite',
      }}
    />
  );
}

function TypingDots() {
  const { token } = theme.useToken();
  return (
    <span
      aria-label="AI is typing"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '2px 0',
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: token.colorPrimary,
            opacity: 0.4,
            animation: `nc-typing-bounce 1.2s ${i * 0.15}s ease-in-out infinite`,
          }}
        />
      ))}
    </span>
  );
}

export function MessageBubble({ message, onConfirm, onCancel, showUsage: _showUsage }: Props) {
  const { token } = theme.useToken();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div
        style={{
          padding: '6px 0',
          textAlign: 'center',
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
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
          marginBottom: 16,
        }}
      >
        <div
          style={{
            // User messages: right-aligned, subtle surface bg, no hard
            // border. Reads as "the user said this" without a heavy
            // solid-color bubble.
            maxWidth: '88%',
            padding: '9px 14px',
            borderRadius: 14,
            background: token.colorFillTertiary,
            color: token.colorText,
            fontSize: 14,
            lineHeight: 1.55,
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
    <div
      style={{
        display: 'flex',
        gap: 10,
        marginBottom: 18,
        alignItems: 'flex-start',
      }}
    >
      <AssistantAvatar />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Tool calls row */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div
            style={{
              marginBottom: 6,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
            }}
          >
            {message.toolCalls.map((tc) => (
              <ToolCallChip key={tc.id} name={tc.name} result={tc.result} />
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

        {/* Text content card. Soft surface, no hard border, gentle
            shadow. Streaming text gets a caret. Empty content while
            streaming renders typing dots. */}
        {message.content ? (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorderSecondary}`,
              boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
              fontSize: 14,
              lineHeight: 1.65,
              color: token.colorText,
            }}
          >
            <MarkdownText content={message.content} />
            {message.isStreaming && <StreamingCursor />}
          </div>
        ) : message.isStreaming ? (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <TypingDots />
          </div>
        ) : null}
      </div>
    </div>
  );
}
