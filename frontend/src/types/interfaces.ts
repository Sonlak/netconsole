export type DeviceInterface = {
  name: string;
  adminStatus: string;
  operStatus: string;
  description?: string;
  mode?: string;
  accessVlan?: string;
  address?: string;
  mtu?: string;
  speed?: string;
};

export type InterfaceDeviceOption = {
  id: string;
  name: string;
  ip: string;
  site: string;
  floor: string;
  status: string;
  vendor?: string;
  model?: string;
};

export type InterfaceInventoryResponse = {
  device: {
    id: string;
    name: string;
    ip: string;
    site: string;
    floor: string;
    status: string;
  };
  interfaces: DeviceInterface[];
  jobId: string | null;
  collectedAt: string | null;
  source: string | null;
};

export type InterfaceAction = 'shut' | 'no-shut' | 'show-run' | 'set-access-vlan';

export type InterfaceActionRequest = {
  action: InterfaceAction;
  interface: string;
  vlan?: string;
};
