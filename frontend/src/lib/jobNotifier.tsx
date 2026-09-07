/**
 * Job completion notifier for the Config Studio commit/rollback flows.
 *
 * Why this lives in a module instead of inline:
 *  - We want a single place that decides toast wording + duration so the
 *    UI stays consistent (and easy to tweak when the user asks "more
 *    verbosely" / "less noisy").
 *  - When the in-page wait window hits (Juniper cRPD can legitimately
 *    take 60-90s on a cold-start commit, plus a slow restart), the
 *    user should still see the SUCCESS or FAILED toast once the job
 *    actually terminates -- not just the "Commit still running"
 *    warning we used to show.
 *
 * History (read this before "simplifying"):
 *  - Original implementation used the AntD static API
 *    (`import { notification } from 'antd'`). On React 19 + StrictMode +
 *    `unstableSetRender` (see main.tsx) this silently no-op'd -- the
 *    user got no toast at all on SUCCESS / FAILED. Worked in dev with
 *    the static API only because dev runs without StrictMode.
 *  - Fix: route everything through `App.useApp()` context-aware
 *    notification. To make the background poll (which runs outside the
 *    React tree, after component unmount) keep working, we cache the
 *    hook return values in a module-level object via `bindJobNotifier`,
 *    called once from a top-level component that lives inside `<App>`.
 *
 * Behaviour:
 *  - useJobNotifier()  -> React hook, returns context-aware notify fns.
 *    Use this for inline commit/rollback handlers.
 *  - bindJobNotifier(api)  -> set the module-level api so background
 *    poll + non-component callers can fire toasts reliably.
 *  - notifyFinal(kind, ..., job)  -> fires via api if bound, else
 *    falls back to static `notification` (best-effort).
 *  - notifyWaitTimeout(kind, ...) -> message.warning
 *  - startBackgroundPoll(jobId, opts) -> polls until terminal, then
 *    fires notifyFinal. ALSO invokes `onTerminal` callback when the
 *    job terminates, so the caller can ack-commit / refresh state
 *    without waiting in the foreground.
 */

import { App, message as staticMessage, notification as staticNotification } from 'antd';
import { Link } from 'react-router-dom';
import { useEffect, useMemo } from 'react';
import type { NotificationInstance } from 'antd/es/notification/interface';
import type { MessageInstance } from 'antd/es/message/interface';

import { JobWaitTimeoutError } from '../api/jobs';
import { authJsonFetch } from '../api/http';
import type { Job } from '../types/job';

const TERMINAL_POLL_MS = 3_000;

function deviceLabel(deviceName: string | undefined, ip: string | undefined): string {
  if (deviceName && ip) return `${deviceName} (${ip})`;
  return deviceName || ip || 'device';
}

/**
 * Module-level notifier API. Populated by `bindJobNotifier(api)` from a
 * component mounted inside `<App>` (see `JobNotifierHost` in App.tsx).
 * When unset (e.g. background poll fires before React hydrates), calls
 * fall back to the static API -- which works for in-page, single-tab
 * cases thanks to `unstableSetRender` in main.tsx, but is unreliable on
 * React 19 + StrictMode. Hence the hook path being preferred.
 */
interface NotifierApi {
  notification: Pick<NotificationInstance, 'success' | 'error' | 'warning' | 'info'>;
  message: Pick<MessageInstance, 'success' | 'error' | 'warning' | 'info' | 'loading'>;
}

let apiRef: NotifierApi | null = null;

export function bindJobNotifier(api: NotifierApi): void {
  apiRef = api;
}

function getApi(): NotifierApi {
  if (apiRef) return apiRef;
  return {
    notification: staticNotification,
    message: staticMessage,
  };
}

/**
 * React hook for components that live inside `<App>`. Returns stable
 * notify functions bound to the App context's notification/message
 * instances. Also calls `bindJobNotifier` so background polls
 * initiated from this component use the same context.
 */
export function useJobNotifier() {
  const { notification, message } = App.useApp();
  const stable = useMemo<NotifierApi>(
    () => ({ notification, message }),
    [notification, message],
  );
  useEffect(() => {
    bindJobNotifier(stable);
  }, [stable]);
  return useMemo(
    () => ({
      notifyFinal: (
        kind: 'commit' | 'rollback',
        deviceName: string | undefined,
        ip: string | undefined,
        job: Job,
      ) => reportFinal(kind, deviceName, ip, job, stable),
      notifyWaitTimeout: (kind: 'commit' | 'rollback', deviceName?: string, ip?: string) =>
        reportWaitTimeout(kind, deviceName, ip, stable),
    }),
    [stable],
  );
}

/**
 * Fire the terminal toast for a job. Safe to call from anywhere --
 * uses the bound context-aware api when available, falls back to the
 * static API otherwise (still works for in-page toasts after
 * `unstableSetRender` is wired).
 */
export function reportFinal(
  kind: 'commit' | 'rollback',
  deviceName: string | undefined,
  ip: string | undefined,
  job: Job,
  api: NotifierApi = getApi(),
): void {
  const device = deviceLabel(deviceName, ip);
  const verb = kind === 'commit' ? 'Commit' : 'Rollback';
  const jobsPath = `/jobs?q=${job.id}`;

  if (job.status === 'SUCCESS') {
    const durMs = computeDurationMs(job);
    const durLabel = durMs != null ? ` · ${formatDur(durMs)}` : '';
    api.notification.success({
      message: `${verb} thành công`,
      description: (
        <span>
          <code>{device}</code> đã {kind === 'commit' ? 'nhận config' : 'rollback'} thành công{durLabel}.{' '}
          <Link to={jobsPath}>mở Jobs</Link>
        </span>
      ),
      duration: 12,
      placement: 'topRight',
    });
    return;
  }

  if (job.status === 'FAILED') {
    const detail = job.error || 'unknown error';
    api.notification.error({
      message: `${verb} thất bại`,
      description: (
        <span>
          <code>{device}</code>: {detail}{' '}
          <Link to={jobsPath}>xem chi tiết</Link>
        </span>
      ),
      duration: 30,
      placement: 'topRight',
    });
    return;
  }

  // Still not terminal (caller error). Treat as warning so we never silently drop.
  api.notification.warning({
    message: `${verb} chưa kết thúc`,
    description: (
      <span>
        <code>{device}</code> job đang ở trạng thái <code>{job.status}</code>.{' '}
        <Link to={jobsPath}>mở Jobs</Link>
      </span>
    ),
    duration: 12,
    placement: 'topRight',
  });
}

export function reportWaitTimeout(
  kind: 'commit' | 'rollback',
  deviceName?: string,
  ip?: string,
  api: NotifierApi = getApi(),
): void {
  const device = deviceLabel(deviceName, ip);
  api.message.warning({
    content: (
      <span>
        {kind === 'commit' ? 'Commit' : 'Rollback'} <code>{device}</code> đang chạy nền
        — sẽ báo lại khi xong.
      </span>
    ),
    duration: 4,
  });
}

/**
 * Alias of `reportWaitTimeout` for call sites that prefer the verb-led
 * naming used by `useJobNotifier().notifyWaitTimeout`.
 */
export const notifyWaitTimeout = reportWaitTimeout;

/**
 * Continue polling `jobId` in the background until it terminates, then
 * fire `notifyFinal` AND invoke the `onTerminal` callback so the caller
 * can ack-commit / refresh state without waiting in the foreground.
 * Returns the AbortController so the caller can stop polling (e.g. on
 * unmount). The controller aborts on terminal state automatically.
 */
export function startBackgroundPoll(
  jobId: string,
  options: {
    kind: 'commit' | 'rollback';
    deviceName?: string;
    ip?: string;
    onTerminal?: (job: Job) => void;
  },
): AbortController {
  const controller = new AbortController();
  const poll = async () => {
    while (!controller.signal.aborted) {
      try {
        const job = await authJsonFetch<Job>(`/api/jobs/${jobId}`);
        if (job.status === 'SUCCESS' || job.status === 'FAILED') {
          reportFinal(options.kind, options.deviceName, options.ip, job);
          if (options.onTerminal) {
            try {
              options.onTerminal(job);
            } catch {
              /* swallow -- caller-side error handling is its own job */
            }
          }
          controller.abort();
          return;
        }
      } catch {
        // Network blip -- keep polling, do not abort.
      }
      await sleep(TERMINAL_POLL_MS);
    }
  };
  // Detach from current stack so the caller can return immediately.
  void poll();
  return controller;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDurationMs(job: Job): number | null {
  const created = parseTs(job.createdAt);
  // Prefer updatedAt for end-of-life; fall back to createdAt+0 if missing.
  const end = parseTs(job.updatedAt);
  if (created == null || end == null) return null;
  return Math.max(0, end - created);
}

function parseTs(value: string | Date | undefined | null): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function formatDur(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return rem === 0 ? `${m} phút` : `${m} phút ${rem} s`;
}

// Re-export so existing call sites that import JobWaitTimeoutError
// from this module keep working after the refactor.
export { JobWaitTimeoutError };
