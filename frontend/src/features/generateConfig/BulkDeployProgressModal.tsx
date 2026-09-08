import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircleTwoTone, CloseCircleTwoTone, LoadingOutlined, MinusCircleOutlined } from '@ant-design/icons';
import { Alert, Button, List, Modal, Space, Tag, Typography, message, notification } from 'antd';
import { fetchJobsByIds } from '@/api/jobs';
import type { Job, JobStatus } from '@/types/job';
import { JOB_TYPE_LABELS } from '@/types/job';

export type BulkDeployQueuedJob = {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceIp: string;
};

type Props = {
  open: boolean;
  jobs: BulkDeployQueuedJob[];
  onClose: () => void;
};

const TERMINAL: JobStatus[] = ['SUCCESS', 'FAILED'];
const POLL_INTERVAL_MS = 2_000;
const AUTO_CLOSE_DELAY_MS = 10_000;

type BrowserNotificationPermission = 'default' | 'denied' | 'granted';

function readNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  return window.Notification.permission as BrowserNotificationPermission;
}

function notifyBrowser(title: string, body: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (window.Notification.permission !== 'granted') return;
  try {
    // eslint-disable-next-line no-new
    new window.Notification(title, { body, icon: '/favicon.ico' });
  } catch {
    // Older browsers / sandboxed contexts may throw — ignore.
  }
}

/**
 * Modal that polls a fixed list of jobs every 2s until every job reaches a
 * terminal status (SUCCESS / FAILED). Shows per-device progress + a summary
 * on completion. Fires a browser notification if any job failed.
 *
 * The modal is intentionally NOT closable while polling — it just minimizes
 * the user's "did it actually finish?" anxiety by leaving the result on
 * screen until they explicitly close (or the auto-close timer fires).
 */
export function BulkDeployProgressModal({ open, jobs, onClose }: Props) {
  const [live, setLive] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const notifiedRef = useRef(false);
  const summaryShownRef = useRef(false);
  const autoCloseTimerRef = useRef<number | null>(null);

  const jobIdsKey = useMemo(() => jobs.map((j) => j.id).join(','), [jobs]);

  // Reset internal state when a fresh batch is tracked.
  useEffect(() => {
    if (!open) return;
    notifiedRef.current = false;
    summaryShownRef.current = false;
    setError(null);
    setLive([]);
  }, [open, jobIdsKey]);

  // Ask for browser-notification permission once per session, the first
  // time a bulk deploy runs. Silently no-ops on browsers without the API.
  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (window.Notification.permission === 'default') {
      void window.Notification.requestPermission().catch(() => {
        /* user dismissed the prompt — fine, we won't notify */
      });
    }
  }, [open]);

  // Poll the tracked jobs every 2s. Stops automatically when all are terminal.
  useEffect(() => {
    if (!open || jobs.length === 0) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const fetched = await fetchJobsByIds(jobs.map((j) => j.id));
        if (cancelled) return;
        setLive(fetched);
        const allTerminal = fetched.every((j) => TERMINAL.includes(j.status));
        if (allTerminal && !summaryShownRef.current) {
          summaryShownRef.current = true;
          const succeeded = fetched.filter((j) => j.status === 'SUCCESS').length;
          const failed = fetched.filter((j) => j.status === 'FAILED').length;
          const skipped = jobs.length - fetched.length;
          const summary =
            failed === 0 && skipped === 0
              ? `✅ All ${succeeded} device(s) updated successfully.`
              : `⚠️ ${succeeded} succeeded, ${failed} failed${
                  skipped > 0 ? `, ${skipped} disappeared` : ''
                }.`;
          if (failed === 0) {
            message.success(summary);
            notification.success({
              message: `Bulk deploy · ${succeeded}/${fetched.length} OK`,
              description: (
                <span>
                  {succeeded} device(s) đã nhận config thành công.{' '}
                  <Link to="/jobs?type=APPLY_CONFIG">xem Jobs</Link>
                </span>
              ),
              duration: 10,
              placement: 'topRight',
            });
          } else {
            message.warning(summary);
            notification.warning({
              message: `Bulk deploy · ${succeeded} OK · ${failed} failed`,
              description: (
                <span>
                  Có {failed} device(s) lỗi.{' '}
                  <Link to="/jobs?type=APPLY_CONFIG">xem Jobs</Link>
                </span>
              ),
              duration: 12,
              placement: 'topRight',
            });
          }
          if (failed > 0 && !notifiedRef.current) {
            notifiedRef.current = true;
            notifyBrowser(
              'Bulk deploy completed with failures',
              `${failed} of ${fetched.length} job(s) failed. Open NetConsole to review.`,
            );
          }
          autoCloseTimerRef.current = window.setTimeout(() => {
            if (!cancelled) onClose();
          }, AUTO_CLOSE_DELAY_MS);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Failed to fetch job status');
      }
    };

    void tick();
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (autoCloseTimerRef.current !== null) {
        window.clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, [open, jobs, onClose]);

  const derived = useMemo(() => {
    const liveById = new Map(live.map((j) => [j.id, j]));
    return jobs.map((queued) => {
      const status: JobStatus | 'UNKNOWN' = liveById.get(queued.id)?.status ?? 'UNKNOWN';
      const error = liveById.get(queued.id)?.error ?? null;
      return { ...queued, status, error };
    });
  }, [jobs, live]);

  const counts = useMemo(() => {
    const out = { PENDING: 0, RUNNING: 0, SUCCESS: 0, FAILED: 0, UNKNOWN: 0 } as Record<
      JobStatus | 'UNKNOWN',
      number
    >;
    for (const row of derived) out[row.status] += 1;
    return out;
  }, [derived]);

  const allTerminal = derived.length > 0 && derived.every((r) => r.status !== 'UNKNOWN' && TERMINAL.includes(r.status));
  const permission = readNotificationPermission();
  const total = jobs.length;
  const finished = counts.SUCCESS + counts.FAILED;

  return (
    <Modal
      open={open}
      width={720}
      title={
        <Space>
          <span>Bulk deploy progress</span>
          <Tag color="blue">{JOB_TYPE_LABELS.APPLY_CONFIG}</Tag>
          {!allTerminal ? <Tag icon={<LoadingOutlined />} color="processing">running</Tag> : null}
          {allTerminal && counts.FAILED === 0 ? <Tag color="success">complete</Tag> : null}
          {allTerminal && counts.FAILED > 0 ? <Tag color="error">{counts.FAILED} failed</Tag> : null}
        </Space>
      }
      footer={
        <Space>
          <Typography.Text type="secondary">
            {allTerminal
              ? `Done. ${counts.SUCCESS}/${total} succeeded.`
              : `Polling ${total} job(s) every ${POLL_INTERVAL_MS / 1000}s — ${finished}/${total} finished.`}
          </Typography.Text>
          <Button onClick={onClose} disabled={!allTerminal}>
            {allTerminal ? 'Close' : 'Hide (keep tracking)'}
          </Button>
          <Link to="/jobs?type=APPLY_CONFIG" onClick={onClose}>
            <Button type="primary" disabled={!allTerminal}>
              Open Jobs page
            </Button>
          </Link>
        </Space>
      }
      onCancel={() => {
        if (allTerminal) onClose();
        // While polling, X just hides the modal — polling keeps running in
        // the background so the next time the user opens it, the result is
        // already there.
      }}
      closable={allTerminal}
      maskClosable={false}
    >
      {error ? (
        <Alert
          showIcon
          type="error"
          style={{ marginBottom: 12 }}
          message="Could not refresh status"
          description={error}
        />
      ) : null}
      {permission === 'denied' ? (
        <Alert
          showIcon
          type="info"
          style={{ marginBottom: 12 }}
          message="Browser notifications are blocked. The summary will still appear in-app."
        />
      ) : null}
      <List
        size="small"
        dataSource={derived}
        locale={{ emptyText: 'No jobs to track.' }}
        renderItem={(row) => (
          <List.Item>
            <List.Item.Meta
              avatar={statusIcon(row.status)}
              title={
                <Space>
                  <code>{row.deviceName}</code>
                  <Typography.Text type="secondary">{row.deviceIp}</Typography.Text>
                  <Tag>{row.status}</Tag>
                </Space>
              }
              description={row.error ? <Typography.Text type="danger">{row.error}</Typography.Text> : null}
            />
          </List.Item>
        )}
      />
    </Modal>
  );
}

function statusIcon(status: JobStatus | 'UNKNOWN') {
  switch (status) {
    case 'SUCCESS':
      return <CheckCircleTwoTone twoToneColor="#52c41a" />;
    case 'FAILED':
      return <CloseCircleTwoTone twoToneColor="#ff4d4f" />;
    case 'PENDING':
    case 'RUNNING':
      return <LoadingOutlined />;
    default:
      return <MinusCircleOutlined />;
  }
}
