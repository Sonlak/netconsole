export type DhcpPool = {
  subnetId: number;
  name: string;
  site: string;
  vlan: number;
  subnet: string;
  pool: string;
  gateway: string;
  dns: string[];
  leased: number;
  poolSize: number;
  utilization: number;
};

export type DhcpSiteSummary = {
  site: string;
  pools: number;
  leased: number;
  poolSize: number;
  utilization: number;
};

export type DhcpGateway = {
  site: string;
  vlan: number;
  gateway: string;
  subnet: string;
  name: string;
};

export type DhcpHaPeer = {
  name: string;
  role: string;
  url: string;
  reachable: boolean;
  state?: string;
};

export type DhcpDashboard = {
  sites: DhcpSiteSummary[];
  pools: DhcpPool[];
  gateways: DhcpGateway[];
  ha: {
    mode: string;
    peers: DhcpHaPeer[];
    active: string | null;
  };
  totals: {
    sites: number;
    pools: number;
    leased: number;
    poolSize: number;
  };
};

export type DhcpLease = {
  ip: string;
  mac: string;
  hostname: string;
  subnetId: number;
  subnet?: string;
  site?: string;
  vlan?: number;
  validLifetime: number;
  cltt: number | null;
  expiresAt: string | null;
  state: number;
  stateLabel: string;
  reserved?: boolean;
  note?: string;
};
