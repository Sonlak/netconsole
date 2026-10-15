/**
 * Tests for the NetBox HTTP client URL construction.
 *
 * Caught 2026-10-13: paths like "/dcim/devices/" were passed with a
 * leading slash to `new URL(path, base)`, which under the WHATWG URL
 * spec replaces the base path entirely. Combined with
 * `NETBOX_URL=http://host:8080/api/`, the client hit
 * `http://host:8080/dcim/devices/` — the 404 HTML page — instead of
 * `http://host:8080/api/dcim/devices/`. The fix lives in `netboxGet()`
 * (strips leading slashes before URL construction). These tests
 * guarantee the bug can't come back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function setNetboxEnv(url: string, token: string): void {
  process.env.NETBOX_URL = url;
  process.env.NETBOX_TOKEN = token;
}

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
}

describe('netboxClient URL construction', () => {
  beforeEach(() => {
    restoreEnv();
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('preserves /api/ prefix when base ends with / and path starts with /', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxDevices } = await import('../../../src/services/netboxClient.js');
    await listNetboxDevices(undefined, { limit: 5 });

    expect(capturedUrl).toMatch(/^http:\/\/host:8080\/api\/dcim\/devices\/\?limit=5/);
    expect(capturedUrl).not.toContain('/api//'); // double slash
    expect(capturedUrl).not.toMatch(/http:\/\/host:8080\/dcim\//); // /api/ got dropped
  });

  it('handles path with NO leading slash (defensive)', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxSites } = await import('../../../src/services/netboxClient.js');
    await listNetboxSites(undefined, { limit: 3 });

    expect(capturedUrl).toMatch(/^http:\/\/host:8080\/api\/dcim\/sites\/\?limit=3/);
  });

  it('handles base with NO trailing slash (defensive)', async () => {
    setNetboxEnv('http://host:8080/api', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxVlans } = await import('../../../src/services/netboxClient.js');
    await listNetboxVlans(undefined, { limit: 10 });

    // /api + /ipam/vlans/ (after stripping leading /) → base ends with /, path "ipam/vlans/"
    // NetBoxClient normalizes: strips leading / and ensures base ends with /
    expect(capturedUrl).toMatch(/^http:\/\/host:8080\/api\/ipam\/vlans\/\?limit=10/);
  });

  it('returns valid JSON for 200 responses (regression: HTML 404 must not slip through)', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    const fakeFetch = vi.fn(async () => {
      return new Response('<!DOCTYPE html><html><body>404</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxDevices, NetBoxError } = await import('../../../src/services/netboxClient.js');
    await expect(listNetboxDevices(undefined, { limit: 5 })).rejects.toBeInstanceOf(NetBoxError);
    await expect(listNetboxDevices(undefined, { limit: 5 })).rejects.toThrow(/NetBox HTTP 404/);
  });

  it('health check path /status/ resolves correctly', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ netbox_version: '4.6.10' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { netboxHealthCheck } = await import('../../../src/services/netboxClient.js');
    const ok = await netboxHealthCheck();
    expect(ok).toBe(true);
    expect(capturedUrl).toBe('http://host:8080/api/status/');
  });

  it('per-device interfaces endpoint concatenates id correctly', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxInterfaces } = await import('../../../src/services/netboxClient.js');
    await listNetboxInterfaces(undefined, 42, { limit: 100 });

    expect(capturedUrl).toMatch(/^http:\/\/host:8080\/api\/dcim\/interfaces\/\?device_id=42&limit=100/);
  });

  it('list_netbox_prefixes passes contains= param to NetBox IPAM', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxPrefixes } = await import('../../../src/services/netboxClient.js');
    await listNetboxPrefixes(undefined, { contains: '10.10.20.131' });

    // The `contains` query param tells NetBox IPAM "find the prefix that
    // contains this IP". Caught 2026-10-13: without this param, the assistant
    // couldn't answer "which subnet is 10.10.20.131 in?".
    expect(capturedUrl).toMatch(/^http:\/\/host:8080\/api\/ipam\/prefixes\/\?contains=10\.10\.20\.131/);
  });

  it('list_netbox_prefixes passes exact prefix= param for exact-match lookup', async () => {
    setNetboxEnv('http://host:8080/api/', 'tok-abc');
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const { listNetboxPrefixes } = await import('../../../src/services/netboxClient.js');
    await listNetboxPrefixes(undefined, { prefix: '10.10.20.0/24' });

    expect(capturedUrl).toMatch(/^http:\/\/host:8080\/api\/ipam\/prefixes\/\?prefix=10\.10\.20\.0%2F24/);
  });
});
