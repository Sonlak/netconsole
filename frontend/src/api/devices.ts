import type { Device, DeviceInput } from '../types/device';
import { authJsonFetch } from './http';

const API_BASE = '/api/devices';

export async function fetchDevices(): Promise<Device[]> {
  return authJsonFetch<Device[]>(API_BASE);
}

export async function createDevice(input: DeviceInput): Promise<Device> {
  return authJsonFetch<Device>(API_BASE, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateDevice(id: string, input: DeviceInput): Promise<Device> {
  return authJsonFetch<Device>(`${API_BASE}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteDevice(id: string): Promise<void> {
  await authJsonFetch<void>(`${API_BASE}/${id}`, { method: 'DELETE' });
}

export async function pingDevice(id: string): Promise<Device> {
  const payload = await authJsonFetch<{ device: Device }>(`${API_BASE}/${id}/ping`, {
    method: 'POST',
  });
  return payload.device;
}

export async function pingAllDevices(): Promise<{
  checked: number;
  skipped: number;
  online: number;
  offline: number;
}> {
  return authJsonFetch(`${API_BASE}/check-ping`, { method: 'POST' });
}

export async function checkManagedDevice(id: string): Promise<{
  device: Device;
  stage: string;
  checks?: Record<string, boolean>;
  job?: { id: string } | null;
}> {
  return authJsonFetch(`${API_BASE}/${id}/check-managed`, { method: 'POST' });
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
  return authJsonFetch(`${API_BASE}/check-managed`, { method: 'POST' });
}