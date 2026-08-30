import { Router } from 'express';
import {
  collectMacAddressesForManagedDevices,
  getMacAddressInventory,
} from '../services/macAddress.js';

export const macAddressesRouter = Router();

macAddressesRouter.get('/', async (_req, res) => {
  const inventory = await getMacAddressInventory();
  res.json(inventory);
});

macAddressesRouter.post('/collect', async (_req, res) => {
  const result = await collectMacAddressesForManagedDevices();
  res.status(202).json(result);
});
