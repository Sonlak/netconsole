import { HttpError } from '../lib/errors';
import type { OperationResponse, Job } from '../types/job';
import type { Device } from '../types/device';
import { authFetch } from './http';

const API_BASE = '/api';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = '/login';
      throw new HttpError(401, 'Unauthorized');
    }
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new HttpError(response.status, payload.error ?? 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function fetchDeviceById(id: string): Promise<Device> {
  const response = await authFetch(`${API_BASE}/devices/${id}`);
  return handleResponse<Device>(response);
}

export async function fetchDeviceConfig(id: string): Promise<OperationResponse> {
  const response = await authFetch(`${API_BASE}/devices/${id}/config`);
  return handleResponse<OperationResponse>(response);
}

export async function triggerDeviceConfig(id: string): Promise<{ job: Job }> {
  const response = await authFetch(`${API_BASE}/devices/${id}/config`, { method: 'POST' });
  return handleResponse(response);
}

export async function fetchDeviceArp(id: string): Promise<OperationResponse> {
  const response = await authFetch(`${API_BASE}/devices/${id}/arp`);
  return handleResponse<OperationResponse>(response);
}

export async function triggerDeviceArp(id: string): Promise<{ job: { id: string } }> {
  const response = await authFetch(`${API_BASE}/devices/${id}/arp`, { method: 'POST' });
  return handleResponse(response);
}

export async function fetchDeviceMac(id: string): Promise<OperationResponse> {
  const response = await authFetch(`${API_BASE}/devices/${id}/mac`);
  return handleResponse<OperationResponse>(response);
}

export async function triggerDeviceMac(id: string): Promise<{ job: { id: string } }> {
  const response = await authFetch(`${API_BASE}/devices/${id}/mac`, { method: 'POST' });
  return handleResponse(response);
}

export async function triggerDeviceConnect(id: string): Promise<{ job: { id: string } }> {
  const response = await authFetch(`${API_BASE}/devices/${id}/connect`, { method: 'POST' });
  return handleResponse(response);
}
