/**
 * Thin wrapper over the OpenAI SDK.
 *
 * Responsibilities:
 *  - Lazy-construct a single OpenAI client per process (the SDK uses
 *    a global `fetch`, so a single instance is enough).
 *  - Compute cost from `usage` (input / cached / output tokens).
 *  - Stream a chat completion via async iteration and yield parsed
 *    SSE-friendly events.
 *
 * Pricing is hard-coded here (micro-dollars per 1M tokens). Update
 * when OpenAI changes their rate card — the only source of truth.
 *
 * Why not use the SDK's helpers? We want strict control over the
 * cache key (system prompt + tool definitions, in that order, on
 * every request). The SDK does this automatically as long as the
 * request shape is stable, but we also surface the `prompt_tokens_details.cached_tokens`
 * field so the cost calculation is exact, not estimated.
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
};

/**
 * Stream a chat completion. Yields each chunk's delta so the route
 * layer can serialise to SSE. The final usage is computed from the
 * chunk's `usage` field (OpenAI sends it on the last chunk when
 * `stream_options.include_usage = true`).
 */
export async function* streamChat(
  params: ChatParams,
): AsyncGenerator<{
  delta: string;
  done: boolean;
  finishReason: string | null;
  usage: UsageInfo | null;
}> {
  const client = getClient();
  const startedAt = Date.now();

  // Cast: openai SDK is strict about types but our params are correct
  // at runtime. We pass them through unchanged.
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
  })) as Stream<ChatCompletionChunk>;

  let usage: UsageInfo | null = null;
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content ?? '';
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }

    if (chunk.usage) {
      const u = chunk.usage;
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      const inTokens = u.prompt_tokens ?? 0;
      const outTokens = u.completion_tokens ?? 0;
      const pricing = PRICING[params.model];
      const costUsd =
        (Math.max(0, inTokens - cached) / 1_000_000) * pricing.input +
        (cached / 1_000_000) * pricing.cached +
        (outTokens / 1_000_000) * pricing.output;
      usage = {
        inputTokens: inTokens,
        cachedInputTokens: cached,
        outputTokens: outTokens,
        totalTokens: u.total_tokens ?? inTokens + outTokens,
        costMicrodollars: Math.round(costUsd * 1_000_000),
        model: params.model,
        latencyMs: Date.now() - startedAt,
      };
    }

    yield { delta, done: Boolean(choice?.finish_reason), finishReason, usage };
  }

  // If the stream ended without a `usage` chunk (rare — e.g. error
  // mid-stream), still emit a final `done` so the caller can clean up.
  yield { delta: '', done: true, finishReason, usage };
}

/** Test helper — allows tests to inject a fake client. */
export function _setClientForTest(client: OpenAI | null) {
  _client = client;
}
