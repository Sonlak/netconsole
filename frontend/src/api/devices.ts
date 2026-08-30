import type { Device, DeviceInput } from '../types/device';
import { authHeaders } from './auth';

const API_BASE = '/api/devices';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      // Token expired or invalid - redirect to login
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function fetchDevices(): Promise<Device[]> {
  const response = await fetch(API_BASE, { headers: authHeaders() });
  return handleResponse<Device[]>(response);
}

export async function createDevice(input: DeviceInput): Promise<Device> {
  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<Device>(response);
}

export async function updateDevice(id: string, input: DeviceInput): Promise<Device> {
  const response = await fetch(`${API_BASE}/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse<Device>(response);
}

export async function deleteDevice(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return handleResponse<void>(response);
}

export async function pingDevice(id: string): Promise<Device> {
  const response = await fetch(`${API_BASE}/${id}/ping`, {
    method: 'POST',
    headers: authHeaders(),
  });
  const payload = await handleResponse<{ device: Device }>(response);
  return payload.device;
}

export async function pingAllDevices(): Promise<{
  checked: number;
  skipped: number;
  online: number;
  offline: number;
}> {
  return handleResponse(await fetch(`${API_BASE}/check-ping`, {
    method: 'POST',
    headers: authHeaders(),
  }));
}

export async function checkManagedDevice(id: string): Promise<{
  device: Device;
  stage: string;
  checks?: Record<string, boolean>;
  job?: { id: string } | null;
}> {
  return handleResponse(await fetch(`${API_BASE}/${id}/check-managed`, {
    method: 'POST',
    headers: authHeaders(),
  }));
}

export async function checkManagedAllDevices(): Promise<{
  checked: number;
  skipped: number;
  queued: number;
  offline: number;
  results: Array<{
    deviceId: string;
    name: string;
    ip: string;
    skipped: boolean;
    reason?: string;
    stage?: string;
    jobId?: string;
  }>;
}> {
  return handleResponse(await fetch(`${API_BASE}/check-managed`, {
    method: 'POST',
    headers: authHeaders(),
  }));
}
