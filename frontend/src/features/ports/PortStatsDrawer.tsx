/**
 * Port stats drawer — opens from the Ports panel "Stats" button.
 *
 * Single Drawer per device, swapped content per row. v2 layout:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Header strip: interface name (mono) · device · LIVE pill │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ [Tabs: Bandwidth | Errors]              [Range: 1h ▾]   │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ KPI hero:  [Utilization] [In rate] [Out rate] [Health]  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Chart card: gradient area + hover tooltip                │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Errors card grid (5 cards w/ progress bars)             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Why a Drawer and not a Modal: the table is ~30 rows and the chart needs
 * width. Drawer pushes in from the right (1080px max) and keeps the table
 * visible so the operator can flip back to it without losing context.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  BarChartOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  LineChartOutlined,
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Drawer,
  Segmented,
  Select,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  fetchCounterHistory,
  fetchLatestCounters,
  refreshDeviceCounters,
  type CounterSampleJson,
} from '@/api/interfaceCounters';
import { BandwidthChart } from './BandwidthChart';
import { Sparkline } from '@/components/dashboard/Sparkline';
import { StatusDot } from '@/components/common/StatusDot';
import { linkStatusMeta } from '@/design/status';
import type { DeviceInterface } from '@/types/interfaces';
import {
  errorCountTone,
  findMatchingIface,
  formatBps,
  formatBytes,
  formatRelative,
  parseSpeedBps,
  utilizationPercent,
  utilizationTone,
} from './portUtils';
import './portStats.css';

type Tab = 'bandwidth' | 'errors';

type Range = 15 | 60 | 360 | 1440;

const RANGE_OPTIONS: Array<{ label: string; value: Range }> = [
  { label: '15 phút', value: 15 },
  { label: '1 giờ', value: 60 },
  { label: '6 giờ', value: 360 },
  { label: '24 giờ', value: 1440 },
];

export function PortStatsDrawer({
  deviceId,
  deviceName,
  deviceIp,
  iface,
  open,
  onClose,
}: {
  deviceId: string;
  deviceName?: string;
  deviceIp?: string;
  iface: DeviceInterface | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('bandwidth');
  const [range, setRange] = useState<Range>(60);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof fetchCounterHistory>> | null>(null);
  const [latest, setLatest] = useState<CounterSampleJson | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interfaceName = iface?.name ?? null;
  const speedBps = useMemo(() => parseSpeedBps(iface?.speed, iface?.name), [iface?.speed, iface?.name]);

  const load = useCallback(async () => {
    if (!interfaceName) return;
    setLoading(true);
    setError(null);
    try {
      const [hist, lat] = await Promise.all([
        fetchCounterHistory(deviceId, { interfaceName, sinceMinutes: range }),
        fetchLatestCounters(deviceId).then((r) => findMatchingIface(r.interfaces, interfaceName)),
      ]);
      setHistory(hist);
      setLatest(lat);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load counters');
    } finally {
      setLoading(false);
    }
  }, [deviceId, interfaceName, range]);

  useEffect(() => {
    if (!open || !interfaceName) return;
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [open, interfaceName, load]);

  const rates = useMemo(() => {
    if (!history) return [];
    const found = findMatchingIface(history.interfaces, interfaceName);
    return found?.rates ?? [];
  }, [history, interfaceName]);

  // Sample history sparkline (max in/out at each tick). Cheap to compute.
  const sparkIn = useMemo(() => rates.map((r) => (r.inBps ?? 0) / 1_000_000), [rates]);
  const sparkOut = useMemo(() => rates.map((r) => (r.outBps ?? 0) / 1_000_000), [rates]);

  const latestRate = useMemo(() => {
    for (let i = rates.length - 1; i >= 0; i--) {
      if (rates[i].inBps !== null || rates[i].outBps !== null) return rates[i];
    }
    return null;
  }, [rates]);

  // Rolling average over last ~10 samples (or all if fewer) for delta badge.
  const avgRate = useMemo(() => {
    if (!rates.length) return null;
    const slice = rates.slice(-Math.min(10, rates.length));
    const validIn = slice.map((r) => r.inBps).filter((v): v is number => v !== null && v > 0);
    const validOut = slice.map((r) => r.outBps).filter((v): v is number => v !== null && v > 0);
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    return { in: avg(validIn), out: avg(validOut) };
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

  // ---------------------------------------------------------------------
  // Error parsing (BigInt strings → numbers for display + tone)
  // ---------------------------------------------------------------------
  const parseBig = (s: string | null): number => {
    if (!s) return 0;
    try {
      return Number(BigInt(s));
    } catch {
      return 0;
    }
  };

  const errorCards = useMemo(() => {
    if (!latest) return [];
    return [
      { key: 'inErrors', label: 'Input errors', value: parseBig(latest.inErrors) },
      { key: 'outErrors', label: 'Output errors', value: parseBig(latest.outErrors) },
      { key: 'inDiscards', label: 'Input discards', value: parseBig(latest.inDiscards) },
      { key: 'outDiscards', label: 'Output discards', value: parseBig(latest.outDiscards) },
      { key: 'inCrcErrors', label: 'Input CRC', value: parseBig(latest.inCrcErrors) },
    ];
  }, [latest]);

  const totalErrors = useMemo(() => errorCards.reduce((acc, c) => acc + c.value, 0), [errorCards]);
  const hasErrors = totalErrors > 0;

  // ---------------------------------------------------------------------
  // Header data
  // ---------------------------------------------------------------------
  const adminMeta = linkStatusMeta(iface?.adminStatus);
  const operMeta = linkStatusMeta(iface?.operStatus);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(1080px, 96vw)"
      destroyOnClose
      rootClassName="nc-port-drawer"
      title={null}
      closeIcon={null}
      extra={null}
    >
      <Spin spinning={loading && !history} delay={120}>
        {/* ============ Header strip ============ */}
        <header className="nc-port-header">
          <div className="nc-port-header-name">
            <span className="nc-port-ifname">{interfaceName ?? '—'}</span>
            <div className="nc-port-ifmeta">
              <StatusDot meta={adminMeta} />
              <span>admin</span>
              <span className="nc-port-ifmeta-dot" />
              <StatusDot meta={operMeta} />
              <span>link</span>
              <span className="nc-port-ifmeta-dot" />
              <span>{iface?.mode ?? '—'}</span>
              {iface?.speed ? (
                <>
                  <span className="nc-port-ifmeta-dot" />
                  <span>{iface.speed}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="nc-port-header-context">
            <span className="nc-port-context-title">{iface?.description ?? 'No description'}</span>
            <div className="nc-port-context-sub">
              <ApiOutlined />
              <span className="nc-mono">{deviceName ?? deviceIp ?? '—'}</span>
              {deviceIp && deviceName ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ({deviceIp})
                </Typography.Text>
              ) : null}
              {latest ? (
                <Tag color={latest.source.includes('rest') ? 'blue' : latest.source.includes('ssh') ? 'gold' : 'default'}>
                  {latest.source}
                </Tag>
              ) : null}
              {iface?.accessVlan ? (
                <Tag color="cyan" style={{ marginLeft: 0 }}>
                  VLAN {iface.accessVlan}
                </Tag>
              ) : null}
              {iface?.address ? (
                <Tag color="geekblue" style={{ marginLeft: 0 }}>
                  {iface.address}
                </Tag>
              ) : null}
            </div>
          </div>

          <div className="nc-port-header-actions">
            <Tooltip title={refreshing ? 'Đang poll…' : 'Poll ngay'}>
              <Button
                shape="circle"
                icon={refreshing ? <SyncOutlined spin /> : <ReloadOutlined />}
                loading={refreshing}
                onClick={() => void triggerRefresh()}
              />
            </Tooltip>
            <span className={`nc-port-live-pill${refreshing ? ' is-idle' : ''}`}>
              <span className="nc-port-live-dot" />
              {refreshing ? 'POLLING' : 'LIVE'}
            </span>
          </div>
        </header>

        {error ? (
          <Alert
            type="error"
            message={error}
            showIcon
            closable
            style={{ marginBottom: 12 }}
            onClose={() => setError(null)}
          />
        ) : null}

        {/* ============ Tabs + range selector ============ */}
        <div className="nc-port-tabs">
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { label: 'Bandwidth', value: 'bandwidth', icon: <LineChartOutlined /> },
              { label: 'Errors & discards', value: 'errors', icon: <ExclamationCircleOutlined /> },
            ]}
          />
          <div className="nc-port-range">
            <Select
              size="small"
              value={range}
              onChange={(v) => setRange(v as Range)}
              options={RANGE_OPTIONS}
              suffixIcon={<ClockCircleOutlined />}
              style={{ width: 130 }}
            />
          </div>
        </div>

        {/* ============ KPI hero row ============ */}
        <div className="nc-port-kpi-row">
          <UtilizationCard
            rateIn={latestRate?.inBps ?? null}
            rateOut={latestRate?.outBps ?? null}
            speedBps={speedBps}
            ifaceSpeedLabel={iface?.speed}
          />
          <RateCard
            tone="in"
            label="In (latest)"
            value={latestRate?.inBps ?? 0}
            avg={avgRate?.in ?? null}
            history={sparkIn}
            icon={<ArrowDownOutlined />}
          />
          <RateCard
            tone="out"
            label="Out (latest)"
            value={latestRate?.outBps ?? 0}
            avg={avgRate?.out ?? null}
            history={sparkOut}
            icon={<ArrowUpOutlined />}
          />
          <HealthCard totalErrors={totalErrors} hasErrors={hasErrors} sampleCount={rates.length} />
        </div>

        {/* ============ Body ============ */}
        {tab === 'bandwidth' ? (
          <section className="nc-port-chart-card">
            <div className="nc-port-chart-card-head">
              <span className="nc-port-chart-title">Throughput</span>
              <span className="nc-port-chart-sub">
                {rates.length} sample · {latest ? `cập nhật ${formatRelative(latest.capturedAt)}` : '—'}
              </span>
            </div>
            <BandwidthChart rates={rates} />
          </section>
        ) : (
          <ErrorsView
            errorCards={errorCards}
            latest={latest}
            totalBytesIn={latest ? formatBytes(latest.inOctets) : '—'}
            totalBytesOut={latest ? formatBytes(latest.outOctets) : '—'}
            totalPacketsIn={latest ? parseBig(latest.inPackets).toLocaleString('en-US') : '—'}
            totalPacketsOut={latest ? parseBig(latest.outPackets).toLocaleString('en-US') : '—'}
          />
        )}
      </Spin>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UtilizationCard({
  rateIn,
  rateOut,
  speedBps,
  ifaceSpeedLabel,
}: {
  rateIn: number | null;
  rateOut: number | null;
  speedBps: number | null;
  ifaceSpeedLabel?: string;
}) {
  const utilIn = utilizationPercent(rateIn, speedBps);
  const utilOut = utilizationPercent(rateOut, speedBps);
  // Worst-direction utilization drives the gauge so a saturated uplink stands out.
  const worst = Math.max(utilIn ?? 0, utilOut ?? 0);
  const tone = utilizationTone(worst);

  const radius = 24;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - worst / 100);

  const toneStroke =
    tone === 'error' ? 'var(--nc-error)' : tone === 'warning' ? 'var(--nc-warning)' : 'var(--nc-success)';

  return (
    <div className="nc-port-kpi">
      <div className="nc-port-kpi-label">
        <ThunderboltOutlined />
        Utilization
      </div>
      <div className="nc-port-util" style={{ marginTop: 8 }}>
        <div className="nc-port-util-ring">
          <svg viewBox="0 0 60 60">
            <circle className="nc-port-util-track" cx="30" cy="30" r={radius} strokeWidth="6" />
            <circle
              className="nc-port-util-arc"
              cx="30"
              cy="30"
              r={radius}
              strokeWidth="6"
              stroke={toneStroke}
              strokeDasharray={circ}
              strokeDashoffset={speedBps ? offset : circ}
            />
          </svg>
          <div className="nc-port-util-center">
            <span className="nc-port-util-pct">{speedBps ? `${worst.toFixed(1)}%` : '—'}</span>
            <span className="nc-port-util-pct-label">
              {ifaceSpeedLabel
                ? ifaceSpeedLabel
                : speedBps
                  ? `${(speedBps / 1_000_000_000).toFixed(0)} Gbps`
                  : 'speed ?'}
            </span>
          </div>
        </div>
        <div className="nc-port-util-detail">
          <UtilBar label="In" percent={utilIn} />
          <UtilBar label="Out" percent={utilOut} />
        </div>
      </div>
    </div>
  );
}

function UtilBar({ label, percent }: { label: string; percent: number | null }) {
  const value = percent ?? 0;
  const tone = utilizationTone(percent);
  const color =
    tone === 'error' ? 'var(--nc-error)' : tone === 'warning' ? 'var(--nc-warning)' : 'var(--nc-success)';
  return (
    <div className="nc-port-util-row">
      <span className="nc-port-util-label">{label}</span>
      <div className="nc-port-util-bar">
        <div className="nc-port-util-fill" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="nc-port-util-pct">{percent === null ? '—' : `${value.toFixed(1)}%`}</span>
    </div>
  );
}

function RateCard({
  tone,
  label,
  value,
  avg,
  history,
  icon,
}: {
  tone: 'in' | 'out';
  label: string;
  value: number;
  avg: number | null;
  history: number[];
  icon: React.ReactNode;
}) {
  const sparkTone = tone === 'in' ? 'success' : 'processing';
  const deltaPct = avg && avg > 0 ? ((value - avg) / avg) * 100 : null;
  const isFlat = deltaPct === null || Math.abs(deltaPct) < 2;
  return (
    <div className={`nc-port-kpi is-${tone}`}>
      <div className="nc-port-kpi-label">
        {icon}
        {label}
      </div>
      <div className="nc-port-kpi-value">
        <span className="nc-port-kpi-number">{formatBps(value)}</span>
      </div>
      <div className="nc-port-kpi-foot">
        {avg !== null ? (
          <>
            <span>avg {formatBps(avg)}</span>
            {deltaPct !== null ? (
              <Typography.Text
                type={isFlat ? 'secondary' : deltaPct > 0 ? 'danger' : 'success'}
                style={{ fontSize: 11 }}
              >
                {deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '·'} {Math.abs(deltaPct).toFixed(0)}%
              </Typography.Text>
            ) : null}
          </>
        ) : (
          <span>—</span>
        )}
      </div>
      {history.length > 1 ? (
        <div className="nc-port-kpi-spark">
          <Sparkline data={history} width={88} height={28} tone={sparkTone} />
        </div>
      ) : null}
    </div>
  );
}

function HealthCard({
  totalErrors,
  hasErrors,
  sampleCount,
}: {
  totalErrors: number;
  hasErrors: boolean;
  sampleCount: number;
}) {
  const color = hasErrors ? 'var(--nc-error)' : 'var(--nc-success)';
  return (
    <div className="nc-port-kpi">
      <div className="nc-port-kpi-label">
        <BarChartOutlined />
        Health
      </div>
      <div className="nc-port-kpi-value">
        <span className="nc-port-kpi-number" style={{ color }}>
          {hasErrors ? totalErrors.toLocaleString('en-US') : 'OK'}
        </span>
      </div>
      <div className="nc-port-kpi-foot">
        {hasErrors ? (
          <Typography.Text type="danger" style={{ fontSize: 11 }}>
            Có lỗi — kiểm tra cable/SFP
          </Typography.Text>
        ) : sampleCount > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Không có lỗi · {sampleCount} sample
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Đang thu thập…
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

function ErrorsView({
  errorCards,
  latest,
  totalBytesIn,
  totalBytesOut,
  totalPacketsIn,
  totalPacketsOut,
}: {
  errorCards: Array<{ key: string; label: string; value: number }>;
  latest: CounterSampleJson | null;
  totalBytesIn: string;
  totalBytesOut: string;
  totalPacketsIn: string;
  totalPacketsOut: string;
}) {
  // For the progress bar, normalize each card against the max in the set so
  // a single huge counter doesn't make the others look empty.
  const maxVal = Math.max(1, ...errorCards.map((c) => c.value));
  return (
    <>
      <div className="nc-port-errors-summary">
        {errorCards.map((c) => {
          const tone = errorCountTone(c.value);
          const fillPct = (c.value / maxVal) * 100;
          return (
            <div key={c.key} className={`nc-port-error-card tone-${tone}`}>
              <div className="nc-port-error-card-label">{c.label}</div>
              <div className={`nc-port-error-card-value tone-${tone}`}>
                {c.value.toLocaleString('en-US')}
              </div>
              <div className="nc-port-error-card-bar">
                <div className={`nc-port-error-card-bar-fill tone-${tone}`} style={{ width: `${fillPct}%` }} />
              </div>
              <div className="nc-port-error-card-foot">
                {tone === 'success' ? 'bình thường' : tone === 'warning' ? 'cần theo dõi' : 'bất thường'}
              </div>
            </div>
          );
        })}
      </div>

      <section className="nc-port-chart-card">
        <div className="nc-port-chart-card-head">
          <span className="nc-port-chart-title">Cumulative totals</span>
          <span className="nc-port-chart-sub">
            {latest ? `cập nhật ${formatRelative(latest.capturedAt)}` : '—'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <CumulativeRow label="Input bytes" value={totalBytesIn} icon={<ArrowDownOutlined />} />
          <CumulativeRow label="Output bytes" value={totalBytesOut} icon={<ArrowUpOutlined />} />
          <CumulativeRow label="Input packets" value={totalPacketsIn} />
          <CumulativeRow label="Output packets" value={totalPacketsOut} />
        </div>
      </section>
    </>
  );
}

function CumulativeRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--nc-text-muted)', letterSpacing: 0.04, textTransform: 'uppercase', fontWeight: 600 }}>
        {icon ? <span style={{ marginRight: 4 }}>{icon}</span> : null}
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--nc-text)' }}>{value}</div>
    </div>
  );
}
