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
 * Used by the multi-action payload. `interface` is OPTIONAL on a
 * subaction — when present, that subaction targets its own interface
 * (enabling cross-interface batches). When absent, the subaction
 * targets the interface hoisted on the top-level payload (legacy
 * same-interface multi-action).
 *
 * Cross-interface example (one call, one job, one device commit-set):
 *   actions: [
 *     {interface:"xe-0/0/8", action:"delete-interface"},
 *     {interface:"xe-0/0/9", action:"delete-interface"},
 *     {interface:"xe-0/0/8", action:"set-access-vlan", vlan:"201"},
 *     {interface:"xe-0/0/8", action:"set-description", description:"client-tang1"},
 *     {interface:"xe-0/0/9", action:"set-access-vlan", vlan:"202"},
 *     {interface:"xe-0/0/9", action:"set-description", description:"client-tang2"},
 *   ]
 *
 * Same-interface (legacy) example:
 *   interface: "xe-0/0/7"
 *   actions: [
 *     {action:"set-access-vlan", vlan:"203"},
 *     {action:"set-description", description:"sonnx_test"},
 *   ]
 */
export type InterfaceSubAction =
  | { action: 'shut'; interface?: string }
  | { action: 'no-shut'; interface?: string }
  | { action: 'set-access-vlan'; vlan: string; interface?: string }
  | { action: 'set-description'; description: string; interface?: string }
  | { action: 'remove-description'; interface?: string }
  | { action: 'delete-interface'; interface?: string };

/**
 * Stored in the Job.payload column. Three shapes are accepted:
 *
 *   1. Legacy single-action:
 *        { action, interface, vlan?, description? }
 *      (kept for backward compat with existing jobs and the public REST
 *      route /api/devices/:id/actions)
 *
 *   2. Multi-action on the SAME interface (hoisted):
 *        { interface, actions: SubAction[] }   // all subactions on `interface`
 *      → all commands land in ONE device commit (atomic on the device)
 *
 *   3. Multi-action ACROSS interfaces (new):
 *        { actions: SubAction[] }              // each subaction has its own `interface`
 *      → worker groups subactions by interface, commits each group
 *        atomically on its own interface, all in the same job.
 *        No top-level `interface` field.
 *
 * Rules:
 * - Reject contradictory subactions on the same interface
 *   (shut+no-shut, delete-interface + anything else).
 * - Cap batch size to 16 subactions and 8 distinct interfaces per job
 *   (operator can always send another job if they need more).
 */
export type InterfaceActionPayload = {
  // Legacy single-action form
  action?: InterfaceAction;
  vlan?: string;
  description?: string;
  // Multi-action form (same or cross interface)
  actions?: InterfaceSubAction[];
} & { interface?: string };

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

  // Per-subaction `interface` is OPTIONAL. When present, it overrides
  // the top-level hoisted `interface` and enables cross-interface
  // multi-action batches. The worker validates uniqueness / conflicts.
  let perIface: string | undefined;
  if (typeof v.interface === 'string' && v.interface.trim()) {
    perIface = v.interface.trim();
  }

  if (action === 'set-access-vlan') {
    const vlan = v.vlan;
    if (typeof vlan !== 'string' || !/^\d{1,4}$/.test(vlan.trim())) return null;
    const n = parseInt(vlan, 10);
    if (n < 1 || n > 4094) return null;
    return { action: 'set-access-vlan', vlan: vlan.trim(), ...(perIface ? { interface: perIface } : {}) };
  }
  if (action === 'set-description') {
    if (typeof v.description !== 'string') return null;
    // Empty string is allowed (it'll be applied literally, but in practice
    // the LLM should use remove-description for "clear"). We trim and
    // require non-empty after trim so the worker doesn't accidentally
    // send `description ""` which means something weird per-vendor.
    const d = v.description.trim();
    if (!d) return null;
    return { action: 'set-description', description: d, ...(perIface ? { interface: perIface } : {}) };
  }
  if (action === 'shut' || action === 'no-shut' || action === 'remove-description' || action === 'delete-interface') {
    return { action, ...(perIface ? { interface: perIface } : {}) } as InterfaceSubAction;
  }
  return null;
}

export function parseInterfaceActionPayload(body: unknown): InterfaceActionPayload | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const value = body as Record<string, unknown>;
  const topIface = typeof value.interface === 'string' && value.interface.trim()
    ? value.interface.trim()
    : undefined;

  // Multi-action form: { interface?, actions: [...] }
  //
  // Two sub-shapes:
  //   A) Cross-interface: NO top-level interface, each subaction has its
  //      own `interface` field. Worker groups by interface.
  //   B) Same-interface: top-level `interface` is set, subactions may or
  //      may not have their own. If a subaction has its own, it OVERRIDES
  //      the top-level for that subaction (so the LLM can mix interfaces
  //      in the same batch even if a top-level interface is provided as
  //      a "default").
  //
  // We don't enforce shape-A-vs-B strictly — we just accept either as
  // long as every subaction has a resolved interface (top-level or
  // per-subaction) by the time the worker sees it.
  if (Array.isArray(value.actions)) {
    if (value.actions.length === 0) return null;
    if (value.actions.length > 16) return null; // sanity cap
    const sub: InterfaceSubAction[] = [];
    for (const raw of value.actions) {
      const parsed = parseSubAction(raw);
      if (!parsed) return null;
      sub.push(parsed);
    }
    return {
      ...(topIface ? { interface: topIface } : {}),
      actions: sub,
    };
  }

  // Legacy single-action form: { action, interface, vlan?, description? }
  // Requires a top-level interface.
  if (!topIface) return null;
  const iface = topIface;

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
    interface: iface,
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
