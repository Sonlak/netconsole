import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Segmented, Select, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { collectArpAddresses, fetchArpAddressInventory } from '@/api/arpAddresses';
import { collectMacAddresses, fetchMacAddressInventory } from '@/api/macAddresses';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { ActiveFilterChips } from '@/components/data-table/ActiveFilterChips';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { DataTableToolbar } from '@/components/data-table/DataTableToolbar';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { IpAddress, MacAddress, MonoValue } from '@/components/display/MonoValue';
import { SITE_OPTIONS } from '@/components/site-provider';
import { parseFloorNumber } from '@/data/bank';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { useUrlSearch } from '@/hooks/useUrlState';
import { matchesMacOrIp } from '@/lib/format';
import { tablePagination, tableScroll } from '@/lib/table';
import type { ArpAddressRow } from '@/types/arpAddress';
import type { MacAddressRow } from '@/types/macAddress';

const AUTO_REFRESH_MS = 10000;

function rowFloorMatches(floor: string, filter: string) {
  if (!filter || filter === 'all') return true;
  if (floor === filter) return true;
  const left = parseFloorNumber(floor);
  const right = parseFloorNumber(filter);
  return left != null && left === right;
}

type Kind = 'mac' | 'arp';

type Inventory = {
  rows: Array<MacAddressRow | ArpAddressRow>;
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
};

export function NetworkTablesPage({ kind }: { kind: Kind }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { site, setSite, get, patch } = useSiteFilter();
  const { value: searchText, setValue: setSearchText, committed: q } = useUrlSearch('q');
  const floorFilter = get('floor') || 'all';
  const deviceFilter = get('device') || 'all';
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [inventory, setInventory] = useState<Inventory>({
    rows: [],
    managedDevices: 0,
    devicesWithData: 0,
    lastUpdatedAt: null,
  });

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      else setRefreshing(true);
      try {
        const next = kind === 'mac' ? await fetchMacAddressInventory() : await fetchArpAddressInventory();
        setInventory({
          rows: Array.isArray(next?.rows) ? next.rows : [],
          managedDevices: Number(next?.managedDevices) || 0,
          devicesWithData: Number(next?.devicesWithData) || 0,
          lastUpdatedAt: next?.lastUpdatedAt ?? null,
        });
        setError(null);
        setHasLoaded(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(`Could not load ${kind.toUpperCase()}`));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    setHasLoaded(false);
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load({ silent: true }), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const floorOptions = useMemo(() => {
    const floors = Array.from(
      new Set(
        inventory.rows
          .filter((row) => site === 'all' || row.site === site)
          .map((row) => row.floor)
          .filter(Boolean),
      ),
    ).sort();
    return floors;
  }, [inventory.rows, site]);

  const deviceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of inventory.rows) {
      if (site !== 'all' && row.site !== site) continue;
      if (floorFilter !== 'all' && !rowFloorMatches(row.floor, floorFilter)) continue;
      map.set(row.deviceId, `${row.deviceName} (${row.deviceIp})`);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [inventory.rows, site, floorFilter]);

  const filtersActive = Boolean(q.trim()) || site !== 'all' || floorFilter !== 'all' || deviceFilter !== 'all';

  const clearFilters = () => {
    setSearchText('');
    setSite('all');
    patch({ floor: null, device: null, q: null });
  };

  const filteredRows = useMemo(() => {
    return inventory.rows.filter((row) => {
      if (site !== 'all' && row.site !== site) return false;
      if (floorFilter !== 'all' && !rowFloorMatches(row.floor, floorFilter)) return false;
      if (deviceFilter !== 'all' && row.deviceId !== deviceFilter) return false;
      if (!q.trim()) return true;
      const hay = [row.mac, 'ip' in row ? row.ip : '', row.deviceName, row.interface, row.deviceIp].join(' ');
      return matchesMacOrIp(hay, q);
    });
  }, [inventory.rows, site, floorFilter, deviceFilter, q]);

  const handleCollect = async () => {
    setCollecting(true);
    try {
      const result = kind === 'mac' ? await collectMacAddresses() : await collectArpAddresses();
      if (result.message === 'No managed devices') {
        message.warning('No MANAGED devices');
        return;
      }
      message.success(`Queued ${kind.toUpperCase()} collection for ${result.jobs.length} devices`);
      window.setTimeout(() => void load({ silent: true }), 5000);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Collection failed');
    } finally {
      setCollecting(false);
    }
  };

  const macColumns: ColumnsType<MacAddressRow> = [
    { title: 'Site', dataIndex: 'site', width: 88 },
    { title: 'Floor', dataIndex: 'floor', width: 80 },
    { title: 'Device', ellipsis: true, render: (_value, row) => <Link to={`/devices/${row.deviceId}`}>{row.deviceName}</Link> },
    { title: 'MAC', dataIndex: 'mac', width: 180, render: (value: string) => <MacAddress value={value} /> },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 150,
      render: (value: string) => (value && value !== 'n/a' ? <IpAddress value={value} /> : 'n/a'),
    },
    { title: 'VLAN', dataIndex: 'vlan', width: 80, render: (value: string) => <MonoValue value={value || '—'} /> },
    { title: 'Interface', dataIndex: 'interface', ellipsis: true, render: (value: string) => <MonoValue value={value} /> },
    { title: 'Flags', dataIndex: 'flags', width: 88, render: (value: string) => <Tag>{value || '—'}</Tag> },
    { title: 'Type', dataIndex: 'type', width: 100, render: (value: string) => <Tag>{value}</Tag> },
  ];

  const arpColumns: ColumnsType<ArpAddressRow> = [
    { title: 'Site', dataIndex: 'site', width: 88 },
    { title: 'Floor', dataIndex: 'floor', width: 80 },
    { title: 'Device', ellipsis: true, render: (_value, row) => <Link to={`/devices/${row.deviceId}`}>{row.deviceName}</Link> },
    { title: 'IP', dataIndex: 'ip', width: 150, render: (value: string) => <IpAddress value={value} /> },
    { title: 'Hostname', dataIndex: 'hostname', ellipsis: true, render: (value: string) => <MonoValue value={value || '—'} /> },
    { title: 'MAC', dataIndex: 'mac', width: 180, render: (value: string) => <MacAddress value={value} /> },
    { title: 'Interface', dataIndex: 'interface', ellipsis: true, render: (value: string) => <MonoValue value={value} /> },
    { title: 'Flags', dataIndex: 'flags', width: 88 },
  ];

  const tableEmpty = () => {
    if (inventory.managedDevices === 0) {
      return (
        <EmptyState
          title="No managed devices"
          description={`${kind.toUpperCase()} collection runs automatically on MANAGED devices.`}
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
          title={`${kind.toUpperCase()} table not collected yet`}
          description="Managed devices are present. Collection runs after sync and on a schedule — wait a moment or collect now."
          extra={
            <Button type="primary" icon={<DownloadOutlined />} loading={collecting} onClick={() => void handleCollect()}>
              Collect
            </Button>
          }
        />
      );
    }
    if (inventory.rows.length === 0) {
      return (
        <EmptyState
          title={`No ${kind.toUpperCase()} entries`}
          description="Collection succeeded but no entries were returned."
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
    return <EmptyState title={`No ${kind.toUpperCase()} entries`} />;
  };

  const switchKind = (next: Kind) => {
    const path = next === 'mac' ? '/mac-addresses' : '/arp-addresses';
    navigate({ pathname: path, search: location.search });
  };

  const chips = [
    q.trim() ? { key: 'q', label: `Search: ${q}` } : null,
    site !== 'all' ? { key: 'site', label: `Site: ${site}` } : null,
    floorFilter !== 'all' ? { key: 'floor', label: `Floor: ${floorFilter}` } : null,
    deviceFilter !== 'all' ? { key: 'device', label: `Device: ${deviceOptions.find(([id]) => id === deviceFilter)?.[1] ?? deviceFilter}` } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  if (loading && !hasLoaded) return <PageSkeleton />;
  if (error && !hasLoaded) {
    return <ErrorState title={`Could not load ${kind.toUpperCase()}`} error={error} onRetry={() => void load()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={hasLoaded ? error : null} onRetry={() => void load({ silent: true })} />
      <Segmented
        style={{ marginBottom: 12 }}
        value={kind}
        onChange={(value) => switchKind(value as Kind)}
        options={[
          { label: 'MAC addresses', value: 'mac' },
          { label: 'ARP neighbors', value: 'arp' },
        ]}
      />
      <Typography.Paragraph className="nc-metric-strip">
        Managed {inventory.managedDevices} · Devices with data {inventory.devicesWithData} · Rows loaded {inventory.rows.length} ·
        Filtered {filteredRows.length}
      </Typography.Paragraph>
      <DataTableShell
        title={kind === 'mac' ? 'MAC addresses' : 'ARP neighbors'}
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
                  value={floorFilter}
                  style={{ width: 120 }}
                  onChange={(value) => patch({ floor: value === 'all' ? null : value, device: null })}
                  options={[{ value: 'all', label: 'All floors' }, ...floorOptions.map((item) => ({ value: item, label: item }))]}
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
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined />}
                  placeholder={kind === 'mac' ? 'MAC, IP, device, interface' : 'IP, MAC, device, interface'}
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
              <>
                <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                  Reload
                </Button>
                <Button type="primary" size="small" icon={<DownloadOutlined />} loading={collecting} onClick={() => void handleCollect()}>
                  Collect
                </Button>
              </>
            }
          />
        }
      >
        {kind === 'mac' ? (
          <Table
            rowKey={(row) => `${row.deviceId}-${row.mac}-${(row as MacAddressRow).vlan}-${row.interface}`}
            size="small"
            loading={refreshing}
            dataSource={filteredRows as MacAddressRow[]}
            columns={macColumns}
            locale={{ emptyText: tableEmpty() }}
            pagination={tablePagination}
            scroll={tableScroll}
            sticky
          />
        ) : (
          <Table
            rowKey={(row) => `${row.deviceId}-${(row as ArpAddressRow).ip}-${row.mac}-${row.interface}`}
            size="small"
            loading={refreshing}
            dataSource={filteredRows as ArpAddressRow[]}
            columns={arpColumns}
            locale={{ emptyText: tableEmpty() }}
            pagination={tablePagination}
            scroll={tableScroll}
            sticky
          />
        )}
      </DataTableShell>
    </div>
  );
}
