import { Router } from 'express';
import {
  collectArpForManagedDevices,
  getArpInventory,
} from '../services/arpAddress.js';
import { requireRole } from '../middleware/auth.js';

export const arpAddressesRouter = Router();

arpAddressesRouter.get('/', async (_req, res) => {
  const inventory = await getArpInventory();
  res.json(inventory);
});

arpAddressesRouter.post('/collect', requireRole('OPERATOR', 'ADMIN'), async (_req, res) => {
  const result = await collectArpForManagedDevices();
  res.status(202).json(result);
});
