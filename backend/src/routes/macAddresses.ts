import { Router } from 'express';
import {
  collectMacAddressesForManagedDevices,
  getMacAddressInventory,
} from '../services/macAddress.js';
import { runIosxeSshCommand } from '../services/labSsh.js';
import { prisma } from '../lib/prisma.js';

export const macAddressesRouter = Router();

macAddressesRouter.get('/', async (_req, res) => {
  const inventory = await getMacAddressInventory();
  res.json(inventory);
});

macAddressesRouter.post('/collect', async (_req, res) => {
  const result = await collectMacAddressesForManagedDevices();
  res.status(202).json(result);
});

/**
 * Synchronous IOS-XE MAC collection via backend SSH proxy (skip the job queue).
 *
 * IOS-XE has no stable YANG model for the MAC address table, so there is no
 * RESTCONF path for this. The worker container often cannot reach lab IOS-XE
 * devices on 10.10.20.x directly (no route from docker bridge), but the
 * backend container can. So we expose `show mac address-table` here and let
 * the worker call back into the API.
 *
 * Auth: same `authMiddleware` as the rest of /api. Used by:
 *   - worker `IOSxeBackend.get_mac()` as primary path (no YANG available)
 *   - could be used by future frontends that want a synchronous preview
 */
macAddressesRouter.post('/collect/:deviceId', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  if (device.vendor !== 'Cisco') {
    res.status(400).json({
      error: `MAC via SSH is only wired for Cisco IOS-XE (got ${device.vendor})`,
    });
    return;
  }
  const result = await runIosxeSshCommand(
    device.ip,
    'show mac address-table',
  );
  if (!result.ok) {
    res.status(502).json({ error: result.error ?? 'SSH failed', entries: [] });
    return;
  }
  const raw = result.output ?? '';
  // Parse Cisco MAC table. Format:
  //   Legend: * = 0000.0c07.ac00   |     + = 0000.0c9f.1234
  //   Vlan    Mac Address        Type    Ports
  //   ----    -----------------  ------  -----
  //     10    5000.0007.0003    DYNAMIC Gi1/0/1
  //     20    a000.0000.0001    STATIC  cpu
  const entries: Array<Record<string, string>> = [];
  let capture = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Legend') || line.startsWith('* =')) continue;
    if (line.startsWith('Vlan') || line.startsWith('--') || line.startsWith('---')) {
      capture = true;
      continue;
    }
    if (!capture) continue;
    // Skip separator lines, blank lines
    if (line.startsWith('Total') || line.startsWith('---')) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 3) continue;
    const vlan = cols[0];
    const mac = cols[1];
    const type = cols[2];
    const iface = cols.slice(3).join(' ');
    // Validate MAC format (xxxx.xxxx.xxxx)
    if (!/^[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}$/.test(mac)) continue;
    entries.push({ mac: mac.toLowerCase(), vlan, type: type.toLowerCase(), interface: iface || '-' });
  }
  res.json({ entries, source: 'ssh-cli', raw });
});
