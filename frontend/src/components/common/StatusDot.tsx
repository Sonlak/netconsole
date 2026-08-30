import { Tag } from 'antd';
import { deviceStatusMeta, jobStatusMeta, type StatusMeta, type StatusTone } from '@/design/status';
import type { DeviceStatus } from '@/types/device';
import type { JobStatus } from '@/types/job';

const TONE_COLOR: Record<StatusTone, string> = {
  success: '#34d399',
  error: '#f87171',
  warning: '#fbbf24',
  processing: '#60a5fa',
  purple: '#a78bfa',
  default: '#64748b',
};

export function StatusDot({
  meta,
  status,
  jobStatus,
}: {
  meta?: StatusMeta;
  status?: DeviceStatus;
  jobStatus?: JobStatus;
}) {
  const resolved = meta ?? (status ? deviceStatusMeta(status) : jobStatus ? jobStatusMeta(jobStatus) : deviceStatusMeta('UNKNOWN'));
  const color = TONE_COLOR[resolved.tone];
  return (
    <span className="nc-status" aria-label={resolved.label}>
      <span
        className={`nc-status-dot${resolved.pulse ? ' is-pulse' : ''}`}
        style={{ background: resolved.tone === 'default' ? 'transparent' : color, borderColor: color }}
        aria-hidden
      />
      <Tag color={resolved.tone === 'default' ? undefined : resolved.tone} style={{ marginInlineEnd: 0 }}>
        {resolved.label}
      </Tag>
    </span>
  );
}
