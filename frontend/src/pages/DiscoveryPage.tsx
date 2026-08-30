import { useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileTextOutlined, RadarChartOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Card, Input, Progress, Segmented, Select, Space, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { fetchDiscoveryScan, fetchDiscoveryScans, startDiscoveryScan, syncDiscoveryResults } from '@/api/discovery';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { IpAddress, MonoValue } from '@/components/display/MonoValue';
import { Timestamp } from '@/components/display/Timestamp';
import { discoveryResultMeta, discoveryScanMeta } from '@/design/status';
import { SITES, floorLabel, floorNumbers, floorVlan, isKnownSite, mgmtCidr, type SiteCode } from '@/data/bank';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { toError } from '@/lib/errors';
import { tablePagination, tableScroll } from '@/lib/table';
import type { DiscoveryResult, DiscoveryScan } from '@/types/discovery';

export default function DiscoveryPage() {
  const navigate = useNavigate();
  const { site, setSite, get, patch } = useSiteFilter({ floorKey: 'floor' });
  const formSite: SiteCode = site !== 'all' && isKnownSite(site) ? site : 'LAB';
  const urlScan = get('scan');
  const urlFloor = get('floor');
  const [scope, setScope] = useState(urlFloor === 'CORE' ? 'core' : urlFloor === 'DIST' ? 'dist' : urlFloor?.replace(/^F0?/, '') || '1');
  const [subnet, setSubnet] = useState(() => mgmtCidr(formSite, 1));
  const [scans, setScans] = useState<DiscoveryScan[]>([]);
  const [activeScan, setActiveScan] = useState<DiscoveryScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [historyError, setHistoryError] = useState<Error | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [resultView, setResultView] = useState<'actionable' | 'all'>('actionable');

  const scopeValue: 'core' | 'dist' | number = scope === 'core' || scope === 'dist' ? scope : Number(scope) || 1;
  const floorTag = scopeValue === 'core' ? 'CORE' : scopeValue === 'dist' ? 'DIST' : floorLabel(scopeValue);

  useEffect(() => {
    setSubnet(mgmtCidr(formSite, scopeValue));
  }, [formSite, scopeValue]);

  const loadScans = useCallback(async () => {
    try {
      const data = await fetchDiscoveryScans();
      const scans = Array.isArray(data) ? data : [];
      setScans(scans);
      setHistoryError(null);
      setHasLoaded(true);
      return scans;
    } catch (cause) {
      setHistoryError(toError(cause, 'Could not load scan history'));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchScan = useCallback(async (scanId: string) => {
    try {
      const scan = await fetchDiscoveryScan(scanId);
      setActiveScan(scan);
      return scan;
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Could not load scan');
      return null;
    }
  }, []);

  const openScan = async (scanId: string) => {
    const scan = await fetchScan(scanId);
    if (scan) patch({ scan: scan.id, site: scan.site || null, floor: scan.floor || null });
  };

  useEffect(() => {
    void loadScans();
  }, [loadScans]);

  useEffect(() => {
    if (urlScan) void fetchScan(urlScan);
  }, [urlScan, fetchScan]);

  useEffect(() => {
    if (!activeScan || activeScan.status !== 'RUNNING') return;
    const timer = window.setInterval(() => void fetchScan(activeScan.id), 2000);
    return () => window.clearInterval(timer);
  }, [activeScan, fetchScan]);

  const allResults = activeScan?.results ?? [];
  const visibleResults = useMemo(() => {
    if (resultView === 'all') return allResults;
    return allResults.filter((item) => item.status !== 'PING_FAIL' && item.status !== 'PENDING');
  }, [allResults, resultView]);

  const breakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of allResults) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }, [allResults]);

  const handleStart = async () => {
    if (!subnet.trim()) {
      message.warning('Enter a subnet');
      return;
    }
    setStarting(true);
    try {
      const scan = await startDiscoveryScan({
        subnet: subnet.trim(),
        site: formSite,
        floor: floorTag,
      });
      setActiveScan(scan);
      setSelectedRowKeys([]);
      patch({ scan: scan.id, site: formSite, floor: floorTag });
      await loadScans();
      message.success(`Started scan ${formSite} ${floorTag} · ${scan.subnet}`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Could not start discovery');
    } finally {
      setStarting(false);
    }
  };

  const handleSync = async () => {
    if (!activeScan) return;
    if (selectedRowKeys.length === 0) {
      message.warning('Select devices to sync');
      return;
    }
    setSyncing(true);
    try {
      const summary = await syncDiscoveryResults(activeScan.id, selectedRowKeys, { site: formSite, floor: floorTag });
      message.success(`Synced ${summary.synced} devices`);
      await fetchScan(activeScan.id);
      setSelectedRowKeys([]);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const progressPercent = activeScan ? Math.round((activeScan.scanned / Math.max(activeScan.totalHosts, 1)) * 100) : 0;
  const discoveredReady = allResults.filter((item) => item.status === 'DISCOVERED').length;

  const columns: ColumnsType<DiscoveryResult> = [
    { title: 'IP', dataIndex: 'ip', width: 150, render: (value: string) => <IpAddress value={value} /> },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 160,
      render: (status: DiscoveryResult['status']) => <StatusDot meta={discoveryResultMeta(status)} />,
    },
    { title: 'Ping', width: 80, render: (_value, record) => (record.pingOk ? `${record.pingMs ?? 0}ms` : 'Fail') },
    {
      title: 'REST',
      width: 80,
      render: (_value, record) => (record.sshOk ? 'OK' : record.pingOk ? 'Fail' : '—'),
    },
    { title: 'Hostname', dataIndex: 'name', ellipsis: true, render: (value?: string | null) => value || '—' },
    { title: 'Vendor', dataIndex: 'vendor', width: 110, ellipsis: true, render: (value?: string | null) => value || '—' },
    { title: 'Model', dataIndex: 'model', width: 130, ellipsis: true, render: (value?: string | null) => value || '—' },
    { title: 'Serial', dataIndex: 'serial', width: 140, ellipsis: true, render: (value?: string | null) => value || '—' },
    { title: 'Notes', dataIndex: 'description', ellipsis: true, render: (value: string | null, record) => value || record.error || '—' },
  ];

  if (loading && !hasLoaded) return <PageSkeleton />;
  if (historyError && !hasLoaded) {
    return <ErrorState title="Could not load scan history" error={historyError} onRetry={() => void loadScans()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={hasLoaded ? historyError : null} onRetry={() => void loadScans()} />

      <Card bordered={false} title="Scan setup" extra={`VLAN ${formSite} F01 = ${floorVlan(formSite, 1)}`}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            value={formSite}
            style={{ width: 160 }}
            onChange={(value) => {
              setSite(value);
              setScope('1');
            }}
            options={SITES.map((item) => ({ value: item.code, label: `${item.code} (${item.floors} floors)` }))}
          />
          <Select
            value={scope}
            style={{ width: 220 }}
            onChange={(value) => {
              setScope(value);
              const nextFloor = value === 'core' ? 'CORE' : value === 'dist' ? 'DIST' : floorLabel(Number(value) || 1);
              patch({ floor: nextFloor });
            }}
            options={[
              { value: 'core', label: 'Core' },
              { value: 'dist', label: 'Distribution' },
              ...floorNumbers(formSite).map((n) => ({
                value: String(n),
                label: `${floorLabel(n)} · VLAN ${floorVlan(formSite, n)}`,
              })),
            ]}
          />
          <Input value={subnet} onChange={(event) => setSubnet(event.target.value)} style={{ width: 220 }} />
          <Button type="primary" icon={<RadarChartOutlined />} loading={starting} onClick={() => void handleStart()}>
            Start Discovery
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void loadScans()}>
            Reload history
          </Button>
        </Space>
        {activeScan ? (
          <div>
            <Space wrap style={{ marginBottom: 8 }}>
              <span className="nc-mono">{activeScan.subnet}</span>
              <StatusDot meta={discoveryScanMeta(activeScan.status)} />
              <Typography.Text type="secondary">
                {activeScan.scanned}/{activeScan.totalHosts} scanned · {activeScan.reachable} ping OK · {activeScan.discovered} discovered
              </Typography.Text>
            </Space>
            <Progress percent={progressPercent} />
          </div>
        ) : (
          <EmptyState
            title="No active scan"
            description="Pick a site and floor (or Core / Dist), confirm the mgmt CIDR, then start a scan."
          />
        )}
      </Card>

      {activeScan ? (
        <div style={{ marginTop: 16 }}>
          <DataTableShell
            title="Results"
            count={visibleResults.length}
            countLabel={resultView === 'all' ? 'shown' : 'actionable'}
            freshness={<TableFreshness />}
            extra={
              <Space wrap>
                <Segmented
                  size="small"
                  value={resultView}
                  onChange={(value) => setResultView(value as 'actionable' | 'all')}
                  options={[
                    { label: `Actionable (${discoveredReady})`, value: 'actionable' },
                    { label: `All (${allResults.length})`, value: 'all' },
                  ]}
                />
                <Button
                  type="primary"
                  icon={<UploadOutlined />}
                  disabled={selectedRowKeys.length === 0}
                  loading={syncing}
                  onClick={() => void handleSync()}
                >
                  Sync selected ({selectedRowKeys.length})
                </Button>
                <Button icon={<FileTextOutlined />} onClick={() => navigate('/generate-config')}>
                  Config Studio
                </Button>
              </Space>
            }
            chips={
              <Typography.Text type="secondary">
                Pending {breakdown.PENDING ?? 0} · Ping fail {breakdown.PING_FAIL ?? 0} · Discovered {breakdown.DISCOVERED ?? 0} ·
                Synced {breakdown.SYNCED ?? 0} · Failed {breakdown.FAILED ?? 0}
              </Typography.Text>
            }
          >
            {visibleResults.length === 0 ? (
              <EmptyState
                title={resultView === 'all' ? 'No results yet' : 'No actionable results'}
                description={
                  activeScan.status === 'RUNNING'
                    ? 'Scan is running. PING_FAIL and PENDING are hidden in Actionable view.'
                    : 'Switch to All to see ping failures and pending hosts.'
                }
              />
            ) : (
              <Table
                rowKey="id"
                size="small"
                rowSelection={{
                  selectedRowKeys,
                  onChange: (keys) => setSelectedRowKeys(keys as string[]),
                  getCheckboxProps: (record) => ({ disabled: record.status !== 'DISCOVERED' }),
                }}
                dataSource={visibleResults}
                columns={columns}
                pagination={tablePagination}
                scroll={tableScroll}
              />
            )}
          </DataTableShell>
        </div>
      ) : null}

      <Card bordered={false} title="Scan history" style={{ marginTop: 16 }}>
        {scans.length === 0 ? (
          <EmptyState title="No scans yet" description="Start a scan to build history." />
        ) : (
          <Table
            rowKey="id"
            size="small"
            dataSource={scans}
            pagination={tablePagination}
            scroll={tableScroll}
            onRow={(record) => ({
              onClick: () => void openScan(record.id),
              style: { cursor: 'pointer' },
            })}
            columns={[
              { title: 'Subnet', dataIndex: 'subnet', ellipsis: true, render: (value: string) => <MonoValue value={value} /> },
              {
                title: 'Status',
                dataIndex: 'status',
                width: 140,
                render: (status: DiscoveryScan['status']) => <StatusDot meta={discoveryScanMeta(status)} />,
              },
              { title: 'Site / floor', width: 140, render: (_value, record) => `${record.site} / ${record.floor}` },
              { title: 'Progress', width: 110, render: (_value, record) => `${record.scanned}/${record.totalHosts}` },
              { title: 'Discovered', dataIndex: 'discovered', width: 120 },
              { title: 'Started', dataIndex: 'createdAt', width: 140, render: (value: string) => <Timestamp value={value} /> },
              {
                title: '',
                width: 80,
                align: 'right',
                render: (_value, record) => (
                  <Button type="link" onClick={() => void openScan(record.id)}>
                    Open
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
