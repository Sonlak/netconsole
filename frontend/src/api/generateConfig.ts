export type ConfigRole = 'core' | 'dist' | 'access' | 'custom';

export type ConfigTemplateMeta = {
  id: Exclude<ConfigRole, 'custom'>;
  label: string;
  description: string;
};

// New: User-defined templates stored in database
export type UserTemplate = {
  id: string;
  name: string;
  description: string | null;
  content: string;
  vendor: 'JUNIPER' | 'CISCO' | 'ARISTA' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
};

export type RenderPreview = {
  vendor: 'JUNIPER' | 'CISCO' | 'ARISTA' | 'UNKNOWN';
  rendered: string;
  rawLength: number;
  renderedLength: number;
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

export type BulkCommitResult = {
  jobs: { id: string; deviceId: string; deviceName: string; deviceIp: string }[];
  skipped: { deviceId: string; reason: string }[];
};

/**
 * Bulk-deploy a config to many devices. Two modes:
 *
 * 1. **Template mode** — pass `role` (core/dist/access). Backend renders
 *    the template per device so each one gets its own hostname/IP.
 * 2. **Literal-draft mode** — pass `content` (verbatim config string).
 *    Backend applies the same content to every selected device.
 *
 * Returns the list of created jobs and any devices that were skipped
 * (e.g. not MANAGED). Backend caps at 64 devices per request.
 */
export async function bulkCommitGenerateConfig(
  deviceIds: string[],
  options: { role?: Exclude<ConfigRole, 'custom'>; content?: string },
): Promise<BulkCommitResult> {
  return authJsonFetch(`${API_BASE}/bulk-commit`, {
    method: 'POST',
    body: JSON.stringify({
      deviceIds,
      ...(options.role ? { role: options.role } : {}),
      ...(options.content ? { content: options.content } : {}),
    }),
  });
}

/**
 * Render the template for a single device without saving or queueing.
 * Used by the bulk-deploy UI to show the user what *this* device will
 * receive (each device has its own hostname/IP so the output differs).
 */
export async function previewBulkConfig(
  role: Exclude<ConfigRole, 'custom'>,
  deviceId: string,
): Promise<{ content: string; role: string; deviceName: string }> {
  return renderConfigTemplate(role, deviceId);
}

// ============================================================================
// User-defined templates (stored in database)
// ============================================================================

const TEMPLATES_API = '/api/templates';

/**
 * Fetch all user-defined templates
 */
export async function fetchUserTemplates(): Promise<UserTemplate[]> {
  const response = await authFetch(TEMPLATES_API);
  return handleResponse(response);
}

/**
 * Fetch a single template by ID
 */
export async function fetchUserTemplate(id: string): Promise<UserTemplate> {
  const response = await authFetch(`${TEMPLATES_API}/${id}`);
  return handleResponse(response);
}

/**
 * Create a new template
 */
export async function createUserTemplate(input: {
  name: string;
  description?: string;
  content?: string;
  fileContent?: string;
  originalFilename?: string;
}): Promise<UserTemplate> {
  return authJsonFetch(TEMPLATES_API, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Update an existing template
 */
export async function updateUserTemplate(
  id: string,
  input: { name?: string; description?: string; content?: string },
): Promise<UserTemplate> {
  return authJsonFetch(`${TEMPLATES_API}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * Delete a template
 */
export async function deleteUserTemplate(id: string): Promise<void> {
  const response = await authFetch(`${TEMPLATES_API}/${id}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to delete template: ${response.status}`);
  }
}

/**
 * Preview render of raw config content without saving
 */
export async function previewRenderConfig(content: string): Promise<RenderPreview> {
  return authJsonFetch(`${TEMPLATES_API}/render`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}
