import { useMemo, useState } from 'react';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Drawer, Input, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { ActiveFilterChips } from '@/components/data-table/ActiveFilterChips';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { DataTableToolbar } from '@/components/data-table/DataTableToolbar';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { DeviceIdentity } from '@/components/display/DeviceIdentity';
import { MonoValue } from '@/components/display/MonoValue';
import { Timestamp } from '@/components/display/Timestamp';
import { JOB_STATUS_META } from '@/design/status';
import { useJobs } from '@/hooks/useJobs';
import { useUrlSearch, useUrlState } from '@/hooks/useUrlState';
import { prettyJson, redactForDisplay, summarizeJson } from '@/lib/format';
import { tablePagination, tableScroll } from '@/lib/table';
import { JOB_TYPE_LABELS, type Job, type JobStatus, type JobType } from '@/types/job';

const STATUSES = Object.keys(JOB_STATUS_META) as JobStatus[];
const TYPES = Object.keys(JOB_TYPE_LABELS) as JobType[];

function parseStatus(value?: string): JobStatus | 'all' {
  return STATUSES.includes(value as JobStatus) ? (value as JobStatus) : 'all';
}

function parseType(value?: string): JobType | 'all' {
  return TYPES.includes(value as JobType) ? (value as JobType) : 'all';
}

export default function JobsPage() {
  const { jobs, stats, isLoading, isRefreshing, error, lastUpdatedAt, refresh } = useJobs();
  const { get, patch } = useUrlState();
  const { value: searchText, setValue: setSearchText, committed: q } = useUrlSearch('q');
  const statusFilter = parseStatus(get('status'));
  const typeFilter = parseType(get('type'));
  const deviceFilter = get('device') || 'all';
  const [openJob, setOpenJob] = useState<Job | null>(null);

  const deviceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of jobs) {
      if (!job.deviceId) continue;
      map.set(job.deviceId, job.device?.name ? `${job.device.name} (${job.device.ip})` : job.deviceId);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [jobs]);

  const filtersActive =
    Boolean(q.trim()) || statusFilter !== 'all' || typeFilter !== 'all' || deviceFilter !== 'all';

  const clearFilters = () => {
    setSearchText('');
    patch({ status: null, type: null, device: null, q: null });
  };

  const filtered = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    return jobs.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;
      if (typeFilter !== 'all' && job.type !== typeFilter) return false;
      if (deviceFilter !== 'all' && job.deviceId !== deviceFilter) return false;
      if (!keyword) return true;
      const hay = [job.id, job.type, job.device?.name, job.device?.ip, job.error, job.deviceId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(keyword);
    });
  }, [jobs, statusFilter, typeFilter, deviceFilter, q]);

  const columns: ColumnsType<Job> = [
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (status: JobStatus) => <StatusDot jobStatus={status} />,
    },
    {
      title: 'Job type',
      dataIndex: 'type',
      width: 170,
      render: (type: JobType) => JOB_TYPE_LABELS[type] ?? type,
    },
    {
      title: 'Device',
      ellipsis: true,
      render: (_value, record) =>
        record.device ? (
          <DeviceIdentity device={{ ...record.device, floor: '', model: record.device.model ?? '', vendor: record.device.vendor ?? '' }} compact />
        ) : (
          record.deviceId || '—'
        ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      width: 120,
      render: (value: string) => <Timestamp value={value} />,
    },
    {
      title: 'Updated',
      dataIndex: 'updatedAt',
      width: 120,
      render: (value: string) => <Timestamp value={value} />,
    },
    {
      title: 'Error / result',
      ellipsis: true,
      render: (_value, record) => record.error || summarizeJson(record.result),
    },
    {
      title: '',
      width: 80,
      align: 'right',
      render: (_value, record) => (
        <Button type="link" size="small" onClick={() => setOpenJob(record)}>
          Details
        </Button>
      ),
    },
  ];

  const chips = [
    q.trim() ? { key: 'q', label: `Search: ${q}` } : null,
    statusFilter !== 'all' ? { key: 'status', label: `Status: ${statusFilter}` } : null,
    typeFilter !== 'all' ? { key: 'type', label: `Type: ${JOB_TYPE_LABELS[typeFilter] ?? typeFilter}` } : null,
    deviceFilter !== 'all' ? { key: 'device', label: `Device: ${deviceOptions.find(([id]) => id === deviceFilter)?.[1] ?? deviceFilter}` } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  if (isLoading && jobs.length === 0) return <PageSkeleton />;
  if (error && jobs.length === 0) {
    return <ErrorState title="Could not load jobs" error={error} onRetry={() => void refresh()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={jobs.length ? error : null} onRetry={() => void refresh({ silent: true })} />
      <Typography.Paragraph className="nc-metric-strip">
        Loaded {stats.total} (last 100) · Pending {stats.pending} · Running {stats.running} · Failed {stats.failed} · Succeeded{' '}
        {stats.success}
      </Typography.Paragraph>
      <DataTableShell
        title="Recent jobs"
        count={filtered.length}
        countLabel="shown"
        freshness={<TableFreshness refreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />}
        chips={<ActiveFilterChips chips={chips} onClear={clearFilters} />}
        toolbar={
          <DataTableToolbar
            leading={
              <>
                <Select
                  size="small"
                  value={statusFilter}
                  style={{ width: 140 }}
                  onChange={(value) => patch({ status: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All statuses' }, ...STATUSES.map((item) => ({ value: item, label: JOB_STATUS_META[item].label }))]}
                />
                <Select
                  size="small"
                  value={typeFilter}
                  style={{ width: 180 }}
                  onChange={(value) => patch({ type: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All types' }, ...TYPES.map((item) => ({ value: item, label: JOB_TYPE_LABELS[item] }))]}
                />
                <Select
                  size="small"
                  showSearch
                  optionFilterProp="label"
                  value={deviceFilter}
                  style={{ minWidth: 200 }}
                  onChange={(value) => patch({ device: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All devices' }, ...deviceOptions.map(([id, label]) => ({ value: id, label }))]}
                />
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined />}
                  placeholder="Device, IP, job ID"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  style={{ width: 220 }}
                />
                {filtersActive ? (
                  <Button size="small" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </>
            }
            trailing={
              <Button icon={<ReloadOutlined />} loading={isRefreshing} onClick={() => void refresh()}>
                Reload
              </Button>
            }
          />
        }
      >
        {jobs.length === 0 ? (
          <EmptyState title="No recent jobs" description="The loaded window (max 100) is empty." />
        ) : (
          <Table
            rowKey="id"
            size="small"
            loading={isRefreshing}
            dataSource={filtered}
            columns={columns}
            pagination={tablePagination}
            scroll={tableScroll}
            sticky
            locale={{
              emptyText: filtersActive ? (
                <EmptyState
                  title="No results for current filters"
                  extra={
                    <Button size="small" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState title="No jobs" />
              ),
            }}
          />
        )}
      </DataTableShell>
      <Drawer
        title={openJob ? JOB_TYPE_LABELS[openJob.type] ?? openJob.type : 'Job'}
        open={Boolean(openJob)}
        onClose={() => setOpenJob(null)}
        width={520}
      >
        {openJob ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">Job ID</Typography.Text>
              <div>
                <MonoValue value={openJob.id} copyable />
              </div>
            </div>
            <StatusDot jobStatus={openJob.status} />
            <div>
              Pending → Running → {openJob.status === 'FAILED' ? 'Failed' : 'Success'}
            </div>
            <Typography.Text type="secondary">
              Created <Timestamp value={openJob.createdAt} mode="absolute" /> · Updated{' '}
              <Timestamp value={openJob.updatedAt} mode="absolute" />
            </Typography.Text>
            {openJob.device ? <DeviceIdentity device={{ ...openJob.device, floor: '', model: openJob.device.model ?? '', vendor: openJob.device.vendor ?? '' }} /> : null}
            {openJob.error ? (
              <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {openJob.error}
              </Typography.Paragraph>
            ) : null}
            <div>
              <Typography.Text type="secondary">Payload</Typography.Text>
              <pre className="nc-code-block">{prettyJson(redactForDisplay(openJob.payload))}</pre>
            </div>
            <div>
              <Typography.Text type="secondary">Result</Typography.Text>
              <pre className="nc-code-block">{prettyJson(redactForDisplay(openJob.result))}</pre>
            </div>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
