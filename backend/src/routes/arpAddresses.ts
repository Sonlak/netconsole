import { Router } from 'express';
import {
  collectArpForManagedDevices,
  getArpInventory,
} from '../services/arpAddress.js';

export const arpAddressesRouter = Router();

arpAddressesRouter.get('/', async (_req, res) => {
  const inventory = await getArpInventory();
  res.json(inventory);
});

arpAddressesRouter.post('/collect', async (_req, res) => {
  const result = await collectArpForManagedDevices();
  res.status(202).json(result);
});
