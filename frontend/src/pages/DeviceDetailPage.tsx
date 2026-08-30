import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  EllipsisOutlined,
  FileTextOutlined,
  LinkOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Dropdown,
  Space,
  Table,
  Tabs,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchDeviceArp,
  fetchDeviceById,
  fetchDeviceConfig,
  fetchDeviceMac,
  triggerDeviceArp,
  triggerDeviceConfig,
  triggerDeviceConnect,
  triggerDeviceMac,
} from '@/api/deviceOperations';
import { checkManagedDevice, pingDevice } from '@/api/devices';
import { JobWaitTimeoutError, waitForJob, waitForJobIfNeeded } from '@/api/jobs';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { IpAddress, MacAddress, MonoValue } from '@/components/display/MonoValue';
import { Timestamp } from '@/components/display/Timestamp';
import ManagedChecksTags from '@/components/ManagedChecksTags';
import { PortsPanel } from '@/features/ports/PortsPanel';
import { useJobs } from '@/hooks/useJobs';
import { useUrlState } from '@/hooks/useUrlState';
import { isNotFound, toError } from '@/lib/errors';
import { formatPing, formatUptime, prettyJson, redactForDisplay, summarizeJson } from '@/lib/format';
import { tablePagination, tableScroll } from '@/lib/table';
import { isFullyManaged, type Device } from '@/types/device';
import { deviceFloor, deviceSite } from '@/data/bank';
import { JOB_TYPE_LABELS, type Job, type OperationResponse } from '@/types/job';

const TABS = ['overview', 'ports', 'config', 'arp', 'mac', 'activity'] as const;
type TabKey = (typeof TABS)[number];

function parseTab(value?: string): TabKey {
  return TABS.includes(value as TabKey) ? (value as TabKey) : 'overview';
}

const AUTO_REFRESH_MS = 15000;

function OperationStubAlert({ data }: { data: Record<string, unknown> }) {
  if (data.implemented === false) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Lab integration unavailable"
        description={String(data.message ?? 'This operation is not implemented on the attached lab.')}
      />
    );
  }
  return null;
}

function ConfigTab({ deviceId }: { deviceId: string }) {
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [payload, setPayload] = useState<OperationResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      setPayload(await fetchDeviceConfig(deviceId));
      setError(null);
    } catch (cause) {
      setError(toError(cause, 'Could not load config'));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load({ silent: true }), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const handleCollect = async () => {
    setCollecting(true);
    try {
      const { job } = await triggerDeviceConfig(deviceId);
      const finished = await waitForJobIfNeeded(job, { timeoutMs: 20000 });
      if (!finished) throw new Error('Job not available');
      if (finished.status === 'FAILED') throw new Error(finished.error || 'Config collection failed');
      await load();
      message.success('Collected running config');
    } catch (cause) {
      if (cause instanceof JobWaitTimeoutError) {
        message.warning(cause.message);
      } else {
        message.error(cause instanceof Error ? cause.message : 'Could not collect config');
      }
    } finally {
      setCollecting(false);
    }
  };

  if (loading && !payload) return <PageSkeleton />;
  if (error && !payload) return <ErrorState title="Could not load config" error={error} onRetry={() => void load()} />;

  const configText = String(payload?.data.config ?? '');

  return (
    <div>
      <StaleDataBanner error={payload ? error : null} onRetry={() => void load()} />
      <OperationStubAlert data={payload?.data ?? {}} />
      <DataTableShell
        title="Running config"
        count={configText ? 1 : 0}
        countLabel={configText ? 'collected' : 'not collected'}
        freshness={<TableFreshness lastUpdatedAt={payload?.collectedAt} />}
        extra={
          <Space>
            <Button icon={<CloudDownloadOutlined />} loading={collecting} onClick={() => void handleCollect()}>
              Collect config
            </Button>
            <Link to={`/generate-config?device=${deviceId}`}>
              <Button icon={<FileTextOutlined />}>Open Config Studio</Button>
            </Link>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          Source: {payload?.source === 'job' ? 'device collection' : payload?.source || 'unknown'}
          {payload?.jobId ? ` · job ${payload.jobId}` : ''}
        </Typography.Paragraph>
        {configText ? (
          <pre className="nc-code-block">{configText}</pre>
        ) : (
          <EmptyState title="Not collected" description="Running config is collected after the device is synced and refreshed on a schedule." />
        )}
      </DataTableShell>
    </div>
  );
}

function DeviceNetworkTable({ deviceId, kind }: { deviceId: string; kind: 'arp' | 'mac' }) {
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [payload, setPayload] = useState<OperationResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      setPayload(kind === 'arp' ? await fetchDeviceArp(deviceId) : await fetchDeviceMac(deviceId));
      setError(null);
    } catch (cause) {
      setError(toError(cause, `Could not load ${kind.toUpperCase()}`));
    } finally {
      setLoading(false);
    }
  }, [deviceId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load({ silent: true }), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const handleCollect = async () => {
    setCollecting(true);
    try {
      const trigger = kind === 'arp' ? await triggerDeviceArp(deviceId) : await triggerDeviceMac(deviceId);
      if (trigger.job?.id) {
        const job = await waitForJob(trigger.job.id);
        await load();
        if (job.status === 'SUCCESS') message.success(`Collected ${kind.toUpperCase()}`);
        else message.error(job.error ?? `${kind.toUpperCase()} collection failed`);
      } else {
        await load();
      }
    } catch (cause) {
      if (cause instanceof JobWaitTimeoutError) message.warning(cause.message);
      else message.error(cause instanceof Error ? cause.message : 'Could not collect');
    } finally {
      setCollecting(false);
    }
  };

  const entries = (payload?.data.entries as Record<string, string>[] | undefined) ?? [];
  const columns: ColumnsType<Record<string, string>> =
    kind === 'arp'
      ? [
          { title: 'IP', dataIndex: 'ip', render: (value: string) => <IpAddress value={value} /> },
          { title: 'Hostname', dataIndex: 'hostname', render: (value: string) => <MonoValue value={value || '—'} /> },
          { title: 'MAC', dataIndex: 'mac', render: (value: string) => <MacAddress value={value} /> },
          { title: 'Interface', dataIndex: 'interface', render: (value: string) => <MonoValue value={value} /> },
          { title: 'Flags', dataIndex: 'flags' },
        ]
      : [
          { title: 'MAC', dataIndex: 'mac', render: (value: string) => <MacAddress value={value} /> },
          { title: 'VLAN', dataIndex: 'vlan', render: (value: string) => <MonoValue value={value || '—'} /> },
          { title: 'Interface', dataIndex: 'interface', render: (value: string) => <MonoValue value={value} /> },
          { title: 'Flags', dataIndex: 'flags' },
          { title: 'Type', dataIndex: 'type' },
        ];

  if (loading && !payload) return <PageSkeleton />;
  if (error && !payload) return <ErrorState title={`Could not load ${kind.toUpperCase()}`} error={error} onRetry={() => void load()} />;

  return (
    <div>
      <StaleDataBanner error={payload ? error : null} onRetry={() => void load()} />
      <OperationStubAlert data={payload?.data ?? {}} />
      <DataTableShell
        title={kind === 'arp' ? 'ARP neighbors' : 'MAC addresses'}
        count={entries.length}
        freshness={<TableFreshness lastUpdatedAt={payload?.collectedAt} />}
        extra={
          <Button type="primary" icon={<CloudDownloadOutlined />} loading={collecting} onClick={() => void handleCollect()}>
            Collect
          </Button>
        }
      >
        {entries.length === 0 ? (
          <EmptyState
            title={`No ${kind.toUpperCase()} entries`}
            description="Entries are collected after sync and on a schedule. Collect now if the table is still empty."
          />
        ) : (
          <Table
            rowKey={(row, index) => `${row.mac}-${row.ip ?? row.interface}-${index}`}
            size="small"
            columns={columns}
            dataSource={entries}
            pagination={tablePagination}
            scroll={tableScroll}
          />
        )}
      </DataTableShell>
    </div>
  );
}

function ActivityTab({ deviceId }: { deviceId: string }) {
  const { jobs, isLoading, isRefreshing, error, lastUpdatedAt, refresh } = useJobs();
  const scoped = useMemo(() => jobs.filter((job) => job.deviceId === deviceId), [jobs, deviceId]);
  const columns: ColumnsType<Job> = [
    { title: 'Status', dataIndex: 'status', width: 130, render: (status: Job['status']) => <StatusDot jobStatus={status} /> },
    { title: 'Type', dataIndex: 'type', render: (type: Job['type']) => JOB_TYPE_LABELS[type] ?? type },
    { title: 'Created', dataIndex: 'createdAt', width: 120, render: (value: string) => <Timestamp value={value} /> },
    { title: 'Updated', dataIndex: 'updatedAt', width: 120, render: (value: string) => <Timestamp value={value} /> },
    { title: 'Error / result', ellipsis: true, render: (_value, record) => record.error || summarizeJson(record.result) },
  ];

  if (isLoading && jobs.length === 0) return <PageSkeleton />;
  if (error && jobs.length === 0) return <ErrorState title="Could not load jobs" error={error} onRetry={() => void refresh()} />;

  return (
    <div>
      <StaleDataBanner error={jobs.length ? error : null} onRetry={() => void refresh({ silent: true })} />
      <DataTableShell
        title="Activity"
        count={scoped.length}
        countLabel="in last 100 jobs"
        freshness={<TableFreshness refreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />}
      >
        <Typography.Paragraph type="secondary">
          Filtered client-side from the latest 100 jobs. This is not a complete audit log.
        </Typography.Paragraph>
        {scoped.length === 0 ? (
          <EmptyState title="No jobs for this device in the loaded window" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            expandable={{
              expandedRowRender: (record) => (
                <pre className="nc-code-block">{prettyJson(redactForDisplay({ payload: record.payload, result: record.result, error: record.error }))}</pre>
              ),
            }}
            dataSource={scoped}
            columns={columns}
            pagination={tablePagination}
            scroll={tableScroll}
          />
        )}
      </DataTableShell>
    </div>
  );
}

export default function DeviceDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { get, patch } = useUrlState();
  const tab = parseTab(get('tab'));
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [checkingManaged, setCheckingManaged] = useState(false);
  const [pinging, setPinging] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        setDevice(await fetchDeviceById(id));
        setError(null);
      } catch (cause) {
        setDevice(null);
        setError(toError(cause, 'Device not found'));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [id]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await triggerDeviceConnect(id);
      message.success('Created connect-test job');
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Could not create job');
    } finally {
      setConnecting(false);
    }
  };

  const handlePing = async () => {
    setPinging(true);
    try {
      setDevice(await pingDevice(id));
      message.success('Ping completed');
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Ping failed');
    } finally {
      setPinging(false);
    }
  };

  const handleCheckManaged = async () => {
    setCheckingManaged(true);
    try {
      const result = await checkManagedDevice(id);
      if (result.job?.id) {
        const job = await waitForJob(result.job.id, { timeoutMs: 45000 });
        setDevice(await fetchDeviceById(id));
        if (job.status === 'SUCCESS') message.success('Managed check OK');
        else message.error(job.error ?? 'Managed check failed');
      } else if (result.device) {
        setDevice(result.device);
        message.warning('Ping failed — device OFFLINE');
      }
    } catch (cause) {
      if (cause instanceof JobWaitTimeoutError) message.warning(cause.message);
      else message.error(cause instanceof Error ? cause.message : 'Managed check failed');
    } finally {
      setCheckingManaged(false);
    }
  };

  if (loading && !device) return <PageSkeleton />;

  if (!device) {
    const missing = isNotFound(error);
    return (
      <div className="nc-page">
        <ErrorState
          title={missing ? 'Device not found' : 'Could not load device'}
          error={error}
          onRetry={missing ? undefined : () => window.location.reload()}
        />
        <div style={{ textAlign: 'center' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/devices')}>
            Back to devices
          </Button>
        </div>
      </div>
    );
  }

  const managed = device.status === 'MANAGED' || isFullyManaged(device.managedChecks);
  const offline = device.status === 'OFFLINE';
  const maintenance = device.status === 'MAINTENANCE';
  const networkDisabled = offline || maintenance;

  return (
    <div className="nc-page">
      <div className="nc-device-header">
        <Space align="start">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/devices')}>
            Back
          </Button>
          <div>
            <Space wrap>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {device.name}
              </Typography.Title>
              <StatusDot status={device.status} />
              {managed ? <StatusDot status="MANAGED" /> : null}
            </Space>
            <div>
              <IpAddress value={device.ip} />
              <Typography.Text type="secondary">
                {' '}
                · {device.vendor} {device.model} · {deviceSite(device)} / {deviceFloor(device)}
              </Typography.Text>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Last ping {formatPing(device.lastPingAt, device.lastPingMs)}
              {device.lastManagedCheckAt ? (
                <>
                  {' '}
                  · Managed check <Timestamp value={device.lastManagedCheckAt} />
                </>
              ) : (
                ' · Managed check never'
              )}
            </Typography.Text>
            <div>
              <ManagedChecksTags checks={device.managedChecks} />
            </div>
          </div>
        </Space>
        <Space wrap>
          <Tooltip title={offline ? 'Retry ping' : 'Ping'}>
            <Button icon={<SendOutlined />} loading={pinging} onClick={() => void handlePing()}>
              {offline ? 'Retry ping' : 'Ping'}
            </Button>
          </Tooltip>
          <Button
            type="primary"
            icon={<SafetyCertificateOutlined />}
            loading={checkingManaged}
            disabled={maintenance}
            onClick={() => void handleCheckManaged()}
          >
            Managed check
          </Button>
          <Link to={`/generate-config?device=${device.id}`}>
            <Button icon={<FileTextOutlined />} disabled={networkDisabled}>
              Config Studio
            </Button>
          </Link>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'connect',
                  icon: <LinkOutlined />,
                  label: 'Connect test',
                  disabled: connecting || networkDisabled,
                  onClick: () => void handleConnect(),
                },
                {
                  key: 'ports',
                  label: 'Open ports',
                  onClick: () => patch({ tab: 'ports' }),
                },
              ],
            }}
          >
            <Button aria-label="More actions" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      </div>

      {offline ? (
        <Alert
          showIcon
          type="error"
          style={{ marginTop: 12 }}
          message="Device is offline"
          description={device.manageError || 'Last ping failed. Destructive port and config actions are disabled.'}
        />
      ) : null}
      {device.status === 'ONLINE' && !managed ? (
        <Alert
          showIcon
          type="warning"
          style={{ marginTop: 12 }}
          message="Online but not managed"
          description="Ping succeeded. Run managed check to verify SSH before port or config changes."
        />
      ) : null}
      {maintenance ? (
        <Alert
          showIcon
          type="warning"
          style={{ marginTop: 12 }}
          message="Maintenance"
          description="Checks are paused. This is not an offline state. Network actions are disabled."
        />
      ) : null}
      {device.manageError && !offline ? (
        <Alert showIcon type="error" style={{ marginTop: 12 }} message="Managed-check error" description={device.manageError} />
      ) : null}

      <Tabs
        style={{ marginTop: 16 }}
        activeKey={tab}
        onChange={(key) => patch({ tab: key === 'overview' ? null : key })}
        destroyInactiveTabPane
        items={[
          {
            key: 'overview',
            label: 'Overview',
            children: (
              <Card bordered={false}>
                <Descriptions column={{ xs: 1, sm: 2 }} size="small">
                  <Descriptions.Item label="Site">{deviceSite(device)}</Descriptions.Item>
                  <Descriptions.Item label="Floor">{deviceFloor(device)}</Descriptions.Item>
                  <Descriptions.Item label="Management IP">
                    <IpAddress value={device.ip} />
                  </Descriptions.Item>
                  <Descriptions.Item label="Status">
                    <StatusDot status={device.status} />
                  </Descriptions.Item>
                  <Descriptions.Item label="Vendor">{device.vendor || '—'}</Descriptions.Item>
                  <Descriptions.Item label="Model">{device.model || '—'}</Descriptions.Item>
                  <Descriptions.Item label="Version">{device.version || '—'}</Descriptions.Item>
                  <Descriptions.Item label="Serial">
                    <MonoValue
                      value={!device.serial || device.serial.startsWith('DISC-') ? '—' : device.serial}
                      copyable={Boolean(device.serial) && !device.serial.startsWith('DISC-')}
                    />
                  </Descriptions.Item>
                  <Descriptions.Item label="Uptime">
                    {formatUptime(device.uptimeSeconds, device.uptimeAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="Description" span={2}>
                    {device.description || '—'}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ),
          },
          {
            key: 'ports',
            label: 'Ports',
            children: (
              <PortsPanel
                deviceId={id}
                deviceName={device.name}
                deviceIp={device.ip}
                managed={managed}
              />
            ),
          },
          { key: 'config', label: 'Config', children: <ConfigTab deviceId={id} /> },
          { key: 'arp', label: 'ARP', children: <DeviceNetworkTable deviceId={id} kind="arp" /> },
          { key: 'mac', label: 'MAC', children: <DeviceNetworkTable deviceId={id} kind="mac" /> },
          { key: 'activity', label: 'Activity', children: <ActivityTab deviceId={id} /> },
        ]}
      />
    </div>
  );
}
