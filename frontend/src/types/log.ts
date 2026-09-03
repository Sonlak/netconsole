export type LogSeverity =
  | 'EMERGENCY'
  | 'ALERT'
  | 'CRITICAL'
  | 'ERROR'
  | 'WARNING'
  | 'NOTICE'
  | 'INFORMATIONAL'
  | 'DEBUG';

export type LogFacility =
  | 'KERNEL'
  | 'USER'
  | 'MAIL'
  | 'DAEMON'
  | 'AUTHORIZATION'
  | 'SYSLOG'
  | 'NTP'
  | 'SECURITY'
  | 'CONSOLE'
  | 'LOCAL0'
  | 'LOCAL1'
  | 'LOCAL2'
  | 'LOCAL3'
  | 'LOCAL4'
  | 'LOCAL5'
  | 'LOCAL6'
  | 'LOCAL7'
  | 'PFE'
  | 'FIREWALL'
  | 'CHANGE_LOG'
  | 'INTERACTIVE_COMMANDS'
  | 'CONFLICT_LOG'
  | 'DFC'
  | 'EXTERNAL'
  | 'FTP'
  | 'PRINTER'
  | 'NEWS'
  | 'UUCP'
  | 'CLOCK'
  | 'AUTH_PRIVATE'
  | 'UNKNOWN';

export type DeviceLogRow = {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceIp: string | null;
  site: string;
  floor: string;
  hostname: string;
  severity: LogSeverity;
  facility: LogFacility;
  timestamp: string;
  receivedAt: string;
  program: string | null;
  pid: number | null;
  tag: string | null;
  message: string;
  jobId: string | null;
};

export type LogsInventory = {
  rows: DeviceLogRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
  severities: LogSeverity[];
};

export type LogsCollectResponse = {
  jobs: { id: string; deviceId: string | null }[];
  deviceCount?: number;
  message?: string;
};

export const LOG_SEVERITY_ORDER: LogSeverity[] = [
  'EMERGENCY',
  'ALERT',
  'CRITICAL',
  'ERROR',
  'WARNING',
  'NOTICE',
  'INFORMATIONAL',
  'DEBUG',
];

export const LOG_SEVERITY_LABEL: Record<LogSeverity, string> = {
  EMERGENCY: 'emergency',
  ALERT: 'alert',
  CRITICAL: 'critical',
  ERROR: 'error',
  WARNING: 'warning',
  NOTICE: 'notice',
  INFORMATIONAL: 'info',
  DEBUG: 'debug',
};

export const LOG_SEVERITY_COLOR: Record<LogSeverity, string> = {
  EMERGENCY: 'magenta',
  ALERT: 'red',
  CRITICAL: 'volcano',
  ERROR: 'orange',
  WARNING: 'gold',
  NOTICE: 'blue',
  INFORMATIONAL: 'cyan',
  DEBUG: 'default',
};

export const LOG_FACILITY_LABEL: Record<LogFacility, string> = {
  KERNEL: 'kernel',
  USER: 'user',
  MAIL: 'mail',
  DAEMON: 'daemon',
  AUTHORIZATION: 'auth',
  SYSLOG: 'syslog',
  NTP: 'ntp',
  SECURITY: 'security',
  CONSOLE: 'console',
  LOCAL0: 'local0',
  LOCAL1: 'local1',
  LOCAL2: 'local2',
  LOCAL3: 'local3',
  LOCAL4: 'local4',
  LOCAL5: 'local5',
  LOCAL6: 'local6',
  LOCAL7: 'local7',
  PFE: 'pfe',
  FIREWALL: 'firewall',
  CHANGE_LOG: 'change-log',
  INTERACTIVE_COMMANDS: 'interactive-commands',
  CONFLICT_LOG: 'conflict-log',
  DFC: 'dfc',
  EXTERNAL: 'external',
  FTP: 'ftp',
  PRINTER: 'printer',
  NEWS: 'news',
  UUCP: 'uucp',
  CLOCK: 'clock',
  AUTH_PRIVATE: 'auth-private',
  UNKNOWN: 'unknown',
};