import type { LogsCollectResponse, LogsInventory, LogSeverity } from '../types/log';
import { authFetch, handleResponse } from './http';

const API_BASE = '/api/logs';

export type JunosLogFile = {
  filename: string;
  label: string;
  facilityHint: string;
  description: string;
};

export const JUNOS_LOG_FILES: JunosLogFile[] = [
  {
    filename: 'messages',
    label: 'System messages',
    facilityHint: 'daemon',
    description: 'Default syslog stream from mgd / rpd / mib2d / etc.',
  },
  {
    filename: 'configuration',
    label: 'Configuration changes',
    facilityHint: 'change-log',
    description: 'Every `set` / `delete` / `commit` event recorded by mgd.',
  },
  {
    filename: 'interactive-commands',
    label: 'Interactive commands',
    facilityHint: 'interactive-commands',
    description: 'Human-issued CLI commands (often a security audit source).',
  },
  {
    filename: 'firewall',
    label: 'Firewall',
    facilityHint: 'firewall',
    description: 'Security / screen counter hits on the forwarding plane.',
  },
];

export const DEFAULT_LOG_FILENAME = 'messages';

export const FILENAME_OPTIONS = JUNOS_LOG_FILES.map((file) => ({
  value: file.filename,
  label: file.label,
  description: file.description,
}));

export type LogsInventoryQuery = {
  deviceId?: string;
  severity?: LogSeverity[];
  facility?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  filename?: string;
};

function buildQuery(params: LogsInventoryQuery = {}): string {
  const search = new URLSearchParams();
  if (params.deviceId) search.append('deviceId', params.deviceId);
  if (params.severity && params.severity.length > 0) {
    search.append('severity', params.severity.join(','));
  }
  if (params.q) search.append('q', params.q);
  if (params.since) search.append('since', params.since);
  if (params.until) search.append('until', params.until);
  if (params.limit) search.append('limit', String(params.limit));
  if (params.filename) search.append('filename', params.filename);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function fetchLogsInventory(params: LogsInventoryQuery = {}): Promise<LogsInventory> {
  const response = await authFetch(`${API_BASE}${buildQuery(params)}`);
  return handleResponse<LogsInventory>(response);
}

export type CollectLogsOptions = {
  filename?: string;
  deviceIds?: string[];
  force?: boolean;
};

export async function collectLogs(options: CollectLogsOptions = {}): Promise<LogsCollectResponse> {
  const response = await authFetch(`${API_BASE}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return handleResponse<LogsCollectResponse>(response);
}

export async function deleteLogsForDevice(deviceId: string): Promise<{ count: number }> {
  const response = await authFetch(`${API_BASE}/device/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ count: number }>(response);
}

// ── Alert rules ────────────────────────────────────────────────────────────────

export type AlertRuleRow = {
  id: string;
  name: string;
  description: string | null;
  deviceId: string | null;
  minSeverity: LogSeverity;
  messagePattern: string | null;
  facility: string | null;
  enabled: boolean;
  createdAt: string;
  alertCount: number;
  unacknowledgedCount: number;
};

export type CreateAlertRuleInput = {
  name: string;
  description?: string;
  deviceId?: string;
  minSeverity: LogSeverity;
  messagePattern?: string;
  facility?: string;
};

export type LogAlertRow = {
  id: string;
  ruleId: string;
  ruleName: string;
  deviceId: string | null;
  deviceIp: string | null;
  severity: LogSeverity;
  hostname: string;
  program: string | null;
  message: string;
  timestamp: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
};

export async function fetchAlertRules(includeDisabled = false): Promise<{ rules: AlertRuleRow[] }> {
  const url = `/api/logs/rules${includeDisabled ? '?includeDisabled=true' : ''}`;
  const response = await authFetch(url);
  return handleResponse<{ rules: AlertRuleRow[] }>(response);
}

export async function createAlertRule(input: CreateAlertRuleInput): Promise<{ rule: AlertRuleRow }> {
  const response = await authFetch('/api/logs/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<{ rule: AlertRuleRow }>(response);
}

export async function updateAlertRule(
  id: string,
  input: Partial<CreateAlertRuleInput & { enabled: boolean }>,
): Promise<{ rule: AlertRuleRow }> {
  const response = await authFetch(`/api/logs/rules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<{ rule: AlertRuleRow }>(response);
}

export async function deleteAlertRule(id: string): Promise<{ deleted: boolean }> {
  const response = await authFetch(`/api/logs/rules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ deleted: boolean }>(response);
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export type AlertsQuery = {
  ruleId?: string;
  deviceId?: string;
  acknowledged?: boolean;
  since?: string;
  limit?: number;
};

export async function fetchAlerts(params?: AlertsQuery): Promise<{ alerts: LogAlertRow[] }> {
  const search = new URLSearchParams();
  if (params?.ruleId) search.append('ruleId', params.ruleId);
  if (params?.deviceId) search.append('deviceId', params.deviceId);
  if (params?.acknowledged !== undefined) search.append('acknowledged', String(params.acknowledged));
  if (params?.since) search.append('since', params.since);
  if (params?.limit) search.append('limit', String(params.limit));
  const qs = search.toString();
  const response = await authFetch(`/api/logs/alerts${qs ? `?${qs}` : ''}`);
  return handleResponse<{ alerts: LogAlertRow[] }>(response);
}

export async function acknowledgeAlerts(ids: string[]): Promise<{ acknowledged: number }> {
  const response = await authFetch('/api/logs/alerts/acknowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  return handleResponse<{ acknowledged: number }>(response);
}

export async function acknowledgeAlert(id: string): Promise<{ acknowledged: boolean }> {
  const response = await authFetch(`/api/logs/alerts/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
  });
  return handleResponse<{ acknowledged: boolean }>(response);
}

export async function deleteAlert(id: string): Promise<{ deleted: boolean }> {
  const response = await authFetch(`/api/logs/alerts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ deleted: boolean }>(response);
}

