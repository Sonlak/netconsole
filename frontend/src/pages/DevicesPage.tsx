import { useNavigate, Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  EyeOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Input, Popconfirm, Select, Space, Table, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { checkManagedAllDevices, pingAllDevices, pingDevice } from '@/api/devices';
import { JobWaitTimeoutError, waitForJob } from '@/api/jobs';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { ActiveFilterChips } from '@/components/data-table/ActiveFilterChips';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { DataTableToolbar } from '@/components/data-table/DataTableToolbar';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { IpAddress, MonoValue } from '@/components/display/MonoValue';
import { Timestamp } from '@/components/display/Timestamp';
import { DEVICE_STATUS_OPTIONS } from '@/design/status';
import { deviceFloor, deviceRole, deviceSite, floorLabel, floorNumbers, floorsMatch, isKnownSite, type DeviceRole } from '@/data/bank';
import { useDevices } from '@/hooks/useDevices';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { useUrlSearch } from '@/hooks/useUrlState';
import { formatPing, formatUptime } from '@/lib/format';
import { tablePagination, tableScroll } from '@/lib/table';
import { DeviceModal } from '@/pages/Devices/DeviceModal';
import type { Device, DeviceInput, DeviceStatus } from '@/types/device';

const ROLES: DeviceRole[] = ['core', 'dist', 'access'];
const STATUSES = DEVICE_STATUS_OPTIONS.map((item) => item.value);

function parseRole(value?: string): DeviceRole | 'all' {
  return ROLES.includes(value as DeviceRole) ? (value as DeviceRole) : 'all';
}

function parseStatus(value?: string): DeviceStatus | 'all' {
  return STATUSES.includes(value as DeviceStatus) ? (value as DeviceStatus) : 'all';
}

export default function DevicesPage() {
  const navigate = useNavigate();
  const { site, setSite, get, patch } = useSiteFilter();
  const { value: searchText, setValue: setSearchText, committed: q } = useUrlSearch('q');
  const floorFilter = get('floor') || 'all';
  const roleFilter = parseRole(get('role'));
  const statusFilter = parseStatus(get('status'));
  const { devices, setDevices, isLoading, isRefreshing, error, lastUpdatedAt, refetch, addDevice, saveDevice, removeDevice } =
    useDevices();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [pingingAll, setPingingAll] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const siteOptions = useMemo(
    () => [...new Set(['LAB', 'NKKN', 'NTMK', ...devices.map((device) => deviceSite(device))])],
    [devices],
  );

  const floorOptions = useMemo(() => {
    const fromDevices = [...new Set(devices.map((device) => deviceFloor(device)).filter(Boolean))];
    if (isKnownSite(site)) {
      return [...new Set(['CORE', 'DIST', ...floorNumbers(site).map((n) => floorLabel(n)), ...fromDevices])];
    }
    return fromDevices.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [devices, site]);

  const filtersActive =
    Boolean(q.trim()) || site !== 'all' || floorFilter !== 'all' || roleFilter !== 'all' || statusFilter !== 'all';

  const clearFilters = () => {
    setSearchText('');
    setSite('all');
    patch({ floor: null, role: null, status: null, q: null });
  };

  const filtered = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    return devices.filter((device) => {
      const matchesSite = site === 'all' || deviceSite(device) === site;
      const matchesFloor = floorsMatch(device, floorFilter);
      const matchesRole = roleFilter === 'all' || deviceRole(device) === roleFilter;
      const matchesStatus = statusFilter === 'all' || device.status === statusFilter;
      const matchesKeyword =
        !keyword ||
        [deviceSite(device), deviceFloor(device), device.name, device.ip, device.vendor, device.model, device.serial, device.description ?? '']
          .join(' ')
          .toLowerCase()
          .includes(keyword);
      return matchesSite && matchesFloor && matchesRole && matchesStatus && matchesKeyword;
    });
  }, [devices, q, site, floorFilter, roleFilter, statusFilter]);

  const stats = useMemo(() => {
    const scoped = devices.filter((device) => site === 'all' || deviceSite(device) === site);
    return {
      total: scoped.length,
      managed: scoped.filter((device) => device.status === 'MANAGED').length,
      online: scoped.filter((device) => device.status === 'ONLINE').length,
      offline: scoped.filter((device) => device.status === 'OFFLINE').length,
      maintenance: scoped.filter((device) => device.status === 'MAINTENANCE').length,
    };
  }, [devices, site]);

  const handleSubmit = async (values: DeviceInput) => {
    setSaving(true);
    try {
      if (editing) {
        await saveDevice(editing.id, values);
        message.success('Device updated');
      } else {
        await addDevice(values);
        message.success('Device added');
      }
      setModalOpen(false);
      setEditing(null);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Could not save device');
    } finally {
      setSaving(false);
    }
  };

  const handlePing = async (id: string) => {
    setPingingId(id);
    try {
      const updated = await pingDevice(id);
      setDevices((current) => current.map((device) => (device.id === id ? updated : device)));
      message.success(`Ping ${updated.ip}: ${updated.status}`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Ping failed');
    } finally {
      setPingingId(null);
    }
  };

  const handlePingAll = async () => {
    setPingingAll(true);
    try {
      const summary = await pingAllDevices();
      await refetch({ silent: true });
      message.success(`Pinged ${summary.checked} devices · ${summary.online} online · ${summary.offline} offline`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Ping all failed');
    } finally {
      setPingingAll(false);
    }
  };

  const handleManagedCheckAll = async () => {
    setCheckingAll(true);
    try {
      const summary = await checkManagedAllDevices();
      const jobIds = summary.results.map((item) => item.jobId).filter((id): id is string => Boolean(id));
      if (summary.offline && !jobIds.length) {
        await refetch({ silent: true });
        message.warning(`Managed check: ${summary.offline}/${summary.checked} offline (ping failed)`);
        return;
      }
      message.loading({
        content: `Checking ${jobIds.length} devices…`,
        key: 'managed-check-all',
        duration: 0,
      });
      await Promise.all(
        jobIds.map((id) =>
          waitForJob(id, { timeoutMs: 90000 }).catch((cause) => {
            if (!(cause instanceof JobWaitTimeoutError)) throw cause;
            return null;
          }),
        ),
      );
      await refetch({ silent: true });
      message.success({
        content: `Managed check done · queued ${summary.queued} · offline ${summary.offline}`,
        key: 'managed-check-all',
      });
    } catch (cause) {
      message.error({
        content: cause instanceof Error ? cause.message : 'Managed check all failed',
        key: 'managed-check-all',
      });
    } finally {
      setCheckingAll(false);
    }
  };

  const columns: ColumnsType<Device> = [
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (status: DeviceStatus) => <StatusDot status={status} />,
    },
    {
      title: 'Device',
      width: 160,
      ellipsis: true,
      render: (_value, record) => (
        <Link to={`/devices/${record.id}`}>
          <Typography.Text strong>{record.name}</Typography.Text>
        </Link>
      ),
    },
    {
      title: 'Site',
      width: 90,
      render: (_value, record) => deviceSite(record),
    },
    {
      title: 'Floor',
      width: 90,
      render: (_value, record) => deviceFloor(record),
    },
    {
      title: 'Role',
      width: 90,
      render: (_value, record) => <span className="nc-role-chip">{deviceRole(record)}</span>,
    },
    {
      title: 'Management IP',
      dataIndex: 'ip',
      width: 140,
      render: (value: string) => <IpAddress value={value} />,
    },
    {
      title: 'Vendor / model',
      width: 160,
      ellipsis: true,
      render: (_value, record) => (
        <span className="nc-cell-meta">
          {record.vendor || '—'}
          {record.model ? ` · ${record.model}` : ''}
        </span>
      ),
    },
    {
      title: 'Serial',
      width: 150,
      ellipsis: true,
      render: (_value, record) => {
        const serial = record.serial?.trim() || '';
        if (!serial || serial.startsWith('DISC-')) return '—';
        return <MonoValue value={serial} copyable />;
      },
    },
    {
      title: 'Uptime',
      width: 110,
      render: (_value, record) => {
        void nowTick;
        return formatUptime(record.uptimeSeconds, record.uptimeAt);
      },
    },
    {
      title: 'Last ping',
      width: 140,
      render: (_value, record) => (
        <Tooltip title={formatPing(record.lastPingAt, record.lastPingMs)}>
          <span>
            <Timestamp value={record.lastPingAt} />
            {record.lastPingMs != null ? <span className="nc-cell-meta"> · {record.lastPingMs}ms</span> : null}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '',
      width: 120,
      align: 'right',
      render: (_value, record) => (
        <Space size={0} onClick={(event) => event.stopPropagation()}>
          <Tooltip title="Open">
            <Button
              type="text"
              size="small"
              aria-label={`Open ${record.name}`}
              icon={<EyeOutlined />}
              onClick={() => navigate(`/devices/${record.id}`)}
            />
          </Tooltip>
          <Tooltip title="Ping">
            <Button
              type="text"
              size="small"
              aria-label={`Ping ${record.name}`}
              icon={<SendOutlined />}
              loading={pingingId === record.id}
              onClick={() => void handlePing(record.id)}
            />
          </Tooltip>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'edit',
                  icon: <EditOutlined />,
                  label: 'Edit',
                  onClick: () => {
                    setEditing(record);
                    setModalOpen(true);
                  },
                },
              ],
            }}
            dropdownRender={(menu) => (
              <div>
                {menu}
                <div style={{ padding: '4px 12px 8px' }}>
                  <Popconfirm
                    title={`Delete ${record.name}?`}
                    onConfirm={() =>
                      void removeDevice(record.id)
                        .then(() => message.success('Device deleted'))
                        .catch((cause) => message.error(cause instanceof Error ? cause.message : 'Delete failed'))
                    }
                  >
                    <Button type="text" danger size="small" icon={<DeleteOutlined />} block>
                      Delete
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            )}
          >
            <Button type="text" size="small" aria-label={`More actions ${record.name}`} icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const emptyActions = (
    <Space>
      <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
        Add device
      </Button>
      <Button icon={<RadarChartOutlined />} onClick={() => navigate('/discovery')}>
        Run Discovery
      </Button>
    </Space>
  );

  const chips = [
    q.trim() ? { key: 'q', label: `Search: ${q}` } : null,
    site !== 'all' ? { key: 'site', label: `Site: ${site}` } : null,
    floorFilter !== 'all' ? { key: 'floor', label: `Floor: ${floorFilter}` } : null,
    roleFilter !== 'all' ? { key: 'role', label: `Role: ${roleFilter} (inferred)` } : null,
    statusFilter !== 'all' ? { key: 'status', label: `Status: ${statusFilter}` } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  if (isLoading && devices.length === 0) {
    return <PageSkeleton />;
  }

  if (error && devices.length === 0) {
    return <ErrorState title="Could not load devices" error={error} onRetry={() => void refetch()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={devices.length ? error : null} onRetry={() => void refetch({ silent: true })} />

      {devices.length > 0 ? (
        <Typography.Paragraph className="nc-metric-strip">
          Total {stats.total} · Managed {stats.managed} · Online {stats.online} · Offline {stats.offline} · Maintenance{' '}
          {stats.maintenance}
        </Typography.Paragraph>
      ) : null}

      <DataTableShell
        title="Devices"
        count={filtered.length}
        countLabel="shown"
        freshness={<TableFreshness refreshing={isRefreshing} lastUpdatedAt={lastUpdatedAt} />}
        chips={<ActiveFilterChips chips={chips} onClear={clearFilters} />}
        toolbar={
          <DataTableToolbar
            leading={
              <>
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined />}
                  placeholder="Search name, IP, serial…"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  style={{ width: 240 }}
                />
                <Select
                  size="small"
                  value={site}
                  style={{ width: 110 }}
                  onChange={setSite}
                  options={[{ value: 'all', label: 'All sites' }, ...siteOptions.map((item) => ({ value: item, label: item }))]}
                />
                <Select
                  size="small"
                  value={floorFilter}
                  style={{ width: 110 }}
                  onChange={(value) => patch({ floor: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All floors' }, ...floorOptions.map((item) => ({ value: item, label: item }))]}
                />
                <Select
                  size="small"
                  value={roleFilter}
                  style={{ width: 130 }}
                  onChange={(value) => patch({ role: value === 'all' ? null : value })}
                  options={[
                    { value: 'all', label: 'All roles' },
                    { value: 'core', label: 'Core (inferred)' },
                    { value: 'dist', label: 'Dist (inferred)' },
                    { value: 'access', label: 'Access (inferred)' },
                  ]}
                />
                <Select
                  size="small"
                  value={statusFilter}
                  style={{ width: 130 }}
                  onChange={(value) => patch({ status: value === 'all' ? null : value })}
                  options={[{ value: 'all', label: 'All statuses' }, ...DEVICE_STATUS_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
                />
                {filtersActive ? (
                  <Button size="small" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </>
            }
            trailing={
              <>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>
                  Reload
                </Button>
                <Button size="small" icon={<RadarChartOutlined />} loading={pingingAll} onClick={() => void handlePingAll()}>
                  Ping all
                </Button>
                <Button
                  size="small"
                  icon={<SafetyCertificateOutlined />}
                  loading={checkingAll}
                  onClick={() => void handleManagedCheckAll()}
                >
                  Managed check all
                </Button>
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openAdd}>
                  Add device
                </Button>
              </>
            }
          />
        }
      >
        {devices.length === 0 ? (
          <EmptyState title="No devices in inventory" description="Add a device or run Discovery against a mgmt range." extra={emptyActions} />
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
                    <Button onClick={clearFilters} size="small">
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState title="No devices" extra={emptyActions} />
              ),
            }}
            onRow={(record) => ({
              onDoubleClick: () => navigate(`/devices/${record.id}`),
            })}
          />
        )}
      </DataTableShell>

      <DeviceModal
        open={modalOpen}
        saving={saving}
        device={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
