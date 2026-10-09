/**
 * Unit tests for the tool handler dispatcher.
 *
 * Strategy: stub every external dependency (prisma, kea, fabric,
 * logs) so the test runs in < 50ms with no DB. The point of these
 * tests is to lock down the contract: "given args X, the handler
 * must call service Y with parameters Z and return a ToolResult
 * shaped like W". If we add a new tool we add a test here.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// Stub prisma first so anything that imports the lib doesn't blow up.
const deviceFindFirst = vi.fn();
const deviceFindMany = vi.fn();
const jobFindMany = vi.fn();
const jobCreate = vi.fn();

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      findFirst: (...args: unknown[]) => deviceFindFirst(...args),
      findMany: (...args: unknown[]) => deviceFindMany(...args),
    },
    job: {
      findMany: (...args: unknown[]) => jobFindMany(...args),
      create: (...args: unknown[]) => jobCreate(...args),
    },
  },
}));

const getMacAddressInventory = vi.fn();
const getFabricTopology = vi.fn();
const listDhcpLeases = vi.fn();
const getDhcpDashboard = vi.fn();
const listLogs = vi.fn();
const listAlerts = vi.fn();
const queueLogsCollection = vi.fn();
const getLatestInterfacesJob = vi.fn();
const queueInterfaceAction = vi.fn();
const parseInterfaceActionPayload = vi.fn();

vi.mock('../../../src/services/macAddress.js', () => ({
  getMacAddressInventory: (...args: unknown[]) => getMacAddressInventory(...args),
}));
vi.mock('../../../src/services/fabricTopology.js', () => ({
  getFabricTopology: (...args: unknown[]) => getFabricTopology(...args),
}));
vi.mock('../../../src/services/keaDhcp.js', () => ({
  listDhcpLeases: (...args: unknown[]) => listDhcpLeases(...args),
  getDhcpDashboard: (...args: unknown[]) => getDhcpDashboard(...args),
}));
vi.mock('../../../src/services/logs.js', () => ({
  listLogs: (...args: unknown[]) => listLogs(...args),
  queueLogsCollection: (...args: unknown[]) => queueLogsCollection(...args),
}));
vi.mock('../../../src/services/logAlerts.js', () => ({
  listAlerts: (...args: unknown[]) => listAlerts(...args),
}));
vi.mock('../../../src/services/interfaces.js', () => ({
  getLatestInterfacesJob: (...args: unknown[]) => getLatestInterfacesJob(...args),
  queueInterfaceAction: (...args: unknown[]) => queueInterfaceAction(...args),
  parseInterfaceActionPayload: (...args: unknown[]) => parseInterfaceActionPayload(...args),
}));

const { HANDLERS, mapRole } = await import('../../../src/services/assistant/handlers.js');

const ctx = {
  userId: 'user-1',
  username: 'admin',
  role: 'ADMIN' as const,
  sessionId: 'sess-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mapRole', () => {
  it('maps ADMIN/OPERATOR/VIEWER/WORKER + handles null', () => {
    expect(mapRole('ADMIN')).toBe('ADMIN');
    expect(mapRole('OPERATOR')).toBe('OPERATOR');
    expect(mapRole('VIEWER')).toBe('VIEWER');
    expect(mapRole('worker')).toBe('WORKER');
    expect(mapRole(null)).toBe('VIEWER');
    expect(mapRole(undefined)).toBe('VIEWER');
  });
});

describe('lookup_mac', () => {
  it('normalises MAC and returns empty result when not found', async () => {
    getMacAddressInventory.mockResolvedValueOnce({ rows: [] });
    const result = await HANDLERS.lookup_mac({ mac: '00:11:22:33:44:55' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.preview).toMatchObject({ found: 0, mac: '00:11:22:33:44:55' });
  });

  it('normalises a MAC without colons', async () => {
    getMacAddressInventory.mockResolvedValueOnce({ rows: [] });
    const result = await HANDLERS.lookup_mac({ mac: '001122334455' }, ctx);
    expect(result.ok).toBe(true);
    expect((result.preview as { mac: string }).mac).toBe('00:11:22:33:44:55');
  });

  it('rejects an invalid MAC length', async () => {
    const result = await HANDLERS.lookup_mac({ mac: '0:1:2' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid MAC/);
  });

  it('returns matching rows when found', async () => {
    getMacAddressInventory.mockResolvedValueOnce({
      rows: [
        {
          mac: 'aa:bb:cc:dd:ee:ff',
          ip: '10.10.20.5',
          vlan: '10',
          interface: 'ge-0/0/5',
          deviceId: 'dev-1',
          deviceName: 'LAB-F2-AS-01',
          deviceIp: '10.10.20.1',
          site: 'NKKN',
          floor: 'F2',
          collectedAt: '2026-10-09T00:00:00Z',
        },
      ],
    });
    const result = await HANDLERS.lookup_mac({ mac: 'AABBCCDDEEFF' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { found: number; entries: Array<{ device: string; port: string }> };
    expect(preview.found).toBe(1);
    expect(preview.entries[0].device).toBe('LAB-F2-AS-01');
    expect(preview.entries[0].port).toBe('ge-0/0/5');
  });
});

describe('get_device', () => {
  it('returns empty result when no match', async () => {
    deviceFindMany.mockResolvedValueOnce([]);
    const result = await HANDLERS.get_device({ query: 'NONEXISTENT' }, ctx);
    expect(result.ok).toBe(true);
    expect((result.preview as { found: number }).found).toBe(0);
  });

  it('returns device list when found', async () => {
    deviceFindMany.mockResolvedValueOnce([
      {
        id: 'dev-1',
        name: 'LAB-F2-AS-01',
        ip: '10.10.20.1',
        status: 'ONLINE',
        vendor: 'juniper',
        model: 'EX3400',
        version: '23.4R2',
        site: 'NKKN',
        floor: 'F2',
        lastPingAt: new Date(),
        lastPingMs: 3,
      },
    ]);
    const result = await HANDLERS.get_device({ query: 'lab-f2-as-01' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { found: number; devices: Array<{ name: string }> };
    expect(preview.found).toBe(1);
    expect(preview.devices[0].name).toBe('LAB-F2-AS-01');
  });
});

describe('get_device_interfaces', () => {
  it('returns empty snapshot message when no job', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01' });
    getLatestInterfacesJob.mockResolvedValueOnce(null);
    const result = await HANDLERS.get_device_interfaces({ device_name: 'LAB-F2-AS-01' }, ctx);
    expect(result.ok).toBe(true);
    expect((result.preview as { lastCollectedAt: null }).lastCollectedAt).toBeNull();
  });

  it('returns interface list from latest job', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01' });
    getLatestInterfacesJob.mockResolvedValueOnce({
      id: 'job-1',
      updatedAt: new Date('2026-10-09T01:00:00Z'),
      result: {
        interfaces: [
          { name: 'ge-0/0/0', adminStatus: 'up', operStatus: 'up' },
          { name: 'ge-0/0/1', adminStatus: 'down', operStatus: 'down' },
        ],
      },
    });
    const result = await HANDLERS.get_device_interfaces(
      { device_name: 'LAB-F2-AS-01', only_down: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { total: number; interfaces: Array<{ name: string }> };
    expect(preview.total).toBe(1);
    expect(preview.interfaces[0].name).toBe('ge-0/0/1');
  });

  it('returns not-found when device missing', async () => {
    deviceFindFirst.mockResolvedValueOnce(null);
    const result = await HANDLERS.get_device_interfaces({ device_name: 'NOPE' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('list_dhcp_leases', () => {
  it('passes subnet_id through and trims to limit', async () => {
    const leases = Array.from({ length: 60 }, (_, i) => ({
      ip: `10.10.20.${i + 1}`,
      mac: `aa:bb:cc:00:00:${i.toString(16).padStart(2, '0')}`,
      hostname: `host-${i}`,
      clientDevice: '',
      clientPort: '',
      subnetId: 1,
      subnet: '10.10.20.0/24',
      vlan: 10,
      site: 'NKKN',
      validLifetime: 3600,
      cltt: 0,
      expiresAt: null,
      state: 0,
      stateLabel: 'active',
      reserved: false,
      note: '',
    }));
    listDhcpLeases.mockResolvedValueOnce(leases);
    const result = await HANDLERS.list_dhcp_leases({ subnet_id: 1, limit: 10 }, ctx);
    expect(result.ok).toBe(true);
    expect(listDhcpLeases).toHaveBeenCalledWith(1);
    const preview = result.preview as { total: number; returned: number; truncated: boolean };
    expect(preview.total).toBe(60);
    expect(preview.returned).toBe(10);
    expect(preview.truncated).toBe(true);
  });
});

describe('get_dhcp_pool_status', () => {
  it('returns dashboard pools + flags high utilization', async () => {
    getDhcpDashboard.mockResolvedValueOnce({
      totals: { sites: 2, pools: 5, leased: 100, poolSize: 200 },
      ha: { mode: 'hot-standby', peers: [], active: 'kea-primary' },
      pools: [
        { subnetId: 1, name: 's1', site: 'NKKN', vlan: 10, subnet: '10.10.20.0/24', pool: '10.10.20.10-10.10.20.100', gateway: '10.10.20.1', leased: 90, poolSize: 90, utilization: 100 },
        { subnetId: 2, name: 's2', site: 'NKKN', vlan: 20, subnet: '10.10.30.0/24', pool: '10.10.30.10-10.10.30.100', gateway: '10.10.30.1', leased: 5, poolSize: 90, utilization: 5.6 },
      ],
    });
    const result = await HANDLERS.get_dhcp_pool_status({ only_high_utilization: true }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { pools: Array<{ subnetId: number }> };
    expect(preview.pools).toHaveLength(1);
    expect(preview.pools[0].subnetId).toBe(1);
  });
});

describe('get_fabric_topology', () => {
  it('counts nodes + links', async () => {
    getFabricTopology.mockResolvedValueOnce({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ id: 'l1' }],
    });
    const result = await HANDLERS.get_fabric_topology({ site: 'NKKN' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { nodeCount: number; linkCount: number };
    expect(preview.nodeCount).toBe(2);
    expect(preview.linkCount).toBe(1);
  });
});

describe('search_recent_jobs', () => {
  it('maps jobs to compact shape', async () => {
    jobFindMany.mockResolvedValueOnce([
      {
        id: 'job-1',
        type: 'GET_ARP',
        status: 'SUCCESS',
        device: { name: 'LAB-F2-AS-01', ip: '10.10.20.1' },
        createdBy: { username: 'admin' },
        createdAt: new Date('2026-10-09T00:00:00Z'),
        error: null,
      },
      {
        id: 'job-2',
        type: 'INTERFACE_ACTION',
        status: 'FAILED',
        device: { name: 'LAB-F2-DS-01', ip: '10.10.20.2' },
        createdBy: { username: 'operator' },
        createdAt: new Date('2026-10-09T01:00:00Z'),
        error: 'timeout',
      },
    ]);
    const result = await HANDLERS.search_recent_jobs({ limit: 20 }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { jobs: Array<{ id: string; status: string }> };
    expect(preview.jobs).toHaveLength(2);
    expect(preview.jobs[0].id).toBe('job-1');
  });
});

describe('get_recent_logs', () => {
  it('maps logs to compact shape and uses 1h default', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01' });
    listLogs.mockResolvedValueOnce({
      rows: [
        { timestamp: '2026-10-09T00:00:00Z', severity: 'ERROR', facility: 'DAEMON', program: 'mgd', message: 'configuration check failed' },
      ],
      lastUpdatedAt: '2026-10-09T00:00:00Z',
    });
    const result = await HANDLERS.get_recent_logs({ device_name: 'LAB-F2-AS-01' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { logs: Array<{ severity: string }> };
    expect(preview.logs[0].severity).toBe('ERROR');
  });

  it('returns not-found when device missing', async () => {
    deviceFindFirst.mockResolvedValueOnce(null);
    const result = await HANDLERS.get_recent_logs({ device_name: 'NOPE' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('get_unacknowledged_alerts', () => {
  it('passes limit through and maps shape', async () => {
    listAlerts.mockResolvedValueOnce([
      { id: 'a-1', ruleId: 'r-1', ruleName: 'critical', deviceId: null, deviceIp: '10.10.20.1', severity: 'CRITICAL', hostname: 'f2-as-01', program: 'mgd', message: 'link down', timestamp: '2026-10-09T00:00:00Z' },
    ]);
    const result = await HANDLERS.get_unacknowledged_alerts({ limit: 5 }, ctx);
    expect(result.ok).toBe(true);
    expect(listAlerts).toHaveBeenCalledWith({ acknowledged: false, limit: 5 });
  });
});

describe('queue_interface_action (WRITE)', () => {
  it('refuses to queue when device is OFFLINE', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'OFFLINE' });
    const result = await HANDLERS.queue_interface_action(
      { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/OFFLINE/);
  });

  it('queues an interface action and returns jobId', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE' });
    parseInterfaceActionPayload.mockReturnValueOnce({
      action: 'shut',
      interface: 'ge-0/0/5',
    });
    queueInterfaceAction.mockResolvedValueOnce({
      kind: 'created',
      job: { id: 'job-99', type: 'INTERFACE_ACTION', status: 'PENDING', createdAt: new Date(), deviceId: 'dev-1', payload: { action: 'shut', interface: 'ge-0/0/5' } },
    });
    const result = await HANDLERS.queue_interface_action(
      { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { jobId: string };
    expect(preview.jobId).toBe('job-99');
  });

  it('returns busy error when device is locked', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE' });
    parseInterfaceActionPayload.mockReturnValueOnce({ action: 'shut', interface: 'ge-0/0/5' });
    queueInterfaceAction.mockResolvedValueOnce({
      kind: 'busy',
      error: { code: 'device_locked', blockingJob: { id: 'j-1', type: 'GET_ARP', status: 'RUNNING', createdAt: new Date(), createdByUsername: 'admin' } },
    });
    const result = await HANDLERS.queue_interface_action(
      { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'shut' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Device busy/);
  });
});

describe('queue_log_collect (WRITE)', () => {
  it('passes through to queueLogsCollection with no filter', async () => {
    queueLogsCollection.mockResolvedValueOnce({ deviceCount: 12, queued: 12, message: undefined });
    const result = await HANDLERS.queue_log_collect({ force: true }, ctx);
    expect(result.ok).toBe(true);
    expect(queueLogsCollection).toHaveBeenCalledWith({ deviceIds: undefined, force: true });
  });

  it('resolves device names to ids', async () => {
    deviceFindMany.mockResolvedValueOnce([{ id: 'dev-1', name: 'LAB-F2-AS-01' }]);
    queueLogsCollection.mockResolvedValueOnce({ deviceCount: 1, queued: 1, message: undefined });
    const result = await HANDLERS.queue_log_collect(
      { device_names: ['LAB-F2-AS-01'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(queueLogsCollection).toHaveBeenCalledWith({ deviceIds: ['dev-1'], force: false });
  });
});

describe('queue_managed_check (WRITE)', () => {
  it('creates a MANAGED_CHECK job with URGENT priority', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1' });
    jobCreate.mockResolvedValueOnce({
      id: 'job-7',
      type: 'MANAGED_CHECK',
      status: 'PENDING',
      createdAt: new Date(),
      deviceId: 'dev-1',
    });
    const result = await HANDLERS.queue_managed_check({ device_name: 'LAB-F2-AS-01' }, ctx);
    expect(result.ok).toBe(true);
    expect(jobCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'MANAGED_CHECK', priority: 200 }),
    }));
  });
});
