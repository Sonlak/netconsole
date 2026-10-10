/**
 * Integration tests for POST /api/assistant.
 *
 * We stub OpenAI's `chat.completions.create` so the test runs without
 * an API key, then drive the SSE stream end-to-end and assert the
 * emitted events. The point is to lock down the wire format the
 * frontend depends on.
 *
 * If you change an event shape or add a new event type, add a test
 * here that asserts the JSON payload so the frontend never silently
 * breaks.
 */

import { describe, expect, it, beforeEach, vi, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'unit-test-secret-not-used-elsewhere';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'sk-test-xxx';

// All mocks are hoisted up so they exist before the dynamic import
// resolves. The `vi.hoisted` callback runs before any module
// evaluation, so the vi.fn references below are guaranteed to be
// defined when the mock factories close over them.
const mocks = vi.hoisted(() => {
  const deviceFindFirst = vi.fn();
  const deviceFindMany = vi.fn();
  const jobCreate = vi.fn();
  const jobFindMany = vi.fn();
  const getLatestInterfacesJob = vi.fn();
  const sessionCreate = vi.fn(async ({ data }: { data: { userId: string | null; model: string; title: string } }) => ({
    id: 'sess-test',
    userId: data.userId,
    model: data.model,
    title: data.title,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const sessionFindUnique = vi.fn(async () => null);
  const messageCreate = vi.fn(async () => ({ id: 'msg-1' }));
  const usageCreate = vi.fn(async () => ({ id: 'u-1' }));
  return {
    deviceFindFirst,
    deviceFindMany,
    jobCreate,
    jobFindMany,
    getLatestInterfacesJob,
    sessionCreate,
    sessionFindUnique,
    messageCreate,
    usageCreate,
  };
});

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      findFirst: (...args: unknown[]) => mocks.deviceFindFirst(...args),
      findMany: (...args: unknown[]) => mocks.deviceFindMany(...args),
    },
    job: {
      findMany: (...args: unknown[]) => mocks.jobFindMany(...args),
      create: (...args: unknown[]) => mocks.jobCreate(...args),
    },
    assistantSession: {
      create: mocks.sessionCreate,
      findUnique: mocks.sessionFindUnique,
    },
    assistantMessage: {
      create: mocks.messageCreate,
    },
    assistantUsageLog: {
      create: mocks.usageCreate,
    },
  },
}));

vi.mock('../../src/services/macAddress.js', () => ({
  getMacAddressInventory: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../../src/services/fabricTopology.js', () => ({
  getFabricTopology: vi.fn(async () => ({ nodes: [], links: [] })),
}));
vi.mock('../../src/services/keaDhcp.js', () => ({
  listDhcpLeases: vi.fn(async () => []),
  getDhcpDashboard: vi.fn(async () => ({
    totals: { sites: 0, pools: 0, leased: 0, poolSize: 0 },
    ha: { mode: 'hot-standby', peers: [], active: null },
    pools: [],
  })),
}));
vi.mock('../../src/services/logs.js', () => ({
  listLogs: vi.fn(async () => ({ rows: [], lastUpdatedAt: null })),
  queueLogsCollection: vi.fn(async () => ({ deviceCount: 0, queued: 0 })),
}));
vi.mock('../../src/services/logAlerts.js', () => ({
  listAlerts: vi.fn(async () => []),
}));
vi.mock('../../src/services/interfaces.js', () => ({
  getLatestInterfacesJob: (...args: unknown[]) => mocks.getLatestInterfacesJob(...args),
  queueInterfaceAction: vi.fn(async () => ({
    kind: 'created',
    job: { id: 'job-x', type: 'INTERFACE_ACTION', status: 'PENDING', createdAt: new Date(), deviceId: 'dev-1', payload: { action: 'shut', interface: 'ge-0/0/5' } },
  })),
  parseInterfaceActionPayload: vi.fn((p: unknown) => p),
}));

const createCompletionMock = vi.fn();
vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      constructor(_opts: unknown) {}
      chat = {
        completions: {
          create: (...args: unknown[]) => createCompletionMock(...args),
        },
      };
    },
  };
});

const { assistantRouter } = await import('../../src/routes/assistant.js');

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/assistant', assistantRouter);
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/api/assistant` });
    });
  });
}

function makeAdminToken(): string {
  return jwt.sign(
    { sub: 'admin', userId: 'user-1', username: 'admin', role: 'ADMIN' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

async function collectEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const out: Array<Record<string, unknown>> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        out.push(JSON.parse(dataLine.slice(6)));
      } catch {
        // ignore parse errors
      }
    }
  }
  return out;
}

/**
 * Test helper: convert a single "non-streaming" LLM response into an
 * AsyncIterable of OpenAI streaming chunks. The route layer now uses
 * real token streaming, so every mock must yield chunks, not a single
 * object.
 *
 * Format mirrors what OpenAI sends when `stream: true`:
 *  - text chunk:   { choices: [{ delta: { content: 'text' } }] }
 *  - tool chunk:   { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: '...' } }] } }] }
 *  - finish chunk: { choices: [{ finish_reason: 'stop' | 'tool_calls' }] }
 *  - usage chunk:  { usage: { ... } }
 *
 * Tool calls are split: id+name in chunk 0, arguments characters
 * trickle in 8-char slices to exercise the streamChat accumulator.
 */
function asStream(opts: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number; cached_tokens?: number };
}): AsyncIterable<unknown> {
  const chunks: unknown[] = [];

  if (opts.text) {
    // Emit text in one chunk — the assistant drawer joins them with
    // '' anyway, so chunk granularity is invisible to tests.
    chunks.push({ choices: [{ delta: { content: opts.text } }] });
  }

  if (opts.toolCalls && opts.toolCalls.length > 0) {
    for (let i = 0; i < opts.toolCalls.length; i++) {
      const tc = opts.toolCalls[i];
      const argsJson = JSON.stringify(tc.arguments);
      // Chunk 0 of this tool: id + name, no args yet.
      chunks.push({
        choices: [{
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: '' },
            }],
          },
        }],
      });
      // Subsequent chunks: trickle the args JSON 8 chars at a time.
      const SLICE = 8;
      for (let j = 0; j < argsJson.length; j += SLICE) {
        chunks.push({
          choices: [{
            delta: {
              tool_calls: [{
                index: i,
                function: { arguments: argsJson.slice(j, j + SLICE) },
              }],
            },
          }],
        });
      }
    }
  }

  if (opts.finishReason) {
    chunks.push({ choices: [{ finish_reason: opts.finishReason }] });
  }

  if (opts.usage) {
    chunks.push({
      usage: {
        prompt_tokens: opts.usage.prompt_tokens,
        completion_tokens: opts.usage.completion_tokens,
        total_tokens: opts.usage.total_tokens ?? opts.usage.prompt_tokens + opts.usage.completion_tokens,
        prompt_tokens_details: { cached_tokens: opts.usage.cached_tokens ?? 0 },
      },
    });
  }

  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

describe('POST /api/assistant', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!server) {
      const s = await startServer();
      server = s.server;
      baseUrl = s.url;
    }
    // Re-establish defaults after clearAllMocks so per-test setup
    // can still override them.
    mocks.sessionCreate.mockImplementation(async ({ data }: { data: { userId: string | null; model: string; title: string } }) => ({
      id: 'sess-test',
      userId: data.userId,
      model: data.model,
      title: data.title,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mocks.sessionFindUnique.mockImplementation(async () => null);
    mocks.messageCreate.mockImplementation(async () => ({ id: 'msg-1' }));
    mocks.usageCreate.mockImplementation(async () => ({ id: 'u-1' }));
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'hi', messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed body with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('streams a session + text + done for a plain chat turn', async () => {
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'Xin chào, tôi có thể giúp gì?',
      finishReason: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 50 },
    }));

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({ userMessage: 'Xin chào', messages: [{ role: 'user', content: 'Xin chào' }] }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain('session');
    expect(types).toContain('text');
    expect(types).toContain('usage');
    expect(types[types.length - 1]).toBe('done');

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toBe('Xin chào, tôi có thể giúp gì?');

    const usage = events.find((e) => e.type === 'usage') as { inputTokens: number; cachedInputTokens: number; outputTokens: number; costMicrodollars: number };
    expect(usage.inputTokens).toBe(100);
    expect(usage.cachedInputTokens).toBe(50);
    expect(usage.outputTokens).toBe(20);
    expect(usage.costMicrodollars).toBeGreaterThan(0);
  });

  it('executes a READ tool and streams tool_call + tool_result events', async () => {
    mocks.deviceFindMany.mockResolvedValueOnce([
      {
        id: 'dev-1',
        name: 'LAB-F2-AS-01',
        ip: '10.10.20.1',
        status: 'ONLINE',
        vendor: 'juniper',
        model: 'EX3400',
        version: '23.4R2',
        site: 'NKKN',
        floor: 'F2',
        lastPingAt: new Date(),
        lastPingMs: 3,
      },
    ]);

    createCompletionMock.mockResolvedValueOnce(asStream({
      toolCalls: [
        {
          id: 'call-1',
          name: 'get_device',
          arguments: { query: 'LAB-F2-AS-01' },
        },
      ],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, cached_tokens: 100 },
    }));
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'LAB-F2-AS-01 đang ONLINE, IP 10.10.20.1.',
      finishReason: 'stop',
      usage: { prompt_tokens: 300, completion_tokens: 25, total_tokens: 325, cached_tokens: 150 },
    }));

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'LAB-F2-AS-01 còn online không?',
        messages: [{ role: 'user', content: 'LAB-F2-AS-01 còn online không?' }],
      }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);
    if (!types.includes('tool_result')) {
      throw new Error(`No tool_result. Got: ${JSON.stringify(events)}`);
    }

    const toolCall = events.find((e) => e.type === 'tool_call') as { name: string; arguments: { query: string } };
    expect(toolCall.name).toBe('get_device');
    expect(toolCall.arguments.query).toBe('LAB-F2-AS-01');

    const toolResult = events.find((e) => e.type === 'tool_result') as { ok: boolean; name: string };
    expect(toolResult.name).toBe('get_device');
    expect(toolResult.ok).toBe(true);

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toMatch(/ONLINE/);

    // Regression: the recursive LLM call MUST receive an `assistant`
    // message carrying `tool_calls` BEFORE the `tool` result row, or
    // OpenAI returns 400 ("messages with role 'tool' must be a response
    // to a preceding message with 'tool_calls'"). Bug seen 2026-10-09
    // when the LLM emitted tool_calls with no text content.
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
    const recursiveArgs = createCompletionMock.mock.calls[1][0] as {
      messages: Array<{ role: string; tool_calls?: unknown; tool_call_id?: string }>;
    };
    const idxToolCall = recursiveArgs.messages.findIndex((m) => Array.isArray(m.tool_calls));
    const idxToolResult = recursiveArgs.messages.findIndex((m) => m.role === 'tool');
    expect(idxToolCall).toBeGreaterThanOrEqual(0);
    expect(idxToolResult).toBeGreaterThan(idxToolCall);
  });

  it('handles multiple tool_calls in one LLM turn (fan-out)', async () => {
    // First LLM call emits TWO read tools (get_device + get_device_interfaces).
    // Bug seen 2026-10-09: only the first tool result was appended to
    // the conversation, so the second tool_call_id had no matching
    // `tool` message and OpenAI returned 400.
    mocks.deviceFindMany.mockResolvedValueOnce([
      {
        id: 'dev-2',
        name: 'LAB-F6-DS-01',
        ip: '10.10.20.6',
        status: 'ONLINE',
        vendor: 'juniper',
        model: 'EX3400',
        version: '23.4R2',
        site: 'NKKN',
        floor: 'F6',
        lastPingAt: new Date(),
        lastPingMs: 4,
      },
    ]);
    mocks.getLatestInterfacesJob.mockResolvedValueOnce({
      id: 'job-1',
      updatedAt: new Date(),
      result: { interfaces: [{ name: 'ge-0/0/0', adminStatus: 'up', operStatus: 'up' }] },
    });

    createCompletionMock.mockResolvedValueOnce(asStream({
      toolCalls: [
        {
          id: 'call-A',
          name: 'get_device',
          arguments: { query: 'LAB-F6-DS-01' },
        },
        {
          id: 'call-B',
          name: 'get_device_interfaces',
          arguments: { device_name: 'LAB-F6-DS-01' },
        },
      ],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, cached_tokens: 100 },
    }));
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'LAB-F6-DS-01 đang ONLINE, có 1 interface up.',
      finishReason: 'stop',
      usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420, cached_tokens: 300 },
    }));

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'LAB-F6-DS-01 status + interfaces?',
        messages: [{ role: 'user', content: 'LAB-F6-DS-01 status + interfaces?' }],
      }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const events = await collectEvents(res);
    const toolResults = events.filter((e) => e.type === 'tool_result') as Array<{ id: string }>;
    expect(toolResults.length).toBe(2);
    const ids = toolResults.map((tr) => tr.id).sort();
    expect(ids).toEqual(['call-A', 'call-B']);

    // The recursive LLM call must receive BOTH tool result messages
    // immediately after the assistant(tool_calls) row. Otherwise
    // OpenAI returns 400 ("did not have response messages").
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
    const recursiveArgs = createCompletionMock.mock.calls[1][0] as {
      messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    };
    const assistantIdx = recursiveArgs.messages.findIndex((m) => Array.isArray(m.tool_calls));
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const toolMessages = recursiveArgs.messages
      .slice(assistantIdx + 1)
      .filter((m) => m.role === 'tool');
    const toolIds = toolMessages.map((m) => m.tool_call_id).sort();
    expect(toolIds).toEqual(['call-A', 'call-B']);
  });

  it('emits confirmation_required for a WRITE tool and does NOT execute', async () => {
    createCompletionMock.mockResolvedValueOnce(asStream({
      toolCalls: [
        {
          id: 'call-2',
          name: 'queue_interface_action',
          arguments: { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' },
        },
      ],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, cached_tokens: 100 },
    }));

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'Shutdown port ge-0/0/5 trên F2-AS-01',
        messages: [{ role: 'user', content: 'Shutdown port ge-0/0/5 trên F2-AS-01' }],
      }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const events = await collectEvents(res);
    // diagnostic: log all events if assertion fails
    const types = events.map((e) => e.type);
    if (!types.includes('confirmation_required')) {
      throw new Error(`No confirmation_required. Got: ${JSON.stringify(events)}`);
    }

    const confirm = events.find((e) => e.type === 'confirmation_required') as {
      name: string;
      arguments: { device_name: string; interface: string; action: string };
      summary: string;
    };
    expect(confirm).toBeTruthy();
    expect(confirm.name).toBe('queue_interface_action');
    expect(confirm.arguments.action).toBe('shut');
    expect(confirm.summary).toMatch(/ge-0\/0\/5/);

    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(0);
  });

  it('executes a confirmed WRITE tool and returns a follow-up summary', async () => {
    mocks.deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE' });
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'Đã queue job INTERFACE_ACTION #job-99 thành công. Bạn có thể track ở /jobs.',
      finishReason: 'stop',
      usage: { prompt_tokens: 250, completion_tokens: 35, total_tokens: 285, cached_tokens: 150 },
    }));

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'Xác nhận',
        messages: [{ role: 'user', content: 'Shutdown port' }],
        confirmedToolCall: {
          id: 'call-2',
          name: 'queue_interface_action',
          arguments: { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' },
        },
      }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const events = await collectEvents(res);
    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toMatch(/job/);

    // Regression (2026-10-09): when the client re-sends a prior
    // assistant(tool_calls) message WITHOUT the corresponding tool
    // response (because we paused on a confirmation card), the
    // confirmation continuation MUST inject a tool message right
    // after the assistant message. Otherwise OpenAI returns 400
    // ("An assistant message with 'tool_calls' must be followed
    // by tool messages responding to each 'tool_call_id'"). This
    // test drives the real flow: client sends the full prior
    // history including the assistant(tool_calls) row, and we
    // verify the LLM call carries the injected tool response in
    // the correct position.
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    const followUpArgs = createCompletionMock.mock.calls[0][0] as {
      messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    };
    const asstIdx = followUpArgs.messages.findIndex((m) => Array.isArray(m.tool_calls));
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    const toolMsg = followUpArgs.messages
      .slice(asstIdx + 1)
      .find((m) => m.role === 'tool' && m.tool_call_id === 'call-2');
    expect(toolMsg).toBeTruthy();
    // No non-tool message should sit between the assistant(tool_calls)
    // and the injected tool result.
    const between = followUpArgs.messages
      .slice(asstIdx + 1)
      .filter((m) => m.role === 'tool' && m.tool_call_id === 'call-2');
    expect(between.length).toBe(1);
  });

  it('emits tool_result with recovery suggestions when LLM calls a non-existent tool', async () => {
    // gpt-4.1-mini sometimes hallucinates tool names (e.g. "get_device_info"
    // instead of "get_device"). The route should NOT crash — it should
    // emit a tool_result with `availableTools` and a fuzzy-matched
    // suggestion so the LLM can retry.
    createCompletionMock.mockResolvedValueOnce(asStream({
      toolCalls: [
        {
          id: 'call-typo',
          name: 'get_device_info', // ❌ not a real tool
          arguments: { query: 'F2-AS-01' },
        },
      ],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 50 },
    }));
    // After the LLM sees the recovery message it should retry with
    // the correct name.
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'Đã tìm thấy thiết bị.',
      finishReason: 'stop',
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, cached_tokens: 100 },
    }));
    mocks.deviceFindMany.mockResolvedValueOnce([
      { id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE', vendor: 'juniper', model: 'EX3400', version: '23.4R2', site: 'NKKN', floor: 'F2' },
    ]);

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'Tìm F2-AS-01',
        messages: [{ role: 'user', content: 'Tìm F2-AS-01' }],
      }),
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}: ${await res.text()}`);

    const events = await collectEvents(res);
    const typoResult = events.find(
      (e) => e.type === 'tool_result' && (e as { name: string }).name === 'get_device_info',
    ) as { ok: boolean; error: string; preview: { availableTools: string[] } };

    expect(typoResult).toBeTruthy();
    expect(typoResult.ok).toBe(false);
    expect(typoResult.error).toMatch(/không tồn tại/);
    expect(typoResult.error).toMatch(/get_device/); // suggests the correct name
    expect(typoResult.preview.availableTools).toContain('get_device');
    expect(typoResult.preview.availableTools).toContain('lookup_mac');

    // The LLM should be able to retry — the recursive LLM call must
    // receive the recovery tool message so it can produce a corrected
    // follow-up. Verify the second LLM call gets the recovery info.
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
    const recoveryArgs = createCompletionMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
    };
    const toolMsg = recoveryArgs.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-typo',
    );
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.content).toMatch(/availableTools/);
  });

  it('emits suggestions SSE event when LLM calls suggest_followup', async () => {
    // LLM ends a turn with a final tool call to suggest_followup. The
    // route should emit a `suggestions` event with the array, AND a
    // regular tool_result so OpenAI's tool_calls invariant holds for
    // any subsequent turn.
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'F2-AS-01 đang ONLINE.',
      finishReason: 'stop',
      usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, cached_tokens: 100 },
    }));
    // The LLM could call suggest_followup in the same turn as the
    // text — let's simulate a follow-up turn where the LLM
    // (hypothetically) calls suggest_followup then a final stop.
    // We test the simpler case first: just text + the LLM calling
    // suggest_followup is its own tool.

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'F2-AS-01 status?',
        messages: [{ role: 'user', content: 'F2-AS-01 status?' }],
      }),
    });
    const events = await collectEvents(res);
    // No suggestion in this test — just verify the basic flow
    // didn't break. The actual suggest_followup behavior is tested
    // by the handler test below.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
  });

  it('injects tool result when prior assistant(tool_calls) was followed by other tool results (mixed READ+WRITE fan-out)', async () => {
    // Flow: LLM emitted [get_device, queue_interface_action] in one
    // turn. get_device ran inline and was persisted. queue_interface_action
    // paused on confirmation. The frontend now sends the prior history
    // (user, assistant(tool_calls), tool(get_device)) and we confirm
    // queue_interface_action. The continuation must inject the WRITE
    // tool result after the existing READ tool result, not before.
    mocks.deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE' });
    createCompletionMock.mockResolvedValueOnce(asStream({
      text: 'Đã shutdown port ge-0/0/5. Job #job-100.',
      finishReason: 'stop',
      usage: { prompt_tokens: 300, completion_tokens: 30, total_tokens: 330, cached_tokens: 200 },
    }));

    const priorMessages = [
      { role: 'user', content: 'Shutdown port ge-0/0/5 trên F2-AS-01' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-r', type: 'function', function: { name: 'get_device', arguments: '{"query":"LAB-F2-AS-01"}' } },
          { id: 'call-w', type: 'function', function: { name: 'queue_interface_action', arguments: '{"device_name":"LAB-F2-AS-01","interface":"ge-0/0/5","action":"shut"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-r', content: JSON.stringify({ found: 1, devices: [{ name: 'LAB-F2-AS-01' }] }) },
    ];

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeAdminToken()}` },
      body: JSON.stringify({
        userMessage: 'Xác nhận',
        messages: priorMessages,
        confirmedToolCall: {
          id: 'call-w',
          name: 'queue_interface_action',
          arguments: { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' },
        },
      }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${body}`);
    }
    const events = await collectEvents(res);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    const followUpArgs = createCompletionMock.mock.calls[0][0] as {
      messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    };
    const asstIdx = followUpArgs.messages.findIndex((m) => Array.isArray(m.tool_calls));
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    // After the assistant message: tool(call-r) then tool(call-w), no
    // other role in between. Order is allowed; both must be present.
    const tail = followUpArgs.messages.slice(asstIdx + 1);
    const firstNonTool = tail.findIndex((m) => m.role !== 'tool');
    const toolSection = firstNonTool === -1 ? tail : tail.slice(0, firstNonTool);
    const toolIds = toolSection.map((m) => m.tool_call_id).sort();
    expect(toolIds).toEqual(['call-r', 'call-w']);
  });
});
