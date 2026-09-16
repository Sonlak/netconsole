import {
  DeviceStatus,
  DiscoveryResultStatus,
  DiscoveryScanStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { pingHost } from './ping.js';
import { parseIosShowVersion, parseJuniperShowVersion, runIosxeSshProbe, runLabSshProbe } from './labSsh.js';
import { probeIosHttpExecIdentity, probeIosxeRestIdentity } from './iosxeRest.js';
import { probeJunosRestIdentity } from './junosRest.js';
import { probeEosApiIdentity } from './eosApi.js';
import { queueDeviceTabCollections } from './deviceTabCollection.js';

const labSshEnabled = process.env.LAB_SSH_ENABLED === 'true';
const labSshUser = process.env.LAB_SSH_USER ?? 'lab';
const labSshPassword = process.env.LAB_SSH_PASSWORD ?? 'lab123';
const labSshPort = Number(process.env.LAB_SSH_PORT ?? 22);

// IOS SSH probe uses the IOSXE_API_* env vars (same creds as RESTCONF /
// HTTP-exec) so a single `netconsole / Admin@123` account works against
// the legacy IOS HTTP server, RESTCONF, AND SSH.
const iosxeSshEnabled = process.env.IOSXE_SSH_ENABLED === 'true' || labSshEnabled;
const iosxeSshUser = process.env.IOSXE_API_USER || process.env.LAB_SSH_USER || 'admin';
const iosxeSshPassword = process.env.IOSXE_API_PASSWORD || process.env.LAB_SSH_PASSWORD || 'Admin@123';
const iosxeSshPort = Number(process.env.IOSXE_API_SSH_PORT ?? labSshPort);

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
  // Fan out across vendors in parallel. Each probe is gated by its own env
  // var (JUNOS_REST_ENABLED / IOSXE_API_ENABLED / EOS_API_ENABLED) and
  // returns ok=false immediately if disabled. Whichever probe returns a
  // valid identity first wins — the other results are ignored.
  //
  // IOS fans out across RESTCONF + HTTP-server-exec in parallel because
  // some IOS images have RESTCONF, some only have the legacy HTML exec
  // endpoint, and some have neither (SSH fallback below). Whichever
  // responds with valid identity wins.
  const probes = await Promise.allSettled([
    probeJunosRestIdentity(ip),
    probeIosxeRestIdentity(ip),
    probeIosHttpExecIdentity(ip),
    probeEosApiIdentity(ip),
  ]);

  for (const outcome of probes) {
    if (outcome.status !== 'fulfilled') continue;
    const result = outcome.value;
    if (!result.ok || !result.fields) continue;

    const fields = result.fields;
    const hostname = fields.hostname?.trim();
    const vendor = fields.vendor || 'Unknown';
    const lastOctet = ip.split('.').pop();
    return {
      sshOk: true,
      fields: {
        name: hostname || `${vendor.toLowerCase()}-${lastOctet}`,
        vendor,
        model: fields.model || 'Unknown',
        version: fields.version || '-',
        serial: fields.serial || `DISC-${ip.replace(/\./g, '')}`,
        description: hostname
          ? `Hostname ${hostname} (${vendor} API)`
          : `Discovered via ${vendor} API (${ip})`,
      },
    };
  }

  // RESTCONF/eAPI probes all failed (or were disabled). Fall back to SSH
  // per-vendor. SSH probes run in parallel — first one to extract a
  // hostname wins. Disabled when no SSH env flag is set so deployments
  // without an SSH account on lab devices don't burn ~5s per host.
  if (labSshEnabled || iosxeSshEnabled) {
    const sshJobs: Array<Promise<{ vendor: string; sshOk: boolean; hostname?: string; model?: string; version?: string; serial?: string; showRun?: string; error?: string }>> = [];

    if (labSshEnabled) {
      sshJobs.push(
        runLabSshProbe(ip, {
          username: labSshUser,
          password: labSshPassword,
          port: labSshPort,
        }).then((res) => {
          if (!res.sshOk || !res.showVersion.trim()) {
            return { vendor: 'Juniper', sshOk: false, error: res.error ?? 'SSH probe failed' };
          }
          const parsed = parseJuniperShowVersion(res.showVersion);
          return { sshOk: true, ...parsed, showRun: res.showRun };
        }),
      );
    }

    if (iosxeSshEnabled) {
      sshJobs.push(
        runIosxeSshProbe(ip, {
          username: iosxeSshUser,
          password: iosxeSshPassword,
          port: iosxeSshPort,
        }).then((res) => {
          if (!res.sshOk || !res.showVersion.trim()) {
            return { vendor: 'Cisco', sshOk: false, error: res.error ?? 'SSH probe failed' };
          }
          const parsed = parseIosShowVersion(res.showVersion);
          return { sshOk: true, ...parsed };
        }),
      );
    }

    const settled = await Promise.allSettled(sshJobs);
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      const r = outcome.value;
      if (!r.sshOk) continue;
      const hostname = r.hostname?.trim();
      const vendor = r.vendor || 'Unknown';
      const lastOctet = ip.split('.').pop();
      return {
        sshOk: true,
        fields: {
          name: hostname || `${vendor.toLowerCase()}-${lastOctet}`,
          vendor,
          model: r.model || 'Unknown',
          version: r.version || '-',
          serial: r.serial || `DISC-${ip.replace(/\./g, '')}`,
          description: hostname
            ? `Hostname ${hostname} (${vendor} SSH)`
            : `Discovered via ${vendor} SSH (${ip})`,
          showRun: r.showRun,
        },
      };
    }

    // Surface the SSH error so the user can see what happened.
    const firstErr = settled.find((s) => s.status === 'fulfilled') as PromiseFulfilledResult<{ error?: string }> | undefined;
    return {
      sshOk: false,
      fields: null,
      error: firstErr?.value?.error ?? 'SSH probe failed for all vendors',
    };
  }

  // Surface the first RESTCONF/eAPI error so the user can see why each
  // vendor probe didn't recognise the host (auth fail vs. wrong port, etc.).
  const errors = probes
    .filter((p) => p.status === 'fulfilled')
    .map((p) => (p as PromiseFulfilledResult<{ ok: boolean; error?: string }>).value.error)
    .filter((e): e is string => typeof e === 'string' && e !== '');

  return {
    sshOk: false,
    fields: null,
    error: errors[0] ?? 'No RESTCONF/eAPI responded for any enabled vendor',
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
