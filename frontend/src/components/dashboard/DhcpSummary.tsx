import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiOutlined,
  ArrowRightOutlined,
  ClusterOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { Alert, Progress, Tag, Tooltip, Typography } from 'antd';
import { StatusDot } from '@/components/common/StatusDot';
import { peerStatusMeta } from '@/design/status';
import type { DhcpDashboard } from '@/types/dhcp';
import { errorMessage } from '@/lib/errors';

/**
 * DhcpSummary — mini-dashboard for the DHCP tile on the main dashboard.
 *
 * Layout:
 *   - Server banner: which switch serves DHCP + reachability.
 *   - 4-stat strip: pools · leased · poolSize · utilization.
 *   - Top 3 hottest pools as proportional progress bars.
 *
 * The Kea HA banner is gone — the distribution switch is the only
 * DHCP server (no DC↔DR pair, no failover state).
 */
export function DhcpSummary({
  data,
  error,
  loading,
  href = '/dhcp',
  reload,
}: {
  data: DhcpDashboard | null;
  error: Error | null;
  loading?: boolean;
  href?: string;
  reload?: () => void;
}) {
  const totals = data?.totals ?? { sites: 0, pools: 0, leased: 0, poolSize: 0 };
  const utilization = totals.poolSize > 0 ? Math.round((totals.leased / totals.poolSize) * 100) : 0;
  const hottestPools = useMemo(() => {
    if (!data?.pools) return [];
    return [...data.pools].sort((a, b) => b.utilization - a.utilization).slice(0, 3);
  }, [data]);

  if (error && !data) {
    return (
      <div className="nc-dhcp-summary">
        <Header href={href} title="DHCP" />
        <Alert
          type="error"
          showIcon
          message="DHCP dashboard unavailable"
          description={errorMessage(error)}
          action={
            reload ? (
              <a onClick={reload} className="nc-dhcp-retry">
                Retry
              </a>
            ) : null
          }
          style={{ marginTop: 12 }}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="nc-dhcp-summary">
        <Header href={href} title="DHCP" />
        <div className="nc-dhcp-empty">
          <WifiOutlined />
          <Typography.Text type="secondary">
            {loading ? 'Loading DHCP dashboard…' : 'DHCP not attached'}
          </Typography.Text>
        </div>
      </div>
    );
  }

  return (
    <div className="nc-dhcp-summary">
      <Header href={href} title="DHCP" />

      <div className="nc-dhcp-ha">
        <Typography.Text type="secondary" className="nc-dhcp-ha-label">
          Server ·{' '}
          <span className="nc-dhcp-ha-mode">{data.server?.name ?? 'unknown'}</span>
        </Typography.Text>
        <div className="nc-dhcp-peers">
          <Tooltip title={`${data.server?.host ?? ''} · ${data.server?.source ?? ''}`}>
            <div className="nc-dhcp-peer">
              <StatusDot meta={peerStatusMeta(data.server?.reachable ?? false)} />
              <div className="nc-dhcp-peer-meta">
                <span className="nc-dhcp-peer-name">{data.server?.name ?? '—'}</span>
                <span className="nc-dhcp-peer-role">
                  {data.server?.reachable ? 'reachable' : 'unreachable'}
                </span>
              </div>
            </div>
          </Tooltip>
        </div>
      </div>

      <div className="nc-dhcp-stats">
        <Stat label="Pools" value={totals.pools} />
        <Stat label="Leased" value={totals.leased} />
        <Stat label="Pool size" value={totals.poolSize} />
        <Stat
          label="Pool util"
          value={`${utilization}%`}
          tone={utilization >= 85 ? 'error' : utilization >= 70 ? 'warning' : 'success'}
        />
      </div>

      {hottestPools.length > 0 ? (
        <div className="nc-dhcp-pools">
          <Typography.Text type="secondary" className="nc-dhcp-pools-label">
            <ClusterOutlined style={{ marginRight: 6 }} />
            Hottest pools
          </Typography.Text>
          <ul className="nc-dhcp-pools-list">
            {hottestPools.map((pool) => (
              <li key={`${pool.site}-${pool.poolName}`}>
                <Link to={`/dhcp?site=${pool.site}&pool=${pool.poolName}`} className="nc-dhcp-pool-row">
                  <span className="nc-dhcp-pool-name">{pool.site} · {pool.name}</span>
                  <Progress
                    percent={pool.utilization}
                    size="small"
                    showInfo={false}
                    strokeColor={
                      pool.utilization >= 85
                        ? 'var(--nc-error)'
                        : pool.utilization >= 70
                          ? 'var(--nc-warning)'
                          : 'var(--nc-success)'
                    }
                    trailColor="var(--nc-border-subtle)"
                    style={{ flex: 1, margin: '0 10px' }}
                  />
                  <Tag color={pool.utilization >= 85 ? 'error' : pool.utilization >= 70 ? 'warning' : 'success'}>
                    {pool.utilization}%
                  </Tag>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Header({ href, title }: { href: string; title: string }) {
  return (
    <div className="nc-dhcp-head">
      <Typography.Text strong>
        <ApiOutlined style={{ marginRight: 6 }} />
        {title}
      </Typography.Text>
      <Link to={href} className="nc-dhcp-cta">
        Open DHCP <ArrowRightOutlined />
      </Link>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'success' | 'warning' | 'error';
}) {
  return (
    <div className="nc-dhcp-stat">
      <div className="nc-dhcp-stat-label">{label}</div>
      <div className={`nc-dhcp-stat-value${tone !== 'default' ? ` is-${tone}` : ''}`}>{value}</div>
    </div>
  );
}
