import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// IMPORTANT: env vars must be set before any module that reads them at top-level is imported.
// We use vi.hoisted to ensure this happens before the dynamic import below.
const { JWT_SECRET } = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-secret-not-used-elsewhere';
  return { JWT_SECRET: process.env.JWT_SECRET! };
});

// Mock prisma BEFORE importing the router
const jobFindMany = vi.fn();
const jobUpdate = vi.fn();
// Phase 2 (2026-10-14): /jobs/queue now atomically claims inside a
// SELECT FOR UPDATE SKIP LOCKED transaction. The test mocks the
// transaction surface ($queryRaw, $executeRaw, transaction-scoped
// findMany) so we don't need a real PG connection for this suite.
const txQueryRaw = vi.fn();
const txExecuteRaw = vi.fn();
const txJobFindMany = vi.fn();

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    $transaction: (fn: (tx: {
      $queryRaw: (...args: unknown[]) => unknown;
      $executeRaw: (...args: unknown[]) => unknown;
      job: { findMany: (...args: unknown[]) => unknown };
    }) => Promise<unknown>) =>
      fn({
        $queryRaw: (...args: unknown[]) => txQueryRaw(...args),
        $executeRaw: (...args: unknown[]) => txExecuteRaw(...args),
        job: { findMany: (...args: unknown[]) => txJobFindMany(...args) },
      }),
    job: {
      findMany: (...args: unknown[]) => jobFindMany(...args),
      findUnique: (...args: unknown[]) => jobFindMany(...args),
      update: (...args: unknown[]) => jobUpdate(...args),
    },
  },
}));

vi.mock('../../src/services/managedCheck.js', () => ({
  applyManagedCheckResult: vi.fn(),
}));
vi.mock('../../src/services/deviceIdentity.js', () => ({
  applyCollectedDeviceFacts: vi.fn(),
}));
vi.mock('../../src/services/interfaces.js', () => ({
  applyInterfaceActionSnapshot: vi.fn(),
  queueGetInterfaces: vi.fn(),
}));

// Dynamic import so that env vars + mocks are wired before module evaluation
const { jobsRouter } = await import('../../src/routes/jobs.js');

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', jobsRouter);
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/api/jobs` });
    });
  });
}

describe('worker auth on /jobs endpoints', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    jobFindMany.mockReset();
    jobUpdate.mockReset();
    txQueryRaw.mockReset();
    txExecuteRaw.mockReset();
    // Default: empty queue (no PENDING jobs). Tests that exercise
    // the SKIP LOCKED claim path override these to return rows.
    txQueryRaw.mockResolvedValue([]);
    txExecuteRaw.mockResolvedValue(0);
    txJobFindMany.mockResolvedValue([]);
    const s = await startServer();
    server = s.server;
    baseUrl = s.url;
  });

  afterAll(() => {
    if (server) server.close();
  });

    function makeWorkerToken(role = 'worker'): string {
      return jwt.sign(
        { sub: 'worker', role },
        process.env.JWT_SECRET!,
        { expiresIn: '1h', issuer: 'netconsole-backend', audience: 'netconsole' },
      );
    }
    function makeAdminToken(): string {
      return jwt.sign(
        { sub: 'admin', role: 'ADMIN' },
        process.env.JWT_SECRET!,
        { expiresIn: '1h', issuer: 'netconsole-backend', audience: 'netconsole' },
      );
    }

  it('GET /jobs/queue returns 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/queue`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/worker credentials required/i);
  });

  it('GET /jobs/queue returns 401 with a non-worker bearer token', async () => {
    const res = await fetch(`${baseUrl}/queue`, {
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });
    // Admin token is not a worker token
    expect(res.status).toBe(401);
  });

  it('GET /jobs/queue returns 200 with a valid worker bearer token', async () => {
    jobFindMany.mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/queue`, {
      headers: { Authorization: `Bearer ${makeWorkerToken()}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /jobs returns 200 with an authenticated user token', async () => {
    jobFindMany.mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: `Bearer ${makeAdminToken()}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('PATCH /jobs/:id/claim returns 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/abc/claim`, { method: 'PATCH' });
    expect(res.status).toBe(401);
  });

  it('PATCH /jobs/:id/complete returns 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/abc/complete`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH /jobs/:id/claim returns 200 with worker token', async () => {
    jobUpdate.mockResolvedValue({ id: 'job-1', status: 'RUNNING' });
    const res = await fetch(`${baseUrl}/job-1/claim`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${makeWorkerToken()}` },
    });
    expect(res.status).toBe(200);
  });
});