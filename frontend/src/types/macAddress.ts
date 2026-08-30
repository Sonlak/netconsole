export type MacAddressRow = {
  mac: string;
  /** Host IP resolved from ARP for this MAC; "n/a" when unknown. */
  ip: string;
  vlan: string;
  tag: string;
  interface: string;
  flags: string;
  type: string;
  sessId: string;
  deviceId: string;
  deviceName: string;
  site: string;
  floor: string;
  deviceIp: string;
  collectedAt: string | null;
};

export type MacAddressInventory = {
  rows: MacAddressRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
};

export type MacCollectResponse = {
  jobs: { id: string; deviceId: string | null }[];
  deviceCount?: number;
  message?: string;
};
