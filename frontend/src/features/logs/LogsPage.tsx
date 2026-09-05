import { Link, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertOutlined,
  ClearOutlined,
  DownloadOutlined,
  FilterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { collectLogs, DEFAULT_LOG_FILENAME, deleteLogsForDevice, fetchLogsInventory, FILENAME_OPTIONS } from '@/api/logs';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { ActiveFilterChips } from '@/components/data-table/ActiveFilterChips';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { DataTableToolbar } from '@/components/data-table/DataTableToolbar';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { SITE_OPTIONS } from '@/components/site-provider';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { useUrlSearch } from '@/hooks/useUrlState';
import { tablePagination, tableScroll } from '@/lib/table';
import {
  LOG_FACILITY_LABEL,
  LOG_SEVERITY_COLOR,
  LOG_SEVERITY_LABEL,
  LOG_SEVERITY_ORDER,
  type DeviceLogRow,
  type LogFacility,
  type LogSeverity,
  type LogsInventory,
} from '@/types/log';

const AUTO_REFRESH_MS = 30000;

const FACILITY_OPTIONS = Object.entries(LOG_FACILITY_LABEL)
  .filter(([key]) => key !== 'UNKNOWN')
  .map(([value, label]) => ({ value, label }));

const SEVERITY_OPTIONS = LOG_SEVERITY_ORDER.map((value) => ({
  value,
  label: LOG_SEVERITY_LABEL[value],
}));

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return value;
  }
}

export function LogsPage() {
  const { site, setSite, get, patch } = useSiteFilter();
  const navigate = useNavigate();
  const { value: searchText, setValue: setSearchText, committed: q } = useUrlSearch('q');
  const deviceFilter = get('device') || 'all';
  // IMPORTANT: these filters are derived from URL params and must be memoized.
  // A new array reference on every render would invalidate the `load` callback
  // below, which triggers `useEffect(() => { setHasLoaded(false); ... }, [load])`
  // every render — that effect sets state every render, which re-renders the
  // component, which creates a new array, which loops forever → React error #185.
  const severityFilter = useMemo(
    () => (get('severity')?.split(',').filter(Boolean) ?? []) as LogSeverity[],
    [get],
  );
  const facilityFilter = (get('facility') || 'all') as LogFacility | 'all';
  const filenameFilter = (get('filename') || DEFAULT_LOG_FILENAME) as string;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [inventory, setInventory] = useState<LogsInventory>({
    rows: [],
    managedDevices: 0,
    devicesWithData: 0,
    lastUpdatedAt: null,
    severities: [],
  });
  const [severityDrawerOpen, setSeverityDrawerOpen] = useState(false);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      else setRefreshing(true);
      try {
        const next = await fetchLogsInventory({
          severity: severityFilter.length > 0 ? severityFilter : undefined,
          facility: facilityFilter !== 'all' ? facilityFilter : undefined,
          q: q || undefined,
        });
        setInventory({
          rows: Array.isArray(next?.rows) ? next.rows : [],
          managedDevices: Number(next?.managedDevices) || 0,
          devicesWithData: Number(next?.devicesWithData) || 0,
          lastUpdatedAt: next?.lastUpdatedAt ?? null,
          severities: Array.isArray(next?.severities) ? next.severities : [],
        });
        setError(null);
        setHasLoaded(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error('Could not load logs'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [severityFilter, facilityFilter, q],
  );

  useEffect(() => {
    setHasLoaded(false);
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load({ silent: true }), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const deviceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of inventory.rows) {
      if (site !== 'all' && row.site !== site) continue;
      if (!row.deviceId) continue;
      const name = row.deviceName ?? 'unknown';
      const ip = row.deviceIp ?? '—';
      map.set(row.deviceId, `${name} (${ip})`);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [inventory.rows, site]);

  const filtersActive =
    Boolean(q.trim()) ||
    site !== 'all' ||
    deviceFilter !== 'all' ||
    severityFilter.length > 0 ||
    facilityFilter !== 'all';

  const clearFilters = () => {
    setSearchText('');
    setSite('all');
    patch({ device: null, severity: null, facility: null, q: null });
  };

  const filteredRows = useMemo(() => {
    return inventory.rows.filter((row) => {
      if (site !== 'all' && row.site !== site) return false;
      if (deviceFilter !== 'all' && row.deviceId !== deviceFilter) return false;
      if (severityFilter.length > 0 && !severityFilter.includes(row.severity)) return false;
      if (facilityFilter !== 'all' && row.facility !== facilityFilter) return false;
      if (!q.trim()) return true;
      const needle = q.trim().toLowerCase();
      const hay = [
        row.message,
        row.hostname,
        row.program ?? '',
        row.tag ?? '',
        row.deviceName ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [inventory.rows, site, deviceFilter, severityFilter, facilityFilter, q]);

  const handleCollect = async () => {
    setCollecting(true);
    try {
      const result = await collectLogs({ filename: filenameFilter, force: true });
      if (result.message === 'No managed devices') {
        message.warning('No MANAGED devices');
        return;
      }
      message.success(`Queued log collection for ${result.jobs.length} devices (${filenameFilter})`);
      window.setTimeout(() => void load({ silent: true }), 5000);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Collection failed');
    } finally {
      setCollecting(false);
    }
  };

  const handleClearDevice = async (deviceId: string, name: string) => {
    try {
      const result = await deleteLogsForDevice(deviceId);
      message.success(`Cleared ${result.count} entries from ${name}`);
      void load({ silent: true });
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Clear failed');
    }
  };

  const columns: ColumnsType<DeviceLogRow> = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      width: 180,
      render: (value: string) => (
        <Typography.Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
          {formatTimestamp(value)}
        </Typography.Text>
      ),
    },
    {
      title: 'Severity',
      dataIndex: 'severity',
      width: 110,
      filters: SEVERITY_OPTIONS.map((opt) => ({ text: opt.label, value: opt.value })),
      onFilter: (value, row) => row.severity === value,
      render: (value: LogSeverity) => (
        <Tag color={LOG_SEVERITY_COLOR[value]} style={{ marginRight: 0 }}>
          {LOG_SEVERITY_LABEL[value]}
        </Tag>
      ),
    },
    {
      title: 'Facility',
      dataIndex: 'facility',
      width: 110,
      render: (value: LogFacility) => (
        <Typography.Text type="secondary">{LOG_FACILITY_LABEL[value]}</Typography.Text>
      ),
    },
    {
      title: 'Device',
      width: 220,
      ellipsis: true,
      render: (_value, row) =>
        row.deviceId ? (
          <Link to={`/devices/${row.deviceId}`}>{row.deviceName ?? row.hostname}</Link>
        ) : (
          <span>{row.deviceName ?? row.hostname}</span>
        ),
    },
    {
      title: 'Host',
      dataIndex: 'hostname',
      width: 140,
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text style={{ fontFamily: 'monospace' }}>{value}</Typography.Text>
      ),
    },
    {
      title: 'Program',
      dataIndex: 'program',
      width: 110,
      render: (value: string | null, row) =>
        value ? (
          <Tooltip title={row.pid ? `PID ${row.pid}` : ''}>
            <Tag>{value}</Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Message',
      dataIndex: 'message',
      ellipsis: true,
      render: (value: string, row) => (
        <Tooltip
          placement="topLeft"
          title={
            <div style={{ maxWidth: 480 }}>
              {row.tag ? (
                <div>
                  <Typography.Text type="secondary">tag </Typography.Text>
                  <code>{row.tag}</code>
                </div>
              ) : null}
              <div>{value}</div>
            </div>
          }
        >
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{value}</span>
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      render: (_v, row) =>
        row.deviceId ? (
          <Tooltip title="Clear logs for this device">
            <Button
              size="small"
              type="text"
              icon={<ClearOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                void handleClearDevice(row.deviceId!, row.deviceName ?? row.hostname);
              }}
            />
          </Tooltip>
        ) : null,
    },
  ];

  const tableEmpty = () => {
    if (inventory.managedDevices === 0) {
      return (
        <EmptyState
          title="No managed devices"
          description="Log collection runs automatically on MANAGED devices."
          extra={
            <Link to="/devices">
              <Button>Open Devices</Button>
            </Link>
          }
        />
      );
    }
    if (inventory.devicesWithData === 0) {
      return (
        <EmptyState
          title="No log data yet"
          description="Managed devices are present. Collection runs after sync and on a schedule — wait a moment or collect now."
          extra={
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={collecting}
              onClick={() => void handleCollect()}
            >
              Collect
            </Button>
          }
        />
      );
    }
    if (inventory.rows.length === 0) {
      return (
        <EmptyState
          title="No log entries"
          description="Try widening the time range or removing filters."
        />
      );
    }
    if (filtersActive) {
      return (
        <EmptyState
          title="No results for current filters"
          extra={
            <Button size="small" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      );
    }
    return <EmptyState title="No log entries" />;
  };

  const toggleSeverity = (severity: LogSeverity) => {
    const next = severityFilter.includes(severity)
      ? severityFilter.filter((s) => s !== severity)
      : [...severityFilter, severity];
    patch({ severity: next.length > 0 ? next.join(',') : null });
  };

  const severityCounters = useMemo(() => {
    const counts = new Map<LogSeverity, number>();
    for (const row of inventory.rows) {
      counts.set(row.severity, (counts.get(row.severity) ?? 0) + 1);
    }
    return counts;
  }, [inventory.rows]);

  const chips = [
    q.trim() ? { key: 'q', label: `Search: ${q}` } : null,
    site !== 'all' ? { key: 'site', label: `Site: ${site}` } : null,
    deviceFilter !== 'all'
      ? {
          key: 'device',
          label: `Device: ${deviceOptions.find(([id]) => id === deviceFilter)?.[1] ?? deviceFilter}`,
        }
      : null,
    filenameFilter !== DEFAULT_LOG_FILENAME
      ? {
          key: 'filename',
          label: `File: ${FILENAME_OPTIONS.find((f) => f.value === filenameFilter)?.label ?? filenameFilter}`,
        }
      : null,
    severityFilter.length > 0
      ? { key: 'severity', label: `Severity: ${severityFilter.map((s) => LOG_SEVERITY_LABEL[s]).join(', ')}` }
      : null,
    facilityFilter !== 'all' ? { key: 'facility', label: `Facility: ${LOG_FACILITY_LABEL[facilityFilter]}` } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  if (loading && !hasLoaded) return <PageSkeleton />;
  if (error && !hasLoaded) {
    return <ErrorState title="Could not load logs" error={error} onRetry={() => void load()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={hasLoaded ? error : null} onRetry={() => void load({ silent: true })} />
      <Typography.Paragraph className="nc-metric-strip">
        Managed {inventory.managedDevices} · Devices with data {inventory.devicesWithData} · Rows loaded{' '}
        {inventory.rows.length} · Filtered {filteredRows.length}
      </Typography.Paragraph>
      <DataTableShell
        title="Device logs"
        count={filteredRows.length}
        freshness={<TableFreshness refreshing={refreshing} lastUpdatedAt={inventory.lastUpdatedAt} />}
        chips={<ActiveFilterChips chips={chips} onClear={clearFilters} />}
        toolbar={
          <DataTableToolbar
            leading={
              <>
                <Select
                  size="small"
                  value={site}
                  style={{ width: 120 }}
                  onChange={setSite}
                  options={SITE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                />
                <Select
                  size="small"
                  showSearch
                  optionFilterProp="label"
                  value={deviceFilter}
                  style={{ minWidth: 220 }}
                  onChange={(value) => patch({ device: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All devices' }, ...deviceOptions.map(([id, label]) => ({ value: id, label }))]}
                />
                <Select
                  size="small"
                  value={facilityFilter}
                  style={{ width: 140 }}
                  onChange={(value) => patch({ facility: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All facilities' }, ...FACILITY_OPTIONS]}
                />
                <Select
                  size="small"
                  value={filenameFilter}
                  style={{ minWidth: 200 }}
                  onChange={(value) => patch({ filename: value })}
                  options={FILENAME_OPTIONS}
                  placeholder="Select log file"
                />
                <Button
                  size="small"
                  icon={<FilterOutlined />}
                  onClick={() => setSeverityDrawerOpen(true)}
                >
                  Severity {severityFilter.length > 0 ? `(${severityFilter.length})` : ''}
                </Button>
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined />}
                  placeholder="Message, host, program, tag"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  style={{ width: 240 }}
                />
                {filtersActive ? (
                  <Button size="small" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </>
            }
            trailing={
              <Space size={8}>
                <Button
                  size="small"
                  icon={<AlertOutlined />}
                  onClick={() => navigate('/logs/alerts')}
                >
                  Alerts
                </Button>
                <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                  Reload
                </Button>
                <Button
                  type="primary"
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={collecting}
                  onClick={() => void handleCollect()}
                >
                  Collect
                </Button>
              </Space>
            }
          />
        }
      >
        <Table
          rowKey={(row) => `${row.jobId ?? 'adhoc'}-${row.id}`}
          size="small"
          loading={refreshing}
          dataSource={filteredRows}
          columns={columns}
          locale={{ emptyText: tableEmpty() }}
          pagination={tablePagination}
          scroll={tableScroll}
          sticky
        />
      </DataTableShell>

      <Drawer
        title="Filter by severity"
        placement="right"
        open={severityDrawerOpen}
        onClose={() => setSeverityDrawerOpen(false)}
        width={320}
        extra={
          <Button
            size="small"
            type="link"
            onClick={() => patch({ severity: null })}
            disabled={severityFilter.length === 0}
          >
            Reset
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {LOG_SEVERITY_ORDER.map((severity) => {
            const count = severityCounters.get(severity) ?? 0;
            const checked = severityFilter.includes(severity);
            return (
              <div
                key={severity}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 4px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: checked ? 'rgba(22, 119, 255, 0.08)' : undefined,
                }}
                onClick={() => toggleSeverity(severity)}
              >
                <Space>
                  <Checkbox
                    checked={checked}
                    onChange={() => toggleSeverity(severity)}
                    onClick={(event) => event.stopPropagation()}
                  />
                  <Tag color={LOG_SEVERITY_COLOR[severity]} style={{ marginRight: 0 }}>
                    {LOG_SEVERITY_LABEL[severity]}
                  </Tag>
                </Space>
                <Typography.Text type="secondary">{count}</Typography.Text>
              </div>
            );
          })}
        </Space>
      </Drawer>
    </div>
  );
}