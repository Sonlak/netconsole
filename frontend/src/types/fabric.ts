export type FabricRole = 'core' | 'dist' | 'access';
export type FabricLinkKind = 'trunk' | 'peer' | 'l3' | 'uplink';

export type FabricNode = {
  id: string;
  name: string;
  shortName: string;
  ip: string;
  site: string;
  floor: string;
  floorNumber: number | null;
  role: FabricRole;
  status: string;
  model: string;
};

export type FabricLink = {
  id: string;
  fromDeviceId: string;
  fromName: string;
  fromPort: string;
  toDeviceId: string;
  toName: string;
  toPort: string;
  kind: FabricLinkKind;
  note: string;
  mode: string;
  operStatus: string;
};

export type FabricTopology = {
  site: string | null;
  nodes: FabricNode[];
  links: FabricLink[];
  collectedAt: string | null;
  nodeCount: number;
  linkCount: number;
  devicesWithPorts: number;
};
