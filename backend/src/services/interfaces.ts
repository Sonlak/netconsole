import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { reclaimStaleJobs } from './jobWatchdog.js';
import { jobPriority, tryCreateDeviceJob, type DeviceBusyError } from './deviceOperations.js';
import { fetchInterfaceList, fetchConfigurationSet, fetchVlanInformation, parseVlanInformation, applyVlanMembershipToInterfaces, parseConfigurationSet, applySwitchingModesToInterfaces, parseSwitchingModesFromSet } from './junosRest.js';
import { fetchIosxeInterfaceList } from './iosxeRest.js';
import { fetchEosInterfaceList } from './eosApi.js';

export type InterfaceAction =
  | 'shut'
  | 'no-shut'
  | 'show-run'
  | 'set-access-vlan'
  | 'set-description'
  | 'remove-description'
  // 'delete-interface' (NEW): reset the entire interface subtree to defaults.
  // Translates to `delete interfaces <name>` on Junos / `no interface <name>` on
  // IOS-XE / EOS / NX-OS. Destructive — require ADMIN role in the UI gate.
  | 'delete-interface';

/**
 * One logical change applied to an interface.
 *
 * Used by the new multi-action payload: queueInterfaceAction now accepts a
 * batch of `actions: SubAction[]` so the LLM can do
 * "set-access-vlan 203 + set-description 'sonnx_test'" in ONE job and ONE
 * device commit instead of two separate round-trips.
 *
 * Each subaction carries the same fields as the legacy single-action payload
 * but drops `interface` (it's hoisted to the top-level payload).
 */
export type InterfaceSubAction =
  | { action: 'shut' }
  | { action: 'no-shut' }
  | { action: 'set-access-vlan'; vlan: string }
  | { action: 'set-description'; description: string }
  | { action: 'remove-description' }
  | { action: 'delete-interface' };

/**
 * Stored in the Job.payload column. Two shapes are accepted:
 *
 *   1. Legacy single-action: { action, interface, vlan?, description? }
 *      (kept for backward compat with existing jobs and the public REST route
 *      /api/devices/:id/actions)
 *
 *   2. Multi-action (new): { interface, actions: SubAction[] }
 *      - all subactions target the SAME interface
 *      - all commands land in ONE device commit (atomic on the device)
 *      - `description` on `set-description` is a non-empty string;
 *        `remove-description` clears the description
 *      - `delete-interface` and `shut` in the same batch is rejected
 *        (contradictory — see validateSubActions in the worker)
 */
export type InterfaceActionPayload = {
  // Legacy single-action form
  action?: InterfaceAction;
  vlan?: string;
  description?: string;
  // New multi-action form
  actions?: InterfaceSubAction[];
} & { interface: string };

const ACTION_VALUES: InterfaceAction[] = ['shut', 'no-shut', 'show-run', 'set-access-vlan', 'set-description', 'remove-description', 'delete-interface'];

const SUBACTION_VALUES = new Set(['shut', 'no-shut', 'set-access-vlan', 'set-description', 'remove-description', 'delete-interface']);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate one subaction entry from the multi-action array.
 *
 * Returns the normalized subaction on success, or null on validation failure.
 * Each subaction is self-contained — `interface` lives on the parent
 * payload, not on each entry.
 */
function parseSubAction(raw: unknown): InterfaceSubAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const action = v.action;
  if (typeof action !== 'string' || !SUBACTION_VALUES.has(action)) return null;

  if (action === 'set-access-vlan') {
    const vlan = v.vlan;
    if (typeof vlan !== 'string' || !/^\d{1,4}$/.test(vlan.trim())) return null;
    const n = parseInt(vlan, 10);
    if (n < 1 || n > 4094) return null;
    return { action: 'set-access-vlan', vlan: vlan.trim() };
  }
  if (action === 'set-description') {
    if (typeof v.description !== 'string') return null;
    // Empty string is allowed (it'll be applied literally, but in practice
    // the LLM should use remove-description for "clear"). We trim and
    // require non-empty after trim so the worker doesn't accidentally
    // send `description ""` which means something weird per-vendor.
    const d = v.description.trim();
    if (!d) return null;
    return { action: 'set-description', description: d };
  }
  if (action === 'shut' || action === 'no-shut' || action === 'remove-description' || action === 'delete-interface') {
    return { action } as InterfaceSubAction;
  }
  return null;
}

export function parseInterfaceActionPayload(body: unknown): InterfaceActionPayload | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const value = body as Record<string, unknown>;
  const iface = value.interface;

  if (typeof iface !== 'string' || !iface.trim()) {
    return null;
  }

  // Multi-action form: { interface, actions: [...] }
  // Preferred for new code; the LLM tool should call this way so the worker
  // can commit all changes atomically.
  if (Array.isArray(value.actions)) {
    if (value.actions.length === 0) return null;
    if (value.actions.length > 16) return null; // sanity cap
    const sub: InterfaceSubAction[] = [];
    for (const raw of value.actions) {
      const parsed = parseSubAction(raw);
      if (!parsed) return null;
      sub.push(parsed);
    }
    return { interface: iface.trim(), actions: sub };
  }

  // Legacy single-action form: { action, interface, vlan?, description? }
  const action = value.action;
  if (typeof action !== 'string' || !ACTION_VALUES.includes(action as InterfaceAction)) {
    return null;
  }

  const vlan = typeof value.vlan === 'string' ? value.vlan.trim() : undefined;
  if (action === 'set-access-vlan') {
    if (!vlan || !/^\d{1,4}$/.test(vlan)) return null;
    const n = parseInt(vlan, 10);
    if (n < 1 || n > 4094) return null;
  }

  // Extract `description` field. Accepts:
  //   - string (will be passed through to the worker; trimmed)
  //   - null  (no description; worker treats as remove for set-description)
  //   - undefined (field absent from JSON; same as null)
  //
  // Without this fix the backend silently dropped the description and the
  // worker saw `description = None`, which made every set-description turn
  // into remove-description. (See InterfaceActionTask in registry.py for the
  // worker-side handling.)
  let description: string | undefined;
  if (typeof value.description === 'string') {
    description = value.description.trim();
  } else if (value.description === null) {
    description = undefined;
  }

  return {
    action: action as InterfaceAction,
    interface: iface.trim(),
    ...(vlan ? { vlan } : {}),
    ...(action === 'set-description' || action === 'remove-description'
      ? { description: description ?? '' }
      : {}),
  };
}

export async function applyInterfaceActionSnapshot(
  deviceId: string,
  result: {
    action?: string;
    interface?: string;
    adminStatus?: string | null;
    accessVlan?: string | null;
  },
) {
  const iface = result.interface?.trim();
  if (!iface || result.action === 'show-run') {
    return;
  }

  const latest = await getLatestInterfacesJob(deviceId);
  if (!latest?.result || typeof latest.result !== 'object' || Array.isArray(latest.result)) {
    return;
  }

  const payload = latest.result as Record<string, unknown>;
  const current = Array.isArray(payload.interfaces) ? payload.interfaces : [];
  const next = current.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }
    const row = item as Record<string, unknown>;
    if (row.name !== iface) {
      return item;
    }
    return {
      ...row,
      ...(result.adminStatus ? { adminStatus: result.adminStatus } : {}),
      ...(result.action === 'shut' ? { operStatus: 'down' } : {}),
      ...(result.accessVlan ? { accessVlan: result.accessVlan } : {}),
    };
  });

  await prisma.job.update({
    where: { id: latest.id },
    data: { result: { ...payload, interfaces: next } as Prisma.InputJsonValue },
  });
}

export async function getLatestInterfacesJob(deviceId: string) {
  return prisma.job.findFirst({
    where: { deviceId, type: JobType.GET_INTERFACES, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
  });
}

const deviceSelect = {
  id: true,
  name: true,
  ip: true,
  site: true,
  floor: true,
} as const;

export async function queueGetInterfaces(deviceId: string, options?: { force?: boolean }) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    return null;
  }

  await reclaimStaleJobs();

  if (!options?.force) {
    const inflight = await prisma.job.findFirst({
      where: {
        deviceId,
        type: JobType.GET_INTERFACES,
        status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
      },
      include: { device: { select: deviceSelect } },
    });
    if (inflight) {
      return inflight;
    }
  }

  return prisma.job.create({
    data: {
      deviceId,
      type: JobType.GET_INTERFACES,
      status: JobStatus.PENDING,
      // Background tab collection — keep at HIGH (100), not URGENT (200).
      // URGENT is reserved for user-driven UI actions so they jump the
      // queue ahead of this background sweep.
      priority: 100,
    },
    include: {
      device: { select: deviceSelect },
    },
  });
}

export async function queueInterfacesCollection(options?: {
  deviceIds?: string[];
  force?: boolean;
}) {
  const devices = await listCollectableDevices(options?.deviceIds);

  if (devices.length === 0) {
    return { jobs: [], deviceCount: 0, queued: 0, message: 'No managed devices' as const };
  }

  const jobs = [];

  for (const device of devices) {
    const before = options?.force
      ? null
      : await prisma.job.findFirst({
          where: {
            deviceId: device.id,
            type: JobType.GET_INTERFACES,
            status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
          },
        });
    if (before) {
      continue;
    }

    const job = await queueGetInterfaces(device.id, { force: options?.force });
    if (job) {
      jobs.push(job);
    }
  }

  return { jobs, deviceCount: devices.length, queued: jobs.length };
}

export function scheduleInterfacesCollection(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 60) * 1000;

  const run = async () => {
    try {
      await reclaimStaleJobs();
      const result = await queueInterfacesCollection();
      console.log(
        `[interfaces] managed=${result.deviceCount} queued=${result.queued}${result.message ? ` (${result.message})` : ''}`,
      );
    } catch (error) {
      console.error('[interfaces] scheduler failed', error);
    }
  };

  setTimeout(() => {
    void run();
  }, 25000);

  return setInterval(() => {
    void run();
  }, intervalMs);
}

export type QueueInterfaceActionResult =
  | { kind: 'created'; job: { id: string; type: JobType; status: JobStatus; createdAt: Date; deviceId: string | null; payload: InterfaceActionPayload } }
  | { kind: 'busy'; error: DeviceBusyError }
  | null; // device not found

export async function queueInterfaceAction(
  deviceId: string,
  payload: InterfaceActionPayload,
  createdById: string | null | undefined = undefined,
): Promise<QueueInterfaceActionResult> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    return null;
  }

  const outcome = await prisma.$transaction(async (tx) =>
    tryCreateDeviceJob(tx, deviceId, JobType.INTERFACE_ACTION, createdById ?? null, payload as Prisma.InputJsonValue),
  );

  if (outcome.kind === 'busy') {
    return { kind: 'busy', error: outcome.error };
  }

  return {
    kind: 'created',
    job: { ...outcome.job, payload },
  };
}

/**
 * Collect interface list for a single device via direct REST call (bypasses job queue).
 *
 * - Juniper: calls `fetchInterfaceList()` using Junos RESTCONF terse RPC.
 * - IOS-XE:  calls `fetchIosxeInterfaceList()` using ietf-interfaces YANG.
 *             Falls back to job queue if REST returns empty.
 * - Other:   always uses job queue.
 *
 * Writes a SUCCESS job row so GET /api/interfaces/:deviceId returns fresh data.
 * Returns `{ job, queued }` where `queued=true` means a worker job was also
 * queued as a fallback (e.g. IOS-XE with sparse YANG response).
 */
export async function collectInterfacesForDevice(
  deviceId: string,
  createdById: string | null | undefined = undefined,
): Promise<{ job: { id: string; type: JobType; status: JobStatus; createdAt: Date; deviceId: string | null }; queued: boolean }> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  const vendor = (device.vendor ?? '').toLowerCase();

  // Juniper: try REST first — fetch terse interfaces + config for switchport modes
  if (vendor === 'juniper') {
    const rest = await fetchInterfaceList(device.ip);
    if (rest.ok) {
      // Fetch configuration to get switchport mode (trunk/access) and VLAN membership
      const cfgResult = await fetchConfigurationSet(device.ip);
      if (cfgResult.ok && cfgResult.config) {
        const modes = parseSwitchingModesFromSet(cfgResult.config);
        applySwitchingModesToInterfaces(rest.interfaces, modes);
      }
      // Fetch VLAN membership so we know which VLAN each interface belongs to
      const vlanResult = await fetchVlanInformation(device.ip);
      if (vlanResult.ok && vlanResult.vlans.length > 0) {
        applyVlanMembershipToInterfaces(rest.interfaces, vlanResult.vlans);
      }
      const job = await prisma.job.create({
        data: {
          deviceId: device.id,
          type: JobType.GET_INTERFACES,
          status: JobStatus.SUCCESS,
          priority: 100,
          ...(createdById ? { createdById } : {}),
          result: {
            implemented: true,
            source: 'junos-rest',
            interfaces: rest.interfaces,
            command: 'get-interface-information terse + get-vlan-information + get-configuration (set format)',
            message: `Collected interfaces from ${device.name} via REST`,
            collectMs: rest.collectMs,
          } as object,
        },
        select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
      });
      console.log(`[interfaces] ${device.ip} collected via REST in ${rest.collectMs}ms (${rest.interfaces.length} interfaces)`);
      return { job, queued: false };
    }
    console.warn(`[interfaces] ${device.ip} REST failed (${rest.error}), falling back to job queue`);
  }

  // IOS-XE: try RESTCONF first
  if (vendor === 'cisco') {
    const rest = await fetchIosxeInterfaceList(device.ip);
    if (rest.ok) {
      const job = await prisma.job.create({
        data: {
          deviceId: device.id,
          type: JobType.GET_INTERFACES,
          status: JobStatus.SUCCESS,
          priority: 100,
          ...(createdById ? { createdById } : {}),
          result: {
            implemented: true,
            source: 'iosxe-rest',
            interfaces: rest.interfaces,
            command: 'ietf-interfaces:interfaces',
            message: `Collected interfaces from ${device.name} via RESTCONF`,
            collectMs: rest.collectMs,
          } as object,
        },
        select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
      });
      console.log(`[interfaces] ${device.ip} collected via RESTCONF in ${rest.collectMs}ms (${rest.interfaces.length} interfaces)`);
      return { job, queued: false };
    }
    console.warn(`[interfaces] ${device.ip} RESTCONF failed (${rest.error}), falling back to job queue`);
  }

  // Arista EOS: try eAPI
  if (vendor === 'arista') {
    const eapi = await fetchEosInterfaceList(device.ip);
    if (eapi.ok) {
      const job = await prisma.job.create({
        data: {
          deviceId: device.id,
          type: JobType.GET_INTERFACES,
          status: JobStatus.SUCCESS,
          priority: 100,
          ...(createdById ? { createdById } : {}),
          result: {
            implemented: true,
            source: 'eos-api',
            interfaces: eapi.interfaces,
            command: 'show interfaces + description + switchport',
            message: `Collected interfaces from ${device.name} via eAPI`,
            collectMs: eapi.collectMs,
          } as object,
        },
        select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
      });
      console.log(`[interfaces] ${device.ip} collected via eAPI in ${eapi.collectMs}ms (${eapi.interfaces.length} interfaces)`);
      return { job, queued: false };
    }
    console.warn(`[interfaces] ${device.ip} eAPI failed (${eapi.error}), falling back to job queue`);
  }

  // Default: queue a job (worker handles vendor-specific logic)
  const existing = await prisma.job.findFirst({
    where: {
      deviceId,
      type: JobType.GET_INTERFACES,
      status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
    },
  });
  if (existing) {
    return { job: existing, queued: true };
  }
  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.GET_INTERFACES,
      status: JobStatus.PENDING,
      priority: 100,
      ...(createdById ? { createdById } : {}),
    },
    select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
  });
  return { job, queued: true };
}
