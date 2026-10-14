import { Redis } from 'ioredis';

/**
 * Redis client wrapper.
 *
 * Phase 2 (2026-10-14): shared cache for hot endpoints (currently
 * /api/devices via services/deviceCache). Future pub/sub for cross-pod
 * invalidation could plug in here too.
 *
 * Behaviour:
 *   - Lazy connect: the first getRedis() call creates the client and starts
 *     the connection. Subsequent calls return the same instance.
 *   - Offline queue disabled: if Redis is unreachable, the request errors
 *     immediately instead of queuing and stalling. Callers (cache helpers)
 *     catch the error and fall back to the source-of-truth (Postgres).
 *   - Aggressive retry with a 2s cap so a long Redis outage doesn't
 *     peg the request handler waiting for reconnection.
 */
let client: Redis | null = null;

function buildClient(): Redis {
  const url = process.env.REDIS_URL || 'redis://localhost:6379/0';
  const instance = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    // ioredis retryStrategy receives the number of reconnect attempts.
    // Cap the backoff at 2s so a long outage doesn't make every request
    // wait that long before falling back.
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
    // Don't spam stderr with stack traces; ioredis logs connection errors
    // at error level by default. The handler in `error` below downgrades
    // them to warnings — operators only see "Redis unreachable" once
    // per reconnect cycle, not 30 times a second.
  });

  instance.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.warn('[redis] connection error (will retry):', err.message);
  });
  instance.on('ready', () => {
    // eslint-disable-next-line no-console
    console.log(`[redis] connected to ${url}`);
  });
  instance.on('end', () => {
    // eslint-disable-next-line no-console
    console.warn('[redis] connection closed');
  });

  // Kick off the connection asynchronously. Errors here are handled by
  // the 'error' listener — we don't need to await connect().
  instance.connect().catch((err: Error) => {
    // eslint-disable-next-line no-console
    console.warn('[redis] initial connect failed:', err.message);
  });

  return instance;
}

export function getRedis(): Redis {
  if (!client) {
    client = buildClient();
  }
  return client;
}

/**
 * Test helper. Used by /api/health (future) to verify cache connectivity
 * without blocking the rest of the health payload.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const result = await getRedis().ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Test helper. Closes the underlying client so test suites can shut down
 * cleanly. Production code never calls this — Redis auto-reconnects.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}