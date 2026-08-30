import { DeviceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export function hasReadyManagedChecks(checks: unknown): boolean {
  if (!checks || typeof checks !== 'object') {
    return false;
  }
  const value = checks as Record<string, unknown>;
  return Boolean(value.ping && value.ssh && value.showVersion && value.showRun);
}

export function isCollectableDevice(device: {
  status: DeviceStatus;
  managedChecks: unknown;
}): boolean {
  return (
    device.status === DeviceStatus.MANAGED || hasReadyManagedChecks(device.managedChecks)
  );
}

export async function listCollectableDevices(deviceIds?: string[]) {
  const devices = await prisma.device.findMany({
    where: {
      status: { not: DeviceStatus.MAINTENANCE },
      ...(deviceIds?.length ? { id: { in: deviceIds } } : {}),
    },
    orderBy: [{ site: 'asc' }, { name: 'asc' }],
  });

  return devices.filter(isCollectableDevice);
}
