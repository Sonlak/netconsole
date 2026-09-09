import { DeviceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export function hasReadyManagedChecks(checks: unknown): boolean {
  if (!checks || typeof checks !== 'object') {
    return false;
  }
  const value = checks as Record<string, unknown>;
  // `rest` is the new gate (RESTCONF / NETCONF TCP reachable). Devices
  // collected before 2026-09-09 may have `showVersion`/`showRun` set
  // but no `rest` key — treat those legacy rows as ready so existing
  // devices stay collectable until the next managed-check refresh.
  const restOk = value.rest === true;
  const legacyOk =
    value.showVersion === true &&
    value.showRun === true &&
    !('rest' in value);
  return Boolean(value.ping && value.ssh && (restOk || legacyOk));
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
