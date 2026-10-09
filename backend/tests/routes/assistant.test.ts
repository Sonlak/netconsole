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
  getLatestInterfacesJob: vi.fn(async () => null),
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
    createCompletionMock.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Xin chào, tôi có thể giúp gì?' },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 50 } },
    });

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

    createCompletionMock.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'get_device', arguments: JSON.stringify({ query: 'LAB-F2-AS-01' }) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_tokens_details: { cached_tokens: 100 } },
    });
    createCompletionMock.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'LAB-F2-AS-01 đang ONLINE, IP 10.10.20.1.' },
        },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 25, total_tokens: 325, prompt_tokens_details: { cached_tokens: 150 } },
    });

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

  it('emits confirmation_required for a WRITE tool and does NOT execute', async () => {
    createCompletionMock.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-2',
                type: 'function',
                function: { name: 'queue_interface_action', arguments: JSON.stringify({ device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' }) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_tokens_details: { cached_tokens: 100 } },
    });

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
    createCompletionMock.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Đã queue job INTERFACE_ACTION #job-99 thành công. Bạn có thể track ở /jobs.' },
        },
      ],
      usage: { prompt_tokens: 250, completion_tokens: 35, total_tokens: 285, prompt_tokens_details: { cached_tokens: 150 } },
    });

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
  });
});
