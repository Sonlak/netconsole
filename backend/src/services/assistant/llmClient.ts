/**
 * Thin wrapper over the OpenAI SDK.
 *
 * Responsibilities:
 *  - Lazy-construct a single OpenAI client per process (the SDK uses
 *    a global `fetch`, so a single instance is enough).
 *  - Compute cost from `usage` (input / cached / output tokens).
 *  - Stream a chat completion via async iteration and yield parsed
 *    events (text deltas + final tool_calls + usage).
 *
 * Pricing is hard-coded here (micro-dollars per 1M tokens). Update
 * when OpenAI changes their rate card — the only source of truth.
 *
 * Why not use the SDK's helpers? We want strict control over the
 * cache key (system prompt + tool definitions, in that order, on
 * every request). The SDK does this automatically as long as the
 * request shape is stable, but we also surface the `prompt_tokens_details.cached_tokens`
 * field so the cost calculation is exact, not estimated.
 *
 * Streaming strategy (2026-10-10 rewrite):
 *  - One generator per LLM call: yields `text` events as soon as
 *    tokens arrive (true SSE), then a single `final` event with
 *    accumulated tool_calls + usage when the stream ends.
 *  - OpenAI streams tool_calls incrementally across multiple chunks
 *    (delta may contain only an `id`, only a name, only args
 *    characters). We accumulate per-index into a buffer and assemble
 *    on the final chunk.
 *  - Cancellation: pass an `AbortSignal` via `params.signal` to abort
 *    mid-flight (e.g. when the frontend closes the drawer).
 */

import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to backend/.env or docker-compose.app.yml and restart the backend container.',
    );
  }
  _client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
  return _client;
}

// ── Pricing (micro-USD per 1M tokens) ─────────────────────────────────────────
// Source: openai.com/api/pricing (verified 2026-10-09).
// gpt-4.1-mini: $0.40 in, $0.20 cached, $1.60 out
const PRICING = {
  'gpt-4.1-mini': {
    input: 0.40,
    cached: 0.20,
    output: 1.6,
  },
  'gpt-4.1': {
    input: 2.5,
    cached: 1.25,
    output: 10,
  },
  'gpt-4o-mini': {
    input: 0.15,
    cached: 0.075,
    output: 0.6,
  },
} as const;

export type AssistantModel = keyof typeof PRICING;

export function defaultModel(): AssistantModel {
  const env = (process.env.OPENAI_MODEL ?? 'gpt-4.1-mini').trim();
  if (env in PRICING) return env as AssistantModel;
  console.warn(`[assistant] Unknown OPENAI_MODEL=${env}, falling back to gpt-4.1-mini`);
  return 'gpt-4.1-mini';
}

export type UsageInfo = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicrodollars: number;
  model: AssistantModel;
  latencyMs: number;
};

export type ChatParams = {
  model: AssistantModel;
  // The system message + tools come first so they form the stable
  // cache prefix. Order matters: don't shuffle these.
  systemMessage: string;
  tools: unknown[]; // ChatCompletionTool[] — typed loosely to keep this file standalone
  messages: unknown[]; // ChatCompletionMessageParam[]
  maxOutputTokens?: number;
  temperature?: number;
  /** Optional AbortSignal — abort the LLM stream mid-flight. */
  signal?: AbortSignal;
};

/** Single assembled tool call after stream completion. */
export type AssembledToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/**
 * Streamed events emitted by `streamChat`:
 *  - `text`: one chunk of assistant text. Sent as tokens arrive from
 *    OpenAI (real SSE, no buffering). Caller forwards each delta
 *    directly to the client.
 *  - `final`: emitted exactly once at the end of the stream. Carries
 *    the assembled tool_calls (if any), the finish_reason from
 *    OpenAI, and the usage record (input/cached/output tokens +
 *    cost). Caller is responsible for processing tool_calls.
 */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'final';
      toolCalls: AssembledToolCall[] | null;
      finishReason: string | null;
      usage: UsageInfo | null;
    };

function computeUsage(
  raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } },
  model: AssistantModel,
  startedAt: number,
): UsageInfo {
  const cached = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const inTokens = raw.prompt_tokens ?? 0;
  const outTokens = raw.completion_tokens ?? 0;
  const pricing = PRICING[model];
  const costUsd =
    (Math.max(0, inTokens - cached) / 1_000_000) * pricing.input +
    (cached / 1_000_000) * pricing.cached +
    (outTokens / 1_000_000) * pricing.output;
  return {
    inputTokens: inTokens,
    cachedInputTokens: cached,
    outputTokens: outTokens,
    totalTokens: raw.total_tokens ?? inTokens + outTokens,
    costMicrodollars: Math.round(costUsd * 1_000_000),
    model,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Stream a chat completion with tool support. Yields text deltas as
 * they arrive and a single final event with the assembled
 * tool_calls + usage.
 *
 * Why one final event for tool_calls: OpenAI streams tool_calls
 * incrementally across many chunks (e.g. first chunk: `id`, second
 * chunk: `name`, third chunk: a few characters of `arguments`).
 * The caller needs the fully assembled tool_call to invoke a tool
 * handler, not a sequence of incomplete fragments. We accumulate
 * per-index internally and surface the finished list only once.
 */
export async function* streamChat(
  params: ChatParams,
): AsyncGenerator<ChatStreamEvent> {
  const client = getClient();
  const startedAt = Date.now();

  const stream = (await client.chat.completions.create({
    model: params.model,
    messages: [
      { role: 'system', content: params.systemMessage },
      ...(params.messages as never[]),
    ],
    tools: params.tools as never[],
    max_tokens: params.maxOutputTokens ?? 1024,
    temperature: params.temperature ?? 0.2,
    stream: true,
    stream_options: { include_usage: true },
  } as never, { signal: params.signal } as never)) as unknown as Stream<ChatCompletionChunk>;

  // Accumulator for streamed tool_calls. OpenAI numbers tool_calls
  // by `index` in the delta; we keep a Map<index, partial> and emit
  // the assembled list only on the chunk where `finish_reason` is set.
  const toolCallBuffers = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  let finishReason: string | null = null;
  let usage: UsageInfo | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];

    // Text delta — forward immediately for true token-level SSE.
    const textDelta = choice?.delta?.content ?? '';
    if (textDelta) {
      yield { type: 'text', delta: textDelta };
    }

    // Tool call deltas — accumulate, do NOT yield yet.
    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index;
        let buf = toolCallBuffers.get(idx);
        if (!buf) {
          buf = { id: '', name: '', args: '' };
          toolCallBuffers.set(idx, buf);
        }
        // First chunk for this index usually carries `id` + start of `name`.
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name = tc.function.name;
        // Subsequent chunks carry `arguments` characters incrementally.
        if (tc.function?.arguments) buf.args += tc.function.arguments;
      }
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }

    // OpenAI emits a usage-only chunk AFTER the finish_reason chunk
    // when stream_options.include_usage=true. Capture it.
    if (chunk.usage) {
      usage = computeUsage(chunk.usage, params.model, startedAt);
    }
  }

  // Assemble tool_calls now that the stream is done.
  let toolCalls: AssembledToolCall[] | null = null;
  if (toolCallBuffers.size > 0) {
    toolCalls = Array.from(toolCallBuffers.entries())
      .sort(([a], [b]) => a - b)
      .map(([, buf]) => ({
        id: buf.id,
        type: 'function' as const,
        function: { name: buf.name, arguments: buf.args },
      }));
  }

  yield { type: 'final', toolCalls, finishReason, usage };
}

/** Test helper — allows tests to inject a fake client. */
export function _setClientForTest(client: OpenAI | null) {
  _client = client;
}