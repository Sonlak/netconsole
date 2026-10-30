export type DhcpPool = {
  /** Junos pool name (e.g. "V201"). */
  poolName: string;
  /** Display name — derived from the VLAN. */
  name: string;
  site: string;
  vlan: number;
  subnet: string;
  /** Inclusive dynamic range, "start-end". */
  pool: string;
  gateway: string;
  dns: string[];
  leased: number;
  poolSize: number;
  utilization: number;
  /** Number of static reservations in this pool. */
  reserved: number;
  /** IRB the local server is attached to ("irb.201"). */
  interface: string;
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

/**
 * The DHCP server. Since the Kea HA pair was removed (2026-10-30) the
 * distribution switch (DS1) is the only DHCP server in the network.
 */
export type DhcpServer = {
  /** Device name (e.g. "LAB-F6-DS-01"). */
  name: string;
  /** IP / hostname used to reach it. */
  host: string;
  /** Whether the switch answered the last query. */
  reachable: boolean;
  /** Where the lease data came from: "restconf" | "ssh". */
  source: string;
};

export type DhcpDashboard = {
  server: DhcpServer;
  sites: DhcpSiteSummary[];
  pools: DhcpPool[];
  gateways: DhcpGateway[];
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
  clientDevice: string;
  clientPort: string;
  /** Junos pool that owns the lease. */
  poolName: string;
  subnet?: string;
  site?: string;
  vlan?: number;
  validLifetime: number;
  cltt: number | null;
  expiresAt: string | null;
  /** Raw platform state ("BOUND", "INIT", ...). */
  state: string;
  /** Normalised state ("bound", "static", ...). */
  stateLabel: string;
  reserved?: boolean;
  note?: string;
};
