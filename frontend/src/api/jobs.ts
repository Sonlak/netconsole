import { authJsonFetch } from './http';
import type { Job } from '../types/job';

const API_BASE = '/api/jobs';

export interface FetchJobsParams {
  status?: string;
  type?: string | string[];
  deviceId?: string;
  forWorker?: string;
  limit?: number;
  offset?: number;
}

export interface JobsPage {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Fetch jobs. Supports the new paginated response shape
 * `{jobs, total, limit, offset}` AND falls back to the legacy bare-array
 * shape if the backend hasn't been redeployed yet (during rolling deploys).
 */
export async function fetchJobs(
  params: FetchJobsParams = {},
): Promise<Job[]> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.append('status', params.status);
  if (params.deviceId) searchParams.append('deviceId', params.deviceId);
  if (params.forWorker) searchParams.append('forWorker', params.forWorker);
  if (params.limit) searchParams.append('limit', params.limit.toString());
  if (params.offset) searchParams.append('offset', params.offset.toString());
  if (params.type) {
    const types = Array.isArray(params.type) ? params.type : [params.type];
    for (const t of types) {
      if (t) searchParams.append('type', t);
    }
  }

  const response = await authJsonFetch<Job[] | JobsPage>(`${API_BASE}?${searchParams.toString()}`);
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.jobs)) return response.jobs;
  return [];
}

export async function claimJob(id: string): Promise<Job> {
  return authJsonFetch<Job>(`${API_BASE}/${id}/claim`, { method: 'PATCH' });
}

export async function completeJob(id: string, result?: unknown, error?: string): Promise<Job> {
  return authJsonFetch<Job>(`${API_BASE}/${id}/complete`, {
    method: 'PATCH',
    body: JSON.stringify({ result, error }),
  });
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

/**
 * Poll a job with a generous timeout (default 240s -- enough for a
 * Junos cRPD cold-start commit that legitimately takes 60-90s, plus
 * headroom for a worker reboot) AND, if the timeout expires while the
 * job is still running, hand off to a background poller that will fire
 * the terminal toast via `jobNotifier.notifyFinal` AND invoke
 * `onTerminal(job)` when the job finally completes -- so the caller
 * can still ack-commit / refresh state once we know the result.
 *
 * This is the call site the Config Studio uses for commit / rollback so
 * the user is always told the final outcome -- success, failed, or
 * "still running, will notify you later" -- even if the in-page wait
 * window expires first.
 */
export async function waitForJobWithNotification(
  jobId: string,
  options: WaitForJobOptions & {
    kind: 'commit' | 'rollback';
    deviceName?: string;
    deviceIp?: string;
    onTerminal?: (job: Job) => void;
  },
): Promise<Job | null> {
  const { timeoutMs = 240_000, pollIntervalMs = 1_000, initial, kind, deviceName, deviceIp, onTerminal } = options;

  const start = Date.now();
  let current = initial ?? (await fetchJob(jobId));

  while (current.status === 'PENDING' || current.status === 'RUNNING') {
    if (Date.now() - start > timeoutMs) {
      // Don't block the user on the device in the foreground any longer
      // -- hand off to background poll and notify when done.
      // Lazy import keeps the dependency tree shallow for callers that
      // don't need notifications.
      const { startBackgroundPoll, notifyWaitTimeout } = await import('../lib/jobNotifier');
      notifyWaitTimeout(kind, deviceName, deviceIp);
      startBackgroundPoll(jobId, { kind, deviceName, ip: deviceIp, onTerminal });
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    current = await fetchJob(jobId);
  }

  if (onTerminal) {
    try {
      onTerminal(current);
    } catch {
      /* swallow -- notifications are best-effort */
    }
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
  return authJsonFetch<Job>(`${API_BASE}/${jobId}`);
}

/**
 * Fetch many jobs in parallel. Used by the bulk-deploy progress tracker to
 * poll all queued jobs in a single round of microtasks. With ≤64 jobs and
 * ~50ms per request, a Promise.all round-trip finishes well under 200ms.
 */
export async function fetchJobsByIds(jobIds: string[]): Promise<Job[]> {
  if (jobIds.length === 0) return [];
  return Promise.all(jobIds.map(fetchJob));
}