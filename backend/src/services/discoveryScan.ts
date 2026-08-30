import {
  DeviceStatus,
  DiscoveryResultStatus,
  DiscoveryScanStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { pingHost } from './ping.js';
import { parseJuniperShowVersion, runLabSshProbe } from './labSsh.js';
import { probeJunosRestIdentity } from './junosRest.js';
import { queueDeviceTabCollections } from './deviceTabCollection.js';

const labSshEnabled = process.env.LAB_SSH_ENABLED === 'true';
const labSshUser = process.env.LAB_SSH_USER ?? 'lab';
const labSshPassword = process.env.LAB_SSH_PASSWORD ?? 'lab123';
const labSshPort = Number(process.env.LAB_SSH_PORT ?? 22);

export type DiscoveredFields = {
  name: string;
  vendor: string;
  model: string;
  version: string;
  serial: string;
  description?: string;
  showRun?: string;
};

export async function probeDiscoveredHost(ip: string): Promise<{
  sshOk: boolean;
  fields: DiscoveredFields | null;
  error?: string;
}> {
  const rest = await probeJunosRestIdentity(ip);
  if (rest.ok && rest.fields) {
    const hostname = rest.fields.hostname?.trim();
    return {
      sshOk: true,
      fields: {
        name: hostname || `juniper-${ip.split('.').pop()}`,
        vendor: rest.fields.vendor || 'Juniper',
        model: rest.fields.model || 'Unknown',
        version: rest.fields.version || '-',
        serial: rest.fields.serial || `DISC-${ip.replace(/\./g, '')}`,
        description: hostname
          ? `Hostname ${hostname} (Junos REST)`
          : `Discovered via Junos REST (${ip})`,
        showRun: rest.raw,
      },
    };
  }

  if (labSshEnabled) {
    const ssh = await runLabSshProbe(ip, {
      username: labSshUser,
      password: labSshPassword,
      port: labSshPort,
    });

    if (!ssh.sshOk || !ssh.showVersion.trim()) {
      return {
        sshOk: false,
        fields: null,
        error: ssh.error ?? rest.error ?? 'SSH/REST probe failed',
      };
    }

    const parsed = parseJuniperShowVersion(ssh.showVersion);
    const hostname = parsed.hostname?.trim();
    return {
      sshOk: true,
      fields: {
        name: hostname ?? `juniper-${ip.split('.').pop()}`,
        vendor: parsed.vendor ?? 'Juniper',
        model: parsed.model ?? 'Unknown',
        version: parsed.version ?? '-',
        serial: parsed.serial ?? `DISC-${ip.replace(/\./g, '')}`,
        description: hostname
          ? `Hostname ${hostname} (SSH)`
          : `Discovered via lab SSH (${ip})`,
        showRun: ssh.showRun,
      },
    };
  }

  return {
    sshOk: false,
    fields: null,
    error: rest.error ?? 'JUNOS REST/SSH chưa xác thực được thiết bị — không dùng dữ liệu stub',
  };
}

async function processIp(scanId: string, ip: string) {
  const existingDevice = await prisma.device.findUnique({ where: { ip } });

  const ping = await pingHost(ip, 1000);
  if (!ping.alive) {
    await prisma.discoveryResult.create({
      data: {
        scanId,
        ip,
        status: DiscoveryResultStatus.PING_FAIL,
        pingOk: false,
        pingMs: ping.latencyMs,
        deviceId: existingDevice?.id,
      },
    });
    return { reachable: false, discovered: false };
  }

  if (existingDevice) {
    const probe = await probeDiscoveredHost(ip);
    const fields = probe.fields;

    if (fields && probe.sshOk) {
      await prisma.device.update({
        where: { id: existingDevice.id },
        data: {
          name: fields.name,
          site: canonicalSite(fields.name, existingDevice.site) || existingDevice.site,
          floor: canonicalFloor(fields.name, existingDevice.floor) || existingDevice.floor,
          vendor: fields.vendor,
          model: fields.model,
          version: fields.version,
          serial: fields.serial,
          description: fields.description,
        },
      });
    }

    await prisma.discoveryResult.create({
      data: {
        scanId,
        ip,
        status: DiscoveryResultStatus.SKIPPED_EXISTS,
        pingOk: true,
        pingMs: ping.latencyMs,
        sshOk: probe.sshOk,
        name: fields?.name ?? existingDevice.name,
        vendor: fields?.vendor ?? existingDevice.vendor,
        model: fields?.model ?? existingDevice.model,
        version: fields?.version ?? existingDevice.version,
        serial: fields?.serial ?? existingDevice.serial,
        description: fields?.description ?? existingDevice.description,
        showRun: fields?.showRun,
        error: probe.sshOk ? 'IP đã tồn tại — đã cập nhật hostname/serial/model từ thiết bị' : probe.error ?? 'SSH/REST probe failed',
        deviceId: existingDevice.id,
      },
    });
    return { reachable: true, discovered: false };
  }

  const result = await prisma.discoveryResult.create({
    data: {
      scanId,
      ip,
      status: DiscoveryResultStatus.PROBING,
      pingOk: true,
      pingMs: ping.latencyMs,
    },
  });

  try {
    const probe = await probeDiscoveredHost(ip);
    const fields = probe.fields;

    if (!fields) {
      await prisma.discoveryResult.update({
        where: { id: result.id },
        data: {
          status: DiscoveryResultStatus.FAILED,
          error: probe.error ?? 'Probe failed',
        },
      });
      return { reachable: true, discovered: false };
    }

    await prisma.discoveryResult.update({
      where: { id: result.id },
      data: {
        status: DiscoveryResultStatus.DISCOVERED,
        sshOk: probe.sshOk,
        name: fields.name,
        vendor: fields.vendor,
        model: fields.model,
        version: fields.version,
        serial: fields.serial,
        description: fields.description,
        showRun: fields.showRun,
        error: probe.sshOk ? null : probe.error ?? null,
      },
    });

    return { reachable: true, discovered: true };
  } catch (error) {
    await prisma.discoveryResult.update({
      where: { id: result.id },
      data: {
        status: DiscoveryResultStatus.FAILED,
        error: error instanceof Error ? error.message : 'Probe failed',
      },
    });
    return { reachable: true, discovered: false };
  }
}

async function runScan(scanId: string, ips: string[]) {
  const concurrency = 64;
  let scanned = 0;
  let reachable = 0;
  let discovered = 0;

  try {
    await prisma.discoveryScan.update({
      where: { id: scanId },
      data: { status: DiscoveryScanStatus.RUNNING, totalHosts: ips.length },
    });

    for (let index = 0; index < ips.length; index += concurrency) {
      const batch = ips.slice(index, index + concurrency);
      const outcomes = await Promise.all(batch.map((ip) => processIp(scanId, ip)));

      for (const outcome of outcomes) {
        scanned += 1;
        if (outcome.reachable) {
          reachable += 1;
        }
        if (outcome.discovered) {
          discovered += 1;
        }
      }

      await prisma.discoveryScan.update({
        where: { id: scanId },
        data: { scanned, reachable, discovered },
      });
    }

    await prisma.discoveryScan.update({
      where: { id: scanId },
      data: { status: DiscoveryScanStatus.COMPLETED },
    });
  } catch (error) {
    await prisma.discoveryScan.update({
      where: { id: scanId },
      data: {
        status: DiscoveryScanStatus.FAILED,
        error: error instanceof Error ? error.message : 'Discovery scan failed',
      },
    });
  }
}

export async function startDiscoveryScan(input: {
  subnet: string;
  site?: string;
  floor?: string;
}) {
  const { expandCidr } = await import('../utils/subnet.js');
  const ips = expandCidr(input.subnet);

  const scan = await prisma.discoveryScan.create({
    data: {
      subnet: input.subnet.trim(),
      site: input.site?.trim() ?? '',
      floor: input.floor?.trim() ?? '',
      status: DiscoveryScanStatus.PENDING,
      totalHosts: ips.length,
    },
  });

  setImmediate(() => {
    void runScan(scan.id, ips);
  });

  return scan;
}

export async function syncDiscoveryResults(
  scanId: string,
  resultIds: string[],
  overrides?: { site?: string; floor?: string },
) {
  const scan = await prisma.discoveryScan.findUnique({ where: { id: scanId } });
  if (!scan) {
    throw new Error('Discovery scan not found');
  }

  const results = await prisma.discoveryResult.findMany({
    where: {
      scanId,
      id: { in: resultIds },
      status: DiscoveryResultStatus.DISCOVERED,
    },
  });

  const site = overrides?.site?.trim() || scan.site || 'Default Site';
  const floor = overrides?.floor?.trim() || scan.floor || 'F1';

  const synced: string[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const result of results) {
    try {
      const existing = await prisma.device.findUnique({ where: { ip: result.ip } });
      if (existing) {
        await prisma.discoveryResult.update({
          where: { id: result.id },
          data: {
            status: DiscoveryResultStatus.SKIPPED_EXISTS,
            deviceId: existing.id,
            error: 'IP đã tồn tại khi sync',
          },
        });
        continue;
      }

      const name = result.name?.trim() || `device-${result.ip}`;
      const serial = result.serial?.trim() || `DISC-${result.ip.replace(/\./g, '')}`;
      const device = await prisma.device.create({
        data: {
          site: canonicalSite(name, site) || site,
          floor: canonicalFloor(name, floor) || floor,
          name,
          ip: result.ip,
          status: result.sshOk ? DeviceStatus.MANAGED : DeviceStatus.ONLINE,
          vendor: result.vendor?.trim() || 'Unknown',
          model: result.model?.trim() || 'Unknown',
          version: result.version?.trim() || '-',
          serial,
          description: result.description?.trim() || `Synced from discovery ${scan.subnet}`,
          lastPingAt: new Date(),
          lastPingMs: result.pingMs,
          managedChecks: {
            ping: result.pingOk,
            ssh: result.sshOk,
            showVersion: result.sshOk,
            showRun: Boolean(result.showRun),
          },
        },
      });

      await prisma.discoveryResult.update({
        where: { id: result.id },
        data: {
          status: DiscoveryResultStatus.SYNCED,
          deviceId: device.id,
        },
      });

      synced.push(device.id);
    } catch (error) {
      errors.push({
        id: result.id,
        error: error instanceof Error ? error.message : 'Sync failed',
      });
    }
  }

  if (synced.length > 0) {
    try {
      await queueDeviceTabCollections({ deviceIds: synced });
    } catch (error) {
      console.error('[tabs] auto-queue after discovery sync failed', error);
    }
  }

  return { syncedCount: synced.length, deviceIds: synced, errors };
}
