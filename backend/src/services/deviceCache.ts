import type { Device } from '@prisma/client';
import { getRedis } from '../lib/redis.js';

/**
 * Read-through cache for hot endpoints.
 *
 * Phase 2 (2026-10-14): wraps /api/devices with a 30s Redis TTL. The
 * device list is hit on every dashboard render and every UI refresh —
 * the workload is mostly read-heavy with infrequent writes (device
 * add/edit/discovery sync).
 *
 * Cache strategy:
 *   - Single key (`cache:devices:list`). No per-user filtering today
 *     because /api/devices returns the full list to all authenticated users.
 *     If role-scoped filtering is added later, change the key to include
 *     the role hash.
 *   - TTL: 30 seconds. Short enough that field-level drift (e.g. updated
 *     lastPingAt from devicePing.ts) is invisible to operators; long
 *     enough to absorb dashboard refresh storms.
 *   - Invalidation: explicit `invalidate()` called from the route handlers
 *     on POST/PATCH/DELETE /api/devices/:id. Field-level background
 *     updates (managed check, ping) intentionally do NOT invalidate —
 *     the 30s TTL is the binding freshness guarantee.
 *   - Graceful degradation: if Redis is unreachable, the cache miss path
 *     loads from Postgres and skips the cache write. The user sees the
 *     correct data; the only cost is the extra DB round-trip until Redis
 *     recovers.
 */

const TTL_SECONDS = 30;
const KEY_DEVICES_LIST = 'cache:devices:list';

async function safeGet(key: string): Promise<string | null> {
  try {
    return await getRedis().get(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[deviceCache] read failed, falling back to DB:', (err as Error).message);
    return null;
  }
}

async function safeSetEx(key: string, ttl: number, value: string): Promise<void> {
  try {
    await getRedis().setex(key, ttl, value);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[deviceCache] write failed (data still served):', (err as Error).message);
  }
}

async function safeDel(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[deviceCache] invalidate failed (TTL will catch up):', (err as Error).message);
  }
}

export const deviceCache = {
  /**
   * Read-through cache for /api/devices. Loader is called on miss
   * (Redis down OR cache empty). The result is stringified and stored
   * with TTL. Returns the deserialized value.
   */
  async getDevicesList(loader: () => Promise<Device[]>): Promise<Device[]> {
    const cached = await safeGet(KEY_DEVICES_LIST);
    if (cached) {
      try {
        return JSON.parse(cached) as Device[];
      } catch (err) {
        // Cached blob is corrupt — nuke and fall back. Probably caused
        // by a Prisma schema change that broke the old shape.
        // eslint-disable-next-line no-console
        console.warn('[deviceCache] corrupt JSON, forcing refresh:', (err as Error).message);
        await safeDel(KEY_DEVICES_LIST);
      }
    }
    const fresh = await loader();
    // Fire-and-forget cache write — we don't want to delay the response
    // waiting for Redis. If the write errors, the next request will
    // re-load from DB and try again.
    void safeSetEx(KEY_DEVICES_LIST, TTL_SECONDS, JSON.stringify(fresh));
    return fresh;
  },

  /**
   * Invalidate after a mutation. Called from POST /devices, PATCH
   * /devices/:id, DELETE /devices/:id and from background paths that
   * change the device SET (e.g. discovery sync).
   */
  async invalidate(): Promise<void> {
    await safeDel(KEY_DEVICES_LIST);
  },
};