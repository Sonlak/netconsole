import { DeviceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { pingHost } from './ping.js';

export type DevicePingOutcome = {
  deviceId: string;
  ip: string;
  alive: boolean;
  latencyMs: number | null;
  status: DeviceStatus;
  skipped: boolean;
  reason?: string;
};

function hasFullManagedChecks(checks: unknown): boolean {
  if (!checks || typeof checks !== 'object') {
    return false;
  }
  const value = checks as Record<string, unknown>;
  return Boolean(value.ping && value.ssh && value.showVersion && value.showRun);
}

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

  const ping = await pingHost(device.ip);
  const nextStatus = ping.alive
    ? device.status === DeviceStatus.MANAGED || hasFullManagedChecks(device.managedChecks)
      ? DeviceStatus.MANAGED
      : device.status === DeviceStatus.OFFLINE || device.status === DeviceStatus.UNKNOWN
        ? DeviceStatus.ONLINE
        : device.status
    : DeviceStatus.OFFLINE;

  await prisma.device.update({
    where: { id: device.id },
    data: {
      status: nextStatus,
      lastPingAt: new Date(),
      lastPingMs: ping.latencyMs,
    },
  });

  return {
    deviceId: device.id,
    ip: device.ip,
    alive: ping.alive,
    latencyMs: ping.latencyMs,
    status: nextStatus,
    skipped: false,
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
