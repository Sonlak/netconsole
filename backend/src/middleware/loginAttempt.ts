/**
 * Per-username + per-IP login-attempt limiter.
 *
 * Security (H11, see docs/agents/16-security-audit-preprod.md): locks
 * out a `(username, ip)` pair after 5 consecutive failed login
 * attempts in a 15-minute window. This complements the existing
 * per-username `authRateLimit` middleware (which lives in
 * `backend/src/middleware/rateLimit.ts` and uses an in-memory store).
 *
 * We keep this DB-backed because the in-memory `RateLimitStore` in
 * rateLimit.ts is wiped on backend restart — that's fine for the rate
 * limit itself, but the lockout-out counter is the kind of thing we
 * want to survive a process restart (otherwise an attacker who can
 * time their burst around a deploy gets more attempts than they should).
 *
 * The bucket key is `(username, ip)` so a NAT'd / shared-IP office
 * doesn't lock out unrelated users, and so a single attacker rotating
 * IPs cannot burn another user's quota.
 */

import { prisma } from '../lib/prisma.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;            // lock after 5 consecutive fails

export interface AttemptState {
  count: number;
  /** First-failure timestamp of the current window. Window starts here. */
  windowStart: number;
}

interface AttemptRow {
  username: string;
  ip: string;
  count: number;
  windowStart: Date;
}

function rowToState(row: AttemptRow): AttemptState {
  return {
    count: row.count,
    windowStart: row.windowStart.getTime(),
  };
}

async function getOrCreate(username: string, ip: string): Promise<AttemptRow> {
  // Use upsert so a concurrent first attempt doesn't race-create two rows.
  // We update `windowStart` lazily in recordFailedLogin() if the window
  // has rolled.
  return prisma.loginAttempt.upsert({
    where: { username_ip: { username, ip } },
    update: {},
    create: {
      username,
      ip,
      count: 0,
      windowStart: new Date(),
    },
  });
}

/** Read the current state without modifying it. */
async function readState(username: string, ip: string): Promise<AttemptState | null> {
  const row = await prisma.loginAttempt.findUnique({
    where: { username_ip: { username, ip } },
  });
  if (!row) return null;
  return rowToState(row);
}

/**
 * Returns true if the (username, ip) is currently locked out. Caller
 * should respond with HTTP 429 and stop the login flow.
 */
export async function isLoginLocked(username: string, ip: string): Promise<boolean> {
  const state = await readState(username, ip);
  if (!state) return false;
  // Stale-window rows: if the first failure was older than WINDOW_MS,
  // we reset. Don't write to DB here — recordFailedLogin will do it on
  // the next attempt.
  if (Date.now() - state.windowStart > WINDOW_MS) return false;
  return state.count >= MAX_ATTEMPTS;
}

/** Increment the failed-attempt counter; sliding window resets if stale. */
export async function recordFailedLogin(username: string, ip: string): Promise<AttemptState> {
  const now = Date.now();
  const existing = await readState(username, ip);
  if (!existing || now - existing.windowStart > WINDOW_MS) {
    // Fresh window.
    return prisma.loginAttempt
      .upsert({
        where: { username_ip: { username, ip } },
        update: { count: 1, windowStart: new Date(now), lastFailedAt: new Date(now) },
        create: {
          username,
          ip,
          count: 1,
          windowStart: new Date(now),
          lastFailedAt: new Date(now),
        },
      })
      .then((r) => rowToState(r));
  }
  // Increment within current window.
  const row = await prisma.loginAttempt.update({
    where: { username_ip: { username, ip } },
    data: {
      count: { increment: 1 },
      lastFailedAt: new Date(now),
    },
  });
  return rowToState(row);
}

/** Clear the counter on successful login. */
export async function recordSuccessfulLogin(username: string, ip: string): Promise<void> {
  await prisma.loginAttempt
    .deleteMany({
      where: { username, ip },
    })
    .catch(() => undefined);
}

/**
 * Force-clear all stored attempt counters. Use sparingly (e.g. an admin
 * needs to unlock a banned user). Not currently wired to an endpoint.
 */
export async function clearAllAttempts(): Promise<number> {
  const result = await prisma.loginAttempt.deleteMany({});
  return result.count;
}
