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
 *     like inline references, not badges. For tool calls that
 *     queued a background job, the chip shows a live status pill
 *     (RUNNING spinner, SUCCESS check + duration, FAILED x + reason).
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
  LoadingOutlined,
  RobotFilled,
} from '@ant-design/icons';
import { MarkdownText } from './MarkdownText';
import { ConfirmationCard } from './ConfirmationCard';

export type AssistantMessageRole = 'user' | 'assistant' | 'system';

export type ToolCallJobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';

export type AssistantMessageView = {
  id: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: { ok: boolean; preview?: unknown; error?: string };
    /**
     * Live status of the background job queued by this tool call.
     * Only populated for the `queue_*` WRITE tools. The drawer
     * patches this in via `startJobFollowUp` from the moment a
     * `jobId` is detected in the tool_result preview, so the chip
     * animates from PENDING → RUNNING → SUCCESS/FAILED without the
     * user having to switch to the Jobs page.
     */
    jobFollowUp?: {
      jobId: string;
      status: ToolCallJobStatus;
      elapsedMs?: number;
      error?: string;
    };
  }>;
  pendingConfirmation?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    summary: string;
  };
  /**
   * Clickable follow-up chips. Set when the LLM calls
   * `suggest_followup` to suggest 1-3 next actions. Clicking a
   * chip sends the suggestion text as a new user message.
   */
  suggestions?: string[];
  isStreaming?: boolean;
};

type Props = {
  message: AssistantMessageView;
  onConfirm: (toolCallId: string) => void;
  onCancel: (toolCallId: string) => void;
  onPickSuggestion?: (suggestion: string) => void;
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

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m${rem}s`;
}

type ToolCallJobFollowUp = NonNullable<
  NonNullable<AssistantMessageView['toolCalls']>[number]['jobFollowUp']
>;

function ToolCallChip({
  name,
  result,
  jobFollowUp,
}: {
  name: string;
  result?: { ok: boolean; error?: string };
  jobFollowUp?: ToolCallJobFollowUp;
}) {
  const { token } = theme.useToken();
  const meta = TOOL_LABELS[name] ?? { label: name, color: 'default' };

  // Background job takes precedence over the synchronous result icon:
  // the tool call returned ok=true ("queued") but the actual outcome
  // is what the user cares about.
  if (jobFollowUp) {
    const { status, elapsedMs, error } = jobFollowUp;
    const isInFlight = status === 'PENDING' || status === 'RUNNING';
    const isSuccess = status === 'SUCCESS';
    const isFailed = status === 'FAILED' || status === 'CANCELLED' || status === 'TIMEOUT';
    const labelText = isInFlight
      ? `${meta.label} · ${status === 'PENDING' ? 'queued' : 'running'} ${formatElapsed(elapsedMs)}`
      : isSuccess
        ? `${meta.label} · done ${formatElapsed(elapsedMs)}`
        : `${meta.label} · ${status === 'TIMEOUT' ? 'timeout' : 'failed'}`;
    const tooltip = isFailed
      ? error ?? `Job ${status.toLowerCase()}`
      : `Job ${jobFollowUp.jobId.slice(0, 8)} · ${status}${elapsedMs !== undefined ? ` · ${formatElapsed(elapsedMs)}` : ''}`;
    const accentColor = isInFlight
      ? token.colorPrimary
      : isSuccess
        ? token.colorSuccess
        : token.colorError;
    return (
      <Tooltip title={tooltip} placement="topLeft">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
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
          <span style={{ color: accentColor }}>{labelText}</span>
          {isInFlight ? (
            <LoadingOutlined style={{ color: accentColor, fontSize: 11 }} />
          ) : isSuccess ? (
            <CheckCircleTwoTone twoToneColor={accentColor} style={{ fontSize: 12 }} />
          ) : (
            <CloseCircleTwoTone twoToneColor={accentColor} style={{ fontSize: 12 }} />
          )}
        </span>
      </Tooltip>
    );
  }

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

export function MessageBubble({ message, onConfirm, onCancel, onPickSuggestion, showUsage: _showUsage }: Props) {
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
              <ToolCallChip
                key={tc.id}
                name={tc.name}
                result={tc.result}
                jobFollowUp={tc.jobFollowUp}
              />
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

        {/* Clickable follow-up chips. Rendered AFTER the text card so
            they read as "what to do next". Hide while streaming so
            the user doesn't see half-baked suggestions. */}
        {!message.isStreaming &&
          message.suggestions &&
          message.suggestions.length > 0 &&
          onPickSuggestion && (
            <div
              style={{
                marginTop: 6,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              {message.suggestions.map((s, i) => (
                <button
                  key={`${s}-${i}`}
                  type="button"
                  onClick={() => onPickSuggestion(s)}
                  style={{
                    cursor: 'pointer',
                    padding: '5px 12px',
                    borderRadius: 14,
                    fontSize: 12,
                    fontWeight: 500,
                    color: token.colorPrimary,
                    background: token.colorPrimaryBg,
                    border: `1px solid ${token.colorPrimaryBorder}`,
                    transition: 'all 160ms ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = token.colorPrimary;
                    e.currentTarget.style.color = '#fff';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = token.colorPrimaryBg;
                    e.currentTarget.style.color = token.colorPrimary;
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
