import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { verifyToken, signToken, requireRole } from '../../src/middleware/auth.js';
import type { AuthenticatedRequest } from '../../src/middleware/auth.js';

describe('verifyToken', () => {
  it('returns payload for a valid token signed with JWT_SECRET', () => {
    process.env.JWT_SECRET = 'unit-test-secret-not-used-elsewhere';
    const token = signToken({ userId: 'u1', username: 'alice', role: 'ADMIN' });
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe('u1');
    expect(payload?.role).toBe('ADMIN');
  });

  it('returns null for a token signed with the wrong secret', () => {
    const token = jwt.sign({ userId: 'u2', role: 'ADMIN' }, 'attacker-secret', {
      expiresIn: '1h',
    });
    const payload = verifyToken(token);
    expect(payload).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(verifyToken('not-a-jwt')).toBeNull();
    expect(verifyToken('a.b.c')).toBeNull();
    expect(verifyToken('')).toBeNull();
  });

  it('returns null for an expired token', () => {
    const token = jwt.sign({ userId: 'u3', role: 'ADMIN' }, 'unit-test-secret-not-used-elsewhere', {
      expiresIn: -1,
    });
    expect(verifyToken(token)).toBeNull();
  });
});

describe('signToken / verifyToken roundtrip with worker role', () => {
  it('verifies a token signed with role=worker (used by backend worker endpoints)', () => {
    const token = signToken({ userId: 'worker-1', username: 'worker', role: 'worker' });
    const payload = verifyToken(token);
    expect(payload?.role).toBe('worker');
  });
});

describe('requireRole', () => {
  function callRequireRole(roles: string[], userRole?: string): { ok: boolean; status?: number } {
    let nextCalled = false;
    const middleware = requireRole(...roles);
    const req = {
      user: userRole ? { userId: 'x', username: 'y', role: userRole } : undefined,
    } as AuthenticatedRequest;
    const res: any = {
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    const next = () => {
      nextCalled = true;
    };
    middleware(req, res, next);
    return { ok: nextCalled, status: res.statusCode };
  }

  it('calls next() when user role is in the allowed list', () => {
    expect(callRequireRole(['ADMIN'], 'ADMIN')).toEqual({ ok: true });
  });

  it('returns 403 when user role is not in the allowed list', () => {
    expect(callRequireRole(['ADMIN'], 'VIEWER')).toEqual({ ok: false, status: 403 });
  });

  it('returns 401 when no user is attached', () => {
    expect(callRequireRole(['ADMIN'])).toEqual({ ok: false, status: 401 });
  });

  it('supports multiple allowed roles', () => {
    expect(callRequireRole(['ADMIN', 'OPERATOR'], 'OPERATOR')).toEqual({ ok: true });
  });
});