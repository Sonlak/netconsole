/**
 * Port stats drawer — opens from the Ports panel action column.
 *
 * Single Drawer per device, swapped content per row. Shows:
 *  - Header: interface name + admin/oper status + last sample timestamp.
 *  - "Băng thông" tab (default): inline SVG line chart with in bps +
 *    out bps for the last 60 minutes, plus a refresh button that POSTs
 *    /api/devices/:id/interface-counters/refresh.
 *  - "Errors" tab: cumulative counters list (inErrors, outErrors,
 *    inDiscards, outDiscards, inCRC) with the same BigInt-string handling.
 *
 * Why a Drawer and not a Modal: the table is ~30 rows and the chart needs
 * width. Drawer pushes in from the right (1200px max) and keeps the table
 * visible so the operator can flip back to it without losing context.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertOutlined,
  BarChartOutlined,
  CloudSyncOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Segmented,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchCounterHistory,
  fetchLatestCounters,
  refreshDeviceCounters,
  type CounterSampleJson,
} from '@/api/interfaceCounters';
import { BandwidthChart } from './BandwidthChart';

type Tab = 'bandwidth' | 'errors';

export function PortStatsDrawer({
  deviceId,
  interfaceName,
  open,
  onClose,
}: {
  deviceId: string;
  interfaceName: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('bandwidth');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof fetchCounterHistory>> | null>(null);
  const [latest, setLatest] = useState<CounterSampleJson | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!interfaceName) return;
    setLoading(true);
    setError(null);
    try {
      const [hist, lat] = await Promise.all([
        fetchCounterHistory(deviceId, { interfaceName, sinceMinutes: 60 }),
        fetchLatestCounters(deviceId).then((r) => r.interfaces.find((s) => s.interfaceName === interfaceName) ?? null),
      ]);
      setHistory(hist);
      setLatest(lat);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load counters');
    } finally {
      setLoading(false);
    }
  }, [deviceId, interfaceName]);

  useEffect(() => {
    if (!open || !interfaceName) return;
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [open, interfaceName, load]);

  const rates = useMemo(() => {
    if (!history) return [];
    const iface = history.interfaces.find((i) => i.interfaceName === interfaceName);
    return iface?.rates ?? [];
  }, [history, interfaceName]);

  const latestRate = useMemo(() => {
    for (let i = rates.length - 1; i >= 0; i--) {
      if (rates[i].inBps !== null || rates[i].outBps !== null) return rates[i];
    }
    return null;
  }, [rates]);

  const triggerRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await refreshDeviceCounters(deviceId);
      if (!r.ok) {
        setError(r.error ?? 'Refresh failed');
      } else {
        await load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [deviceId, load]);

  const countersTable: ColumnsType<{ key: string; label: string; value: string }> = [
    { title: 'Counter', dataIndex: 'label', width: 140 },
    {
      title: 'Cumulative',
      dataIndex: 'value',
      align: 'right',
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
  ];

  const counterRows = useMemo(() => {
    if (!latest) return [];
    return [
      { key: 'inOctets', label: 'Input bytes', value: latest.inOctets ?? '—' },
      { key: 'outOctets', label: 'Output bytes', value: latest.outOctets ?? '—' },
      { key: 'inPackets', label: 'Input packets', value: latest.inPackets ?? '—' },
      { key: 'outPackets', label: 'Output packets', value: latest.outPackets ?? '—' },
      { key: 'inErrors', label: 'Input errors', value: latest.inErrors ?? '—', error: true },
      { key: 'outErrors', label: 'Output errors', value: latest.outErrors ?? '—', error: true },
      { key: 'inDiscards', label: 'Input discards', value: latest.inDiscards ?? '—', error: true },
      { key: 'outDiscards', label: 'Output discards', value: latest.outDiscards ?? '—', error: true },
      { key: 'inCrcErrors', label: 'Input CRC errors', value: latest.inCrcErrors ?? '—', error: true },
    ];
  }, [latest]);

  const hasErrors = useMemo(() => {
    if (!latest) return false;
    const fields = [latest.inErrors, latest.outErrors, latest.inDiscards, latest.outDiscards, latest.inCrcErrors];
    return fields.some((f) => f && f !== '0');
  }, [latest]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(960px, 96vw)"
      destroyOnClose
      title={
        <Space>
          <Typography.Text strong>{interfaceName ?? '—'}</Typography.Text>
          {latest ? (
            <Tag color={latest.source.includes('rest') ? 'blue' : latest.source.includes('ssh') ? 'gold' : 'default'}>
              {latest.source}
            </Tag>
          ) : null}
        </Space>
      }
      extra={
        <Space>
          <Tooltip title="Refresh now">
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void triggerRefresh()}>
              Refresh
            </Button>
          </Tooltip>
        </Space>
      }
    >
      {error ? <Alert type="error" message={error} showIcon closable style={{ marginBottom: 12 }} onClose={() => setError(null)} /> : null}
      <Space style={{ marginBottom: 12 }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { label: 'Bandwidth', value: 'bandwidth', icon: <BarChartOutlined /> },
            { label: 'Errors', value: 'errors', icon: <AlertOutlined /> },
          ]}
        />
        {latest ? (
          <Typography.Text type="secondary">
            Updated {new Date(latest.capturedAt).toLocaleTimeString('vi-VN', { hour12: false })}
          </Typography.Text>
        ) : null}
      </Space>
      <Spin spinning={loading && !history}>
        {tab === 'bandwidth' ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space wrap>
              <Statistic
                title="In (last)"
                value={(latestRate?.inBps ?? 0) || 0}
                formatter={() =>
                  latestRate && latestRate.inBps && latestRate.inBps > 0
                    ? `${(latestRate.inBps / 1000).toFixed(1)} Kbps`
                    : '—'
                }
              />
              <Statistic
                title="Out (last)"
                value={(latestRate?.outBps ?? 0) || 0}
                formatter={() =>
                  latestRate && latestRate.outBps && latestRate.outBps > 0
                    ? `${(latestRate.outBps / 1000).toFixed(1)} Kbps`
                    : '—'
                }
              />
              <Statistic title="Samples" value={rates.length} />
            </Space>
            <BandwidthChart rates={rates} />
            {!refreshing && rates.length < 2 ? (
              <Typography.Text type="secondary">
                Polling vẫn đang warm-up. Sample đầu tiên xuất hiện trong ~30 giây.
              </Typography.Text>
            ) : null}
            <Button
              icon={<CloudSyncOutlined />}
              type="dashed"
              onClick={() => void triggerRefresh()}
              loading={refreshing}
            >
              Poll now
            </Button>
          </Space>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {hasErrors ? (
              <Alert
                type="warning"
                showIcon
                message="Có counter lỗi > 0"
                description="Kiểm tra cable/SFP hoặc gắn thêm log/syslog để xem chi tiết."
              />
            ) : (
              <Alert type="success" showIcon message="Không có lỗi / discard trong sample mới nhất" />
            )}
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Source">{latest?.source ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Captured at">
                {latest ? new Date(latest.capturedAt).toLocaleString('vi-VN', { hour12: false }) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Device ID">{deviceId}</Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={counterRows}
              columns={countersTable}
            />
          </Space>
        )}
      </Spin>
    </Drawer>
  );
}
