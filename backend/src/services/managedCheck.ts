import { DeviceStatus, JobStatus, JobType, type Job } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { pingHost } from './ping.js';
import { jobPriority } from './deviceOperations.js';

export type ManagedChecks = {
  ping: boolean;
  ssh: boolean;
  rest: boolean;
  showVersion: boolean;
  showRun: boolean;
};

export type ParsedDeviceFields = {
  vendor?: string;
  model?: string;
  version?: string;
  serial?: string;
  hostname?: string;
  description?: string;
  uptimeSeconds?: number | string;
};

export type ManagedCheckResult = {
  checks: ManagedChecks;
  parsed?: ParsedDeviceFields;
  showVersion?: string;
  showRun?: string;
  message?: string;
};

export async function startManagedCheck(deviceId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  if (device.status === DeviceStatus.MAINTENANCE) {
    return {
      device,
      skipped: true,
      reason: 'Device is in MAINTENANCE mode',
    };
  }

  const ping = await pingHost(device.ip, 1500);
  const pingChecks: ManagedChecks = {
    ping: ping.alive,
    ssh: false,
    rest: false,
    showVersion: false,
    showRun: false,
  };

  if (!ping.alive) {
    const updated = await prisma.device.update({
      where: { id: device.id },
      data: {
        status: DeviceStatus.OFFLINE,
        lastPingAt: new Date(),
        lastPingMs: ping.latencyMs,
        lastManagedCheckAt: new Date(),
        managedChecks: pingChecks,
        manageError: 'Ping failed',
      },
    });

    return {
      device: updated,
      skipped: false,
      stage: 'ping',
      checks: pingChecks,
      job: null,
    };
  }

  const reachable = await prisma.device.update({
    where: { id: device.id },
    data: {
      status: device.status === DeviceStatus.MANAGED ? DeviceStatus.MANAGED : DeviceStatus.ONLINE,
      lastPingAt: new Date(),
      lastPingMs: ping.latencyMs,
      manageError: null,
    },
  });

  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.MANAGED_CHECK,
      status: JobStatus.PENDING,
      priority: jobPriority(JobType.MANAGED_CHECK),
    },
    include: { device: true },
  });

  return {
    device: reachable,
    skipped: false,
    stage: 'queued',
    checks: pingChecks,
    job,
  };
}

export async function startManagedCheckAll() {
  const devices = await prisma.device.findMany({
    where: { status: { not: DeviceStatus.MAINTENANCE } },
    orderBy: { name: 'asc' },
  });
  const skippedMaintenance = await prisma.device.count({
    where: { status: DeviceStatus.MAINTENANCE },
  });

  const results = await Promise.all(
    devices.map(async (device) => {
      const inflight = await prisma.job.findFirst({
        where: {
          deviceId: device.id,
          type: JobType.MANAGED_CHECK,
          status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (inflight) {
        return {
          deviceId: device.id,
          name: device.name,
          ip: device.ip,
          skipped: true,
          reason: 'Managed check already queued',
          stage: 'queued',
          jobId: inflight.id,
        };
      }

      const result = await startManagedCheck(device.id);
      return {
        deviceId: device.id,
        name: device.name,
        ip: device.ip,
        skipped: Boolean(result.skipped),
        reason: 'reason' in result ? result.reason : undefined,
        stage: 'stage' in result ? result.stage : undefined,
        jobId: 'job' in result ? result.job?.id : undefined,
      };
    }),
  );

  return {
    checked: devices.length,
    skipped: skippedMaintenance + results.filter((item) => item.skipped && !item.jobId).length,
    queued: results.filter((item) => Boolean(item.jobId)).length,
    offline: results.filter((item) => item.stage === 'ping').length,
    results,
  };
}

export function isFullyManaged(checks: ManagedChecks): boolean {
  // Gate is now `ping + rest` (TCP-reachable API ports). The previous
  // implementation also required `showVersion` + `showRun` to be true,
  // which meant the probe had to actually SSH login and pull
  // `show running-config` on every check — that burned 2 SSH sessions
  // and pushed ~5-50 KB per device every 30s. Now the probe is just a
  // TCP connect (see worker/netconsole_worker/probe.py), so the gate
  // is correspondingly lighter. showVersion/showRun stay in the shape
  // for back-compat but are always false in the worker output.
  //
  // The `ssh` field (plain SSH port 22) is no longer probed for Juniper
  // (auth.log noise). The relevant API ports (830=NETCONF-SSH, 8443=RESTCONF,
  // 443=eAPI) are already covered by the `rest` field, so the gate
  // becomes `ping && rest`.
  return Boolean(checks.ping && checks.rest);
}

export async function applyManagedCheckResult(job: Job) {
  if (job.type !== JobType.MANAGED_CHECK) {
    return null;
  }

  if (!job.deviceId) {
    return null;
  }

  const device = await prisma.device.findUnique({ where: { id: job.deviceId } });
  if (!device) {
    return null;
  }

  if (job.status === JobStatus.FAILED) {
    return prisma.device.update({
      where: { id: device.id },
      data: {
        status: DeviceStatus.ONLINE,
        lastManagedCheckAt: new Date(),
        manageError: job.error ?? 'Managed check failed',
      },
    });
  }

  const result = (job.result ?? {}) as ManagedCheckResult;
  const checks = result.checks ?? {
    ping: true,
    ssh: false,
    rest: false,
    showVersion: false,
    showRun: false,
  };

  if (!isFullyManaged(checks)) {
    return prisma.device.update({
      where: { id: device.id },
      data: {
        status: DeviceStatus.ONLINE,
        lastManagedCheckAt: new Date(),
        managedChecks: checks,
        manageError:
          result.message ?? 'SSH or REST/NETCONF API port not reachable',
      },
    });
  }

  const parsed = result.parsed ?? {};
  const uptimeSeconds = Number.parseInt(String(parsed.uptimeSeconds ?? ''), 10);
  const nextName = parsed.hostname?.trim() || device.name;
  const nextFloor = canonicalFloor(nextName, device.floor);
  const nextSite = canonicalSite(nextName, device.site);

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      status: DeviceStatus.MANAGED,
      vendor: parsed.vendor?.trim() || device.vendor,
      model: parsed.model?.trim() || device.model,
      version: parsed.version?.trim() || device.version,
      serial: parsed.serial?.trim() || device.serial,
      name: nextName,
      site: nextSite || device.site,
      floor: nextFloor || device.floor,
      description: parsed.description?.trim() || device.description,
      ...(Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0
        ? { uptimeSeconds, uptimeAt: new Date() }
        : {}),
      lastManagedCheckAt: new Date(),
      managedChecks: checks,
      manageError: null,
    },
  });

  return updated;
}

export function scheduleManagedCheck(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 30) * 1000;
  const run = async () => {
    try {
      const result = await startManagedCheckAll();
      console.log(`[managed-check] checked ${result.checked} device(s), queued ${result.queued} job(s)`);
    } catch (error) {
      console.error('[managed-check] scheduled run failed:', error);
    }
  };
  // Run immediately on startup, then on the interval
  void run();
  return setInterval(run, intervalMs);
}
