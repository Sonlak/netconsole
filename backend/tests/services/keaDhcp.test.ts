/**
 * Tests for the Kea HA topology detection in `keaDhcp.ts`.
 *
 * Caught 2026-10-27 on the production host: prod's kea-dc1 runs
 * STANDALONE (KEA_HA_ENABLED=false → no libdhcp_ha hook), so the
 * control agent answers `ha-heartbeat` with
 *   HTTP 200 + {"result": 2, "text": "'ha-heartbeat' command not supported."}
 *
 * The old code derived reachability from `result === 0`, so it read the
 * healthy prod DC as "unreachable" and, because prod's
 * KEA_STANDBY_API_URL still pointed at the DEV lab host (10.10.20.30),
 * it reported the dev server as a live "DR active" peer. That produced
 * a bogus "failover DC → DR" event and made the prod DHCP dashboard
 * show the wrong server's data.
 *
 * These tests lock in:
 *   1. Reachability = transport-level (the agent answered), not result===0
 *   2. No DR peer is advertised when HA is off / no DR URL is set
 *   3. `auto`/`all` targets never fall through to an unconfigured DR URL
 *   4. Standalone deployments report mode "standalone" and DC as active
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const DC_URL = 'http://172.31.0.10:8000/';
const DR_URL = 'http://10.10.20.30:8001/';

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
}

/**
 * Stub fetch so that:
 *   - the DC URL answers with the given payload
 *   - the DR URL answers with the given payload (or refuses to connect)
 */
function stubKea(
  dc: { ok: boolean; body?: unknown; error?: string },
  dr?: { ok: boolean; body?: unknown; error?: string },
): { calls: string[] } {
  const calls: string[] = [];
  const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const spec = url.startsWith(DR_URL) ? dr : dc;
    if (!spec) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    if (!spec.ok) {
      throw new Error(spec.error ?? 'connect ECONNREFUSED');
    }
    return new Response(JSON.stringify(spec.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fakeFetch);
  return { calls };
}

const HEARTBEAT_OK = {
  arguments: { state: 'hot-standby', scopes: ['kea-dc1'], 'date-time': 'Tue, 27 Oct 2026 08:13:41 GMT' },
  result: 0,
  text: 'HA peer status returned.',
};

const HEARTBEAT_UNSUPPORTED = {
  result: 2,
  text: "'ha-heartbeat' command not supported.",
};

async function loadKeaModule() {
  return await import('../../../src/services/keaDhcp.js');
}

describe('keaDhcp HA topology detection', () => {
  beforeEach(() => {
    restoreEnv();
    vi.resetModules();
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats a standalone Kea (result=2) as REACHABLE', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    delete process.env.KEA_STANDBY_API_URL;
    stubKea({ ok: true, body: [HEARTBEAT_UNSUPPORTED] });

    const { getHaState } = await loadKeaModule();
    const state = await getHaState();

    expect(state.peers).toHaveLength(1);
    expect(state.peers[0].site).toBe('DC');
    expect(state.peers[0].reachable).toBe(true);
    expect(state.peers[0].state).toBe('standalone');
  });

  it('does not advertise a DR peer when HA is disabled', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    process.env.KEA_STANDBY_API_URL = DR_URL; // stale dev URL — must be ignored
    stubKea({ ok: true, body: [HEARTBEAT_UNSUPPORTED] });

    const { getHaState } = await loadKeaModule();
    const state = await getHaState();

    expect(state.peers.map((p) => p.site)).toEqual(['DC']);
    expect(state.mode).toBe('standalone');
    expect(state.activeSite).toBe('DC');
    expect(state.recommendedAction).toBe('none');
  });

  it('never probes the DR URL when no DR peer is configured', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    process.env.KEA_STANDBY_API_URL = DR_URL;
    const { calls } = stubKea({ ok: true, body: [HEARTBEAT_UNSUPPORTED] });

    const { getHaState } = await loadKeaModule();
    await getHaState();

    expect(calls.some((c) => c.startsWith(DR_URL))).toBe(false);
  });

  it('never falls through to the DR URL for "auto" commands', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    process.env.KEA_STANDBY_API_URL = DR_URL;
    const { calls } = stubKea({ ok: true, body: [HEARTBEAT_UNSUPPORTED] });

    const { keaCommand } = await loadKeaModule();
    await keaCommand('config-get');

    expect(calls.every((c) => c.startsWith(DC_URL))).toBe(true);
  });

  it('rejects an explicit DR target when no DR peer is configured', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    delete process.env.KEA_STANDBY_API_URL;
    stubKea({ ok: true, body: [HEARTBEAT_UNSUPPORTED] });

    const { keaCommand } = await loadKeaModule();
    await expect(keaCommand('ha-switch-partner', undefined, { target: 'dr' })).rejects.toThrow(
      /not configured/i,
    );
  });

  it('still reports a real DC↔DR pair as hot-standby when both are up', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'true';
    process.env.KEA_STANDBY_API_URL = DR_URL;
    stubKea(
      { ok: true, body: [HEARTBEAT_OK] },
      {
        ok: true,
        body: [
          {
            arguments: { state: 'hot-standby', scopes: ['kea-dr1'], 'date-time': 'Tue, 27 Oct 2026 08:13:41 GMT' },
            result: 0,
            text: 'HA peer status returned.',
          },
        ],
      },
    );

    const { getHaState } = await loadKeaModule();
    const state = await getHaState();

    expect(state.peers.map((p) => p.site)).toEqual(['DC', 'DR']);
    expect(state.mode).toBe('hot-standby');
    expect(state.activeSite).toBe('DC');
    expect(state.peers.every((p) => p.reachable)).toBe(true);
  });

  it('marks a peer unreachable when the control agent does not answer', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'true';
    process.env.KEA_STANDBY_API_URL = DR_URL;
    stubKea(
      { ok: false, error: 'connect ECONNREFUSED' },
      {
        ok: true,
        body: [
          {
            arguments: { state: 'hot-standby', scopes: ['kea-dr1'] },
            result: 0,
            text: 'HA peer status returned.',
          },
        ],
      },
    );

    const { getHaState } = await loadKeaModule();
    const state = await getHaState();

    expect(state.peers.find((p) => p.site === 'DC')?.reachable).toBe(false);
    expect(state.peers.find((p) => p.site === 'DR')?.reachable).toBe(true);
    expect(state.activeSite).toBe('DR');
  });

  it('does not label an unrelated Kea error as "standalone"', async () => {
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    delete process.env.KEA_STANDBY_API_URL;
    // result=1 with an unrelated error — the agent answered, but the
    // failure is NOT "ha-heartbeat is unsupported".
    stubKea({ ok: true, body: [{ result: 1, text: 'unexpected internal error' }] });

    const { getHaState } = await loadKeaModule();
    const state = await getHaState();

    // Still reachable (the agent answered)…
    expect(state.peers[0].reachable).toBe(true);
    // …but NOT labelled standalone, because that label is reserved for
    // "the HA hook is not loaded".
    expect(state.peers[0].state).toBe('');
  });
});
