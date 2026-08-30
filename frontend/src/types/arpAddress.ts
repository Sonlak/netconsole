export type ArpAddressRow = {
  ip: string;
  mac: string;
  hostname: string;
  interface: string;
  flags: string;
  deviceId: string;
  deviceName: string;
  site: string;
  floor: string;
  deviceIp: string;
  collectedAt: string | null;
};

export type ArpAddressInventory = {
  rows: ArpAddressRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
};

export type ArpCollectResponse = {
  jobs: { id: string; deviceId: string | null }[];
  deviceCount?: number;
  message?: string;
};
