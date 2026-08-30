export type ConfigRole = 'core' | 'dist' | 'access' | 'custom';

export type ConfigTemplateMeta = {
  id: Exclude<ConfigRole, 'custom'>;
  label: string;
  description: string;
};

export type DeviceSavedConfig = {
  id: string;
  deviceId: string;
  role: string;
  content: string;
  committedContent: string | null;
  rollbackContent: string | null;
  committedAt: string | null;
  updatedAt: string;
};

export type GenerateConfigState = {
  device: {
    id: string;
    name: string;
    ip: string;
    site: string;
    floor: string;
    status: string;
    model: string;
  };
  suggestedRole: Exclude<ConfigRole, 'custom'>;
  saved: DeviceSavedConfig | null;
  running: {
    source: string;
    jobId: string | null;
    collectedAt: string | null;
    config: string;
  };
};

import { authJsonFetch, authFetch, handleResponse } from './http';

const API_BASE = '/api/config';

export async function fetchConfigTemplates(): Promise<ConfigTemplateMeta[]> {
  const response = await authFetch(`${API_BASE}/templates`);
  return handleResponse(response);
}

export async function renderConfigTemplate(
  role: Exclude<ConfigRole, 'custom'>,
  deviceId: string,
): Promise<{ content: string; role: string; deviceName: string }> {
  const response = await authFetch(`${API_BASE}/templates/${role}?deviceId=${encodeURIComponent(deviceId)}`);
  return handleResponse(response);
}

export async function fetchGenerateConfig(deviceId: string): Promise<GenerateConfigState> {
  const response = await authFetch(`${API_BASE}/devices/${deviceId}`);
  return handleResponse(response);
}

export async function saveGenerateConfig(
  deviceId: string,
  input: { content: string; role: string },
): Promise<DeviceSavedConfig> {
  return authJsonFetch(`${API_BASE}/devices/${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function commitGenerateConfig(
  deviceId: string,
  input: { content: string; role: string },
): Promise<{ job: { id: string } }> {
  return authJsonFetch(`${API_BASE}/devices/${deviceId}/commit`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function rollbackGenerateConfig(deviceId: string): Promise<{ job: { id: string } }> {
  const response = await authFetch(`${API_BASE}/devices/${deviceId}/rollback`, {
    method: 'POST',
  });
  return handleResponse(response);
}

export async function ackCommitJob(jobId: string): Promise<DeviceSavedConfig> {
  const response = await authFetch(`${API_BASE}/jobs/${jobId}/ack-commit`, { method: 'POST' });
  return handleResponse(response);
}

export async function ackRollbackJob(jobId: string): Promise<DeviceSavedConfig> {
  const response = await authFetch(`${API_BASE}/jobs/${jobId}/ack-rollback`, { method: 'POST' });
  return handleResponse(response);
}
