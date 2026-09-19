import { Link } from 'react-router-dom';
import {
  ApiOutlined,
  ArrowRightOutlined,
  ClusterOutlined,
  ThunderboltFilled,
  ToolOutlined,
  WarningFilled,
  WifiOutlined,
} from '@ant-design/icons';
import { Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { Timestamp } from '@/components/display/Timestamp';
import { JOB_TYPE_LABELS, type Job } from '@/types/job';
import type { Device } from '@/types/device';
import type { DhcpHaPeer, DhcpPool } from '@/types/dhcp';

type Severity = 0 | 1 | 2 | 3 | 4 | 5;

export type ActivityItem = {
  key: string;
  severity: Severity;
  icon: ReactNode;
  title: string;
  detail: string;
  href: string;
  /** Optional timestamp shown on the right. Defaults to "now" for live feel. */
  updatedAt?: string | null;
};

const SEVERITY_META: Record<Severity, { label: string; bar: string; tag: string }> = {
  0: { label: 'Critical', bar: 'is-critical', tag: 'error' },
  1: { label: 'Offline', bar: 'is-error', tag: 'error' },
  2: { label: 'Error', bar: 'is-error', tag: 'error' },
  3: { label: 'Failed', bar: 'is-warn', tag: 'warning' },
  4: { label: 'Unknown', bar: 'is-neutral', tag: 'default' },
  5: { label: 'Pressure', bar: 'is-warn', tag: 'warning' },
};

const ICON_BY_TONE: Record<string, ReactNode> = {
  api: <ApiOutlined />,
  kea: <WifiOutlined />,
  offline: <ThunderboltFilled />,
  unknown: <ToolOutlined />,
  pool: <ClusterOutlined />,
  failed: <WarningFilled />,
};

/**
 * Build activity items from the same sources the old `Attention` list used,
 * but with stable shape so the feed can show a vertical timeline. Sorted by
 * severity first, then by recency (if timestamps are available).
 */
export function buildActivityItems(input: {
  healthError: Error | null;
  dhcpError: Error | null;
  dhcpHaPeers: DhcpHaPeer[];
  devices: Device[];
  failedJobs: Job[];
  dhcpPools: DhcpPool[];
}): ActivityItem[] {
  const items: ActivityItem[] = [];
  if (input.healthError) {
    items.push({
      key: 'api',
      severity: 0,
      icon: ICON_BY_TONE.api,
      title: 'API unreachable',
      detail: input.healthError.message,
      href: '/',
    });
  }
  for (const peer of input.dhcpHaPeers) {
    if (!peer.reachable) {
      items.push({
        key: `kea-${peer.name}`,
        severity: 0,
        icon: ICON_BY_TONE.kea,
        title: `Kea peer unreachable`,
        detail: `${peer.name} · ${peer.role}${peer.state ? ` · ${peer.state}` : ''}`,
        href: '/dhcp',
      });
    }
  }
  if (input.dhcpError) {
    items.push({
      key: 'dhcp-api',
      severity: 0,
      icon: ICON_BY_TONE.api,
      title: 'DHCP unavailable',
      detail: input.dhcpError.message,
      href: '/dhcp',
    });
  }
  for (const device of input.devices.filter((d) => d.status === 'OFFLINE')) {
    items.push({
      key: `off-${device.id}`,
      severity: 1,
      icon: ICON_BY_TONE.offline,
      title: device.name,
      detail: device.manageError || 'Device offline',
      href: `/devices/${device.id}`,
      updatedAt: device.lastManagedCheckAt ?? device.lastPingAt ?? null,
    });
  }
  for (const device of input.devices.filter((d) => d.manageError && d.status !== 'OFFLINE')) {
    items.push({
      key: `err-${device.id}`,
      severity: 2,
      icon: ICON_BY_TONE.unknown,
      title: device.name,
      detail: device.manageError || 'Managed-check error',
      href: `/devices/${device.id}`,
      updatedAt: device.lastManagedCheckAt ?? null,
    });
  }
  for (const job of input.failedJobs) {
    items.push({
      key: `job-${job.id}`,
      severity: 3,
      icon: ICON_BY_TONE.failed,
      title: JOB_TYPE_LABELS[job.type] ?? job.type,
      detail: job.error || job.device?.name || 'Failed job',
      href: `/jobs?status=FAILED&device=${job.deviceId ?? ''}`,
      updatedAt: job.updatedAt ?? null,
    });
  }
  for (const device of input.devices.filter((d) => d.status === 'UNKNOWN')) {
    items.push({
      key: `unk-${device.id}`,
      severity: 4,
      icon: ICON_BY_TONE.unknown,
      title: device.name,
      detail: 'Not checked yet',
      href: `/devices/${device.id}`,
      updatedAt: device.lastManagedCheckAt ?? null,
    });
  }
  for (const pool of input.dhcpPools) {
    if (pool.utilization >= 70) {
      items.push({
        key: `pool-${pool.subnetId}`,
        severity: pool.utilization >= 85 ? 3 : 5,
        icon: ICON_BY_TONE.pool,
        title: `${pool.site} ${pool.name}`,
        detail: `${pool.utilization}% · ${pool.leased}/${pool.poolSize} leased`,
        href: `/dhcp?site=${pool.site}&pool=${pool.subnetId}`,
      });
    }
  }
  return items.sort((a, b) => a.severity - b.severity).slice(0, 10);
}

/**
 * ActivityFeed — vertical timeline of attention items.
 *
 * Replaces the old plain Attention list. Each row has:
 *   - severity bar (left edge, color-coded)
 *   - severity icon (AntD icon font, tinted)
 *   - title + detail (1-line clamp)
 *   - timestamp (right edge)
 *   - chevron on hover
 */
export function ActivityFeed({
  items,
  loading,
  emptyHint,
}: {
  items: ActivityItem[];
  loading?: boolean;
  emptyHint?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="nc-activity-empty">
        <div className="nc-activity-empty-glyph" aria-hidden>🌿</div>
        <Typography.Text strong>All quiet</Typography.Text>
        <Typography.Text type="secondary">{emptyHint ?? 'No open alerts in the loaded window.'}</Typography.Text>
      </div>
    );
  }
  return (
    <ol className="nc-activity" aria-label="Activity feed">
      {items.map((item) => {
        const meta = SEVERITY_META[item.severity];
        return (
          <li key={item.key} className="nc-activity-item">
            <span className={`nc-activity-bar ${meta.bar}`} aria-hidden />
            <span className={`nc-activity-icon ${meta.bar}`}>{item.icon}</span>
            <Link to={item.href} className="nc-activity-body">
              <div className="nc-activity-row">
                <Typography.Text strong className="nc-activity-title">
                  {item.title}
                </Typography.Text>
                <Tag color={meta.tag as 'error' | 'warning' | 'default'} className="nc-activity-tag">
                  {meta.label}
                </Tag>
                {item.updatedAt ? (
                  <Tooltip title={new Date(item.updatedAt).toLocaleString()}>
                    <span className="nc-activity-time">
                      <Timestamp value={item.updatedAt} />
                    </span>
                  </Tooltip>
                ) : null}
                <ArrowRightOutlined className="nc-activity-chevron" />
              </div>
              <Typography.Text type="secondary" className="nc-activity-detail" ellipsis>
                {item.detail}
              </Typography.Text>
            </Link>
            {loading ? <span className="nc-activity-loading-pulse" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}
