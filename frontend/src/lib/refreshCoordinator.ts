// Cross-tab single-flight refresh coordinator.
//
// Why this file exists
// --------------------
// The backend's refresh-token flow has strict replay protection (see
// backend/src/lib/refreshTokens.ts:84-91): every successful /api/auth/refresh
// call CONSUMES the old refresh row and rotates a new pair. If two tabs of
// the same user POST /refresh within the same access-token window, the
// second POST lands on a token whose row already has `consumedAt` set, the
// backend fires `replay_detected`, and the entire refresh chain for that
// user is revoked. Every tab then has to log back in.
//
// What this module does
// ---------------------
// Ensures only ONE tab per browser calls /api/auth/refresh at any given
// moment. Other tabs defer to the leader, wait for the BroadcastChannel
// "refresh_succeeded" message, and copy the new (access, refresh) pair
// into their own localStorage. The per-tab single-flight in http.ts still
// runs as a second layer — together they form a two-tier guard.
//
// Algorithm
// ---------
//   1. On 401, candidate tab checks localStorage (LEADER_KEY) for an
//      active leader claim (startedAt within the last 8s).
//   2. If a claim exists -> wait as follower; resolve when the leader
//      broadcasts refresh_succeeded.
//   3. If no claim exists -> write our own claim with a fresh requestId
//      and startedAt = Date.now().
//   4. Wait CLAIM_WINDOW_MS (80ms) and re-read. If our requestId
//      survived, we're the leader. If something else is there, defer
//      as follower.
//   5. Leader: POST /refresh via refreshTokens() (which writes the new
//      tokens to localStorage on success). A 3s heartbeat refreshes
//      the claim so a slow backend doesn't cause premature takeover.
//      On success, broadcast the new tokens to followers; on failure,
//      broadcast refresh_failed.
//
// Edge cases
// ----------
//   - BroadcastChannel / localStorage unavailable -> fall back to direct
//     refreshTokens() call. Per-tab single-flight still prevents concurrent
//     calls within one tab; cross-tab coordination is lost but the worst
//     case is the old behaviour (occasional replay_detected -> re-login).
//   - Leader tab crashes mid-refresh -> heartbeat stops, claim expires
//     after 8s, another tab can claim and retry.
//   - Leader refresh hangs >20s -> followers time out and clear local
//     auth (they're already broken; the leader's eventual broadcast is
//     ignored). User lands on /login.
//   - Two tabs both POST in the rare case that localStorage hasn't synced
//     by CLAIM_WINDOW_MS -> at most one tab triggers replay_detected.
//     Old behaviour was the same; this fix is not a regression.
//
// Security note
// -------------
// This is purely a UX fix. The single-tab behaviour is identical to
// before (one leader claim, one POST, one broadcast nobody listens to).
// Server-side replay detection is unchanged.

import {
  refreshTokens as apiRefresh,
  clearAllAuth,
  setToken,
  setRefreshToken,
  getToken,
  getRefreshToken,
  type RefreshResponse,
} from '../api/auth';

const BC_NAME = 'nc_auth';
const LEADER_KEY = 'nc_refresh_leader';
const LEADER_TTL_MS = 8_000;        // claim expires 8s after last write
const HEARTBEAT_MS = 3_000;         // refresh claim every 3s while in flight
const CLAIM_WINDOW_MS = 80;         // wait this long to detect a racing tab
const FOLLOWER_TIMEOUT_MS = 20_000; // give up waiting after 20s

interface LeaderClaim {
  requestId: string;
  startedAt: number;
}

type AuthMessage =
  | { type: 'refresh_succeeded'; token: string; refreshToken: string; refreshExpiresAt: string }
  | { type: 'refresh_failed'; code?: string }
  | { type: 'auth_cleared' }
  | { type: 'logout' };

interface Follower {
  resolve: (tokens: RefreshResponse) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

let channel: BroadcastChannel | null = null;
const followers: Follower[] = [];

// --- Capability detection ---

function hasCoordination(): boolean {
  return (
    typeof BroadcastChannel !== 'undefined' &&
    typeof localStorage !== 'undefined' &&
    typeof crypto !== 'undefined'
  );
}

// --- BroadcastChannel plumbing ---

function getChannel(): BroadcastChannel | null {
  if (!hasCoordination()) return null;
  if (!channel) {
    channel = new BroadcastChannel(BC_NAME);
    channel.addEventListener('message', (event) => {
      handleBroadcast(event.data as AuthMessage);
    });
  }
  return channel;
}

function handleBroadcast(msg: AuthMessage): void {
  switch (msg.type) {
    case 'refresh_succeeded':
      setToken(msg.token);
      setRefreshToken(msg.refreshToken, msg.refreshExpiresAt);
      flushFollowers(true, {
        token: msg.token,
        refreshToken: msg.refreshToken,
        refreshExpiresAt: msg.refreshExpiresAt,
      });
      break;
    case 'refresh_failed':
    case 'auth_cleared':
    case 'logout':
      clearAllAuth();
      flushFollowers(false, undefined, new Error('Auth cleared in another tab'));
      break;
  }
}

function flushFollowers(
  success: boolean,
  result?: RefreshResponse,
  err?: Error,
): void {
  while (followers.length) {
    const f = followers.shift()!;
    if (f.settled) continue;
    f.settled = true;
    if (success && result) {
      f.resolve(result);
    } else {
      f.reject(err ?? new Error('Auth cleared in another tab'));
    }
  }
}

// --- Leader claim via localStorage ---

function readLeader(): LeaderClaim | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    if (!raw) return null;
    const claim = JSON.parse(raw) as LeaderClaim;
    if (
      typeof claim.startedAt !== 'number' ||
      typeof claim.requestId !== 'string'
    ) {
      return null;
    }
    if (Date.now() - claim.startedAt > LEADER_TTL_MS) {
      // Stale claim — treat as no leader.
      return null;
    }
    return claim;
  } catch {
    return null;
  }
}

function writeLeader(requestId: string): void {
  if (typeof localStorage === 'undefined') return;
  const claim: LeaderClaim = { requestId, startedAt: Date.now() };
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify(claim));
  } catch {
    // localStorage may throw in private mode or when storage is full.
    // Coordination is best-effort; fall back to direct refresh.
  }
}

function clearLeader(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LEADER_KEY);
  } catch {
    // ignored
  }
}

// --- Follower wait ---

function awaitFollower(): Promise<RefreshResponse> {
  return new Promise<RefreshResponse>((resolve, reject) => {
    let settled = false;

    const entry: Follower = {
      resolve: (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      },
      reject: (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      },
      settled: false,
    };
    followers.push(entry);

    // Hard timeout — if the leader never broadcasts (hung backend,
    // crashed tab before broadcast, etc.), don't strand the follower.
    setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      const i = followers.indexOf(entry);
      if (i >= 0) followers.splice(i, 1);
      reject(new Error('Refresh coordination timeout — leader did not respond'));
    }, FOLLOWER_TIMEOUT_MS);
  });
}

// --- Leader heartbeat (keeps claim alive during slow refresh) ---

function startHeartbeat(requestId: string): () => void {
  const timer = setInterval(() => {
    const current = readLeader();
    if (!current || current.requestId !== requestId) {
      // Lost leadership (another tab claimed after our claim expired)
      // — stop heartbeat so we don't accidentally re-claim.
      clearInterval(timer);
      return;
    }
    writeLeader(requestId);
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

// --- Helpers ---

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers without randomUUID.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-tab-coordinated refresh. Resolves with the new (access, refresh)
 * pair on success and updates localStorage. Rejects on any failure
 * (replay, expired, invalid, network, timeout). Only one tab per browser
 * will POST /api/auth/refresh at any given moment.
 *
 * Safe to call concurrently within a tab — subsequent calls during an
 * in-flight refresh will wait for the same in-tab single-flight promise
 * set up by http.ts.
 */
export async function coordinatedRefresh(): Promise<RefreshResponse> {
  if (!hasCoordination()) {
    // Fallback: no cross-tab coordination. Per-tab single-flight in
    // http.ts still prevents concurrent calls within one tab.
    return apiRefresh();
  }

  // Make sure the channel listener is attached so we receive the
  // leader's broadcast even if we don't become the leader.
  getChannel();

  // Step 1: is there an existing leader?
  let existing: LeaderClaim | null;
  try {
    existing = readLeader();
  } catch {
    existing = null;
  }
  if (existing) {
    return awaitFollower();
  }

  // Step 2-4: try to claim leadership. Any failure here is non-fatal;
  // we fall back to a direct refresh (which may waste one POST if a
  // parallel tab also falls back, but that's the old behaviour).
  const requestId = generateRequestId();
  try {
    writeLeader(requestId);
    await sleep(CLAIM_WINDOW_MS);
    const current = readLeader();
    if (!current || current.requestId !== requestId) {
      return awaitFollower();
    }
  } catch {
    return apiRefresh();
  }

  // Step 5: we're the leader. Heartbeat keeps our claim alive while
  // the backend processes the refresh.
  const stopHeartbeat = startHeartbeat(requestId);
  const ch = getChannel();
  try {
    const result = await apiRefresh();
    if (ch) {
      try {
        ch.postMessage({
          type: 'refresh_succeeded',
          token: result.token,
          refreshToken: result.refreshToken,
          refreshExpiresAt: result.refreshExpiresAt,
        });
      } catch {
        // Channel may have been closed (e.g. page navigating away) —
        // the local refresh already succeeded, so we just return.
      }
    }
    return result;
  } catch (err) {
    if (ch) {
      try {
        const code = (err as { code?: string } | null)?.code;
        ch.postMessage({ type: 'refresh_failed', code });
      } catch {
        // ignored
      }
    }
    throw err;
  } finally {
    stopHeartbeat();
    clearLeader();
  }
}

/**
 * Broadcast a logout event so other tabs also clear their local auth
 * state. Call AFTER local clearAllAuth(). No-op if BroadcastChannel is
 * unavailable.
 */
export function broadcastLogout(): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'logout' });
  } catch {
    // ignored
  }
}

/**
 * Broadcast a generic "auth cleared" event — used after replay_detected
 * or any irrecoverable auth failure so sibling tabs don't keep trying
 * with the now-dead refresh token. No-op if BroadcastChannel unavailable.
 */
export function broadcastAuthCleared(): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'auth_cleared' });
  } catch {
    // ignored
  }
}

/**
 * Diagnostic snapshot — exposed for debugging only. Not used in production
 * code paths.
 */
export function __debugState(): {
  hasChannel: boolean;
  followerCount: number;
  hasLeader: boolean;
  hasTokens: boolean;
} {
  return {
    hasChannel: channel !== null,
    followerCount: followers.length,
    hasLeader: readLeader() !== null,
    hasTokens: getToken() !== null && getRefreshToken() !== null,
  };
}
