import type { LogFacility, LogSeverity } from '@prisma/client';

/**
 * Junos syslog severity name → NetConsole Prisma enum.
 * Order from most severe (emergency) to least severe (debug).
 */
export const SEVERITY_FROM_JUNOS: Record<string, LogSeverity> = {
  emergency: 'EMERGENCY',
  alert: 'ALERT',
  critical: 'CRITICAL',
  error: 'ERROR',
  err: 'ERROR',
  warning: 'WARNING',
  warn: 'WARNING',
  notice: 'NOTICE',
  info: 'INFORMATIONAL',
  informational: 'INFORMATIONAL',
  debug: 'DEBUG',
};

/**
 * Junos syslog facility name → NetConsole Prisma enum.
 * Names follow RFC 5424 / Junos `system syslog` facility table.
 */
export const FACILITY_FROM_JUNOS: Record<string, LogFacility> = {
  kern: 'KERNEL',
  kernel: 'KERNEL',
  user: 'USER',
  mail: 'MAIL',
  daemon: 'DAEMON',
  auth: 'AUTHORIZATION',
  authorization: 'AUTHORIZATION',
  syslog: 'SYSLOG',
  ntp: 'NTP',
  security: 'SECURITY',
  console: 'CONSOLE',
  local0: 'LOCAL0',
  local1: 'LOCAL1',
  local2: 'LOCAL2',
  local3: 'LOCAL3',
  local4: 'LOCAL4',
  local5: 'LOCAL5',
  local6: 'LOCAL6',
  local7: 'LOCAL7',
  pfe: 'PFE',
  firewall: 'FIREWALL',
  'change-log': 'CHANGE_LOG',
  changelog: 'CHANGE_LOG',
  'interactive-commands': 'INTERACTIVE_COMMANDS',
  'conflict-log': 'CONFLICT_LOG',
  conflictlog: 'CONFLICT_LOG',
  dfc: 'DFC',
  external: 'EXTERNAL',
  ftp: 'FTP',
  printer: 'PRINTER',
  lpr: 'PRINTER',
  news: 'NEWS',
  uucp: 'UUCP',
  clock: 'CLOCK',
  'auth-private': 'AUTH_PRIVATE',
  authpriv: 'AUTH_PRIVATE',
};

export const SEVERITY_ORDER: LogSeverity[] = [
  'EMERGENCY',
  'ALERT',
  'CRITICAL',
  'ERROR',
  'WARNING',
  'NOTICE',
  'INFORMATIONAL',
  'DEBUG',
];

export const SEVERITY_LABEL: Record<LogSeverity, string> = {
  EMERGENCY: 'emergency',
  ALERT: 'alert',
  CRITICAL: 'critical',
  ERROR: 'error',
  WARNING: 'warning',
  NOTICE: 'notice',
  INFORMATIONAL: 'info',
  DEBUG: 'debug',
};

export const SEVERITY_COLOR: Record<LogSeverity, string> = {
  EMERGENCY: 'magenta',
  ALERT: 'red',
  CRITICAL: 'volcano',
  ERROR: 'orange',
  WARNING: 'gold',
  NOTICE: 'blue',
  INFORMATIONAL: 'cyan',
  DEBUG: 'default',
};

export const FACILITY_LABEL: Record<LogFacility, string> = {
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

export function severityFromJunos(name: string | undefined | null): LogSeverity {
  if (!name) return 'INFORMATIONAL';
  const key = name.toLowerCase().trim();
  return SEVERITY_FROM_JUNOS[key] ?? 'INFORMATIONAL';
}

export function facilityFromJunos(name: string | undefined | null): LogFacility {
  if (!name) return 'UNKNOWN';
  const key = name.toLowerCase().trim();
  return FACILITY_FROM_JUNOS[key] ?? 'UNKNOWN';
}

export function severityFromPriorityCode(priority: number): LogSeverity {
  // syslog priority = facility * 8 + severity. We only need the severity here.
  const sev = priority & 0x07;
  return SEVERITY_ORDER[Math.min(sev, SEVERITY_ORDER.length - 1)];
}

export function facilityFromPriorityCode(priority: number): LogFacility {
  const fac = (priority >> 3) & 0xff;
  const facilityByCode: Record<number, LogFacility> = {
    0: 'KERNEL',
    1: 'USER',
    2: 'MAIL',
    3: 'DAEMON',
    4: 'AUTHORIZATION',
    5: 'SYSLOG',
    6: 'PRINTER',
    7: 'NEWS',
    8: 'UUCP',
    9: 'CLOCK',
    10: 'AUTH_PRIVATE',
    11: 'FTP',
    12: 'NTP',
    13: 'SECURITY',
    14: 'CONSOLE',
    16: 'LOCAL0',
    17: 'LOCAL1',
    18: 'LOCAL2',
    19: 'LOCAL3',
    20: 'LOCAL4',
    21: 'LOCAL5',
    22: 'LOCAL6',
    23: 'LOCAL7',
  };
  return facilityByCode[fac] ?? 'UNKNOWN';
}