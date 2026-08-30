import { Link, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiOutlined, PlusOutlined, RadarChartOutlined, ReloadOutlined, WifiOutlined } from '@ant-design/icons';
import { Button, Card, Col, Flex, Row, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { fetchDhcpDashboard } from '@/api/dhcp';
import { fetchJobs } from '@/api/jobs';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { MetricCard } from '@/components/common/MetricCard';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { RefreshIndicator, StaleDataBanner } from '@/components/common/StaleDataBanner';
import { StatusDot } from '@/components/common/StatusDot';
import { Timestamp } from '@/components/display/Timestamp';
import { useSite } from '@/components/site-provider';
import { DHCP_UTIL_CRITICAL, DHCP_UTIL_WARNING, dhcpUtilMeta, peerStatusMeta } from '@/design/status';
import { SITES, filterBySite, siteStats } from '@/data/bank';
import { useDevices } from '@/hooks/useDevices';
import { toError } from '@/lib/errors';
import { JOB_TYPE_LABELS, type Job } from '@/types/job';
import type { DhcpDashboard } from '@/types/dhcp';

const AUTO_REFRESH_MS = 15000;

type AttentionItem = {
  key: string;
  severity: number;
  title: string;
  detail: string;
  href: string;
};

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

  const loadWidgets = useCallback(async (silent = false) => {
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
  }, []);

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

  const queueLabel = (() => {
    if (jobsError && jobs.length === 0) return 'Jobs unavailable';
    if (pending + running > 0) return `Queue active · ${running} running · ${pending} pending`;
    if (jobsLoaded || jobs.length > 0) return 'Queue idle';
    return widgetsLoading ? 'Checking queue' : 'Jobs unavailable';
  })();

  const attention = useMemo(() => {
    const items: AttentionItem[] = [];
    if (healthError) {
      items.push({
        key: 'api',
        severity: 0,
        title: 'API unavailable',
        detail: healthError.message,
        href: '/',
      });
    }
    for (const peer of dhcp?.ha?.peers ?? []) {
      if (!peer.reachable) {
        items.push({
          key: `kea-${peer.name}`,
          severity: 0,
          title: `Kea peer unreachable`,
          detail: `${peer.name} · ${peer.role}${peer.state ? ` · ${peer.state}` : ''}`,
          href: '/dhcp',
        });
      }
    }
    if (dhcpError && !dhcp) {
      items.push({
        key: 'dhcp-api',
        severity: 0,
        title: 'DHCP unavailable',
        detail: dhcpError.message,
        href: '/dhcp',
      });
    }
    for (const device of scoped.filter((item) => item.status === 'OFFLINE')) {
      items.push({
        key: `off-${device.id}`,
        severity: 1,
        title: device.name,
        detail: device.manageError || 'Offline',
        href: `/devices/${device.id}`,
      });
    }
    for (const device of scoped.filter((item) => item.manageError && item.status !== 'OFFLINE')) {
      items.push({
        key: `err-${device.id}`,
        severity: 2,
        title: device.name,
        detail: device.manageError || 'Managed-check error',
        href: `/devices/${device.id}`,
      });
    }
    for (const job of failedJobs) {
      items.push({
        key: `job-${job.id}`,
        severity: 3,
        title: JOB_TYPE_LABELS[job.type] ?? job.type,
        detail: job.error || job.device?.name || 'Failed job',
        href: `/jobs?status=FAILED&device=${job.deviceId ?? ''}`,
      });
    }
    for (const device of scoped.filter((item) => item.status === 'UNKNOWN')) {
      items.push({
        key: `unk-${device.id}`,
        severity: 4,
        title: device.name,
        detail: 'Not checked yet',
        href: `/devices/${device.id}`,
      });
    }
    for (const pool of dhcp?.pools ?? []) {
      if (pool.utilization >= DHCP_UTIL_WARNING) {
        items.push({
          key: `pool-${pool.subnetId}`,
          severity: pool.utilization >= DHCP_UTIL_CRITICAL ? 0 : 5,
          title: `${pool.site} ${pool.name}`,
          detail: `${pool.utilization}% · ${pool.leased}/${pool.poolSize} leased`,
          href: `/dhcp?site=${pool.site}&pool=${pool.subnetId}`,
        });
      }
    }
    return items.sort((a, b) => a.severity - b.severity).slice(0, 12);
  }, [dhcp, dhcpError, failedJobs, healthError, scoped]);

  const hottestPool = useMemo(() => {
    const pools = dhcp?.pools ?? [];
    if (pools.length === 0) return null;
    return [...pools].sort((a, b) => b.utilization - a.utilization)[0];
  }, [dhcp]);

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

  return (
    <div className="nc-dashboard">
      <StaleDataBanner error={inventory.length ? devicesError : null} onRetry={() => void refetchDevices({ silent: true })} />

      <Flex align="center" justify="space-between" gap={12} wrap style={{ marginBottom: 12 }}>
        <RefreshIndicator refreshing={devicesRefreshing || widgetsLoading} lastUpdatedAt={lastUpdatedAt} />
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

      <Card bordered={false} title="System health" style={{ marginBottom: 12 }}>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={6}>
            <HealthCell
              icon={<ApiOutlined />}
              label="API / DB"
              ok={healthOk === true}
              failed={Boolean(healthError)}
              text={healthError ? 'Unavailable' : healthOk ? 'Healthy' : widgetsLoading ? 'Checking' : 'Unavailable'}
            />
          </Col>
          <Col xs={24} md={6}>
            <HealthCell
              label="Job queue"
              ok={pending + running > 0}
              failed={Boolean(jobsError) && jobs.length === 0}
              text={queueLabel}
              idle={pending + running === 0 && !(jobsError && jobs.length === 0)}
            />
          </Col>
          <Col xs={24} md={12}>
            {dhcpError && !dhcp ? (
              <HealthCell icon={<WifiOutlined />} label="Kea HA" failed text="Kea unavailable" />
            ) : dhcp ? (
              <Space wrap size={[16, 8]}>
                {(dhcp.ha?.peers ?? []).map((peer) => (
                  <div key={peer.name}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {peer.name} · {peer.role}
                      {dhcp.ha?.active === peer.name ? ' · active' : ''}
                    </Typography.Text>
                    <div>
                      <StatusDot meta={peerStatusMeta(peer.reachable)} />
                      {peer.state ? (
                        <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                          {peer.state}
                        </Typography.Text>
                      ) : null}
                    </div>
                  </div>
                ))}
              </Space>
            ) : (
              <HealthCell icon={<WifiOutlined />} label="Kea HA" text={widgetsLoading ? 'Checking' : 'Not attached'} />
            )}
          </Col>
        </Row>
      </Card>

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
          <MetricCard label="Devices" value={stats.total} loading={devicesLoading && inventory.length === 0} />
          <MetricCard label="Managed" value={stats.managed} hint="Ping + SSH" />
          <MetricCard label="Offline" value={stats.offline} alert={stats.offline > 0} />
          <MetricCard label="Unchecked" value={stats.unknown} />
          <MetricCard
            label="Failed jobs"
            value={jobsError && jobs.length === 0 ? '—' : failedJobs.length}
            hint="In last 100 loaded"
            alert={failedJobs.length > 0}
            loading={widgetsLoading && !jobsLoaded}
          />
        </div>
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card bordered={false} title="Attention">
            {attention.length === 0 ? (
              <EmptyState title="Nothing needs attention" description="No offline devices, failed jobs, or Kea pressure in the loaded data." />
            ) : (
              attention.map((item) => (
                <Link key={item.key} to={item.href} className="nc-attention-item">
                  <div>
                    <Typography.Text strong>{item.title}</Typography.Text>
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {item.detail}
                      </Typography.Text>
                    </div>
                  </div>
                  <Typography.Text type="secondary">Open</Typography.Text>
                </Link>
              ))
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card bordered={false} title="Site health">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {SITES.filter((item) => site === 'all' || item.code === site).map((item) => {
                const local = siteStats(inventory, item.code);
                return (
                  <Flex key={item.code} justify="space-between" gap={12}>
                    <div>
                      <Link to={`/devices?site=${item.code}`}>
                        <Typography.Text strong>{item.code}</Typography.Text>
                      </Link>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {local.total} devices · {local.managed} managed
                        </Typography.Text>
                      </div>
                    </div>
                    <Space size={8}>
                      <Tag color={local.offline > 0 ? 'error' : 'default'}>{local.offline} offline</Tag>
                      <Tag>{local.unknown} unchecked</Tag>
                    </Space>
                  </Flex>
                );
              })}
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={14}>
          <Card bordered={false} title="Recent jobs" extra={<Link to="/jobs">Open jobs</Link>}>
            {jobsError && jobs.length === 0 ? (
              <ErrorState title="Could not load jobs" error={jobsError} onRetry={() => void loadWidgets()} />
            ) : (
              <>
                <StaleDataBanner error={jobs.length ? jobsError : null} onRetry={() => void loadWidgets(true)} />
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: <EmptyState title="No recent jobs" description="Loaded window is empty (API returns up to 100 jobs)." /> }}
                  dataSource={jobs.slice(0, 8)}
                  columns={jobColumns}
                  onRow={(record) => ({
                    onClick: () => navigate(`/jobs?device=${record.deviceId ?? ''}`),
                  })}
                />
              </>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card bordered={false} title="Kea HA / pool pressure" extra={<Link to="/dhcp">Open DHCP</Link>}>
            {dhcpError && !dhcp ? (
              <ErrorState title="DHCP unavailable" error={dhcpError} onRetry={() => void loadWidgets()} />
            ) : dhcp ? (
              <>
                <StaleDataBanner error={dhcpError} onRetry={() => void loadWidgets(true)} />
                {hottestPool ? (
                  <div style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary">Most utilized pool</Typography.Text>
                    <div>
                      <Link to={`/dhcp?site=${hottestPool.site}&pool=${hottestPool.subnetId}`}>
                        <Typography.Text strong>
                          {hottestPool.site} {hottestPool.name}
                        </Typography.Text>
                      </Link>
                    </div>
                    <Space>
                      <StatusDot meta={dhcpUtilMeta(hottestPool.utilization)} />
                      <Typography.Text>
                        {hottestPool.utilization}% · {hottestPool.leased}/{hottestPool.poolSize}
                      </Typography.Text>
                    </Space>
                  </div>
                ) : (
                  <EmptyState title="No pool data" />
                )}
              </>
            ) : widgetsLoading && !dhcpLoaded ? (
              <PageSkeleton />
            ) : (
              <EmptyState title="DHCP not attached" description="Kea dashboard has no data yet." />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function HealthCell({
  icon,
  label,
  text,
  ok,
  failed,
  idle,
}: {
  icon?: ReactNode;
  label: string;
  text: string;
  ok?: boolean;
  failed?: boolean;
  idle?: boolean;
}) {
  const color = failed ? 'error' : ok ? 'processing' : idle ? 'default' : 'default';
  return (
    <div>
      <Space size={6}>
        {icon}
        <Typography.Text type="secondary">{label}</Typography.Text>
      </Space>
      <div>
        <Tag color={failed ? 'error' : color === 'processing' ? 'processing' : undefined}>{text}</Tag>
      </div>
    </div>
  );
}
