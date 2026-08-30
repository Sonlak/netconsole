import type { Job } from '../types/job';
import type {
  InterfaceActionRequest,
  InterfaceDeviceOption,
  InterfaceInventoryResponse,
} from '../types/interfaces';
import { authJsonFetch, authFetch, handleResponse } from './http';

const API_BASE = '/api/interfaces';

export async function fetchInterfaceDevices(): Promise<InterfaceDeviceOption[]> {
  const response = await authFetch(`${API_BASE}/devices`);
  const payload = await handleResponse<{ devices: InterfaceDeviceOption[] }>(response);
  return payload.devices;
}

export async function fetchDeviceInterfaces(
  deviceId: string,
): Promise<InterfaceInventoryResponse> {
  const response = await authFetch(`${API_BASE}/${deviceId}`);
  return handleResponse<InterfaceInventoryResponse>(response);
}

export async function collectDeviceInterfaces(
  deviceId: string,
): Promise<{ job: Job; message?: string }> {
  const response = await authFetch(`${API_BASE}/${deviceId}/collect`, { method: 'POST' });
  return handleResponse(response);
}

export async function runInterfaceAction(
  deviceId: string,
  body: InterfaceActionRequest,
): Promise<{ job: Job; message?: string }> {
  return authJsonFetch(`${API_BASE}/${deviceId}/actions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
