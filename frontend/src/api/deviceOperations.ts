import { HttpError } from '../lib/errors';
import type { OperationResponse, Job } from '../types/job';
import type { Device } from '../types/device';
import { authJsonFetch } from './http';

const API_BASE = '/api';

// handleResponse in http.ts wraps everything; we only need to convert
// non-401 errors into HttpError for callers that already use it.
function rethrowAsHttpError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof Error) throw new HttpError(500, err.message);
  throw new HttpError(500, 'Request failed');
}

export async function fetchDeviceById(id: string): Promise<Device> {
  try {
    return await authJsonFetch<Device>(`${API_BASE}/devices/${id}`);
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function fetchDeviceConfig(id: string): Promise<OperationResponse> {
  try {
    return await authJsonFetch<OperationResponse>(`${API_BASE}/devices/${id}/config`);
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function triggerDeviceConfig(id: string): Promise<{ job: Job }> {
  try {
    return await authJsonFetch<{ job: Job }>(`${API_BASE}/devices/${id}/config`, { method: 'POST' });
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function fetchDeviceArp(id: string): Promise<OperationResponse> {
  try {
    return await authJsonFetch<OperationResponse>(`${API_BASE}/devices/${id}/arp`);
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function triggerDeviceArp(id: string): Promise<{ job: { id: string } }> {
  try {
    return await authJsonFetch<{ job: { id: string } }>(`${API_BASE}/devices/${id}/arp`, { method: 'POST' });
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function fetchDeviceMac(id: string): Promise<OperationResponse> {
  try {
    return await authJsonFetch<OperationResponse>(`${API_BASE}/devices/${id}/mac`);
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function triggerDeviceMac(id: string): Promise<{ job: { id: string } }> {
  try {
    return await authJsonFetch<{ job: { id: string } }>(`${API_BASE}/devices/${id}/mac`, { method: 'POST' });
  } catch (err) {
    rethrowAsHttpError(err);
  }
}

export async function triggerDeviceConnect(id: string): Promise<{ job: { id: string } }> {
  try {
    return await authJsonFetch<{ job: { id: string } }>(`${API_BASE}/devices/${id}/connect`, { method: 'POST' });
  } catch (err) {
    rethrowAsHttpError(err);
  }
}