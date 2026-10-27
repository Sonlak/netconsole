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

/**
 * Kea peer (one site) in the DC↔DR HA pair.
 *
 * `site` distinguishes the physical locations (DC = primary, DR = backup)
 * and is what the UI uses for labels and color coding. `role` is the
 * Kea-level role (primary = serving DHCP, standby = passive).
 */
export type DhcpHaPeer = {
  name: string;
  site: 'DC' | 'DR';
  role: string;
  url: string;
  reachable: boolean;
  /**
   * Kea HA hook state. Possible values:
   *   "waiting" | "syncing" | "hot-standby" | "load-balancing" |
   *   "partner-down" | "unavailable" | "communication-recovered" | "terminated"
   */
  state?: string;
  scopes?: string[];
  lastHeartbeatAt?: string | null;
  uptimeInRole?: number;
};

export type DhcpHa = {
  mode: string;
  peers: DhcpHaPeer[];
  /** Site that is currently serving DHCP: 'DC' | 'DR' | null. */
  active: 'DC' | 'DR' | null;
};

export type DhcpDashboard = {
  sites: DhcpSiteSummary[];
  pools: DhcpPool[];
  gateways: DhcpGateway[];
  ha: DhcpHa;
  totals: {
    sites: number;
    pools: number;
    leased: number;
    poolSize: number;
  };
};

/** Detailed HA state returned by /api/dhcp/ha-state. */
export type HaStateSnapshot = {
  activeSite: 'DC' | 'DR' | null;
  peers: DhcpHaPeer[];
  recommendedAction: 'none' | 'switchover-to-dc' | 'switchover-to-dr' | 'investigate';
  reason: string;
  capturedAt: string;
  /**
   * "hot-standby" — DC↔DR pair with the libdhcp_ha hook loaded.
   * "standalone"  — single Kea server, no DR peer configured.
   */
  mode?: 'hot-standby' | 'standalone';
};

/** Auto-failback scheduler status (in-memory on the backend). */
export type AutoFailbackStatus = {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastFailoverAt: string | null;
  lastFailbackAt: string | null;
  lastFailbackReason: string | null;
  lastFailbackFrom: 'DC' | 'DR' | null;
  lastFailbackTo: 'DC' | 'DR' | null;
  cooldownRemainingSeconds: number;
  stabilityRequiredSeconds: number;
  nextCheckAt: string | null;
  recentEvents: Array<{
    at: string;
    kind: 'failover' | 'failback' | 'switchover' | 'check' | 'skip';
    from: 'DC' | 'DR' | null;
    to: 'DC' | 'DR' | null;
    reason: string;
  }>;
};

export type HaStateResponse = {
  ha: HaStateSnapshot;
  autoFailback: AutoFailbackStatus;
};

export type SwitchoverResult = {
  ok: boolean;
  result: {
    result: number;
    text: string;
    beforeState: HaStateSnapshot;
  };
};

export type DhcpLease = {
  ip: string;
  mac: string;
  hostname: string;
  clientDevice: string;
  clientPort: string;
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
