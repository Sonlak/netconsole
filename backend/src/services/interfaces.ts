import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { reclaimStaleJobs } from './jobWatchdog.js';

export type InterfaceAction = 'shut' | 'no-shut' | 'show-run' | 'set-access-vlan';

export type InterfaceActionPayload = {
  action: InterfaceAction;
  interface: string;
  vlan?: string;
};

const ACTION_VALUES: InterfaceAction[] = ['shut', 'no-shut', 'show-run', 'set-access-vlan'];

export function parseInterfaceActionPayload(body: unknown): InterfaceActionPayload | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const value = body as Record<string, unknown>;
  const action = value.action;
  const iface = value.interface;

  if (typeof action !== 'string' || !ACTION_VALUES.includes(action as InterfaceAction)) {
    return null;
  }
  if (typeof iface !== 'string' || !iface.trim()) {
    return null;
  }

  const vlan = typeof value.vlan === 'string' ? value.vlan.trim() : undefined;
  if (action === 'set-access-vlan' && (!vlan || !/^\d{1,4}$/.test(vlan))) {
    return null;
  }

  return {
    action: action as InterfaceAction,
    interface: iface.trim(),
    ...(vlan ? { vlan } : {}),
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

export async function queueInterfaceAction(deviceId: string, payload: InterfaceActionPayload) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    return null;
  }

  return prisma.job.create({
    data: {
      deviceId,
      type: JobType.INTERFACE_ACTION,
      status: JobStatus.PENDING,
      payload: payload as Prisma.InputJsonValue,
    },
    include: {
      device: {
        select: { id: true, name: true, ip: true, site: true, floor: true },
      },
    },
  });
}
