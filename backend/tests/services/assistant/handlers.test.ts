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
const jobFindFirst = vi.fn();
const jobCreate = vi.fn();
const savedConfigUpsert = vi.fn();
const txExecute = vi.fn();

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      findFirst: (...args: unknown[]) => deviceFindFirst(...args),
      findMany: (...args: unknown[]) => deviceFindMany(...args),
    },
    job: {
      findMany: (...args: unknown[]) => jobFindMany(...args),
      findFirst: (...args: unknown[]) => jobFindFirst(...args),
      create: (...args: unknown[]) => jobCreate(...args),
    },
    deviceSavedConfig: {
      upsert: (...args: unknown[]) => savedConfigUpsert(...args),
    },
    // The handler does `prisma.$transaction((tx) => tryCreateDeviceJob(tx, ...))`.
    // We unwrap the callback immediately and forward `tx` so the test
    // can assert on the inner call.
    $transaction: (cb: (tx: unknown) => unknown) => {
      const fakeTx = { _isTx: true };
      txExecute.mockImplementationOnce((tx) => cb(tx));
      return txExecute(fakeTx);
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

// tryCreateDeviceJob is imported by handlers.ts. We stub it so the
// queue_* tests can return either {kind:"created", job:...} or
// {kind:"busy", error:...} without needing a real Postgres advisory
// lock + INSERT round-trip.
const tryCreateDeviceJob = vi.fn();
vi.mock('../../../src/services/deviceOperations.js', () => ({
  tryCreateDeviceJob: (...args: unknown[]) => tryCreateDeviceJob(...args),
  getLatestJobResult: vi.fn(),
  mapBlockingJob: vi.fn(),
}));

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

// NetBox read-only client — 8 new assistant tools call this directly.
const listNetboxSitesMock = vi.fn();
const listNetboxDeviceRolesMock = vi.fn();
const listNetboxManufacturersMock = vi.fn();
const listNetboxDevicesMock = vi.fn();
const getNetboxDeviceByIdMock = vi.fn();
const findNetboxDeviceByNetconsoleIdMock = vi.fn();
const listNetboxInterfacesMock = vi.fn();
const listNetboxVlansMock = vi.fn();
const listNetboxPrefixesMock = vi.fn();
const listNetboxIpAddressesMock = vi.fn();
const netboxHealthCheckMock = vi.fn();
vi.mock('../../../src/services/netboxClient.js', () => ({
  listNetboxSites: (...args: unknown[]) => listNetboxSitesMock(...args),
  listNetboxDeviceRoles: (...args: unknown[]) => listNetboxDeviceRolesMock(...args),
  listNetboxManufacturers: (...args: unknown[]) => listNetboxManufacturersMock(...args),
  listNetboxDevices: (...args: unknown[]) => listNetboxDevicesMock(...args),
  getNetboxDeviceById: (...args: unknown[]) => getNetboxDeviceByIdMock(...args),
  findNetboxDeviceByNetconsoleId: (...args: unknown[]) => findNetboxDeviceByNetconsoleIdMock(...args),
  listNetboxInterfaces: (...args: unknown[]) => listNetboxInterfacesMock(...args),
  listNetboxVlans: (...args: unknown[]) => listNetboxVlansMock(...args),
  listNetboxPrefixes: (...args: unknown[]) => listNetboxPrefixesMock(...args),
  listNetboxIpAddresses: (...args: unknown[]) => listNetboxIpAddressesMock(...args),
  netboxHealthCheck: (...args: unknown[]) => netboxHealthCheckMock(...args),
  NetBoxError: class NetBoxError extends Error {},
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

  // ── Multi-action: set VLAN + description in ONE call ───────────────────

  it('queues a multi-action batch and reports subActionCount=2', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F6-DS-01', ip: '10.10.20.6', status: 'ONLINE' });
    parseInterfaceActionPayload.mockReturnValueOnce({
      interface: 'xe-0/0/7',
      actions: [
        { action: 'set-access-vlan', vlan: '203' },
        { action: 'set-description', description: 'sonnx_test' },
      ],
    });
    queueInterfaceAction.mockResolvedValueOnce({
      kind: 'created',
      job: {
        id: 'job-multi-1',
        type: 'INTERFACE_ACTION',
        status: 'PENDING',
        createdAt: new Date(),
        deviceId: 'dev-1',
        payload: {
          interface: 'xe-0/0/7',
          actions: [
            { action: 'set-access-vlan', vlan: '203' },
            { action: 'set-description', description: 'sonnx_test' },
          ],
        },
      },
    });
    const result = await HANDLERS.queue_interface_action(
      {
        device_name: 'LAB-F6-DS-01',
        interface: 'xe-0/0/7',
        actions: [
          { action: 'set-access-vlan', vlan: '203' },
          { action: 'set-description', description: 'sonnx_test' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { subActionCount: number; subActionSummary: string; jobId: string };
    expect(preview.subActionCount).toBe(2);
    expect(preview.subActionSummary).toContain('set-access-vlan 203');
    expect(preview.subActionSummary).toContain('sonnx_test');
    expect(preview.jobId).toBe('job-multi-1');
  });

  it('queues a single-action via multi-action shape (one subaction) without error', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE' });
    parseInterfaceActionPayload.mockReturnValueOnce({
      interface: 'ge-0/0/5',
      actions: [{ action: 'shut' }],
    });
    queueInterfaceAction.mockResolvedValueOnce({
      kind: 'created',
      job: { id: 'job-x', type: 'INTERFACE_ACTION', status: 'PENDING', createdAt: new Date(), deviceId: 'dev-1', payload: { interface: 'ge-0/0/5', actions: [{ action: 'shut' }] } },
    });
    const result = await HANDLERS.queue_interface_action(
      { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', actions: [{ action: 'shut' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { subActionCount: number };
    expect(preview.subActionCount).toBe(1);
  });

  it('rejects when the action payload is invalid', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', status: 'ONLINE' });
    parseInterfaceActionPayload.mockReturnValueOnce(null);
    const result = await HANDLERS.queue_interface_action(
      { device_name: 'LAB-F2-AS-01', interface: 'ge-0/0/5', action: 'totally-bogus' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid action payload/);
  });

  // ── Multi-action CROSS-INTERFACE: 2 ports in 1 call ────────────────────

  it('queues a cross-interface batch (2 ports, 6 subactions) and reports interfaceCount=2', async () => {
    deviceFindFirst.mockResolvedValueOnce({ id: 'dev-1', name: 'LAB-F6-DS-01', ip: '10.10.20.6', status: 'ONLINE' });
    parseInterfaceActionPayload.mockReturnValueOnce({
      actions: [
        { interface: 'xe-0/0/8', action: 'delete-interface' },
        { interface: 'xe-0/0/9', action: 'delete-interface' },
        { interface: 'xe-0/0/8', action: 'set-access-vlan', vlan: '201' },
        { interface: 'xe-0/0/8', action: 'set-description', description: 'client-tang1' },
        { interface: 'xe-0/0/9', action: 'set-access-vlan', vlan: '202' },
        { interface: 'xe-0/0/9', action: 'set-description', description: 'client-tang2' },
      ],
    });
    queueInterfaceAction.mockResolvedValueOnce({
      kind: 'created',
      job: {
        id: 'job-cross-1',
        type: 'INTERFACE_ACTION',
        status: 'PENDING',
        createdAt: new Date(),
        deviceId: 'dev-1',
        payload: {
          actions: [
            { interface: 'xe-0/0/8', action: 'delete-interface' },
            { interface: 'xe-0/0/9', action: 'delete-interface' },
            { interface: 'xe-0/0/8', action: 'set-access-vlan', vlan: '201' },
            { interface: 'xe-0/0/8', action: 'set-description', description: 'client-tang1' },
            { interface: 'xe-0/0/9', action: 'set-access-vlan', vlan: '202' },
            { interface: 'xe-0/0/9', action: 'set-description', description: 'client-tang2' },
          ],
        },
      },
    });
    const result = await HANDLERS.queue_interface_action(
      {
        device_name: 'LAB-F6-DS-01',
        actions: [
          { interface: 'xe-0/0/8', action: 'delete-interface' },
          { interface: 'xe-0/0/9', action: 'delete-interface' },
          { interface: 'xe-0/0/8', action: 'set-access-vlan', vlan: '201' },
          { interface: 'xe-0/0/8', action: 'set-description', description: 'client-tang1' },
          { interface: 'xe-0/0/9', action: 'set-access-vlan', vlan: '202' },
          { interface: 'xe-0/0/9', action: 'set-description', description: 'client-tang2' },
        ],
      },
      ctx,
    );
    if (!result.ok) {
      throw new Error(`handler returned ok=false, error=${(result as { error: string }).error}`);
    }
    expect(result.ok).toBe(true);
    const preview = result.preview as {
      subActionCount: number;
      interfaceCount: number;
      interfaces: string[];
      subActionSummary: string;
      jobId: string;
    };
    expect(preview.subActionCount).toBe(6);
    expect(preview.interfaceCount).toBe(2);
    expect(preview.interfaces).toEqual(expect.arrayContaining(['xe-0/0/8', 'xe-0/0/9']));
    expect(preview.subActionSummary).toContain('client-tang1');
    expect(preview.subActionSummary).toContain('client-tang2');
    expect(preview.subActionSummary).toContain('201');
    expect(preview.subActionSummary).toContain('202');
    expect(preview.jobId).toBe('job-cross-1');
  });
});

describe('suggest_followup (UI affordance)', () => {
  it('returns ok with trimmed suggestions when given valid array', async () => {
    const result = await HANDLERS.suggest_followup(
      { suggestions: ['Queue managed check F2-AS-01', 'Xem job fail 24h qua', '   ', 'Extra chip ignored'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { suggestions: string[] };
    expect(preview.suggestions).toHaveLength(3);
    expect(preview.suggestions[0]).toBe('Queue managed check F2-AS-01');
  });

  it('rejects empty array', async () => {
    const result = await HANDLERS.suggest_followup({ suggestions: [] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-empty/);
  });

  it('rejects non-array input', async () => {
    const result = await HANDLERS.suggest_followup({ suggestions: 'not an array' }, ctx);
    expect(result.ok).toBe(false);
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

// ───────────────────────────────────────────────────────────────────────────
// apply_config_dry_run + queue_apply_config — merge mode
//
// Added 2026-10-11 to support the "add 2 lines, don't replace the rest"
// flow. Backend must:
//   - read args.mode (default "replace")
//   - if merge: require args.content, skip DeviceSavedConfig, diff content
//     vs running only
//   - if replace: existing behaviour (DeviceSavedConfig.content / override)
//
// The worker's apply_config is always a merge under the hood (Junos
// load set / IOS-XE conf t / EOS session.config), so device-side nothing
// changes — the mode arg is just a backend UX gate.
// ───────────────────────────────────────────────────────────────────────────

describe('apply_config_dry_run', () => {
  it('merge mode requires content arg, never falls back to DeviceSavedConfig', async () => {
    // Even with a saved config present, merge mode must reject (no
    // fallback). Otherwise the assistant could silently replace the
    // user's intent ("add 2 lines") with the full saved snapshot.
    deviceFindFirst.mockResolvedValueOnce({
      id: 'dev-1',
      name: 'LAB-F6-CORE-02',
      ip: '10.10.20.102',
      vendor: 'Juniper',
      savedConfig: { content: 'set full-saved-config-with-50-lines' },
    });
    const result = await HANDLERS.apply_config_dry_run(
      { device_name: 'LAB-F6-CORE-02', mode: 'merge' /* no content */ },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/merge.*content/i);
  });

  it('merge mode diffs content (delta) vs running, not against saved config', async () => {
    deviceFindFirst.mockResolvedValueOnce({
      id: 'dev-1',
      name: 'LAB-F6-CORE-02',
      ip: '10.10.20.102',
      vendor: 'Juniper',
      // Even with a 50-line saved config present, merge mode MUST NOT
      // touch it. If the handler fell back to savedConfig.content, the
      // dry-run would show a 50-line diff and confuse the LLM.
      savedConfig: { content: 'set X\nset Y\nset Z\nset A\nset B' },
    });
    // No GET_CONFIG SUCCESS row → running config = ''.
    jobFindFirst.mockResolvedValueOnce(null);
    const result = await HANDLERS.apply_config_dry_run(
      {
        device_name: 'LAB-F6-CORE-02',
        mode: 'merge',
        content: 'set protocols ospf area 0.0.0.100',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { mode: string; added: number; targetLineCount: number };
    expect(preview.mode).toBe('merge');
    // Target line count comes from `content` (1 line), NOT savedConfig
    // (5 lines). This is the key assertion: merge mode's content is the
    // delta only, even when savedConfig is huge.
    expect(preview.targetLineCount).toBe(1);
    // At least the new line shows as added (exact `added` count depends
    // on the LCS diff's empty-line treatment; the important part is
    // that no full-config comparison happened).
    expect(preview.added).toBeGreaterThanOrEqual(1);
  });

  it('replace mode (default) uses DeviceSavedConfig.content when no content override', async () => {
    deviceFindFirst.mockResolvedValueOnce({
      id: 'dev-1',
      name: 'LAB-F6-CORE-02',
      vendor: 'Juniper',
      savedConfig: { role: 'core', content: 'set Z' },
    });
    jobFindFirst.mockResolvedValueOnce(null);
    const result = await HANDLERS.apply_config_dry_run(
      { device_name: 'LAB-F6-CORE-02' /* mode defaults to replace */ },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { mode: string; targetLineCount: number };
    expect(preview.mode).toBe('replace');
    expect(preview.targetLineCount).toBe(1);
  });
});

describe('queue_apply_config — merge mode', () => {
  it('merge mode requires content, queues APPLY_CONFIG with payload.mode=merge', async () => {
    deviceFindFirst.mockResolvedValueOnce({
      id: 'dev-1',
      name: 'LAB-F6-CORE-02',
      ip: '10.10.20.102',
      vendor: 'Juniper',
      status: 'MANAGED',
      savedConfig: { content: 'set full-saved-config' },
    });
    jobFindFirst.mockResolvedValueOnce(null); // GET_CONFIG baseline
    tryCreateDeviceJob.mockResolvedValueOnce({
      kind: 'created',
      job: { id: 'job-merge-1', type: 'APPLY_CONFIG', status: 'PENDING', createdAt: new Date(), deviceId: 'dev-1' },
    });

    const result = await HANDLERS.queue_apply_config(
      {
        device_name: 'LAB-F6-CORE-02',
        mode: 'merge',
        content: 'set protocols ospf area 0.0.0.100\nset protocols ospf area 0.0.0.10 interface ge-0/0/4',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { mode: string; jobId: string; message: string };
    expect(preview.mode).toBe('merge');
    expect(preview.jobId).toBe('job-merge-1');
    expect(preview.message).toMatch(/MERGE/i);

    // The job payload must carry `mode: "merge"` so the worker / audit
    // log / future replays all know the job was a delta-apply, not a
    // full snapshot.
    expect(tryCreateDeviceJob).toHaveBeenCalledWith(
      expect.objectContaining({ _isTx: true }),
      'dev-1',
      'APPLY_CONFIG',
      'user-1',
      expect.objectContaining({
        mode: 'merge',
        config: 'set protocols ospf area 0.0.0.100\nset protocols ospf area 0.0.0.10 interface ge-0/0/4',
      }),
    );

    // CRITICAL: merge mode MUST NOT touch DeviceSavedConfig. The saved
    // snapshot stays as the full device config (the next Config Studio
    // session still sees the right baseline). If it wrote, the merge
    // delta would overwrite the saved full snapshot and the next
    // dry-run would show a 50-line diff again.
    expect(savedConfigUpsert).not.toHaveBeenCalled();
  });

  it('merge mode refuses to queue without content', async () => {
    deviceFindFirst.mockResolvedValueOnce({
      id: 'dev-1',
      name: 'LAB-F6-CORE-02',
      vendor: 'Juniper',
      status: 'MANAGED',
      savedConfig: { content: 'set X' },
    });
    const result = await HANDLERS.queue_apply_config(
      { device_name: 'LAB-F6-CORE-02', mode: 'merge' /* no content */ },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/merge.*content/i);
    // Must not have queued a job.
    expect(tryCreateDeviceJob).not.toHaveBeenCalled();
  });

  it('replace mode (default) writes DeviceSavedConfig.upsert with the resolved content', async () => {
    deviceFindFirst.mockResolvedValueOnce({
      id: 'dev-1',
      name: 'LAB-F2-AS-01',
      vendor: 'Juniper',
      status: 'MANAGED',
      savedConfig: { role: 'core', content: 'set OLD' },
    });
    jobFindFirst.mockResolvedValueOnce(null);
    tryCreateDeviceJob.mockResolvedValueOnce({
      kind: 'created',
      job: { id: 'job-rep-1', type: 'APPLY_CONFIG', status: 'PENDING', createdAt: new Date(), deviceId: 'dev-1' },
    });
    const result = await HANDLERS.queue_apply_config(
      { device_name: 'LAB-F2-AS-01', content: 'set NEW' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const preview = result.preview as { mode: string };
    expect(preview.mode).toBe('replace');
    // Default replace mode DOES persist the saved config (it's the
    // Config Studio path). Verify the upsert was called.
    expect(savedConfigUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: 'dev-1' },
        create: expect.objectContaining({ content: 'set NEW', role: 'core' }),
        update: expect.objectContaining({ content: 'set NEW', role: 'core' }),
      }),
    );
    // Payload mode must be "replace" too (worker audit).
    expect(tryCreateDeviceJob).toHaveBeenCalledWith(
      expect.anything(),
      'dev-1',
      'APPLY_CONFIG',
      'user-1',
      expect.objectContaining({ mode: 'replace' }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NetBox READ handlers (added 2026-10-13)
//
// All 8 tools call the netboxClient directly (in-process; no HTTP). The
// get_netbox_sync_status handler is the only one that reads from the
// NetConsole DB — it answers "do we have a NetBox record for this
// device?" without making a NetBox API call.
// ───────────────────────────────────────────────────────────────────────────

describe('get_netbox_health', () => {
  it('returns ok=true when NetBox is reachable', async () => {
    netboxHealthCheckMock.mockResolvedValueOnce(true);
    const result = await HANDLERS.get_netbox_health({}, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { ok: boolean; message: string };
    expect(preview.ok).toBe(true);
    expect(preview.message).toMatch(/hoạt động/);
  });

  it('returns ok=true with "không phản hồi" when NetBox is unreachable', async () => {
    netboxHealthCheckMock.mockResolvedValueOnce(false);
    const result = await HANDLERS.get_netbox_health({}, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { ok: boolean; message: string };
    expect(preview.ok).toBe(false);
    expect(preview.message).toMatch(/KHÔNG phản hồi/);
  });
});

describe('list_netbox_sites', () => {
  it('returns compact site list with id/name/slug', async () => {
    listNetboxSitesMock.mockResolvedValueOnce([
      { id: 1, name: 'LAB', slug: 'lab', status: { value: 'active', label: 'Active' }, description: '', tags: [{ id: 99, name: 'source-netconsole', slug: 'source-netconsole' }] },
      { id: 2, name: 'NKKN', slug: 'nkkn', status: { value: 'active', label: 'Active' }, description: 'Nội khu khuôn viên', tags: [] },
    ]);
    const result = await HANDLERS.list_netbox_sites({ limit: 50 }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { total: number; sites: Array<{ name: string; tags: string[] }> };
    expect(preview.total).toBe(2);
    expect(preview.sites[0].name).toBe('LAB');
    expect(preview.sites[0].tags).toEqual(['source-netconsole']);
  });

  it('returns ok=false on NetBox error', async () => {
    const { NetBoxError } = await import('../../../src/services/netboxClient.js');
    listNetboxSitesMock.mockRejectedValueOnce(new NetBoxError('NetBox HTTP 502: Bad Gateway'));
    const result = await HANDLERS.list_netbox_sites({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/502/);
  });
});

describe('list_netbox_devices', () => {
  it('passes filters through to the client and returns compact device list', async () => {
    listNetboxDevicesMock.mockResolvedValueOnce({
      total: 3,
      devices: [
        {
          id: 7,
          name: 'LAB-F2-AS-01',
          device_type: { id: 1, manufacturer: { id: 1, name: 'Juniper' }, model: 'EX3400', slug: 'juniper-ex3400' },
          role: { id: 1, name: 'Access', slug: 'access', color: '9e9e9e' },
          site: { id: 1, name: 'LAB', slug: 'lab' },
          status: { value: 'active', label: 'Active' },
          serial: 'ABC123',
          platform: { id: 5, name: '23.4R2', slug: 'juniper-23-4r2' },
          rack: { id: 1, name: 'V1' },
          position: 11,
          face: { value: 'front', label: 'Front' },
          primary_ip4: { id: 1, address: '10.10.20.1/24' },
          primary_ip6: null,
          description: '',
          comments: '',
          tags: [{ id: 99, name: 'source-netconsole', slug: 'source-netconsole' }],
          custom_fields: { netconsole_id: 'dev-abc' },
          url: 'http://netbox/api/dcim/devices/7/',
          created: '2026-10-01T00:00:00Z',
          last_updated: '2026-10-12T00:00:00Z',
        },
      ],
    });
    const result = await HANDLERS.list_netbox_devices({ site: 'lab', status: 'active' }, ctx);
    expect(result.ok).toBe(true);
    expect(listNetboxDevicesMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'lab', status: 'active', limit: 50, offset: 0 }),
    );
    const preview = result.preview as {
      total: number;
      returned: number;
      devices: Array<{ name: string; netconsoleId: string; primaryIp4: string }>;
    };
    expect(preview.total).toBe(3);
    expect(preview.returned).toBe(1);
    expect(preview.devices[0].name).toBe('LAB-F2-AS-01');
    expect(preview.devices[0].netconsoleId).toBe('dev-abc');
    expect(preview.devices[0].primaryIp4).toBe('10.10.20.1/24');
  });
});

describe('get_netbox_device', () => {
  it('looks up by id', async () => {
    getNetboxDeviceByIdMock.mockResolvedValueOnce({
      id: 7,
      name: 'LAB-F2-AS-01',
      device_type: { id: 1, manufacturer: { id: 1, name: 'Juniper' }, model: 'EX3400', slug: 'j' },
      role: { id: 1, name: 'Access', slug: 'access', color: '9e9e9e' },
      site: { id: 1, name: 'LAB', slug: 'lab' },
      status: { value: 'active', label: 'Active' },
      serial: 'ABC123',
      platform: null,
      rack: null,
      position: null,
      face: null,
      primary_ip4: null,
      primary_ip6: null,
      description: '',
      comments: '',
      tags: [],
      custom_fields: {},
      url: '',
      created: '',
      last_updated: '',
    });
    const result = await HANDLERS.get_netbox_device({ id: 7 }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { found: boolean; device: { id: number; name: string } };
    expect(preview.found).toBe(true);
    expect(preview.device.id).toBe(7);
  });

  it('returns found=false when id has no match', async () => {
    getNetboxDeviceByIdMock.mockResolvedValueOnce(null);
    const result = await HANDLERS.get_netbox_device({ id: 9999 }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { found: boolean };
    expect(preview.found).toBe(false);
  });

  it('looks up by netconsole_id (preferred path)', async () => {
    findNetboxDeviceByNetconsoleIdMock.mockResolvedValueOnce({
      id: 7,
      name: 'LAB-F2-AS-01',
      device_type: { id: 1, manufacturer: { id: 1, name: 'Juniper' }, model: 'EX3400', slug: 'j' },
      role: { id: 1, name: 'Access', slug: 'access', color: '9e9e9e' },
      site: { id: 1, name: 'LAB', slug: 'lab' },
      status: { value: 'active', label: 'Active' },
      serial: 'ABC123',
      platform: null,
      rack: null,
      position: null,
      face: null,
      primary_ip4: null,
      primary_ip6: null,
      description: '',
      comments: '',
      tags: [],
      custom_fields: { netconsole_id: 'dev-abc' },
      url: '',
      created: '',
      last_updated: '',
    });
    const result = await HANDLERS.get_netbox_device({ netconsole_id: 'dev-abc' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { found: boolean; device: { netconsoleId: string } };
    expect(preview.found).toBe(true);
    expect(preview.device.netconsoleId).toBe('dev-abc');
  });

  it('looks up by name via full-text search', async () => {
    listNetboxDevicesMock.mockResolvedValueOnce({
      total: 1,
      devices: [{
        id: 7, name: 'LAB-F2-AS-01',
        device_type: { id: 1, manufacturer: { id: 1, name: 'Juniper' }, model: 'EX3400', slug: 'j' },
        role: { id: 1, name: 'Access', slug: 'access', color: '9e9e9e' },
        site: { id: 1, name: 'LAB', slug: 'lab' },
        status: { value: 'active', label: 'Active' },
        serial: '', platform: null, rack: null, position: null, face: null,
        primary_ip4: null, primary_ip6: null, description: '', comments: '',
        tags: [], custom_fields: {}, url: '', created: '', last_updated: '',
      }],
    });
    const result = await HANDLERS.get_netbox_device({ name: 'F2-AS' }, ctx);
    expect(listNetboxDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ search: 'F2-AS', limit: 5 }));
    expect(result.ok).toBe(true);
  });

  it('rejects when no lookup key is given', async () => {
    const result = await HANDLERS.get_netbox_device({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/id, netconsole_id, name/);
  });
});

describe('list_netbox_interfaces', () => {
  it('requires netbox_device_id', async () => {
    const result = await HANDLERS.list_netbox_interfaces({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/netbox_device_id/);
  });

  it('returns compact interface list with speed converted to Mbps', async () => {
    listNetboxInterfacesMock.mockResolvedValueOnce([
      {
        id: 1, device: { id: 7, name: 'LAB-F2-AS-01' },
        name: 'ge-0/0/0', type: { value: '1000base-t', label: '1000BASE-T (1GE)' },
        enabled: true, description: 'uplink', mtu: 1514,
        speed: 1_000_000_000, mac_address: 'aa:bb:cc:00:00:01',
        mode: { value: 'tagged', label: 'Tagged' },
        untagged_vlan: null,
        tagged_vlans: [{ id: 1, vid: 201, name: 'VLAN201' }, { id: 2, vid: 202, name: 'VLAN202' }],
        tag: null,
      },
      {
        id: 2, device: { id: 7, name: 'LAB-F2-AS-01' },
        name: 'ge-0/0/1', type: { value: '1000base-t', label: '1000BASE-T (1GE)' },
        enabled: false, description: '', mtu: null,
        speed: null, mac_address: null, mode: null, untagged_vlan: null, tagged_vlans: [],
        tag: null,
      },
    ]);
    const result = await HANDLERS.list_netbox_interfaces({ netbox_device_id: 7, only_up: true }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as {
      total: number;
      returned: number;
      interfaces: Array<{ name: string; speedMbps: number | null; taggedVlans: number[] }>;
    };
    expect(preview.total).toBe(2);
    // only_up filter should drop the disabled interface
    expect(preview.returned).toBe(1);
    expect(preview.interfaces[0].name).toBe('ge-0/0/0');
    expect(preview.interfaces[0].speedMbps).toBe(1000);
    expect(preview.interfaces[0].taggedVlans).toEqual([201, 202]);
  });
});

describe('list_netbox_vlans', () => {
  it('maps vlan list to compact shape', async () => {
    listNetboxVlansMock.mockResolvedValueOnce([
      {
        id: 1, vid: 201, name: 'VLAN201',
        status: { value: 'active', label: 'Active' },
        site: { id: 1, name: 'LAB' }, group: { id: 1, name: 'default' },
        description: '', role: null,
      },
    ]);
    const result = await HANDLERS.list_netbox_vlans({ site: 'lab' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { vlans: Array<{ vid: number; site: string | null }> };
    expect(preview.vlans[0].vid).toBe(201);
    expect(preview.vlans[0].site).toBe('LAB');
  });
});

describe('list_netbox_prefixes', () => {
  it('passes filters through and returns utilization', async () => {
    listNetboxPrefixesMock.mockResolvedValueOnce([
      {
        id: 1, prefix: '10.10.20.0/24',
        site: { id: 1, name: 'LAB' }, vrf: null,
        status: { value: 'active', label: 'Active' },
        role: null, description: 'synced from NetConsole', utilization: 87.5,
      },
    ]);
    const result = await HANDLERS.list_netbox_prefixes({ site: 'lab' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { prefixes: Array<{ utilization: number }> };
    expect(preview.prefixes[0].utilization).toBe(87.5);
  });
});

describe('list_netbox_ip_addresses', () => {
  it('returns compact IP list with assignedTo', async () => {
    listNetboxIpAddressesMock.mockResolvedValueOnce([
      {
        id: 1, address: '10.10.20.1/24',
        status: { value: 'active', label: 'Active' },
        role: null, dns_name: 'f2-as-01.lab.local', description: 'mgmt',
        assigned_object: {
          id: 5, name: 'fxp0', device: { id: 7, name: 'LAB-F2-AS-01' },
        },
        interface: { id: 5, name: 'fxp0' },
        nat_inside: null,
        tags: [{ id: 99, name: 'source-netconsole', slug: 'source-netconsole' }],
      },
    ]);
    const result = await HANDLERS.list_netbox_ip_addresses({ netbox_device_id: 7 }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as {
      addresses: Array<{ address: string; assignedTo: { device: string | null; interfaceName: string } | null; tags: string[] }>;
    };
    expect(preview.addresses[0].address).toBe('10.10.20.1/24');
    expect(preview.addresses[0].assignedTo?.device).toBe('LAB-F2-AS-01');
    expect(preview.addresses[0].assignedTo?.interfaceName).toBe('fxp0');
    expect(preview.addresses[0].tags).toEqual(['source-netconsole']);
  });

  it('handles unassigned IP (assignedTo=null)', async () => {
    listNetboxIpAddressesMock.mockResolvedValueOnce([
      {
        id: 2, address: '10.10.20.50/24',
        status: { value: 'active', label: 'Active' },
        role: null, dns_name: '', description: '',
        assigned_object: null, interface: null, nat_inside: null, tags: [],
      },
    ]);
    const result = await HANDLERS.list_netbox_ip_addresses({ search: '10.10.20.50' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as { addresses: Array<{ assignedTo: unknown }> };
    expect(preview.addresses[0].assignedTo).toBeNull();
  });
});

describe('get_netbox_sync_status', () => {
  it('returns summary + device list, including synced/pending/failed counts', async () => {
    deviceFindMany.mockResolvedValueOnce([
      {
        id: 'dev-1', name: 'LAB-F2-AS-01', ip: '10.10.20.1', site: 'LAB', vendor: 'juniper', model: 'EX3400',
        netboxDeviceId: 7, netboxSyncedAt: new Date('2026-10-12T00:00:00Z'), netboxSyncError: null,
      },
      {
        id: 'dev-2', name: 'LAB-F2-DS-01', ip: '10.10.20.2', site: 'LAB', vendor: 'juniper', model: 'QFX5120',
        netboxDeviceId: null, netboxSyncedAt: null, netboxSyncError: null,
      },
      {
        id: 'dev-3', name: 'LAB-F2-AS-02', ip: '10.10.20.3', site: 'LAB', vendor: 'arista', model: '7050',
        netboxDeviceId: 99, netboxSyncedAt: new Date('2026-10-10T00:00:00Z'),
        netboxSyncError: 'NetBox upsert failed: HTTP 502',
      },
    ]);
    const result = await HANDLERS.get_netbox_sync_status({ site: 'LAB' }, ctx);
    expect(result.ok).toBe(true);
    const preview = result.preview as {
      summary: { total: number; synced: number; pending: number; failed: number };
      devices: Array<{ name: string; synced: boolean; netboxDeviceId: number | null; netboxSyncError: string | null }>;
    };
    expect(preview.summary).toEqual({ total: 3, synced: 1, pending: 1, failed: 1 });
    expect(preview.devices[0].name).toBe('LAB-F2-AS-01');
    expect(preview.devices[0].synced).toBe(true);
    expect(preview.devices[1].synced).toBe(false);
    expect(preview.devices[2].synced).toBe(false);
    expect(preview.devices[2].netboxSyncError).toMatch(/502/);
  });

  it('filters to only_failed when requested', async () => {
    deviceFindMany.mockResolvedValueOnce([
      {
        id: 'dev-3', name: 'LAB-F2-AS-02', ip: '10.10.20.3', site: 'LAB', vendor: 'arista', model: '7050',
        netboxDeviceId: 99, netboxSyncedAt: new Date(), netboxSyncError: 'broken',
      },
    ]);
    await HANDLERS.get_netbox_sync_status({ only_failed: true }, ctx);
    expect(deviceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ netboxSyncError: { not: null } }) }),
    );
  });
});
