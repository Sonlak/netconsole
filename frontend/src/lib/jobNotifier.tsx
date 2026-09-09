/**
 * Job completion notifier for the Config Studio commit/rollback flows.
 *
 * Why this lives in a module instead of inline:
 *  - We want a single place that decides toast wording + duration so the
 *    UI stays consistent (and easy to tweak when the user asks "more
 *    verbosely" / "less noisy").
 *  - When the 90-second wait timeout hits (Juniper cRPD can legitimately
 *    take 60-90s on a cold-start commit, plus a slow restart), the user
 *    should still see the SUCCESS or FAILED toast once the job actually
 *    terminates -- not just the "Commit still running" warning we used
 *    to show.
 *
 * Behaviour:
 *  - reportFinal(...)   -> success / failed toast with details + a link
 *    to the Jobs page filtered to this job id. 6s for success, 8s for
 *    failed (user needs longer to read the device-side error).
 *  - reportBackgroundStarted(...) -> 4s info toast saying "still
 *    running, will notify you when done".
 *  - The poll loop is bound to a single AbortController so navigating
 *    away (component unmount) cancels it cleanly.
 */

import { notification as staticNotification, message as staticMessage } from 'antd';
import type { NotificationInstance } from 'antd/es/notification/interface';
import type { MessageInstance } from 'antd/es/message/interface';
import { Link } from 'react-router-dom';

import { JobWaitTimeoutError } from '../api/jobs';
import { authJsonFetch } from '../api/http';
import type { Job } from '../types/job';

const TERMINAL_POLL_MS = 3_000;

// The AntD `App.useApp()` hook returns bound `notification` and `message`
// instances that respect the active ConfigProvider (theme tokens, locale,
// z-index). The legacy static `notification.success({...})` calls do
// NOT see ConfigProvider context, which is why the existing "Commit
// thanh cong" toast was never appearing for users running under a theme
// provider. We let callers inject the bound instance via setNotifierApi()
// once at mount; if no instance is provided we fall back to the static
// API so the helper still works in tests / Storybook.
interface NotifierApi {
  notification: NotificationInstance;
  message: MessageInstance;
}

let boundApi: NotifierApi | null = null;

export function setNotifierApi(api: NotifierApi | null): void {
  boundApi = api;
}

function notify(): NotificationInstance {
  return boundApi?.notification ?? staticNotification;
}

function toast(): MessageInstance {
  return boundApi?.message ?? staticMessage;
}

function deviceLabel(deviceName: string | undefined, ip: string | undefined): string {
  if (deviceName && ip) return `${deviceName} (${ip})`;
  return deviceName || ip || 'device';
}

/**
 * Fire the terminal toast for a job. Used both inside the inline wait
 * loop and after we hand the job off to the background poller.
 */
export function reportFinal(
  kind: 'commit' | 'rollback',
  deviceName: string | undefined,
  ip: string | undefined,
  job: Job,
): void {
  const device = deviceLabel(deviceName, ip);
  const verb = kind === 'commit' ? 'Commit' : 'Rollback';
  const jobsPath = `/jobs?q=${job.id}`;

  if (job.status === 'SUCCESS') {
    const durMs = computeDurationMs(job);
    const durLabel = durMs != null ? ` · ${formatDur(durMs)}` : '';
    notify().success({
      message: `${verb} thành công`,
      description: (
        <span>
          <code>{device}</code> đã {kind === 'commit' ? 'nhận config' : 'rollback'} thành công{durLabel}.{' '}
          <Link to={jobsPath}>mở Jobs</Link>
        </span>
      ),
      duration: 15, // auto-close after 15s
      placement: 'topRight',
    });
    return;
  }

  if (job.status === 'FAILED') {
    notify().error({
      message: `${verb} thất bại`,
      description: (
        <span>
          <code>{device}</code>: {job.error || 'unknown error'}{' '}
          <Link to={jobsPath}>xem chi tiết</Link>
        </span>
      ),
      duration: 0, // stays open until user clicks Close
      placement: 'topRight',
    });
    return;
  }

  // Still not terminal (caller error). Treat as warning so we never silently drop.
  notify().warning({
    message: `${verb} chưa kết thúc`,
    description: (
      <span>
        <code>{device}</code> job đang ở trạng thái <code>{job.status}</code>.{' '}
        <Link to={jobsPath}>mở Jobs</Link>
      </span>
    ),
    duration: 8,
    placement: 'topRight',
  });
}

export function reportWaitTimeout(kind: 'commit' | 'rollback', deviceName?: string, ip?: string): void {
  const device = deviceLabel(deviceName, ip);
  toast().warning({
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
 * Continue polling `jobId` in the background until it terminates, then
 * fire a notification. Returns the AbortController so the caller can
 * stop polling (e.g. on unmount). The controller aborts on terminal
 * state automatically.
 *
 * `kind`, `deviceName`, `ip` are passed in so the final toast is
 * meaningful without needing to re-read the device list.
 */
export function startBackgroundPoll(
  jobId: string,
  options: { kind: 'commit' | 'rollback'; deviceName?: string; ip?: string },
): AbortController {
  const controller = new AbortController();
  const poll = async () => {
    while (!controller.signal.aborted) {
      try {
        const job = await authJsonFetch<Job>(`/api/jobs/${jobId}`);
        if (job.status === 'SUCCESS' || job.status === 'FAILED') {
          reportFinal(options.kind, options.deviceName, options.ip, job);
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
