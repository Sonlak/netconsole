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

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Drawer,
  Input,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  ApartmentOutlined,
  ApiOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  ClearOutlined,
  CloseOutlined,
  GlobalOutlined,
  KeyOutlined,
  LoadingOutlined,
  RobotFilled,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { useAuth } from '@/hooks/useAuth';
import { streamAssistant, type AssistantMessage, type AssistantStreamEvent } from '@/api/assistant';
import { MessageBubble, type AssistantMessageView } from './MessageBubble';
import { startJobFollowUp } from '@/lib/jobFollowUp';
import { detectPreviewArray } from '../../utils/excelExport';

type Props = {
  open: boolean;
  onClose: () => void;
};

// Storage keys are namespaced per user so a shared browser (kiosk,
// team machine) doesn't leak one user's chat history to another.
// `null` userId (logged out) means we still want a stable key so
// the drawer doesn't show someone else's session — we wipe state
// instead in that case.
function messagesKey(userId: string | null) {
  return `netconsole:assistant:messages:${userId ?? 'guest'}`;
}
function sessionKey(userId: string | null) {
  return `netconsole:assistant:session:${userId ?? 'guest'}`;
}

// Legacy keys from the pre-per-user version. We migrate on first
// read and then drop them so old browsers don't carry stale state.
const LEGACY_MESSAGES_KEY = 'netconsole:assistant:messages';
const LEGACY_SESSION_KEY = 'netconsole:assistant:session';

// Card-grid suggested prompts for the welcome state. Each card has
// an icon, title, and the actual prompt. Clicking the card fires
// the prompt. Pattern borrowed from Notion AI / Linear AI / Vercel
// AI Chat — gives the user immediate value without forcing them to
// think of a question.
const SUGGESTED_CARDS: Array<{
  icon: React.ReactNode;
  title: string;
  prompt: string;
}> = [
  {
    icon: <KeyOutlined />,
    title: 'Tìm MAC address',
    prompt: 'MAC 00:11:22:33:44:55 hiện đang nằm ở port nào?',
  },
  {
    icon: <WifiOutlined />,
    title: 'Trạng thái thiết bị',
    prompt: 'LAB-F2-AS-01 có đang online không?',
  },
  {
    icon: <ApartmentOutlined />,
    title: 'Fabric topology',
    prompt: 'Cho tôi xem fabric topology hiện tại',
  },
  {
    icon: <GlobalOutlined />,
    title: 'DHCP leases',
    prompt: 'Liệt kê 10 DHCP lease gần nhất',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: 'Alerts',
    prompt: 'Có alert nào chưa acknowledge không?',
  },
  {
    icon: <ApiOutlined />,
    title: 'Job gần đây',
    prompt: 'Job nào fail gần đây?',
  },
];

export function AssistantDrawer({ open, onClose }: Props) {
  const { user } = useAuth();
  const { message: toast } = AntApp.useApp();
  // Pull real token values (not CSS vars) so we can pass them as
  // inline style overrides. AntD's Drawer renders into a portal, and
  // the body/header/footer wrappers can ship their own background that
  // beats var() cascade. Inline-style values are guaranteed to apply.
  const { token } = theme.useToken();

  // Per-user storage keys (memoized — the helpers above would be
  // called on every render otherwise).
  const storageUserId = user?.id ?? null;
  const messagesStorageKey = useMemo(() => messagesKey(storageUserId), [storageUserId]);
  const sessionStorageKey = useMemo(() => sessionKey(storageUserId), [storageUserId]);

  // ── state ────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<AssistantMessageView[]>(() => loadMessages(storageUserId));
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(() => loadSessionId(storageUserId));
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
  // True when the messages scroll viewport is at (or within ~80px of)
  // the bottom. Drives the floating "↓ xuống cuối" button so the user
  // can jump back without manual scroll, and gates auto-scroll on new
  // messages (don't yank a reading user away from the top).
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Counter for new messages that arrived while the user was scrolled
  // up. Displayed as a Badge dot on the jump-to-bottom button so the
  // user knows there's something new without committing to a scroll.
  const [unreadCount, setUnreadCount] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Last userId we loaded messages for. Used to detect user switches
  // mid-session so we don't show user A's history to user B on the
  // same shared browser/kiosk.
  const loadedForUserRef = useRef<string | null>(storageUserId);
  // Tracks the previous value of `messages` so we can count "new"
  // bubbles that arrived while the user was scrolled up. Kept in a
  // ref (not state) so updating it doesn't trigger a render — only
  // the unreadCount state update does.
  const prevMessagesLengthRef = useRef(messages.length);
  // True when the next messages change should auto-scroll (e.g. user
  // sent a message, drawer just opened, or user clicked the jump
  // button). Resets to false after the next scroll-to-bottom.
  const forceScrollRef = useRef(false);

  /**
   * Set to true when the user sends a message that contains an export
   * keyword ("xuất", "tải file", "excel", "export", "csv", "download",
   * ...). The flag is consumed once — it marks only the immediately
   * following assistant bubble so the export button appears without the
   * user having to ask twice.
   */
  const expectExportRef = useRef(false);

  /** Case-insensitive keyword test for export requests. */
  const hasExportKeyword = (text: string) =>
    /\b(xuất|tải\s*(về|file|xlsx|excel|csv)|export|excel|xlsx|csv|download)\b/i.test(text);

  const isAdmin = user?.role === 'ADMIN';

  // ── persistence (per-user keys) ─────────────────────────────────────
  useEffect(() => {
    sessionStorage.setItem(messagesStorageKey, JSON.stringify(messages));
  }, [messages, messagesStorageKey]);
  useEffect(() => {
    if (sessionId) sessionStorage.setItem(sessionStorageKey, sessionId);
    else sessionStorage.removeItem(sessionStorageKey);
  }, [sessionId, sessionStorageKey]);

  // ── user-switch detection ───────────────────────────────────────────
  // If the logged-in user changes (e.g. logout/login on a shared
  // browser), reload the chat for the new user. Without this, user B
  // would see user A's history and possibly send follow-up messages
  // to a sessionId that belongs to user A's server session.
  useEffect(() => {
    if (loadedForUserRef.current === storageUserId) return;
    loadedForUserRef.current = storageUserId;
    setMessages(loadMessages(storageUserId));
    setSessionId(loadSessionId(storageUserId));
    setError(null);
    setTotalCostMicrodollars(0);
    setTotalInputTokens(0);
    setTotalCachedTokens(0);
    setTotalOutputTokens(0);
    setUnreadCount(0);
    // After swapping state, force a scroll to the (new) bottom.
    forceScrollRef.current = true;
  }, [storageUserId]);

  // ── scroll position tracking ───────────────────────────────────────
  // `isAtBottom` is true when the user can see the last message. We
  // use an 80px tolerance so the button doesn't flicker on small
  // bounces (typing, single new tool pill, etc.).
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80;
    setIsAtBottom(atBottom);
    if (atBottom) setUnreadCount(0);
  }, []);

  // ── auto-scroll ─────────────────────────────────────────────────────
  // Three triggers force a scroll-to-bottom:
  //   1. The drawer just opened (useEffect on `open` below, with a
  //      delay that beats the drawer slide-in animation).
  //   2. The user clicked the jump button (sets forceScrollRef = true
  //      then dispatches a no-op state change).
  //   3. The user sent a message — we mark forceScrollRef and let
  //      sendMessage flip the new bubble into the list.
  // For streaming chunks we only auto-scroll if the user was ALREADY
  // at the bottom (otherwise we'd yank them off a message they're
  // re-reading just because a token came in).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const lengthDelta = messages.length - prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;
    // If a new bubble appeared and we were NOT at the bottom, count
    // it as "unread" so the jump button badge can show.
    if (lengthDelta > 0 && !isAtBottom && !forceScrollRef.current) {
      setUnreadCount((c) => c + lengthDelta);
      return;
    }
    if (forceScrollRef.current || isAtBottom) {
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
    }
  }, [messages, isAtBottom]);

  // ── focus input on open + scroll to bottom ─────────────────────────
  useEffect(() => {
    if (open) {
      // Slight delay to let the drawer animation finish (AntD's
      // slide-in takes ~300ms). Without the delay, scrollHeight is 0
      // because the panel hasn't laid out yet, and the user lands at
      // the top of an empty container — the bug that prompted the
      // "↓ xuống cuối" request.
      const t = setTimeout(() => {
        inputRef.current?.focus();
        const el = scrollRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
          setIsAtBottom(true);
          setUnreadCount(0);
        }
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── jump-to-bottom button handler ──────────────────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    forceScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    setIsAtBottom(true);
    setUnreadCount(0);
    // Restore focus to the composer so the user can type right away.
    inputRef.current?.focus();
  }, []);

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
        // User-initiated message — always jump to bottom so they see
        // the streaming reply land.
        forceScrollRef.current = true;
      }
      // Detect export keyword before consuming the ref.
      if (userMessage && hasExportKeyword(userMessage)) {
        expectExportRef.current = true;
      }
      // Add a placeholder assistant bubble that we'll stream into.
      const assistantId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const showExport = expectExportRef.current;
      expectExportRef.current = false; // consume — only next response gets the flag
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', isStreaming: true, showExport },
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
              // If the tool queued a background job (queue_interface_action,
              // queue_log_collect, queue_managed_check), the preview carries
              // a jobId. Start a background follow-up so the chip animates
              // PENDING → RUNNING → SUCCESS/FAILED and a toast fires on
              // terminal — without this, the user only sees "Job queued"
              // and has to navigate to /jobs to learn the outcome.
              const jobId = (preview as { jobId?: unknown } | null | undefined)?.jobId;
              if (typeof jobId === 'string' && jobId) {
                const stop = startJobFollowUp(jobId, (update) => {
                  updateAssistant((m) => ({
                    ...m,
                    toolCalls: (m.toolCalls ?? []).map((tc) =>
                      tc.id === id
                        ? {
                            ...tc,
                            jobFollowUp: {
                              jobId,
                              status: update.status,
                              ...(update.elapsedMs !== undefined
                                ? { elapsedMs: update.elapsedMs }
                                : {}),
                              ...(update.error ? { error: update.error } : {}),
                            },
                          }
                        : tc,
                    ),
                  }));
                  if (
                    update.status === 'SUCCESS' ||
                    update.status === 'FAILED' ||
                    update.status === 'CANCELLED' ||
                    update.status === 'TIMEOUT'
                  ) {
                    // One-shot notification. Don't fire on the synthetic
                    // PENDING replay that startJobFollowUp emits for late
                    // subscribers — that has no elapsedMs and is just a
                    // rehydration.
                    if (update.elapsedMs !== undefined) {
                      const summary = (preview as { message?: string } | null | undefined)?.message;
                      if (update.status === 'SUCCESS') {
                        const ms = update.elapsedMs;
                        const dur =
                          ms < 1000
                            ? `${ms}ms`
                            : ms < 60_000
                              ? `${(ms / 1000).toFixed(1)}s`
                              : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
                        toast.success(
                          summary
                            ? `✅ ${summary} (${dur})`
                            : `Job hoàn thành trong ${dur}`,
                        );
                      } else {
                        toast.error(
                          update.error
                            ? `❌ ${update.error}`
                            : `Job ${update.status.toLowerCase()}. Xem /jobs.`,
                        );
                      }
                    }
                    stop();
                  }
                });
              }
            },
            onConfirmationRequired: (id, name, args, summary) => {
              updateAssistant((m) => ({ ...m, pendingConfirmation: { id, name, arguments: args, summary } }));
              setPendingConfirm({ toolCallId: id, name, arguments: args });
            },
            onSuggestions: (suggestions) => {
              updateAssistant((m) => ({ ...m, suggestions }));
            },
            onUsage: (inTok, cached, outTok, cost) => {
              setTotalInputTokens((p) => p + inTok);
              setTotalCachedTokens((p) => p + cached);
              setTotalOutputTokens((p) => p + outTok);
              setTotalCostMicrodollars((p) => p + cost);
            },
            onError: (msg) => {
              // On auth failure, wipe the stale session so the user can
              // re-login without stale messages blocking the next turn.
              // The coordinator returns "Session expired — please log in
              // again." on 401, and the backend may return the same on
              // server-side session errors. Any 401 text in the error
              // is also covered.
              const lower = msg.toLowerCase();
              const isAuthError =
                lower.includes('401') ||
                lower.includes('unauthorized') ||
                lower.includes('session expired') ||
                lower.includes('token expired');
              if (isAuthError) {
                sessionStorage.removeItem(messagesStorageKey);
                sessionStorage.removeItem(sessionStorageKey);
                setMessages([]);
                setSessionId(null);
              }
              setError(msg);
            },
            onDone: () => {
              updateAssistant((m) => {
                // If the user asked for export but the AI didn't re-call
                // a data tool, no button will appear — surface a tip so
                // the user knows to ask again with the data fetch.
                const hasExportableTool = (m.toolCalls ?? []).some(
                  (tc) => tc.result?.ok && detectPreviewArray(tc.result.preview) !== null,
                );
                const exportTip =
                  showExport && !hasExportableTool
                    ? 'AI chưa gọi lại data tool nên chưa có nút tải. Hãy hỏi lại kiểu "liệt kê X rồi xuất Excel" để có nút nhé.'
                    : undefined;
                return { ...m, isStreaming: false, ...(exportTip ? { exportTip } : {}) };
              });
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
    setUnreadCount(0);
    sessionStorage.removeItem(messagesStorageKey);
    sessionStorage.removeItem(sessionStorageKey);
    toast.info('Đã xoá cuộc trò chuyện.');
  }, [toast, messagesStorageKey, sessionStorageKey]);

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
        <Space size={8} align="center">
          <div
            aria-hidden
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: `linear-gradient(135deg, ${token.colorPrimary} 0%, ${token.colorPrimaryActive} 100%)`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              boxShadow: `0 2px 6px ${token.colorPrimary}33`,
            }}
          >
            <RobotFilled style={{ fontSize: 13 }} />
          </div>
          <span style={{ fontWeight: 600, fontSize: 15 }}>NetConsole Assistant</span>
          <Tag
            color="blue"
            style={{
              fontSize: 10,
              padding: '0 6px',
              lineHeight: '16px',
              borderRadius: 4,
              margin: 0,
              fontWeight: 500,
            }}
          >
            gpt-4.1-mini
          </Tag>
          {sessionId && (
            <Tag
              style={{
                fontSize: 10,
                padding: '0 6px',
                lineHeight: '16px',
                borderRadius: 4,
                margin: 0,
                color: token.colorTextTertiary,
                background: token.colorFillTertiary,
                border: 'none',
              }}
            >
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
          background: token.colorBgContainer,
        },
        header: {
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          padding: '12px 16px',
        },
        footer: { background: token.colorBgContainer },
        content: { background: token.colorBgContainer },
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
              <Button
                type="text"
                icon={<ClearOutlined />}
                disabled={messages.length === 0}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      }
    >
      {/* Global keyframes for streaming cursor + typing dots. Kept
          inside the drawer so they only live while the drawer is
          mounted (avoids any leak into the rest of the app). */}
      <style>
        {`
        @keyframes nc-cursor-blink {
          0%, 50%   { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
        @keyframes nc-typing-bounce {
          0%, 60%, 100% { transform: translateY(0);   opacity: 0.4; }
          30%           { transform: translateY(-4px); opacity: 1;   }
        }
        `}
      </style>

      {/* Messages scroll area. Wrapped in a positioned container so
          we can float a "↓ xuống cuối" button on top without it
          being part of the scroll content (which would shift the
          scrollHeight and the auto-scroll math). */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          minHeight: 0,
        }}
      >
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            position: 'absolute',
            inset: 0,
            overflowY: 'auto',
            padding: '16px 14px 16px 14px',
            background: token.colorBgLayout,
          }}
        >
        {messages.length === 0 ? (
          <EmptyState onPick={(p) => void sendMessage(p)} token={token} />
        ) : (
          // Walk the message list left-to-right and remember the most
          // recent assistant message that produced an exportable tool
          // result. We pass that to the next bubble as `lastExportableToolCall`
          // so the rescue button can recover when the LLM forgets to
          // re-call a data tool on an export request. The carry-over
          // resets naturally when a NEW exportable tool call appears.
          (() => {
            let lastExp: { name: string; preview: unknown } | undefined;
            return messages.map((m) => {
              const ownExp =
                m.toolCalls
                  ?.filter((tc) => tc.result?.ok && detectPreviewArray(tc.result.preview) !== null)
                  .slice(-1)[0] ?? null;
              if (ownExp) {
                lastExp = { name: ownExp.name, preview: ownExp.result!.preview };
              }
              // For the current message, only show the rescue button
              // when it didn't produce its own exportable tool call.
              const showRescue =
                m.role === 'assistant' &&
                m.showExport === true &&
                (!m.toolCalls || m.toolCalls.length === 0) &&
                lastExp !== undefined;
              return (
                <MessageBubble
                  key={m.id}
                  message={m}
                  onConfirm={handleConfirm}
                  onCancel={handleCancel}
                  onPickSuggestion={(s) => void sendMessage(s)}
                  showUsage={isAdmin}
                  lastExportableToolCall={showRescue ? lastExp : undefined}
                />
              );
            });
          })()
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

        {/* Floating "↓ xuống cuối" button. Hidden when the user is
            already at the bottom (no need for a button that scrolls
            to where they already are). The unread badge is a soft
            hint — it doesn't force the user to scroll away from a
            message they're re-reading. Pattern borrowed from
            Messenger / Telegram / Slack: button is only visible when
            the viewport is NOT pinned to the bottom. */}
        {!isAtBottom && messages.length > 0 && (
          <Tooltip
            title={
              unreadCount > 0
                ? `${unreadCount} tin nhắn mới — bấm để xuống cuối`
                : 'Xuống cuối cuộc trò chuyện'
            }
            placement="left"
          >
            <Button
              type="primary"
              shape="circle"
              size="middle"
              icon={<ArrowDownOutlined />}
              onClick={scrollToBottom}
              style={{
                position: 'absolute',
                right: 16,
                bottom: 16,
                zIndex: 5,
                boxShadow: `0 4px 14px ${token.colorPrimary}44, 0 1px 3px rgba(0,0,0,0.18)`,
              }}
              aria-label={
                unreadCount > 0
                  ? `Xuống cuối (${unreadCount} tin nhắn mới)`
                  : 'Xuống cuối cuộc trò chuyện'
              }
            >
              {unreadCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -4,
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    background: token.colorError,
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 5px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    pointerEvents: 'none',
                  }}
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Button>
          </Tooltip>
        )}
      </div>

      {/* Usage footer (admin only) — sits above the composer, not below
          the input, so it doesn't push the composer off-screen on tall
          conversations. */}
      {isAdmin && (totalInputTokens > 0 || totalOutputTokens > 0) && (
        <div
          style={{
            padding: '4px 16px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            fontSize: 11,
            color: token.colorTextTertiary,
            display: 'flex',
            justifyContent: 'space-between',
            background: token.colorBgContainer,
          }}
        >
          <span>
            Tokens: {totalInputTokens} in
            {totalCachedTokens > 0 && (
              <Tooltip title="Tokens served from prompt cache (50% off)">
                <span style={{ color: token.colorSuccess }}> ({totalCachedTokens} cached)</span>
              </Tooltip>
            )}
            {' + '}{totalOutputTokens} out
          </span>
          <Tooltip title="Tổng chi phí ước tính (USD) cho cuộc trò chuyện này">
            <span>≈ ${(totalCostMicrodollars / 1_000_000).toFixed(6)}</span>
          </Tooltip>
        </div>
      )}

      {/* Composer — ChatGPT-style rounded card with textarea + a
          circular send button on the right. The button is hidden
          until the user types something (no dead-button look). */}
      <div
        style={{
          padding: 12,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
            background: token.colorBgLayout,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 16,
            padding: '8px 8px 8px 14px',
            transition: 'border-color 180ms ease, box-shadow 180ms ease',
          }}
          onFocus={(e: React.FocusEvent<HTMLDivElement>) => {
            // Lift the border to primary on focus to give a soft
            // "active" cue. Applied on the wrapper since the actual
            // textarea sits inside.
            e.currentTarget.style.borderColor = token.colorPrimary;
            e.currentTarget.style.boxShadow = `0 0 0 3px ${token.colorPrimaryBg}`;
          }}
          onBlur={(e: React.FocusEvent<HTMLDivElement>) => {
            e.currentTarget.style.borderColor = token.colorBorderSecondary;
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <Input.TextArea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              streaming
                ? 'Đang chờ phản hồi...'
                : 'Hỏi về thiết bị, MAC, DHCP, alert... (Enter để gửi)'
            }
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={streaming}
            variant="borderless"
            style={{
              resize: 'none',
              padding: '4px 0',
              background: 'transparent',
              fontSize: 14,
            }}
          />
          <Button
            type="primary"
            shape="circle"
            icon={streaming ? <LoadingOutlined /> : <ArrowUpOutlined />}
            loading={streaming}
            disabled={!input.trim()}
            onClick={() => void sendMessage(input)}
            size="middle"
            aria-label="Gửi"
          />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 10,
            color: token.colorTextTertiary,
            marginTop: 6,
            padding: '0 4px',
          }}
        >
          <span>
            <Badge status="processing" text="prompt caching" />
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              WRITE actions cần xác nhận trước khi chạy
            </span>
          </span>
        </div>
      </div>
    </Drawer>
  );
}

// ─── persistence helpers ──────────────────────────────────────────────────

function loadSessionId(userId: string | null): string | null {
  try {
    const v = sessionStorage.getItem(sessionKey(userId));
    if (v) return v;
    // One-time migration: if the user has a legacy key, adopt it for
    // the first logged-in user and drop the legacy entry so it never
    // leaks again.
    if (userId && sessionStorage.getItem(LEGACY_SESSION_KEY)) {
      const legacy = sessionStorage.getItem(LEGACY_SESSION_KEY);
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
      if (legacy) {
        sessionStorage.setItem(sessionKey(userId), legacy);
        return legacy;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function loadMessages(userId: string | null): AssistantMessageView[] {
  try {
    const v = sessionStorage.getItem(messagesKey(userId));
    if (v) {
      const parsed = JSON.parse(v) as AssistantMessageView[];
      if (Array.isArray(parsed)) {
        // Strip the streaming flag on rehydrate — the previous stream is dead.
        return parsed.map((m) => ({ ...m, isStreaming: false }));
      }
    }
    // One-time migration from the legacy (shared) key.
    if (userId && sessionStorage.getItem(LEGACY_MESSAGES_KEY)) {
      const legacy = sessionStorage.getItem(LEGACY_MESSAGES_KEY);
      sessionStorage.removeItem(LEGACY_MESSAGES_KEY);
      if (legacy) {
        sessionStorage.setItem(messagesKey(userId), legacy);
        const parsed = JSON.parse(legacy) as AssistantMessageView[];
        if (Array.isArray(parsed)) {
          return parsed.map((m) => ({ ...m, isStreaming: false }));
        }
      }
    }
    return [];
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
  onSuggestions: (suggestions: string[]) => void;
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
    case 'suggestions':
      h.onSuggestions(event.suggestions);
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

// ─── EmptyState: card grid of suggested tasks ──────────────────────────────
//
// Pattern borrowed from Notion AI / Linear AI / Vercel AI Chat — gives
// the user immediate value instead of an empty void. Each card is
// clickable and fires its prompt into the composer.

function EmptyState({
  onPick,
  token,
}: {
  onPick: (prompt: string) => void;
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  return (
    <div
      style={{
        padding: '24px 8px 8px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* Brand mark + welcome line */}
      <div
        aria-hidden
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: `linear-gradient(135deg, ${token.colorPrimary} 0%, ${token.colorPrimaryActive} 100%)`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          boxShadow: `0 6px 16px ${token.colorPrimary}33`,
          marginBottom: 14,
        }}
      >
        <RobotFilled style={{ fontSize: 22 }} />
      </div>
      <Typography.Title
        level={5}
        style={{
          margin: 0,
          fontSize: 18,
          fontWeight: 600,
          color: token.colorText,
        }}
      >
        Tôi có thể giúp gì hôm nay?
      </Typography.Title>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, marginTop: 4, textAlign: 'center', maxWidth: 360 }}
      >
        Tra cứu thiết bị, MAC, DHCP, fabric topology, jobs, alerts. Hoặc click thử một gợi ý bên dưới.
      </Typography.Text>

      {/* 2-column card grid */}
      <div
        style={{
          marginTop: 22,
          width: '100%',
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 10,
        }}
      >
        {SUGGESTED_CARDS.map((card) => (
          <button
            key={card.title}
            type="button"
            onClick={() => onPick(card.prompt)}
            style={{
              cursor: 'pointer',
              textAlign: 'left',
              padding: 12,
              borderRadius: 12,
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorderSecondary}`,
              transition: 'border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease',
              color: token.colorText,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = token.colorPrimary;
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = `0 4px 12px ${token.colorPrimary}22`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = token.colorBorderSecondary;
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: token.colorPrimaryBg,
                color: token.colorPrimary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                marginBottom: 8,
              }}
            >
              {card.icon}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{card.title}</div>
            <div
              style={{
                fontSize: 11.5,
                color: token.colorTextTertiary,
                lineHeight: 1.4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {card.prompt}
            </div>
          </button>
        ))}
      </div>

      <div
        style={{
          marginTop: 18,
          fontSize: 11,
          color: token.colorTextTertiary,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <ThunderboltOutlined />
        <span>Tip: mọi tác vụ trên NetConsole đều có thể thực hiện qua chat.</span>
      </div>
    </div>
  );
}
