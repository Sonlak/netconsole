import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { applyCollectedDeviceFacts } from './deviceIdentity.js';
import { fetchConfigurationSet, junosRestEnabled } from './junosRest.js';

export async function collectDeviceConfig(deviceId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  if (!junosRestEnabled()) {
    const job = await prisma.job.create({
      data: {
        deviceId: device.id,
        type: JobType.GET_CONFIG,
        status: JobStatus.PENDING,
      },
      include: { device: true },
    });
    return { job, device, queued: true as const };
  }

  const rest = await fetchConfigurationSet(device.ip);
  if (!rest.ok || !rest.config) {
    throw new Error(rest.error || 'Junos REST get-configuration failed');
  }

  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.GET_CONFIG,
      status: JobStatus.SUCCESS,
      result: {
        implemented: true,
        source: 'junos-rest',
        config: rest.config,
        hostname: rest.identity.hostname || '',
        version: rest.identity.version || '',
        command: 'get-configuration format=set',
        message: `Collected running config from ${device.name}`,
        collectMs: rest.collectMs,
      },
    },
    include: { device: true },
  });

  const updated = await applyCollectedDeviceFacts(job);
  console.log(`[config] ${device.ip} collected in ${rest.collectMs}ms (${rest.config.split('\n').length} lines)`);
  return { job, device: updated ?? device, queued: false as const };
}
