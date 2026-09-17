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
  /** LLDP neighbour on this port (merged at collection time) */
  remoteDeviceId?: string;
  /** Canonical port ID from LLDP Port ID TLV (e.g. "GigabitEthernet1") */
  remotePort?: string;
  /** Human-written Port Description from LLDP TLV (e.g. "LINK_TO_SW-F6-DS-01_ge-0/0/5") */
  portDescription?: string;
  chassisId?: string;
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
