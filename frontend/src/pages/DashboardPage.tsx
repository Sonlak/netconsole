import { Link, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { Button, Card, Empty, Flex, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { fetchDhcpDashboard } from '@/api/dhcp';
import { fetchJobs } from '@/api/jobs';
import { ActivityFeed, buildActivityItems } from '@/components/dashboard/ActivityFeed';
import { FabricMiniMap } from '@/components/dashboard/FabricMiniMap';
import { HeroLink, HeroStatusBanner } from '@/components/dashboard/HeroStatusBanner';
import { KeaSummary } from '@/components/dashboard/KeaSummary';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { RefreshIndicator, StaleDataBanner } from '@/components/common/StaleDataBanner';
import { StatusDot } from '@/components/common/StatusDot';
import { Timestamp } from '@/components/display/Timestamp';
import { useSite } from '@/components/site-provider';
import { peerStatusMeta, type StatusMeta } from '@/design/status';
import { SITES, filterBySite, siteStats } from '@/data/bank';
import { useDevices } from '@/hooks/useDevices';
import { useMetricHistory } from '@/hooks/useMetricHistory';
import { toError } from '@/lib/errors';
import { JOB_TYPE_LABELS, type Job } from '@/types/job';
import type { DhcpDashboard } from '@/types/dhcp';

const AUTO_REFRESH_MS = 15000;

/**
 * Site health severity used by the hero banner.
 *
 *  err    — at least one critical offline device or Kea peer unreachable.
 *  warn   — at least one offline device, pool at warning, or failed jobs.
 *  ok     — nothing in the loaded window.
 *
 * The fail-soft policy here mirrors Meraki / DNA "operational" semantics:
 * if we can't load the data we don't claim green.
 */
type HeroSeverity = 'ok' | 'warn' | 'err';

export default function DashboardPage() {
  const navigate = useNavigate();
  const { site } = useSite();
  const {
    devices: inventory,
    isLoading: devicesLoading,
    isRefreshing: devicesRefreshing,
    error: devicesError,
    lastUpdatedAt,
    refetch: refetchDevices,
  } = useDevices();
  const [widgetsLoading, setWidgetsLoading] = useState(true);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [healthError, setHealthError] = useState<Error | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsError, setJobsError] = useState<Error | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [dhcp, setDhcp] = useState<DhcpDashboard | null>(null);
  const [dhcpError, setDhcpError] = useState<Error | null>(null);
  const [dhcpLoaded, setDhcpLoaded] = useState(false);
  const history = useMetricHistory();

  const loadWidgets = useCallback(
    async (silent = false) => {
      if (!silent) setWidgetsLoading(true);
      const results = await Promise.allSettled([
        fetch('/api/health').then((response) => {
          if (!response.ok) throw new Error('Health check failed');
          return response.json() as Promise<{ status?: string }>;
        }),
        fetchJobs(),
        fetchDhcpDashboard(),
      ]);

      if (results[0].status === 'fulfilled') {
        setHealthOk(results[0].value.status === 'ok');
        setHealthError(null);
      } else {
        setHealthError(toError(results[0].reason, 'Health check failed'));
        setHealthOk((current) => (current === null ? false : current));
      }

      if (results[1].status === 'fulfilled' && Array.isArray(results[1].value)) {
        setJobs(results[1].value as Job[]);
        setJobsError(null);
        setJobsLoaded(true);
      } else {
        setJobsError(toError(results[1].status === 'rejected' ? results[1].reason : 'Could not load jobs', 'Could not load jobs'));
        setJobsLoaded((current) => current || false);
      }

      if (results[2].status === 'fulfilled') {
        setDhcp(results[2].value);
        setDhcpError(null);
        setDhcpLoaded(true);
      } else {
        setDhcpError(toError(results[2].reason, 'Could not load DHCP'));
      }

      setWidgetsLoading(false);
    },
    [],
  );

  useEffect(() => {
    void loadWidgets();
    const timer = window.setInterval(() => {
      void loadWidgets(true);
      void refetchDevices({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadWidgets, refetchDevices]);

  const scoped = useMemo(() => filterBySite(inventory, site), [inventory, site]);
  const stats = useMemo(() => siteStats(inventory, site), [inventory, site]);
  const pending = jobs.filter((job) => job.status === 'PENDING').length;
  const running = jobs.filter((job) => job.status === 'RUNNING').length;
  const failedJobs = jobs.filter((job) => job.status === 'FAILED');
  const emptyInventory = !devicesLoading && !devicesError && inventory.length === 0;
  const devicesFailed = Boolean(devicesError) && inventory.length === 0 && !devicesLoading;

  // Push current sample into history on every refresh tick. The hook
  // ignores null/NaN and prunes to MAX_HISTORY samples automatically.
  useEffect(() => {
    if (devicesLoading) return;
    history.push('devices.total', inventory.length);
    history.push('devices.managed', stats.managed);
    history.push('devices.offline', stats.offline);
    history.push('devices.unknown', stats.unknown);
    history.push('jobs.failed', failedJobs.length);
  }, [devicesLoading, inventory.length, stats.managed, stats.offline, stats.unknown, failedJobs.length, history]);

  const queueLabel = (() => {
    if (jobsError && jobs.length === 0) return 'Jobs unavailable';
    if (pending + running > 0) return `Queue active · ${running} running · ${pending} pending`;
    if (jobsLoaded || jobs.length > 0) return 'Queue idle';
    return widgetsLoading ? 'Checking queue' : 'Jobs unavailable';
  })();

  const activityItems = useMemo(
    () =>
      buildActivityItems({
        healthError,
        dhcpError,
        dhcpHaPeers: dhcp?.ha?.peers ?? [],
        devices: scoped,
        failedJobs,
        dhcpPools: dhcp?.pools ?? [],
      }),
    [dhcp, dhcpError, failedJobs, healthError, scoped],
  );

  // Hero severity — fail-soft: if we cannot confirm green we say warn.
  const heroSeverity: HeroSeverity = useMemo(() => {
    if (healthError) return 'err';
    if (dhcp?.ha?.peers?.some((p) => !p.reachable)) return 'err';
    const offline = stats.offline;
    const anyFailed = failedJobs.length > 0;
    const anyPoolHigh = (dhcp?.pools ?? []).some((p) => p.utilization >= 85);
    if (offline > 0 || anyFailed || anyPoolHigh) return 'warn';
    return 'ok';
  }, [dhcp, failedJobs.length, healthError, stats.offline]);

  const heroTitle = useMemo(() => {
    switch (heroSeverity) {
      case 'err':
        return 'Critical — needs attention';
      case 'warn':
        return 'Operational with warnings';
      case 'ok':
        return 'All systems operational';
    }
  }, [heroSeverity]);

  const subtitle = useMemo(() => {
    if (heroSeverity === 'err') return 'One or more subsystems unreachable. Open the activity feed for details.';
    if (heroSeverity === 'warn') {
      const parts: string[] = [];
      if (stats.offline) parts.push(`${stats.offline} device${stats.offline === 1 ? '' : 's'} offline`);
      if (failedJobs.length) parts.push(`${failedJobs.length} failed job${failedJobs.length === 1 ? '' : 's'}`);
      const highPool = (dhcp?.pools ?? []).find((p) => p.utilization >= 85);
      if (highPool) parts.push(`${highPool.site} ${highPool.name} at ${highPool.utilization}%`);
      return parts.length ? parts.join(' · ') : 'See activity feed below';
    }
    return lastUpdatedAt
      ? `Last refreshed ${new Date(lastUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Auto-refresh every 15s';
  }, [dhcp, failedJobs.length, heroSeverity, lastUpdatedAt, stats.offline]);

  const jobColumns: ColumnsType<Job> = [
    {
      title: 'Job',
      dataIndex: 'type',
      render: (type: Job['type']) => JOB_TYPE_LABELS[type] ?? type,
    },
    {
      title: 'Device',
      ellipsis: true,
      render: (_value, record) => record.device?.name ?? '—',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (status: Job['status']) => <StatusDot jobStatus={status} />,
    },
    {
      title: 'Updated',
      width: 110,
      render: (_value, record) => <Timestamp value={record.updatedAt} />,
    },
  ];

  const heroStats = useMemo(
    () => [
      { label: 'Sites', value: site === 'all' ? SITES.length : 1, href: '/devices' },
      { label: 'Devices', value: stats.total, href: '/devices', tone: stats.offline > 0 ? ('warning' as const) : ('default' as const) },
      { label: 'Managed', value: stats.managed, href: '/devices?managedOnly=1' },
      {
        label: 'Failed jobs',
        value: jobsError && jobs.length === 0 ? '—' : failedJobs.length,
        href: '/jobs?status=FAILED',
        tone: failedJobs.length > 0 ? ('error' as const) : ('default' as const),
      },
    ],
    [site, stats.total, stats.managed, stats.offline, failedJobs.length, jobs.length, jobsError],
  );

  return (
    <div className="nc-dashboard">
      <StaleDataBanner
        error={inventory.length ? devicesError : null}
        onRetry={() => void refetchDevices({ silent: true })}
      />

      <HeroStatusBanner
        severity={heroSeverity}
        title={heroTitle}
        subtitle={subtitle}
        stats={heroStats}
        action={<HeroLink to="/jobs?status=FAILED" count={activityItems.length} label="Open activity feed" />}
      />

      <Flex align="center" justify="space-between" gap={12} wrap className="nc-dashboard-toolbar">
        <Flex align="center" gap={12}>
          <HealthChip
            icon={<ApiOutlined />}
            label="API"
            ok={healthOk === true}
            failed={Boolean(healthError)}
            text={healthError ? 'Down' : healthOk ? 'OK' : widgetsLoading ? '…' : '—'}
          />
          <HealthChip
            label="Queue"
            ok={pending + running > 0}
            failed={Boolean(jobsError) && jobs.length === 0}
            text={queueLabel}
            idle={pending + running === 0 && !(jobsError && jobs.length === 0)}
          />
          {dhcp ? (
            <HealthChip
              icon={<WifiOutlined />}
              label="Kea"
              failed={dhcp.ha.peers.some((p) => !p.reachable)}
              text={
                dhcp.ha.active
                  ? `${dhcp.ha.mode} · ${dhcp.ha.active} active`
                  : dhcp.ha.peers.every((p) => p.reachable)
                    ? 'All peers reachable'
                    : 'Peer unreachable'
              }
              peerDots={dhcp.ha.peers.map((p) => ({ name: p.name, meta: peerStatusMeta(p.reachable) }))}
            />
          ) : (
            <HealthChip icon={<WifiOutlined />} label="Kea" text={widgetsLoading ? '…' : '—'} />
          )}
          <RefreshIndicator refreshing={devicesRefreshing || widgetsLoading} lastUpdatedAt={lastUpdatedAt} />
        </Flex>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => { void loadWidgets(); void refetchDevices(); }}>
            Reload
          </Button>
          <Button icon={<RadarChartOutlined />} onClick={() => navigate('/discovery')}>
            Run Discovery
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/devices')}>
            Add device
          </Button>
        </Space>
      </Flex>

      {devicesFailed ? (
        <ErrorState title="Could not load inventory" error={devicesError} onRetry={() => void refetchDevices()} />
      ) : null}

      {emptyInventory ? (
        <Card bordered={false} style={{ marginBottom: 12 }}>
          <EmptyState
            title="No devices in inventory"
            description="Empty inventory is valid. Add a device or run Discovery against a mgmt range."
            extra={
              <Space>
                <Button type="primary" icon={<RadarChartOutlined />} onClick={() => navigate('/discovery')}>
                  Run Discovery
                </Button>
                <Button icon={<PlusOutlined />} onClick={() => navigate('/devices')}>
                  Add device
                </Button>
              </Space>
            }
          />
        </Card>
      ) : null}

      {!emptyInventory && !devicesFailed ? (
        <div className="nc-metric-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(120px, 1fr))', marginBottom: 12 }}>
          <MetricCard
            label="Devices"
            value={stats.total}
            hint="Inventory"
            history={history.samples('devices.total')}
            delta={deltaOf(history.samples('devices.total'))}
            loading={devicesLoading && inventory.length === 0}
          />
          <MetricCard
            label="Managed"
            value={stats.managed}
            hint="Ping + SSH + REST"
            history={history.samples('devices.managed')}
            delta={deltaOf(history.samples('devices.managed'))}
          />
          <MetricCard
            label="Offline"
            value={stats.offline}
            hint="Needs action"
            alert={stats.offline > 0}
            variant="error"
            history={history.samples('devices.offline')}
            delta={deltaOf(history.samples('devices.offline'))}
            deltaInverse
          />
          <MetricCard
            label="Unchecked"
            value={stats.unknown}
            hint="Status unknown"
            alert={stats.unknown > 0 && stats.offline === 0}
            variant="warning"
            history={history.samples('devices.unknown')}
            delta={deltaOf(history.samples('devices.unknown'))}
          />
          <MetricCard
            label="Failed jobs"
            value={jobsError && jobs.length === 0 ? '—' : failedJobs.length}
            hint="Recent activity"
            alert={failedJobs.length > 0}
            variant="error"
            history={history.samples('jobs.failed')}
            delta={deltaOf(history.samples('jobs.failed'))}
            deltaInverse
            loading={widgetsLoading && !jobsLoaded}
          />
        </div>
      ) : null}

      <div className="nc-row-2col" data-template="14-10">
        <Card bordered={false} className="nc-row-2col-main" title="Live activity" extra={<Link to="/jobs?status=FAILED">Open jobs</Link>}>
          <ActivityFeed items={activityItems} loading={widgetsLoading && activityItems.length === 0} />
        </Card>
        <Card bordered={false} className="nc-row-2col-side" title="Fabric overview">
          <FabricMiniMap devices={scoped} lastUpdatedAt={lastUpdatedAt} />
        </Card>
      </div>

      <div className="nc-row-2col" data-template="14-10">
        <Card bordered={false} className="nc-row-2col-main" title="Recent jobs" extra={<Link to="/jobs">Open jobs</Link>}>
          {jobsError && jobs.length === 0 ? (
            <ErrorState title="Could not load jobs" error={jobsError} onRetry={() => void loadWidgets()} />
          ) : (
            <>
              <StaleDataBanner error={jobs.length ? jobsError : null} onRetry={() => void loadWidgets(true)} />
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        <span>
                          <Typography.Text strong>No recent jobs</Typography.Text>
                          <br />
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            Loaded window is empty (API returns up to 100 jobs).
                          </Typography.Text>
                        </span>
                      }
                    />
                  ),
                }}
                dataSource={jobs.slice(0, 8)}
                columns={jobColumns}
                onRow={(record) => ({
                  onClick: () => navigate(`/jobs?device=${record.deviceId ?? ''}`),
                })}
              />
            </>
          )}
        </Card>
        <Card bordered={false} className="nc-row-2col-side" title="DHCP" styles={{ body: { padding: 16 } }}>
          {dhcpError && !dhcp ? (
            <ErrorState title="DHCP unavailable" error={dhcpError} onRetry={() => void loadWidgets()} />
          ) : dhcp ? (
            <KeaSummary data={dhcp} error={null} loading={widgetsLoading && !dhcpLoaded} reload={() => void loadWidgets(true)} />
          ) : widgetsLoading && !dhcpLoaded ? (
            <PageSkeleton />
          ) : (
            <EmptyState title="DHCP not attached" description="Kea dashboard has no data yet." />
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Compute a "since last sample" delta — single number, signed.
 *
 * With 1 sample we have nothing to compare; return undefined so the badge
 * doesn't render. With 2+ samples compare oldest sample still in window to
 * the latest so the sparkline shows "this is moving up/down by N over the
 * last N minutes".
 */
function deltaOf(samples: number[]): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  return last - first;
}

function HealthChip({
  icon,
  label,
  text,
  ok,
  failed,
  idle,
  peerDots,
}: {
  icon?: ReactNode;
  label: string;
  text: string;
  ok?: boolean;
  failed?: boolean;
  idle?: boolean;
  peerDots?: Array<{ name: string; meta: StatusMeta }>;
}) {
  const tone = failed ? 'is-error' : ok ? 'is-success' : idle ? 'is-idle' : 'is-idle';
  return (
    <span className={`nc-health-chip ${tone}`}>
      <span className="nc-health-chip-label">
        {icon ? <span className="nc-health-chip-icon">{icon}</span> : null}
        {label}
      </span>
      <span className="nc-health-chip-text">{text}</span>
      {peerDots && peerDots.length > 0 ? (
        <span className="nc-health-chip-peers" aria-label={`${peerDots.length} peers`}>
          {peerDots.map((peer) => (
            <StatusDot key={peer.name} meta={peer.meta} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

