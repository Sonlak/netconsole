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
 *   4. Call LLM (non-streaming) with full history + tools.
 *   5. Stream the LLM's text content to the client in small chunks
 *      ("synthetic streaming" — gpt-4.1-mini finishes in 1-3s so
 *      we don't need true delta streaming for v1).
 *   6. If the LLM emitted tool_calls:
 *        - READ tools: execute, append tool result, recurse to step 4
 *        - WRITE tools: emit `confirmation_required`, STOP.
 *   7. When the client confirms a WRITE tool, it sends the same
 *      payload with `confirmedToolCall` set; we execute the tool
 *      and call the LLM once more for the post-action summary.
 */

import { Router, type Request, type Response } from 'express';
import OpenAI from 'openai';
import { authMiddleware } from '../middleware/auth.js';
import { strictRateLimit } from '../middleware/rateLimit.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

import { SYSTEM_PROMPT, OPENAI_TOOLS, getTool } from '../services/assistant/prompts.js';
import { HANDLERS, mapRole } from '../services/assistant/handlers.js';
import { defaultModel, type AssistantModel, type UsageInfo } from '../services/assistant/llmClient.js';
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

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface LlmResponse {
  text: string | null;
  toolCalls: ToolCall[] | null;
  finishReason: string | null;
  usage: UsageInfo | null;
}

const ROLES: Record<AssistantRole, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
  WORKER: 1,
};

const PRICING: Record<AssistantModel, { input: number; cached: number; output: number }> = {
  'gpt-4.1-mini': { input: 0.4, cached: 0.2, output: 1.6 },
  'gpt-4.1': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
};

function roleAllows(actual: AssistantRole, required: AssistantRole): boolean {
  return ROLES[actual] >= ROLES[required];
}

function costFromUsage(model: AssistantModel, inTokens: number, cached: number, outTokens: number) {
  const rate = PRICING[model] ?? PRICING['gpt-4.1-mini'];
  const costUsd =
    (Math.max(0, inTokens - cached) / 1_000_000) * rate.input +
    (cached / 1_000_000) * rate.cached +
    (outTokens / 1_000_000) * rate.output;
  return Math.round(costUsd * 1_000_000);
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

    try {
      if (body.confirmedToolCall) {
        await runConfirmation(body, ctx, model, res);
      } else {
        await runTurn(body.messages, ctx, model, res);
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
  //
  // The body.messages we receive includes the prior assistant
  // message that emitted the tool_calls (the one we paused on for
  // confirmation), but does NOT include a corresponding `tool`
  // message — by design, because at the time we sent the
  // confirmation_required event we hadn't run the tool yet.
  //
  // OpenAI's API is strict here: an assistant message with
  // tool_calls MUST be followed by `tool` messages for every
  // tool_call_id, with nothing in between. If we just append our
  // "[Confirmed] ..." user message after the original assistant
  // message, the LLM rejects the request with
  //   "An assistant message with 'tool_calls' must be followed
  //    by tool messages responding to each 'tool_call_id'."
  //
  // injectToolResult finds the assistant message that contains our
  // toolCallId and inserts the tool response right after it (and
  // any other tool responses already there from READ tools that
  // ran inline before the confirmation pause).
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

  await callAndStream(followUp, ctx, model, res, 'confirmation');
}

/**
 * Insert a `tool` role message into a conversation so that OpenAI's
 * strict "tool message must follow assistant(tool_calls)" invariant
 * holds. Returns a new array; the input is not mutated.
 *
 * Strategy: walk the messages, and after each assistant message
 * that contains a tool_call matching our `toolCallId`, append all
 * the immediately-following tool messages that are already in the
 * input (these belong to READ tools that ran inline before the
 * confirmation pause — e.g. the LLM called `get_device` to verify
 * existence, then `queue_interface_action` which we paused on).
 * Then append our new tool result.
 *
 * If the toolCallId is not found in any assistant message (defensive
 * — shouldn't happen in normal flow), the result is appended at the
 * end with a synthetic preceding assistant(tool_calls) message.
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
      // Carry forward any tool messages already in the input that
      // follow this assistant message (READ tool results from
      // before the confirmation pause). Skip if the input already
      // has a result for our id (defensive — shouldn't happen for
      // WRITE tools, since runConfirmation is the only caller).
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
    // Defensive: the toolCallId wasn't found in any assistant
    // message. Synthesize the smallest valid sequence so the LLM
    // call doesn't 400. The LLM will likely reply with something
    // generic, which is the right fallback.
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
  res: Response,
) {
  await callAndStream(messages, ctx, model, res, 'turn');
}

/**
 * Single LLM call + recursive tool execution. Streams text to the
 * client chunk-by-chunk (synthetic streaming) and processes
 * tool_calls inline.
 *
 * When a WRITE tool is requested, stops with a `confirmation_required`
 * event. When a READ tool is requested, executes it, appends the
 * result, and recurses once (so the LLM can produce a final answer
 * with the data in hand).
 */
async function callAndStream(
  messages: AssistantMessage[],
  ctx: ToolContext,
  model: AssistantModel,
  res: Response,
  reason: 'turn' | 'continuation' | 'confirmation',
) {
  const response = await callLlm({ model, messages });
  if (response.usage) {
    await recordUsage(ctx, response.usage, reason);
    sseSend(res, {
      type: 'usage',
      inputTokens: response.usage.inputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      outputTokens: response.usage.outputTokens,
      costMicrodollars: response.usage.costMicrodollars,
    });
  }

  // Stream text in synthetic chunks. Without true token streaming
  // we have to wait for the full LLM response, but chunking the
  // text into ~30-char slices still gives the "typing" feel.
  if (response.text) {
    await streamTextInChunks(res, response.text);
  }

  // Persist the assistant turn.
  await appendMessage(ctx.sessionId, 'assistant', {
    content: response.text,
    ...(response.toolCalls && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    metadata: { model, finishReason: response.finishReason },
  });

  if (!response.toolCalls || response.toolCalls.length === 0) {
    return;
  }

  // Process tool calls. WRITE tools stop the loop (and the rest
  // are abandoned); READ tools execute inline and we recurse once
  // for the LLM's final answer with the data in context.
  //
  // Multi-tool fan-out: if the LLM emits multiple tool_calls in
  // one turn (e.g. get_device + get_device_interfaces), we execute
  // them all and append a tool message for each. We do NOT
  // interleave recurses — that would break the OpenAI "tool message
  // must immediately follow assistant(tool_calls)" invariant.
  const toolResults: AssistantMessage[] = [];
  for (const tc of response.toolCalls) {
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

    const tool = getTool(name);
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
    // LLM call. We do NOT recurse here — collect all results first,
    // then recurse once at the end of the loop.
    const handler = HANDLERS[name];
    const result = await handler(args, ctx);
    sseSend(res, {
      type: 'tool_result',
      id: tc.id,
      name,
      ok: result.ok,
      preview: result.preview,
      ...(result.error ? { error: result.error } : {}),
    });
    toolResults.push({
      role: 'tool' as const,
      tool_call_id: tc.id,
      content: JSON.stringify(result.preview ?? {}),
    });
    await appendMessage(ctx.sessionId, 'tool', {
      content: JSON.stringify(result.preview ?? {}),
      toolCallId: tc.id,
      toolName: name,
      metadata: { ok: result.ok, error: result.error ?? null },
    });
  }

  if (toolResults.length > 0) {
    const nextMessages: AssistantMessage[] = [
      ...messages,
      // Always include the assistant turn so every tool message below
      // has a valid preceding message with `tool_calls`. The OpenAI
      // API requires this — emitting a `tool` role message without a
      // matching `assistant` `tool_calls` returns 400. The assistant
      // content can be null when the LLM only emitted tool calls.
      {
        role: 'assistant' as const,
        content: response.text,
        tool_calls: response.toolCalls ?? undefined,
      },
      ...toolResults,
    ];
    await callAndStream(nextMessages, ctx, model, res, 'continuation');
  }
}

// ─── LLM call (non-streaming) ─────────────────────────────────────────────────

async function callLlm(params: { model: AssistantModel; messages: AssistantMessage[] }): Promise<LlmResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set. Add it to backend/.env and restart.');
  }
  const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
  const startedAt = Date.now();

  const res = await client.chat.completions.create({
    model: params.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(params.messages as never[]),
    ],
    tools: OPENAI_TOOLS as never[],
    max_tokens: 1024,
    temperature: 0.2,
  });

  const choice = res.choices?.[0];
  const tcs = (choice?.message?.tool_calls ?? null) as ToolCall[] | null;
  const text = choice?.message?.content ?? null;

  let usage: UsageInfo | null = null;
  if (res.usage) {
    const inTokens = res.usage.prompt_tokens ?? 0;
    const cached = res.usage.prompt_tokens_details?.cached_tokens ?? 0;
    const outTokens = res.usage.completion_tokens ?? 0;
    usage = {
      inputTokens: inTokens,
      cachedInputTokens: cached,
      outputTokens: outTokens,
      totalTokens: res.usage.total_tokens ?? inTokens + outTokens,
      costMicrodollars: costFromUsage(params.model, inTokens, cached, outTokens),
      model: params.model,
      latencyMs: Date.now() - startedAt,
    };
  }

  return { text, toolCalls: tcs, finishReason: choice?.finish_reason ?? null, usage };
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

/**
 * Synthetic text streaming — break the LLM's full text response
 * into ~30 char chunks and write them with a small delay so the
 * UI gets a "typing" feel. No real LLM streaming tokens needed
 * for v1 (gpt-4.1-mini is fast enough that the 1-3s wait is
 * acceptable).
 */
async function streamTextInChunks(res: Response, text: string) {
  const CHUNK = 30;
  const DELAY_MS = 25;
  for (let i = 0; i < text.length; i += CHUNK) {
    const piece = text.slice(i, i + CHUNK);
    sseSend(res, { type: 'text', content: piece });
    await sleep(DELAY_MS);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
