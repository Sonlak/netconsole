import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import {
  startDiscoveryScan,
  syncDiscoveryResults,
} from '../services/discoveryScan.js';
import { normalizeCidr } from '../utils/subnet.js';

export const discoveryRouter = Router();

discoveryRouter.get('/scans', async (_req, res) => {
  const scans = await prisma.discoveryScan.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      _count: { select: { results: true } },
    },
  });
  res.json(scans);
});

discoveryRouter.get('/scans/:id', async (req, res) => {
  const scan = await prisma.discoveryScan.findUnique({
    where: { id: req.params.id },
    include: {
      results: {
        orderBy: [{ status: 'asc' }, { ip: 'asc' }],
      },
    },
  });

  if (!scan) {
    res.status(404).json({ error: 'Discovery scan not found' });
    return;
  }

  res.json(scan);
});

discoveryRouter.post('/scans', async (req, res) => {
  const { subnet, site, floor } = req.body as {
    subnet?: string;
    site?: string;
    floor?: string;
  };

  if (!subnet?.trim()) {
    res.status(400).json({ error: 'subnet is required, e.g. 10.20.1.0/24' });
    return;
  }

  try {
    normalizeCidr(subnet.trim());
    const scan = await startDiscoveryScan({ subnet, site, floor });
    res.status(202).json(scan);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid subnet',
    });
  }
});

discoveryRouter.post('/scans/:id/sync', async (req, res) => {
  const { resultIds, site, floor } = req.body as {
    resultIds?: string[];
    site?: string;
    floor?: string;
  };

  if (!Array.isArray(resultIds) || resultIds.length === 0) {
    res.status(400).json({ error: 'resultIds array is required' });
    return;
  }

  try {
    const summary = await syncDiscoveryResults(String(req.params.id), resultIds, {
      site,
      floor,
    });
    res.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});
