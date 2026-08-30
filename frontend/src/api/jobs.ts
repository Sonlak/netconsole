import { authHeaders } from './auth';
import type { Job } from '../types/job';

const API_BASE = '/api/jobs';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
  return response.json() as Promise<T>;
}

export async function fetchJobs(params: { status?: string; forWorker?: string; limit?: number } = {}): Promise<Job[]> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.append('status', params.status);
  if (params.forWorker) searchParams.append('forWorker', params.forWorker);
  if (params.limit) searchParams.append('limit', params.limit.toString());

  const response = await fetch(`${API_BASE}?${searchParams.toString()}`, {
    headers: authHeaders(),
  });
  return handleResponse<Job[]>(response);
}

export async function claimJob(id: string): Promise<Job> {
  const response = await fetch(`${API_BASE}/${id}/claim`, {
    method: 'PATCH',
    headers: authHeaders(),
  });
  return handleResponse<Job>(response);
}

export async function completeJob(id: string, result?: unknown, error?: string): Promise<Job> {
  const response = await fetch(`${API_BASE}/${id}/complete`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ result, error }),
  });
  return handleResponse<Job>(response);
}

export class JobWaitTimeoutError extends Error {
  constructor(public jobId: string, message = 'Job wait timeout') {
    super(message);
    this.name = 'JobWaitTimeoutError';
  }
}

interface WaitForJobOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  initial?: Job | null;
}

/**
 * Poll a job until it reaches a terminal status (SUCCESS or FAILED).
 * Returns the final job, or throws JobWaitTimeoutError on timeout.
 */
export async function waitForJob(
  jobId: string,
  options: WaitForJobOptions = {},
): Promise<Job> {
  const { timeoutMs = 30_000, pollIntervalMs = 1_000, initial } = options;

  const start = Date.now();
  let current = initial ?? (await fetchJob(jobId));

  while (current.status === 'PENDING' || current.status === 'RUNNING') {
    if (Date.now() - start > timeoutMs) {
      throw new JobWaitTimeoutError(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    current = await fetchJob(jobId);
  }

  return current;
}

export async function waitForJobIfNeeded(
  job: Job | null | undefined,
  options: WaitForJobOptions = {},
): Promise<Job | null> {
  if (!job) return null;
  if (job.status !== 'PENDING' && job.status !== 'RUNNING') return job;
  return waitForJob(job.id, { ...options, initial: job });
}

async function fetchJob(jobId: string): Promise<Job> {
  const response = await fetch(`${API_BASE}/${jobId}`, {
    headers: authHeaders(),
  });
  return handleResponse<Job>(response);
}
