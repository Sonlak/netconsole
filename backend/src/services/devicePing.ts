import { DeviceStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { pingHost } from './ping.js';
import { tryCreateDeviceJob } from './deviceOperations.js';

export type DevicePingOutcome = {
  deviceId: string;
  ip: string;
  alive: boolean;
  latencyMs: number | null;
  status: DeviceStatus;
  skipped: boolean;
  reason?: string;
  managedCheckQueued?: boolean;
};

export async function pingAndUpdateDevice(deviceId: string): Promise<DevicePingOutcome> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  if (device.status === DeviceStatus.MAINTENANCE) {
    return {
      deviceId: device.id,
      ip: device.ip,
      alive: false,
      latencyMs: device.lastPingMs,
      status: device.status,
      skipped: true,
      reason: 'Device is in MAINTENANCE mode',
    };
  }

  const previousStatus = device.status;
  const ping = await pingHost(device.ip);
  // Status logic:
  //   - If ping fails → OFFLINE
  //   - If ping succeeds AND device is already MANAGED → stay MANAGED
  //     (MAINTENANCE is filtered out above)
  //   - If ping succeeds AND device is OFFLINE/UNKNOWN → ONLINE (first time)
  //   - Otherwise → leave unchanged
  //
  // BUG fix: the previous `nextStatus` expression could downgrade a MANAGED
  // device back to ONLINE if `hasFullManagedChecks` returned false (e.g.
  // immediately after a commit reset the managedChecks row). This caused
  // 409 "Thiết bị phải MANAGED trước khi commit" right after a successful
  // commit. MANAGED is an admin-promoted status — only the admin (or the
  // commit/rollback path) should be able to clear it, never ping.
  const nextStatus: DeviceStatus = !ping.alive
    ? DeviceStatus.OFFLINE
    : device.status === DeviceStatus.MANAGED
      ? DeviceStatus.MANAGED
      : device.status === DeviceStatus.OFFLINE || device.status === DeviceStatus.UNKNOWN
        ? DeviceStatus.ONLINE
        : device.status;

  await prisma.device.update({
    where: { id: device.id },
    data: {
      status: nextStatus,
      lastPingAt: new Date(),
      lastPingMs: ping.latencyMs,
    },
  });

  // Recover hook: when a device transitions OFFLINE/UNKNOWN → ONLINE, the
  // managedChecks row is stale (the previous probe found no API ports
  // reachable) so the REST/NETCONF tag in the UI stays red until the next
  // MANAGED_CHECK scheduler tick (default 600s — way too slow for the
  // "device came back online, why is REST still red?" UX complaint).
  //
  // Trigger an urgent MANAGED_CHECK job right now so the TCP probe
  // runs within ~1s of the ping recovery. `tryCreateDeviceJob` returns
  // `busy` if there's already an inflight job for this device — that's
  // fine, we don't want to double-queue; the inflight one will update
  // the flags too.
  let managedCheckQueued = false;
  if (
    ping.alive &&
    (previousStatus === DeviceStatus.OFFLINE || previousStatus === DeviceStatus.UNKNOWN) &&
    nextStatus === DeviceStatus.ONLINE
  ) {
    try {
      const outcome = await prisma.$transaction(async (tx) =>
        tryCreateDeviceJob(tx, device.id, JobType.MANAGED_CHECK, null),
      );
      if (outcome.kind === 'created') {
        managedCheckQueued = true;
        console.log(
          `[ping] ${device.name} recovered OFFLINE→ONLINE, queued MANAGED_CHECK ${outcome.job.id}`,
        );
      } else {
        console.log(
          `[ping] ${device.name} recovered OFFLINE→ONLINE, MANAGED_CHECK skipped: ${outcome.error.code}`,
        );
      }
    } catch (err) {
      console.error(`[ping] failed to queue MANAGED_CHECK for ${device.name}:`, err);
    }
  }

  return {
    deviceId: device.id,
    ip: device.ip,
    alive: ping.alive,
    latencyMs: ping.latencyMs,
    status: nextStatus,
    skipped: false,
    managedCheckQueued,
  };
}

export async function pingAllDevices() {
  const devices = await prisma.device.findMany({
    where: { status: { not: DeviceStatus.MAINTENANCE } },
    orderBy: { name: 'asc' },
  });

  const results: DevicePingOutcome[] = [];

  for (const device of devices) {
    const outcome = await pingAndUpdateDevice(device.id);
    results.push(outcome);
  }

  const skipped = await prisma.device.count({
    where: { status: DeviceStatus.MAINTENANCE },
  });

  return {
    checked: results.length,
    skipped,
    online: results.filter(
      (item) => item.status === DeviceStatus.ONLINE || item.status === DeviceStatus.MANAGED,
    ).length,
    offline: results.filter((item) => item.status === DeviceStatus.OFFLINE).length,
    results,
  };
}

export function scheduleDevicePing(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 15) * 1000;

  const run = async () => {
    try {
      const summary = await pingAllDevices();
      console.log(
        `[ping] checked=${summary.checked} online=${summary.online} offline=${summary.offline} skipped=${summary.skipped}`,
      );
    } catch (error) {
      console.error('[ping] scheduler failed', error);
    }
  };

  void run();
  return setInterval(() => {
    void run();
  }, intervalMs);
}
