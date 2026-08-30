import { JobStatus, JobType, type Job } from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';

type ConfigJobResult = {
  hostname?: string;
  version?: string;
  config?: string;
  uptimeSeconds?: number | string | null;
};

function parseUptimeSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function token(value: string | undefined): string {
  const text = (value ?? '').trim().replace(/^"+|"+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(text)) {
    return '';
  }
  return text;
}

function parseFromSetConfig(config: string): { hostname: string; version: string } {
  const host = config.match(/^set system host-name\s+(\S+)/m)?.[1];
  const version = config.match(/^set version\s+(\S+)/m)?.[1];
  return {
    hostname: token(host),
    version: token(version),
  };
}

export async function applyCollectedDeviceFacts(job: Job) {
  if (job.type !== JobType.GET_CONFIG || job.status !== JobStatus.SUCCESS || !job.deviceId) {
    return null;
  }

  const result = (job.result ?? {}) as ConfigJobResult;
  const fromConfig = parseFromSetConfig(String(result.config ?? ''));
  const hostname = token(result.hostname) || fromConfig.hostname;
  const version = token(result.version) || fromConfig.version;
  const uptimeSeconds = parseUptimeSeconds(result.uptimeSeconds);
  if (!hostname && !version && uptimeSeconds == null) {
    return null;
  }

  const device = await prisma.device.findUnique({ where: { id: job.deviceId } });
  if (!device) {
    return null;
  }

  const data: { name?: string; version?: string; description?: string; site?: string; floor?: string; uptimeSeconds?: number; uptimeAt?: Date } = {};
  const nextName = hostname || device.name;
  if (hostname && hostname !== device.name) {
    data.name = hostname;
    const description = device.description ?? '';
    if (!description || description.startsWith('Hostname ') || description.includes(device.name)) {
      data.description = description.includes(device.name)
        ? description.replaceAll(device.name, hostname)
        : `Hostname ${hostname} (Junos REST)`;
    }
  }
  const nextSite = canonicalSite(nextName, device.site);
  if (nextSite && nextSite !== device.site) {
    data.site = nextSite;
  }
  const nextFloor = canonicalFloor(nextName, device.floor);
  if (nextFloor && nextFloor !== device.floor) {
    data.floor = nextFloor;
  }
  if (version && version !== device.version) {
    data.version = version;
  }
  if (uptimeSeconds != null) {
    data.uptimeSeconds = uptimeSeconds;
    data.uptimeAt = new Date();
  }

  if (Object.keys(data).length === 0) {
    return device;
  }

  const updated = await prisma.device.update({
    where: { id: device.id },
    data,
  });
  console.log(
    `[identity] ${device.ip} updated${data.name ? ` name ${device.name} -> ${updated.name}` : ''}${data.version ? ` version ${device.version} -> ${updated.version}` : ''}`,
  );
  return updated;
}
