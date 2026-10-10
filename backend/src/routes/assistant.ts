/**
 * AI Assistant HTTP routes.
 *
 * Single endpoint: POST /api/assistant. The frontend owns the
 * conversation state; every request re-sends the full message
 * history. The backend is stateless (besides the audit + usage
 * tables) so the architecture stays simple.
 *
 * Streaming: Server-Sent Events. Each event is a JSON object that
 * the frontend maps to a UI update. The events are documented in
 * `types.ts::AssistantStreamEvent`.
 *
 * Authentication: standard JWT (authMiddleware on the route). RBAC
 * is enforced per-tool — VIEWER can only call READ tools, WRITE
 * tools return 403.
 *
 * Flow:
 *
 *   1. Validate request body.
 *   2. Load or create the session (audit scope).
 *   3. Persist the latest user message.
 *   4. Stream the LLM call (true SSE — text events arrive as tokens
 *      are generated; final event carries tool_calls + usage).
 *   5. If the LLM emitted tool_calls:
 *        - READ tools: execute, append tool result, recurse to step 4
 *        - WRITE tools: emit `confirmation_required`, STOP.
 *   6. When the client confirms a WRITE tool, it sends the same
 *      payload with `confirmedToolCall` set; we execute the tool
 *      and stream the post-action summary back.
 *
 * 2026-10-10 rewrite: replaced non-streaming `chat.completions.create`
 * + 30-char synthetic chunking with true token-level streaming via
 * `streamChat`. User now sees text appearing character-by-character
 * within ~200ms of the LLM starting to generate, instead of waiting
 * 1-3s for the full response before any text renders.
 */

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { strictRateLimit } from '../middleware/rateLimit.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

import { SYSTEM_PROMPT, OPENAI_TOOLS, getTool, TOOL_CATALOG } from '../services/assistant/prompts.js';
import { HANDLERS, mapRole } from '../services/assistant/handlers.js';
import { defaultModel, streamChat, type AssistantModel, type UsageInfo } from '../services/assistant/llmClient.js';
import type { AssembledToolCall } from '../services/assistant/llmClient.js';
import {
  appendMessage,
  createSession,
  loadSession,
  recordUsage,
} from '../services/assistant/persistence.js';
import type {
  AssistantMessage,
  AssistantRequest,
  AssistantRole,
  AssistantStreamEvent,
  AssistantToolMessage,
  AssistantToolName,
  ToolContext,
} from '../services/assistant/types.js';

export const assistantRouter = Router();

const assistantRateLimit = strictRateLimit;

interface LlmTurnResult {
  text: string;
  toolCalls: AssembledToolCall[] | null;
  finishReason: string | null;
  usage: UsageInfo | null;
}

const ROLES: Record<AssistantRole, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
  WORKER: 1,
};

function roleAllows(actual: AssistantRole, required: AssistantRole): boolean {
  return ROLES[actual] >= ROLES[required];
}

/**
 * POST /api/assistant
 *
 * Body: AssistantRequest — see types.ts.
 *
 * SSE stream. First event is always `{type:'session', ...}`. Last
 * is `{type:'done'}`.
 */
assistantRouter.post(
  '/',
  assistantRateLimit,
  authMiddleware,
  async (req: Request, res: Response) => {
    const authed = req as AuthenticatedRequest;
    const userId = (authed.user?.userId as string | undefined) ?? null;
    const username = (authed.user?.username as string | undefined) ?? null;
    const role = mapRole(authed.user?.role as string | undefined);

    const body = parseRequest(req.body);
    if (!body) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    const model = defaultModel();
    let sessionId = body.sessionId;
    if (sessionId) {
      const existing = await loadSession(sessionId, userId);
      if (!existing) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      sessionId = existing.id;
    } else {
      const created = await createSession(userId, username, model, body.userMessage);
      sessionId = created.id;
    }

    // Persist the latest user message before doing any LLM work.
    await appendMessage(sessionId, 'user', {
      content: body.userMessage,
      metadata: { username, role },
    });

    sseOpen(res);
    sseSend(res, { type: 'session', sessionId, model });

    const ctx: ToolContext = { userId, username, role, sessionId };

    // Honour client disconnect — abort the LLM stream when the
    // drawer closes. Saves $ + lets the user cancel a long-running
    // reasoning loop.
    const ac = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      if (body.confirmedToolCall) {
        await runConfirmation(body, ctx, model, ac.signal, res);
      } else {
        await runTurn(body.messages, ctx, model, ac.signal, res);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      console.error('[assistant] error:', error);
      sseSend(res, { type: 'error', message });
    } finally {
      sseSend(res, { type: 'done' });
      res.end();
    }
  },
);

// ─── Confirmation continuation ────────────────────────────────────────────────

async function runConfirmation(
  body: AssistantRequest,
  ctx: ToolContext,
  model: AssistantModel,
  signal: AbortSignal,
  res: Response,
) {
  if (!body.confirmedToolCall) return;
  const { id, name, arguments: args } = body.confirmedToolCall;

  const tool = getTool(name);
  if (!roleAllows(ctx.role, tool.requiresRole)) {
    sseSend(res, { type: 'error', message: `Role ${ctx.role} cannot run tool ${name}` });
    return;
  }

  sseSend(res, { type: 'tool_call', id, name, arguments: args });

  const handler = HANDLERS[name];
  const result = await handler(args, ctx);
  sseSend(res, {
    type: 'tool_result',
    id,
    name,
    ok: result.ok,
    preview: result.preview,
    ...(result.error ? { error: result.error } : {}),
  });

  await appendMessage(ctx.sessionId, 'tool', {
    content: JSON.stringify(result.preview ?? {}),
    toolCallId: id,
    toolName: name,
    metadata: { ok: result.ok, error: result.error ?? null },
  });

  // Feed the confirmed action + result back to the LLM so it can
  // produce a natural follow-up message.
  const messagesWithToolResult = injectToolResult(
    body.messages,
    id,
    name,
    JSON.stringify(result.preview ?? {}),
  );

  const followUp: AssistantMessage[] = [
    ...messagesWithToolResult,
    {
      role: 'user',
      content:
        `[Confirmed] Tôi đã xác nhận chạy ${name} với args: ${JSON.stringify(args)}. ` +
        `Kết quả: ${JSON.stringify(result.preview)}. Tóm tắt cho tôi.`,
    },
  ];

  await streamTurn(followUp, ctx, model, signal, res, 'confirmation');
}

/**
 * Insert a `tool` role message into a conversation so that OpenAI's
 * strict "tool message must follow assistant(tool_calls)" invariant
 * holds. Returns a new array; the input is not mutated.
 */
function injectToolResult(
  messages: AssistantMessage[],
  toolCallId: string,
  toolName: string,
  resultContent: string,
): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let injected = false;
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];
    out.push(m);
    i++;

    if (
      !injected &&
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.id === toolCallId)
    ) {
      while (i < messages.length && messages[i].role === 'tool') {
        const tm = messages[i] as AssistantToolMessage;
        if (tm.tool_call_id === toolCallId) {
          injected = true;
          break;
        }
        out.push(messages[i]);
        i++;
      }
      if (!injected) {
        out.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: resultContent,
        });
        injected = true;
      }
    }
  }

  if (!injected) {
    out.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: '{}' },
        },
      ],
    });
    out.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: resultContent,
    });
  }

  return out;
}

// ─── Main turn ────────────────────────────────────────────────────────────────

async function runTurn(
  messages: AssistantMessage[],
  ctx: ToolContext,
  model: AssistantModel,
  signal: AbortSignal,
  res: Response,
) {
  await streamTurn(messages, ctx, model, signal, res, 'turn');
}

/**
 * Stream one LLM turn + tool execution loop.
 *
 * Each LLM call yields text deltas in real time (true SSE). When the
 * stream finishes, we either:
 *  - Persist the assistant turn + return (no tool_calls).
 *  - Process each tool_call. WRITE tools pause with confirmation_required.
 *  - READ tools execute inline, append tool results, recurse once
 *    so the LLM can produce a final answer with the data in hand.
 *
 * Multi-tool fan-out: if the LLM emits multiple tool_calls in one
 * turn (e.g. get_device + get_device_interfaces), we execute them
 * all and append a tool message for each before recursing.
 */
async function streamTurn(
  messages: AssistantMessage[],
  ctx: ToolContext,
  model: AssistantModel,
  signal: AbortSignal,
  res: Response,
  reason: 'turn' | 'continuation' | 'confirmation',
): Promise<void> {
  const result = await streamOneLlmTurn(messages, ctx, model, signal, res, reason);

  if (!result.toolCalls || result.toolCalls.length === 0) {
    return;
  }

  // Process tool calls. WRITE tools stop the loop; READ tools
  // execute inline and we recurse once.
  const toolResults: AssistantMessage[] = [];
  for (const tc of result.toolCalls) {
    const name = tc.function.name as AssistantToolName;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      sseSend(res, {
        type: 'tool_result',
        id: tc.id,
        name,
        ok: false,
        preview: {},
        error: 'Invalid JSON in tool arguments',
      });
      toolResults.push({
        role: 'tool' as const,
        tool_call_id: tc.id,
        content: JSON.stringify({ error: 'invalid_json' }),
      });
      await appendMessage(ctx.sessionId, 'tool', {
        content: JSON.stringify({ error: 'invalid_json' }),
        toolCallId: tc.id,
        toolName: name,
        metadata: { ok: false, error: 'invalid_json' },
      });
      continue;
    }

    sseSend(res, { type: 'tool_call', id: tc.id, name, arguments: args });

    // Self-recovery: when the LLM hallucinates a tool name (e.g.
    // `get_device_info` instead of `get_device`, or `dhcp_leases`
    // instead of `list_dhcp_leases`), don't crash — return a tool
    // result that includes a list of similar valid names so the
    // LLM can retry. Pattern parallels `get_statistics.availableStats`
    // (added 2026-09-21; reduced gpt-4.1-mini "system has no X"
    // deflection by ~80% in production per the assistant stat log).
    const tool = lookupToolOrSuggestion(name);
    if (!tool) {
      const suggestions = suggestToolNames(name);
      const errorMsg = suggestions.length > 0
        ? `Tool "${name}" không tồn tại. Có thể bạn muốn: ${suggestions.slice(0, 5).join(', ')}. Hãy gọi lại với tên chính xác.`
        : `Tool "${name}" không tồn tại. Gọi describe_capabilities() để xem TẤT CẢ tool có sẵn.`;
      sseSend(res, {
        type: 'tool_result',
        id: tc.id,
        name,
        ok: false,
        preview: { availableTools: TOOL_CATALOG.map((t) => 'function' in t ? t.function.name : '').filter(Boolean) },
        error: errorMsg,
      });
      toolResults.push({
        role: 'tool' as const,
        tool_call_id: tc.id,
        content: JSON.stringify({
          error: 'tool_not_found',
          suggestion: errorMsg,
          availableTools: TOOL_CATALOG.map((t) => 'function' in t ? t.function.name : '').filter(Boolean),
        }),
      });
      await appendMessage(ctx.sessionId, 'tool', {
        content: JSON.stringify({ error: 'tool_not_found' }),
        toolCallId: tc.id,
        toolName: name,
        metadata: { ok: false, error: 'tool_not_found' },
      });
      continue;
    }

    if (!roleAllows(ctx.role, tool.requiresRole)) {
      sseSend(res, {
        type: 'tool_result',
        id: tc.id,
        name,
        ok: false,
        preview: {},
        error: `Role ${ctx.role} cannot run tool ${name} (requires ${tool.requiresRole})`,
      });
      toolResults.push({
        role: 'tool' as const,
        tool_call_id: tc.id,
        content: JSON.stringify({ error: 'permission_denied' }),
      });
      await appendMessage(ctx.sessionId, 'tool', {
        content: JSON.stringify({ error: 'permission_denied' }),
        toolCallId: tc.id,
        toolName: name,
        metadata: { ok: false, error: 'role_too_low' },
      });
      continue;
    }

    if (!tool.readonly) {
      // WRITE: emit confirmation and STOP. We deliberately do not
      // execute any subsequent tools in the batch (a confirmation
      // card is a hard pause — the user must accept before more
      // changes run).
      sseSend(res, {
        type: 'confirmation_required',
        id: tc.id,
        name,
        arguments: args,
        summary: tool.confirmSummary(args),
      });
      return;
    }

    // READ: execute, persist, queue the tool result for the next
    // LLM call.
    const handler = HANDLERS[name];
    const handlerResult = await handler(args, ctx);

    // UI affordance — `suggest_followup` is a read-only tool but its
    // result is intended for the frontend, not the LLM. Emit a
    // dedicated `suggestions` SSE event so the drawer renders chips.
    if (name === 'suggest_followup' && handlerResult.ok && handlerResult.preview) {
      const list = (handlerResult.preview as { suggestions?: unknown }).suggestions;
      if (Array.isArray(list) && list.length > 0) {
        sseSend(res, {
          type: 'suggestions',
          suggestions: list.filter((s): s is string => typeof s === 'string').slice(0, 3),
        });
      }
    }

    sseSend(res, {
      type: 'tool_result',
      id: tc.id,
      name,
      ok: handlerResult.ok,
      preview: handlerResult.preview,
      ...(handlerResult.error ? { error: handlerResult.error } : {}),
    });
    toolResults.push({
      role: 'tool' as const,
      tool_call_id: tc.id,
      content: JSON.stringify(handlerResult.preview ?? {}),
    });
    await appendMessage(ctx.sessionId, 'tool', {
      content: JSON.stringify(handlerResult.preview ?? {}),
      toolCallId: tc.id,
      toolName: name,
      metadata: { ok: handlerResult.ok, error: handlerResult.error ?? null },
    });
  }

  if (toolResults.length > 0) {
    const nextMessages: AssistantMessage[] = [
      ...messages,
      {
        role: 'assistant' as const,
        content: result.text,
        tool_calls: result.toolCalls ?? undefined,
      },
      ...toolResults,
    ];
    await streamTurn(nextMessages, ctx, model, signal, res, 'continuation');
  }
}

/**
 * Single LLM streaming call. Returns the assembled result so the
 * caller can decide what to do next (process tool_calls or stop).
 *
 * Side effects:
 *  - Emits `text` SSE events for every token chunk OpenAI produces.
 *  - Emits `usage` SSE event with cost info.
 *  - Persists the assistant turn (text + tool_calls + finish reason)
 *    to the AssistantMessage table.
 */
async function streamOneLlmTurn(
  messages: AssistantMessage[],
  ctx: ToolContext,
  model: AssistantModel,
  signal: AbortSignal,
  res: Response,
  reason: 'turn' | 'continuation' | 'confirmation',
): Promise<LlmTurnResult> {
  // Sanitize the client-supplied history (handles abandoned WRITE
  // tool_calls gracefully — see sanitizeForOpenAI below).
  const safeMessages = sanitizeForOpenAI(messages);

  let accumulatedText = '';
  let toolCalls: AssembledToolCall[] | null = null;
  let finishReason: string | null = null;
  let usage: UsageInfo | null = null;

  for await (const event of streamChat({
    model,
    systemMessage: SYSTEM_PROMPT,
    tools: OPENAI_TOOLS,
    messages: safeMessages,
    signal,
  })) {
    if (event.type === 'text') {
      accumulatedText += event.delta;
      sseSend(res, { type: 'text', content: event.delta });
    } else {
      // 'final'
      toolCalls = event.toolCalls;
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }

  if (usage) {
    await recordUsage(ctx, usage, reason);
    sseSend(res, {
      type: 'usage',
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      costMicrodollars: usage.costMicrodollars,
    });
  }

  // Persist the assistant turn.
  await appendMessage(ctx.sessionId, 'assistant', {
    content: accumulatedText || null,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    metadata: { model, finishReason },
  });

  return {
    text: accumulatedText,
    toolCalls,
    finishReason,
    usage,
  };
}

/**
 * Sanitize a message array for OpenAI's strict tool_calls invariant:
 *
 *   "An assistant message with 'tool_calls' must be followed by tool
 *    messages responding to each 'tool_call_id' before the next
 *    non-tool message."
 *
 * Why we need this:
 *
 *   The frontend flattens the view state into the wire by appending
 *   a `tool` role row for each assistant tool_call that has a
 *   `result` defined. A tool_call without a `result` is one that
 *   never ran — typically a WRITE action paused for confirmation
 *   that the user abandoned (typed a new question instead of
 *   clicking Confirm).
 *
 *   If the LLM emitted N tool_calls in one turn and only M < N
 *   were executed (because one of them was a WRITE that paused),
 *   the resulting wire is:
 *
 *     [..., assistant(tool_calls=[A, B, C]), tool(A), tool(C), user_q2, ...]
 *
 *   OpenAI's API rejects this with 400. Fix: strip unfulfilled ids
 *   from the assistant's tool_calls. If that leaves zero tool_calls,
 *   drop the field entirely so the LLM sees a normal text-only
 *   assistant turn.
 */
function sanitizeForOpenAI(messages: AssistantMessage[]): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const expectedIds = new Set(m.tool_calls.map((tc) => tc.id));
      const providedIds = new Set<string>();
      let j = i + 1;
      while (j < messages.length && (messages[j] as { role?: string }).role === 'tool') {
        providedIds.add((messages[j] as AssistantToolMessage).tool_call_id);
        j++;
      }
      const missing = [...expectedIds].filter((id) => !providedIds.has(id));
      if (missing.length > 0) {
        if (missing.length === expectedIds.size) {
          out.push({ ...m, tool_calls: undefined });
        } else {
          const fulfilled = m.tool_calls.filter((tc) => !missing.includes(tc.id));
          out.push({ ...m, tool_calls: fulfilled });
        }
      } else {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseRequest(body: unknown): AssistantRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.userMessage !== 'string' || !b.userMessage.trim()) return null;
  if (!Array.isArray(b.messages)) return null;
  if (typeof b.sessionId !== 'undefined' && typeof b.sessionId !== 'string') return null;

  let confirmedToolCall: AssistantRequest['confirmedToolCall'];
  if (b.confirmedToolCall && typeof b.confirmedToolCall === 'object') {
    const ct = b.confirmedToolCall as Record<string, unknown>;
    if (typeof ct.id === 'string' && typeof ct.name === 'string') {
      let parsed: Record<string, unknown> = {};
      if (typeof ct.arguments === 'string') {
        try {
          parsed = JSON.parse(ct.arguments);
        } catch {
          return null;
        }
      } else if (ct.arguments && typeof ct.arguments === 'object') {
        parsed = ct.arguments as Record<string, unknown>;
      }
      confirmedToolCall = {
        id: ct.id,
        name: ct.name as AssistantToolName,
        arguments: parsed,
      };
    }
  }

  return {
    userMessage: b.userMessage,
    messages: b.messages as AssistantMessage[],
    sessionId: typeof b.sessionId === 'string' ? b.sessionId : undefined,
    ...(confirmedToolCall ? { confirmedToolCall } : {}),
  };
}

function sseOpen(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function sseSend(res: Response, event: AssistantStreamEvent) {
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ─── Tool name fuzzy-match helpers ────────────────────────────────────────────

/**
 * Look up a tool by exact name. Returns null instead of throwing so
 * the caller can emit a self-recovery tool_result (see streamTurn).
 */
function lookupToolOrSuggestion(name: string): ReturnType<typeof getTool> | null {
  try {
    return getTool(name);
  } catch {
    return null;
  }
}

/**
 * Suggest up to 5 similar tool names for a hallucinated name.
 * Strategy (cheaper than Levenshtein, good enough for tool names):
 *  1. Substring match (case-insensitive) — catches `device_info` → `get_device`
 *  2. Token overlap (split by `_`) — catches `get device` → `get_device`
 *  3. Prefix match — catches `create_use` → `create_user`
 *
 * Returns names sorted by descending similarity score. Empty list =
 * no reasonable match (caller should suggest describe_capabilities).
 */
function suggestToolNames(typo: string): string[] {
  const allNames = TOOL_CATALOG
    .map((t) => ('function' in t ? t.function.name : ''))
    .filter(Boolean);
  const lowerTypo = typo.toLowerCase();
  const typoTokens = new Set(lowerTypo.split(/[_\- ]+/).filter(Boolean));

  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of allNames) {
    const lower = candidate.toLowerCase();

    // 1. Substring match
    let score = 0;
    if (lower.includes(lowerTypo) || lowerTypo.includes(lower)) {
      score = Math.max(score, 10);
    }

    // 2. Token overlap (Jaccard-ish, weight by coverage of typo)
    if (typoTokens.size > 0) {
      const candTokens = new Set(lower.split(/[_\- ]+/).filter(Boolean));
      let overlap = 0;
      for (const t of typoTokens) {
        if (candTokens.has(t)) overlap++;
      }
      const coverage = overlap / typoTokens.size;
      if (coverage > 0) score = Math.max(score, coverage * 5);
    }

    // 3. Prefix match (first 3 chars)
    if (lower.slice(0, 3) === lowerTypo.slice(0, 3) && lower.length > 3) {
      score = Math.max(score, 2);
    }

    if (score > 0) {
      scored.push({ name: candidate, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.name);
}