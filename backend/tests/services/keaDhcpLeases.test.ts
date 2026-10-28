/**
 * Tests for the ORPHAN LEASE filter in `keaDhcp.ts::listDhcpLeases`.
 *
 * Caught 2026-10-28 on production: prod's kea-dc1 shipped the LAB subnet
 * list (10.1.201.0/24 ... 10.1.204.0/24) inside the image template, so the
 * prod console showed the dev/lab pools — and the leases of those lab
 * subnets were still in the memfile lease DB even after the pool list was
 * replaced with an empty one.
 *
 * A lease whose `subnet-id` is not present in the live Kea config does not
 * belong to any configured pool and must not be reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const DC_URL = 'http://172.31.0.10:8000/';

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
}

vi.mock('../../src/services/arpAddress.js', () => ({
  buildClientLookup: vi.fn(async () => new Map()),
}));

vi.mock('../../src/services/collectableDevices.js', () => ({
  listCollectableDevices: vi.fn(async () => []),
}));

const CONFIG_GET = {
  arguments: {
    Dhcp4: {
      subnet4: [
        {
          id: 101,
          subnet: '10.10.101.0/24',
          'user-context': { site: 'NKKN', vlan: 101, name: 'NKKN VLAN101', gateway: '10.10.101.254' },
        },
      ],
    },
  },
  result: 0,
  text: '',
};

const LEASE_GET_ALL = {
  arguments: {
    leases: [
      {
        'ip-address': '10.10.101.50',
        'hw-address': 'aa:bb:cc:dd:ee:01',
        hostname: 'pc-real',
        'subnet-id': 101,
        'valid-lft': 3600,
        cltt: 1750000000,
        state: 0,
      },
      {
        // Orphan: subnet-id 201 is NOT in the live config any more.
        'ip-address': '10.1.201.10',
        'hw-address': 'aa:bb:cc:dd:ee:02',
        hostname: 'lab-pc',
        'subnet-id': 201,
        'valid-lft': 3600,
        cltt: 1750000000,
        state: 0,
      },
    ],
  },
  result: 0,
  text: '',
};

describe('keaDhcp lease listing', () => {
  beforeEach(() => {
    restoreEnv();
    vi.resetModules();
    process.env.KEA_API_URL = DC_URL;
    process.env.KEA_HA_ENABLED = 'false';
    delete process.env.KEA_STANDBY_API_URL;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = String(init?.body ?? '');
        const body = payload.includes('lease4-get-all') ? LEASE_GET_ALL : CONFIG_GET;
        return new Response(JSON.stringify([body]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('drops leases whose subnet is not in the live config', async () => {
    const { listDhcpLeases } = await import('../../src/services/keaDhcp.js');
    const leases = await listDhcpLeases();

    expect(leases.map((l) => l.ip)).toEqual(['10.10.101.50']);
    expect(leases[0].site).toBe('NKKN');
  });

  it('drops orphan leases when a specific subnet is requested too', async () => {
    const { listDhcpLeases } = await import('../../src/services/keaDhcp.js');
    const leases = await listDhcpLeases(201);

    expect(leases).toEqual([]);
  });
});
