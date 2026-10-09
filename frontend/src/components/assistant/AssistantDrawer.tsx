/**
 * AI Assistant chat drawer.
 *
 * Opens from the header bar (Assistant button). Persists the
 * conversation in component state + sessionStorage so a page
 * refresh doesn't lose the chat.
 *
 * Flow per turn:
 *  1. User types a message and hits Enter.
 *  2. We POST /api/assistant with the full message history.
 *  3. We stream SSE events into a local "view" list:
 *     - `text` events append to the current assistant message.
 *     - `tool_call` events add a "tool happened" pill.
 *     - `tool_result` events attach the result to the latest pill.
 *     - `confirmation_required` adds a ConfirmationCard inline.
 *     - `usage` events are aggregated into a footer.
 *  4. On Confirm, we POST again with the same messages + a
 *     `confirmedToolCall` field; the backend executes and streams
 *     the post-action summary back.
 *
 * We DO NOT depend on the assistant for routing the rest of the
 * app — the user can keep using the dashboard with the drawer
 * open (e.g. copy a device name from Devices page into the chat).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  ClearOutlined,
  CloseOutlined,
  LoadingOutlined,
  RobotOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useAuth } from '@/hooks/useAuth';
import { streamAssistant, type AssistantMessage, type AssistantStreamEvent } from '@/api/assistant';
import { MessageBubble, type AssistantMessageView } from './MessageBubble';

type Props = {
  open: boolean;
  onClose: () => void;
};

const SESSION_STORAGE_KEY = 'netconsole:assistant:session';
const MESSAGES_STORAGE_KEY = 'netconsole:assistant:messages';

const SUGGESTED_PROMPTS = [
  'MAC 00:11:22:33:44:55 đang ở port nào?',
  'LAB-F2-AS-01 có online không?',
  'Subnet NKKN sắp hết IP chưa?',
  'Có alert nào chưa acknowledge?',
  'Shutdown port ge-0/0/5 trên LAB-F2-AS-01',
];

export function AssistantDrawer({ open, onClose }: Props) {
  const { user } = useAuth();
  const { message: toast } = AntApp.useApp();
  // Pull real token values (not CSS vars) so we can pass them as
  // inline style overrides. AntD's Drawer renders into a portal, and
  // the body/header/footer wrappers can ship their own background that
  // beats var() cascade. Inline-style values are guaranteed to apply.
  const { token } = theme.useToken();

  // ── state ────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<AssistantMessageView[]>(() => loadMessages());
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(() => loadSessionId());
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
  } | null>(null);
  const [totalCostMicrodollars, setTotalCostMicrodollars] = useState(0);
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalCachedTokens, setTotalCachedTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const isAdmin = user?.role === 'ADMIN';

  // ── persistence ─────────────────────────────────────────────────────
  useEffect(() => {
    sessionStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);
  useEffect(() => {
    if (sessionId) sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }, [sessionId]);

  // ── auto-scroll ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // ── focus input on open ─────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      // Slight delay to let the drawer animation finish.
      const t = setTimeout(() => inputRef.current?.focus(), 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── send a message ──────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (userMessage: string, confirmedToolCall?: {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }) => {
      if (!userMessage.trim() && !confirmedToolCall) return;

      // Cancel any in-flight stream.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      // Build OpenAI messages: collapse the view back to the wire shape.
      // We MUST preserve tool_calls on assistant messages and the tool
      // result rows so the LLM sees the prior turn's tool history.
      // Otherwise the LLM re-runs the same tool on every follow-up.
      const wire: AssistantMessage[] = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => m.role === 'user' || m.content || (m.toolCalls && m.toolCalls.length > 0))
        .flatMap((m): AssistantMessage[] => {
          if (m.role === 'user') return [{ role: 'user' as const, content: m.content }];
          // assistant: keep text + tool_calls + any tool result rows that
          // we stored on the view (each tool result lives next to its call).
          const out: AssistantMessage[] = [
            {
              role: 'assistant' as const,
              content: m.content,
              ...(m.toolCalls && m.toolCalls.length > 0
                ? {
                    tool_calls: m.toolCalls.map((tc) => ({
                      id: tc.id,
                      type: 'function' as const,
                      function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments ?? {}),
                      },
                    })),
                  }
                : {}),
            },
          ];
          for (const tc of m.toolCalls ?? []) {
            if (tc.result === undefined) continue;
            out.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(tc.result.preview ?? { ok: tc.result.ok, error: tc.result.error ?? null }),
            });
          }
          return out;
        });
      if (userMessage) wire.push({ role: 'user', content: userMessage });

      // Add the user bubble (skip when re-sending via confirmation).
      if (userMessage) {
        setMessages((prev) => [
          ...prev,
          { id: `u-${Date.now()}`, role: 'user', content: userMessage },
        ]);
      }
      // Add a placeholder assistant bubble that we'll stream into.
      const assistantId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', isStreaming: true },
      ]);

      setInput('');
      setStreaming(true);
      setError(null);
      if (confirmedToolCall) setPendingConfirm(null);

      let receivedFirst = false;

      const updateAssistant = (updater: (m: AssistantMessageView) => AssistantMessageView) => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
      };

      try {
        await streamAssistant(
          {
            userMessage: userMessage || `[Confirmed: ${confirmedToolCall?.name}]`,
            messages: wire,
            ...(sessionId ? { sessionId } : {}),
            ...(confirmedToolCall ? { confirmedToolCall } : {}),
          },
          (event) => handleEvent(event, {
            onSession: (sid) => {
              if (!sessionId) setSessionId(sid);
            },
            onText: (chunk) => {
              receivedFirst = true;
              updateAssistant((m) => ({ ...m, content: m.content + chunk }));
            },
            onToolCall: (id, name, args) => {
              updateAssistant((m) => ({
                ...m,
                toolCalls: [...(m.toolCalls ?? []), { id, name, arguments: args }],
              }));
            },
            onToolResult: (id, ok, preview, errorMsg) => {
              updateAssistant((m) => ({
                ...m,
                toolCalls: (m.toolCalls ?? []).map((tc) =>
                  tc.id === id ? { ...tc, result: { ok, preview, error: errorMsg } } : tc,
                ),
              }));
            },
            onConfirmationRequired: (id, name, args, summary) => {
              updateAssistant((m) => ({ ...m, pendingConfirmation: { id, name, arguments: args, summary } }));
              setPendingConfirm({ toolCallId: id, name, arguments: args });
            },
            onUsage: (inTok, cached, outTok, cost) => {
              setTotalInputTokens((p) => p + inTok);
              setTotalCachedTokens((p) => p + cached);
              setTotalOutputTokens((p) => p + outTok);
              setTotalCostMicrodollars((p) => p + cost);
            },
            onError: (msg) => {
              setError(msg);
            },
            onDone: () => {
              updateAssistant((m) => ({ ...m, isStreaming: false }));
            },
          }),
          ac.signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Assistant request failed';
        setError(msg);
        updateAssistant((m) => ({
          ...m,
          isStreaming: false,
          content: m.content || `⚠️ ${msg}`,
        }));
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // Mark streaming off even if the helper missed the done event.
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m)),
        );
        void receivedFirst; // suppress unused warning
      }
    },
    [messages, sessionId],
  );

  // ── confirmation flow ───────────────────────────────────────────────
  const handleConfirm = useCallback(
    (_toolCallId: string) => {
      if (!pendingConfirm) return;
      sendMessage('', {
        id: pendingConfirm.toolCallId,
        name: pendingConfirm.name as never,
        arguments: pendingConfirm.arguments,
      });
    },
    [pendingConfirm, sendMessage],
  );

  const handleCancel = useCallback((toolCallId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.pendingConfirmation?.id === toolCallId
          ? { ...m, pendingConfirmation: undefined, content: m.content || 'Đã huỷ thao tác.' }
          : m,
      ),
    );
    setPendingConfirm(null);
  }, []);

  // ── clear chat ──────────────────────────────────────────────────────
  const clearChat = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setError(null);
    setTotalCostMicrodollars(0);
    setTotalInputTokens(0);
    setTotalCachedTokens(0);
    setTotalOutputTokens(0);
    toast.info('Đã xoá cuộc trò chuyện.');
  }, [toast]);

  // ── input handlers ──────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  // ── render ──────────────────────────────────────────────────────────
  return (
    <Drawer
      title={
        <Space>
          <RobotOutlined style={{ color: '#1677ff' }} />
          <span>NetConsole Assistant</span>
          {streaming && <LoadingOutlined />}
          {sessionId && (
            <Tag color="default" style={{ fontSize: 10 }}>
              sess-{sessionId.slice(0, 6)}
            </Tag>
          )}
        </Space>
      }
      placement="right"
      width={520}
      open={open}
      onClose={onClose}
      closeIcon={<CloseOutlined />}
      styles={{
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          // Make the drawer body follow the active theme instead of the
          // AntD default (always light). Without this, the chat scroll
          // area ends up stuck on a white surface in dark mode and the
          // assistant bubble's --ant-color-bg-elevated contrast is wrong.
          background: token.colorBgContainer,
        },
        // Header is dark-by-default in AntD's Drawer; align it to the
        // same container color so the top edge doesn't read as a stripe.
        header: {
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        },
        // Footer/content panels inside the drawer should also follow
        // the theme (the Input.TextArea wrapper sits in `footer` in
        // older AntD; safe to set on both for future-proofing).
        footer: {
          background: token.colorBgContainer,
        },
        content: {
          background: token.colorBgContainer,
        },
        mask: { background: 'rgba(0, 0, 0, 0.55)' },
      }}
      extra={
        <Space>
          <Popconfirm
            title="Xoá cuộc trò chuyện?"
            description="Toàn bộ tin nhắn sẽ bị xoá (audit log vẫn còn)."
            okText="Xoá"
            cancelText="Huỷ"
            onConfirm={clearChat}
            disabled={messages.length === 0}
          >
            <Tooltip title="Xoá cuộc trò chuyện">
              <Button type="text" icon={<ClearOutlined />} disabled={messages.length === 0} />
            </Tooltip>
          </Popconfirm>
        </Space>
      }
    >
      {/* Messages scroll area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          // Subtle vertical gradient: a touch lighter at the top, settling
          // into the container color below. Reads as a distinct "chat
          // surface" against the surrounding Drawer body without fighting
          // the theme.
          background: token.colorBgLayout,
          backgroundImage: `linear-gradient(180deg, ${token.colorFillQuaternary} 0%, ${token.colorBgLayout} 240px)`,
        }}
      >
        {messages.length === 0 ? (
          <Empty
            image={<RobotOutlined style={{ fontSize: 48, color: '#1677ff' }} />}
            description={
              <div>
                <Typography.Title level={5} style={{ marginTop: 8 }}>
                  Tôi có thể giúp gì?
                </Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Tra cứu thiết bị, MAC, DHCP, fabric topology, job gần đây...
                </Typography.Text>
                <div style={{ marginTop: 12 }}>
                  {SUGGESTED_PROMPTS.map((p) => (
                    <Tag
                      key={p}
                      style={{ cursor: 'pointer', marginBottom: 4, padding: '2px 8px' }}
                      onClick={() => void sendMessage(p)}
                    >
                      <ThunderboltOutlined /> {p}
                    </Tag>
                  ))}
                </div>
              </div>
            }
          />
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
              showUsage={isAdmin}
            />
          ))
        )}

        {error && (
          <Alert
            type="error"
            showIcon
            style={{ margin: '8px 0' }}
            message={error}
            closable
            onClose={() => setError(null)}
          />
        )}
      </div>

      {/* Usage footer (admin only) */}
      {isAdmin && (totalInputTokens > 0 || totalOutputTokens > 0) && (
        <div
          style={{
            padding: '4px 16px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            fontSize: 11,
            color: token.colorTextTertiary,
            display: 'flex',
            justifyContent: 'space-between',
            background: token.colorBgElevated,
          }}
        >
          <span>
            Tokens: {totalInputTokens} in
            {totalCachedTokens > 0 && (
              <Tooltip title="Tokens served from prompt cache (50% off)">
                <span style={{ color: '#52c41a' }}> ({totalCachedTokens} cached)</span>
              </Tooltip>
            )}
            {' + '}{totalOutputTokens} out
          </span>
          <Tooltip title="Tổng chi phí ước tính (USD) cho cuộc trò chuyện này">
            <span>≈ ${(totalCostMicrodollars / 1_000_000).toFixed(6)}</span>
          </Tooltip>
        </div>
      )}

      {/* Input area */}
      <div
        style={{
          padding: 12,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgElevated,
        }}
      >
        <Space.Compact style={{ width: '100%' }}>
          <Input.TextArea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Hỏi về thiết bị, MAC, DHCP, alert... (Enter để gửi, Shift+Enter xuống dòng)"
            autoSize={{ minRows: 1, maxRows: 5 }}
            disabled={streaming}
            style={{ resize: 'none' }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={streaming}
            disabled={!input.trim() || streaming}
            onClick={() => void sendMessage(input)}
            style={{ height: 'auto' }}
          >
            Gửi
          </Button>
        </Space.Compact>
        <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>
          <Badge status="processing" text="gpt-4.1-mini + prompt caching" />
          {' · '}
          <span>WRITE actions (shutdown port, ...) cần xác nhận trước khi chạy</span>
        </div>
      </div>
    </Drawer>
  );
}

// ─── persistence helpers ──────────────────────────────────────────────────

function loadSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function loadMessages(): AssistantMessageView[] {
  try {
    const raw = sessionStorage.getItem(MESSAGES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AssistantMessageView[];
    if (!Array.isArray(parsed)) return [];
    // Strip the streaming flag on rehydrate — the previous stream is dead.
    return parsed.map((m) => ({ ...m, isStreaming: false }));
  } catch {
    return [];
  }
}

// Event handler bundle. Pulled out of the main component so the
// closure doesn't capture stale state across rapid re-renders.
type EventHandlers = {
  onSession: (sid: string) => void;
  onText: (chunk: string) => void;
  onToolCall: (id: string, name: string, args: Record<string, unknown>) => void;
  onToolResult: (id: string, ok: boolean, preview: unknown, error?: string) => void;
  onConfirmationRequired: (id: string, name: string, args: Record<string, unknown>, summary: string) => void;
  onUsage: (inTokens: number, cached: number, outTokens: number, cost: number) => void;
  onError: (msg: string) => void;
  onDone: () => void;
};

function handleEvent(event: AssistantStreamEvent, h: EventHandlers): void {
  switch (event.type) {
    case 'session':
      h.onSession(event.sessionId);
      return;
    case 'text':
      h.onText(event.content);
      return;
    case 'tool_call':
      h.onToolCall(event.id, event.name, event.arguments);
      return;
    case 'tool_result':
      h.onToolResult(event.id, event.ok, event.preview, event.error);
      return;
    case 'confirmation_required':
      h.onConfirmationRequired(event.id, event.name, event.arguments, event.summary);
      return;
    case 'usage':
      h.onUsage(event.inputTokens, event.cachedInputTokens, event.outputTokens, event.costMicrodollars);
      return;
    case 'error':
      h.onError(event.message);
      return;
    case 'done':
      h.onDone();
      return;
  }
  // Exhaustiveness check: if a new event type is added and we don't
  // handle it, the switch above fails to type-check.
  const _exhaustive: never = event;
  void _exhaustive;
}
