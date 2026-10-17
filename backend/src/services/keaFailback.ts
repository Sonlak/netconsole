/**
 * Kea DHCP auto-failback scheduler.
 *
 * Watches the DC↔DR HA pair and triggers a graceful `ha-switch-partner`
 * when the DC has recovered after a failover. Prevents the common
 * "ops forgets to swap back" footgun.
 *
 * Stability gates (all must hold before triggering):
 *   1. DC is reachable via control agent
 *   2. DC's HA state is "hot-standby" (i.e. it's joined the pair and
 *      has a synced lease DB; NOT in "waiting" / "syncing" / "unavailable")
 *   3. DR is currently the active site (recommendedAction === 'switchover-to-dc')
 *   4. DC has been healthy continuously for `KEA_FAILBACK_STABILITY_SECONDS`
 *      (default 300s = 5 min) — prevents flapping if DC keeps crashing
 *   5. At least `KEA_FAILBACK_COOLDOWN_SECONDS` (default 3600s = 1h) has
 *      passed since the last failback — prevents excessive switching
 *
 * In addition, the scheduler only acts if `KEA_AUTO_FAILBACK=true` AND
 * the runtime flag `autoFailbackEnabled` is true (toggleable via API).
 *
 * Operator overrides:
 *   - POST /api/dhcp/auto-failback { enabled: false }  → pause
 *   - POST /api/dhcp/auto-failback/check              → run check now
 *   - POST /api/dhcp/switchover { currentPrimary }     → manual swap
 *
 * The state below is in-memory only; a backend restart resets the
 * "DC stable since" timer (but DC's actual uptime on the Kea side is
 * unaffected — it just means we wait 5 more minutes after restart).
 */

import {
  type AutoFailbackStatus,
  getHaState,
  switchHaPartner,
} from './keaDhcp.js';

const RECENT_EVENT_LIMIT = 50;

const envBool = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
};

const envNumber = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const stabilityRequiredSeconds = envNumber('KEA_FAILBACK_STABILITY_SECONDS', 300);
const cooldownSeconds = envNumber('KEA_FAILBACK_COOLDOWN_SECONDS', 3600);
const checkIntervalSeconds = envNumber('KEA_FAILBACK_CHECK_INTERVAL_SECONDS', 30);

type RecentEvent = AutoFailbackStatus['recentEvents'][number];

type Runtime = {
  enabled: boolean;          // env var KEA_AUTO_FAILBACK (set at startup)
  runtimeEnabled: boolean;   // toggle via API
  dcHealthySince: number | null;  // ms timestamp when DC became healthy; null = not yet
  lastFailoverAt: number | null;
  lastFailbackAt: number | null;
  lastFailbackFrom: 'DC' | 'DR' | null;
  lastFailbackTo: 'DC' | 'DR' | null;
  lastFailbackReason: string | null;
  lastCheckedAt: number | null;
  recentEvents: RecentEvent[];
  intervalHandle: NodeJS.Timeout | null;
  isRunning: boolean;
};

const runtime: Runtime = {
  enabled: envBool('KEA_AUTO_FAILBACK', false),
  runtimeEnabled: envBool('KEA_AUTO_FAILBACK', false),
  dcHealthySince: null,
  lastFailoverAt: null,
  lastFailbackAt: null,
  lastFailbackFrom: null,
  lastFailbackTo: null,
  lastFailbackReason: null,
  lastCheckedAt: null,
  recentEvents: [],
  intervalHandle: null,
  isRunning: false,
};

function recordEvent(event: RecentEvent) {
  runtime.recentEvents.unshift(event);
  if (runtime.recentEvents.length > RECENT_EVENT_LIMIT) {
    runtime.recentEvents.length = RECENT_EVENT_LIMIT;
  }
}

function detectFailover(state: Awaited<ReturnType<typeof getHaState>>) {
  // A "failover" event is when the previously-known active site is no
  // longer the active site. We detect this by comparing the previous
  // event log to the current state.
  //
  // Simple heuristic: if the most recent failover/failback event's
  // "to" site is no longer the active site, we just observed another
  // swap. We log it as 'failover' if the new active site is not what
  // the env says is "normal" (DC), else 'failback'.
  //
  // For simplicity we mark a 'failover' event whenever the active site
  // changes from DC → DR, and a 'failback' when DR → DC. The auto
  // failback trigger is the more important of the two; failover
  // detection is informational (Kea handles failover automatically).
  const lastEvent = runtime.recentEvents.find(
    (e) => e.kind === 'failover' || e.kind === 'failback' || e.kind === 'switchover',
  );
  const previousActive = lastEvent ? lastEvent.to : 'DC';
  if (previousActive === state.activeSite) return;
  if (state.activeSite === null) return; // both down, don't log

  if (previousActive === 'DC' && state.activeSite === 'DR') {
    runtime.lastFailoverAt = Date.now();
    recordEvent({
      at: new Date().toISOString(),
      kind: 'failover',
      from: 'DC',
      to: 'DR',
      reason: 'DC became unreachable; DR promoted to primary',
    });
    console.warn('[kea-failback] FAILOVER detected: DC → DR');
  } else if (previousActive === 'DR' && state.activeSite === 'DC') {
    // This shouldn't happen automatically — only the failback scheduler
    // swaps DR → DC. If we see it, log as 'switchover' (could be manual).
    recordEvent({
      at: new Date().toISOString(),
      kind: 'switchover',
      from: 'DR',
      to: 'DC',
      reason: 'DR demoted; DC promoted (likely manual switchover)',
    });
    console.log('[kea-failback] DC active again (likely manual switchover)');
  }
}

/**
 * Run one failback check. Returns the current status + (if triggered)
 * the result of the ha-switch-partner call.
 */
export async function runFailbackCheck(trigger: 'scheduled' | 'manual' = 'scheduled'): Promise<{
  status: AutoFailbackStatus;
  switched: boolean;
  error?: string;
}> {
  runtime.lastCheckedAt = Date.now();
  runtime.isRunning = true;
  try {
    const state = await getHaState();
    const dc = state.peers.find((p) => p.site === 'DC');

    // Track DC's healthy-since timer
    if (dc?.reachable && dc.state === 'hot-standby') {
      if (runtime.dcHealthySince == null) {
        runtime.dcHealthySince = Date.now();
        console.log(
          `[kea-failback] DC is healthy (state=${dc.state}); stability timer reset`,
        );
      }
    } else {
      if (runtime.dcHealthySince != null) {
        console.log(
          `[kea-failback] DC no longer healthy ` +
            `(reachable=${dc?.reachable}, state=${dc?.state ?? 'unknown'}); stability timer reset`,
        );
      }
      runtime.dcHealthySince = null;
    }

    detectFailover(state);

    // Decide whether to trigger
    const canFailback = computeCanFailback(state);
    let switched = false;
    let error: string | undefined;

    if (trigger === 'manual' || (runtime.enabled && runtime.runtimeEnabled)) {
      if (canFailback.ok) {
        try {
          console.log(`[kea-failback] Triggering ha-switch-partner on DR (${canFailback.reason})`);
          const result = await switchHaPartner('DR');
          if (result.result === 0) {
            runtime.lastFailbackAt = Date.now();
            runtime.lastFailbackFrom = 'DR';
            runtime.lastFailbackTo = 'DC';
            runtime.lastFailbackReason = canFailback.reason;
            recordEvent({
              at: new Date().toISOString(),
              kind: 'failback',
              from: 'DR',
              to: 'DC',
              reason: canFailback.reason,
            });
            console.log('[kea-failback] FAILBACK completed: DR → DC');
            switched = true;
          } else {
            error = result.text || `Kea returned result=${result.result}`;
            console.error('[kea-failback] ha-switch-partner rejected:', error);
            recordEvent({
              at: new Date().toISOString(),
              kind: 'skip',
              from: 'DR',
              to: 'DC',
              reason: `Kea rejected: ${error}`,
            });
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          console.error('[kea-failback] ha-switch-partner threw:', error);
          recordEvent({
            at: new Date().toISOString(),
            kind: 'skip',
            from: 'DR',
            to: 'DC',
            reason: `Threw: ${error}`,
          });
        }
      } else if (trigger === 'manual') {
        // Manual check that couldn't trigger — record why for the UI
        recordEvent({
          at: new Date().toISOString(),
          kind: 'skip',
          from: state.activeSite,
          to: state.activeSite === 'DR' ? 'DC' : 'DR',
          reason: `Cannot failback: ${canFailback.reason}`,
        });
      }
    }

    return { status: getAutoFailbackStatus(), switched, error };
  } finally {
    runtime.isRunning = false;
  }
}

function computeCanFailback(
  state: Awaited<ReturnType<typeof getHaState>>,
): { ok: true; reason: string } | { ok: false; reason: string } {
  if (state.activeSite !== 'DR') {
    return { ok: false, reason: `Active site is ${state.activeSite ?? 'unknown'}, not DR` };
  }
  const dc = state.peers.find((p) => p.site === 'DC');
  if (!dc?.reachable) {
    return { ok: false, reason: 'DC not reachable' };
  }
  if (dc.state !== 'hot-standby') {
    return { ok: false, reason: `DC state is "${dc.state || 'unknown'}", expected "hot-standby"` };
  }
  if (runtime.dcHealthySince == null) {
    return { ok: false, reason: 'DC healthy-since timer not initialized' };
  }
  const stableFor = Math.floor((Date.now() - runtime.dcHealthySince) / 1000);
  if (stableFor < stabilityRequiredSeconds) {
    const remaining = stabilityRequiredSeconds - stableFor;
    return {
      ok: false,
      reason: `DC stable for ${stableFor}s, need ${stabilityRequiredSeconds}s (${remaining}s remaining)`,
    };
  }
  if (runtime.lastFailbackAt != null) {
    const sinceLast = Math.floor((Date.now() - runtime.lastFailbackAt) / 1000);
    if (sinceLast < cooldownSeconds) {
      const remaining = cooldownSeconds - sinceLast;
      return {
        ok: false,
        reason: `Cooldown: ${remaining}s remaining since last failback`,
      };
    }
  }
  return { ok: true, reason: 'All stability gates passed' };
}

export function getAutoFailbackStatus(): AutoFailbackStatus {
  const now = Date.now();
  const cooldownRemaining =
    runtime.lastFailbackAt == null
      ? 0
      : Math.max(0, cooldownSeconds - Math.floor((now - runtime.lastFailbackAt) / 1000));
  return {
    enabled: runtime.enabled && runtime.runtimeEnabled,
    lastCheckedAt: runtime.lastCheckedAt ? new Date(runtime.lastCheckedAt).toISOString() : null,
    lastFailoverAt: runtime.lastFailoverAt ? new Date(runtime.lastFailoverAt).toISOString() : null,
    lastFailbackAt: runtime.lastFailbackAt ? new Date(runtime.lastFailbackAt).toISOString() : null,
    lastFailbackReason: runtime.lastFailbackReason,
    lastFailbackFrom: runtime.lastFailbackFrom,
    lastFailbackTo: runtime.lastFailbackTo,
    cooldownRemainingSeconds: cooldownRemaining,
    stabilityRequiredSeconds,
    nextCheckAt: runtime.intervalHandle
      ? new Date(now + checkIntervalSeconds * 1000).toISOString()
      : null,
    recentEvents: [...runtime.recentEvents],
  };
}

export function setAutoFailbackEnabled(enabled: boolean) {
  runtime.runtimeEnabled = enabled;
  console.log(`[kea-failback] runtime enabled flag set to ${enabled}`);
}

/** Manual trigger (called from POST /api/dhcp/auto-failback/check). */
export async function triggerKeaFailbackCheck(_reason: string) {
  return runFailbackCheck('manual');
}

/**
 * Start the periodic scheduler. Returns a handle for graceful shutdown.
 * Safe to call multiple times — subsequent calls reset the interval.
 */
export function startKeccFailbackScheduler() {
  stopKeaFailbackScheduler();
  const intervalMs = Math.max(checkIntervalSeconds, 10) * 1000;
  console.log(
    `[kea-failback] scheduler starting: enabled=${runtime.enabled} ` +
      `interval=${checkIntervalSeconds}s stability=${stabilityRequiredSeconds}s cooldown=${cooldownSeconds}s`,
  );
  // Run once on startup (delayed slightly so the HTTP server is up)
  setTimeout(() => {
    void runFailbackCheck('scheduled');
  }, 5000);
  runtime.intervalHandle = setInterval(() => {
    void runFailbackCheck('scheduled');
  }, intervalMs);
}

export function stopKeaFailbackScheduler() {
  if (runtime.intervalHandle) {
    clearInterval(runtime.intervalHandle);
    runtime.intervalHandle = null;
  }
}

// Re-export the type expected by routes/dhcp.ts.
export type KEA_FAILBACK_RUNTIME = typeof runtime;
