/**
 * Background job follow-up for the AI Assistant.
 *
 * When the assistant queues a WRITE action (interface shut/no-shut,
 * description change, managed check, log collect), the backend
 * returns a `tool_result` whose preview includes a `jobId` and
 * `jobStatus: PENDING`. The actual work runs asynchronously in the
 * worker (1-30s depending on vendor + cold-start cost).
 *
 * Without follow-up, the user sees only "Job queued with id X" and
 * has to navigate to /jobs to learn the outcome. This module
 * changes that: the assistant drawer keeps polling the job in the
 * background and patches the inline tool card with the final
 * status when the job reaches a terminal state (SUCCESS/FAILED/
 * CANCELLED) or the 90s soft timeout fires.
 *
 * Implementation: a small registry, indexed by jobId, that owns the
 * AbortController for each follow-up loop. Multiple subscribers can
 * attach to the same job (e.g. the assistant bubble + a header
 * badge) and the loop is torn down only when the last subscriber
 * detaches.
 *
 * Why a registry, not per-component state:
 *  - The user can open/close the drawer while a job runs; we don't
 *    want to lose the follow-up just because the component
 *    unmounted.
 *  - Multiple UI surfaces (drawer chip + a future global toast)
 *    should share the same poll to avoid hammering /api/jobs/:id.
 */

import { fetchJob } from '@/api/jobs';
import type { Job, JobStatus } from '@/types/job';

export type FollowUpStatus = JobStatus | 'TIMEOUT';

export interface FollowUpUpdate {
  status: FollowUpStatus;
  /** Wall-clock ms since follow-up started. Undefined on the first tick. */
  elapsedMs?: number;
  /** Final job row from the server (only set on terminal states). */
  job?: Job;
  /** Human-friendly error when status is FAILED or TIMEOUT. */
  error?: string;
}

export type FollowUpListener = (update: FollowUpUpdate) => void;

interface RegistryEntry {
  controller: AbortController;
  startedAt: number;
  listeners: Set<FollowUpListener>;
  // Latest status we've seen — late subscribers get this immediately
  // so the UI doesn't briefly show "PENDING" again.
  lastStatus: FollowUpStatus;
  lastJob?: Job;
  finished: boolean;
}

const POLL_INTERVAL_MS = 2_000;
const SOFT_TIMEOUT_MS = 90_000;
const TERMINAL: ReadonlySet<JobStatus> = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);

const registry = new Map<string, RegistryEntry>();

function notify(entry: RegistryEntry, update: FollowUpUpdate) {
  entry.lastStatus = update.status;
  if (update.job) entry.lastJob = update.job;
  for (const l of entry.listeners) {
    try {
      l(update);
    } catch {
      // Swallow — a misbehaving listener must not break the poll loop.
    }
  }
}

function startPoll(jobId: string, entry: RegistryEntry) {
  const tick = async () => {
    while (!entry.controller.signal.aborted && !entry.finished) {
      const elapsed = Date.now() - entry.startedAt;
      if (elapsed >= SOFT_TIMEOUT_MS) {
        entry.finished = true;
        notify(entry, {
          status: 'TIMEOUT',
          elapsedMs: elapsed,
          error: `Job ${jobId} chưa hoàn thành sau ${Math.round(elapsed / 1000)}s. Xem /jobs để biết thêm.`,
        });
        registry.delete(jobId);
        return;
      }

      try {
        const job = await fetchJob(jobId);
        if (entry.controller.signal.aborted) return;
        if (TERMINAL.has(job.status)) {
          entry.finished = true;
          notify(entry, {
            status: job.status,
            elapsedMs: elapsed,
            job,
            error: job.status === 'FAILED' ? job.error ?? undefined : undefined,
          });
          registry.delete(jobId);
          return;
        }
        // Intermediate update so the UI can show "RUNNING" with elapsed time.
        notify(entry, { status: job.status, elapsedMs: elapsed, job });
      } catch (err) {
        // Network blip — keep polling. Surface the error only on terminal.
        // eslint-disable-next-line no-console
        console.warn(`[jobFollowUp] poll failed for ${jobId}:`, err);
      }

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, POLL_INTERVAL_MS);
        entry.controller.signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };
  void tick();
}

/**
 * Begin following a job. If a follow-up for this jobId is already
 * running, the new listener is attached to the existing loop and
 * receives the latest status synchronously (no flicker).
 *
 * Returns a teardown function. Call it when the subscriber unmounts
 * to detach the listener. The poll loop keeps running until ALL
 * subscribers detach or the job reaches a terminal state.
 */
export function startJobFollowUp(
  jobId: string,
  listener: FollowUpListener,
): () => void {
  const existing = registry.get(jobId);
  if (existing) {
    existing.listeners.add(listener);
    // Replay the latest status so the new subscriber renders correctly.
    listener({
      status: existing.lastStatus,
      job: existing.lastJob,
    });
    if (existing.finished) {
      // Already terminal — call the teardown immediately; the new
      // listener already got the final state.
      existing.listeners.delete(listener);
      return () => {};
    }
    return () => {
      existing.listeners.delete(listener);
      // Don't kill the loop while other subscribers still care.
    };
  }

  const controller = new AbortController();
  const entry: RegistryEntry = {
    controller,
    startedAt: Date.now(),
    listeners: new Set([listener]),
    lastStatus: 'PENDING',
    finished: false,
  };
  registry.set(jobId, entry);
  startPoll(jobId, entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.controller.abort();
      if (!entry.finished) registry.delete(jobId);
    }
  };
}
