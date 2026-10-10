/**
 * AI Assistant API client.
 *
 * The backend uses Server-Sent Events (one JSON object per `event:
 * message` block). We consume the stream with the standard ReadableStream
 * API and dispatch each event to a callback so the UI can update
 * incrementally.
 *
 * Auth: re-uses the existing JWT. If the first POST returns 401 we
 * trigger a single-flight refresh (see /lib/refreshCoordinator) and
 * retry once. This mirrors the auth flow used by every other
 * JSON endpoint.
 *
 * Retry on network drop: the LLM call is expensive ($) so we DO NOT
 * silently retry a partial stream. If the connection drops mid-turn,
 * the frontend should show an error and let the user re-send the
 * same `messages` array — the assistant will pick up where it left
 * off.
 */

import { authHeaders } from './auth';
import { coordinatedRefresh } from '../lib/refreshCoordinator';

/** Mirrors the backend `AssistantStreamEvent` union in types.ts. */
export type AssistantStreamEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      preview: unknown;
      error?: string;
    }
  | {
      type: 'confirmation_required';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      summary: string;
    }
  | { type: 'error'; message: string }
  | {
      type: 'usage';
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      costMicrodollars: number;
    }
  | { type: 'done' }
  | { type: 'suggestions'; suggestions: string[] };

/** OpenAI Chat Completions message shape. */
export type AssistantMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: unknown }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Body of POST /api/assistant. */
export type AssistantRequest = {
  messages: AssistantMessage[];
  userMessage: string;
  sessionId?: string;
  confirmedToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
};

/**
 * Send a request and stream the SSE response.
 *
 * @param body     The request payload.
 * @param onEvent  Called for each parsed event as it arrives.
 * @param signal   Optional AbortSignal to cancel the request.
 *
 * Throws on:
 *  - 401 after a refresh attempt (caller should redirect to /login)
 *  - 5xx (the backend tried to start streaming and failed)
 *  - network errors
 */
export async function streamAssistant(
  body: AssistantRequest,
  onEvent: (e: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await postWithRefresh('/api/assistant', body, signal);
  if (!response.ok || !response.body) {
    let message = `Assistant request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  await consumeSse(response.body, onEvent, signal);
}

async function postWithRefresh(
  url: string,
  body: AssistantRequest,
  signal: AbortSignal | undefined,
): Promise<Response> {
  // First attempt.
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status !== 401) return res;

  // 401: try a refresh, then retry once. If the refresh itself fails
  // we throw and let the UI bounce to /login.
  try {
    await coordinatedRefresh();
  } catch {
    throw new Error('Session expired — please log in again.');
  }
  res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  return res;
}

/**
 * Parse a ReadableStream as Server-Sent Events. The backend uses the
 * single `event: message` channel and puts the typed JSON in `data:`.
 * Each event block ends with a blank line.
 */
async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (e: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on the SSE event boundary (blank line).
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // Walk the block, looking for the data: line.
        const dataLine = block
          .split('\n')
          .find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const parsed = JSON.parse(dataLine.slice(6)) as AssistantStreamEvent;
          onEvent(parsed);
        } catch (err) {
          // Bad JSON in a stream event is non-fatal — keep going.
          console.warn('[assistant] bad SSE event:', err, dataLine);
        }
      }
    }
    // Flush any trailing data (no terminating blank line).
    if (buffer.trim()) {
      const dataLine = buffer.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        try {
          onEvent(JSON.parse(dataLine.slice(6)) as AssistantStreamEvent);
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
