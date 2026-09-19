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
 * KeaSummary — replaces the original "Kea HA / pool pressure" tile with a
 * richer mini-dashboard that actually uses the data the API already returns.
 *
 * Layout:
 *   - Banner: HA mode + active peer (uses dhcp.ha.{mode,active,peers}).
 *   - 4-stat strip: sites · pools · leased · poolSize (uses dhcp.totals).
 *   - Top 3 hottest pools as proportional progress bars.
 *   - Error state if the API call failed; empty state if Kea is reachable
 *     but returned no pools.
 */
export function KeaSummary({
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
      <div className="nc-kea-summary">
        <Header href={href} title="Kea DHCP" />
        <Alert
          type="error"
          showIcon
          message="DHCP dashboard unavailable"
          description={errorMessage(error)}
          action={
            reload ? (
              <a onClick={reload} className="nc-kea-retry">
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
      <div className="nc-kea-summary">
        <Header href={href} title="Kea DHCP" />
        <div className="nc-kea-empty">
          <WifiOutlined />
          <Typography.Text type="secondary">
            {loading ? 'Loading DHCP dashboard…' : 'DHCP not attached'}
          </Typography.Text>
        </div>
      </div>
    );
  }

  return (
    <div className="nc-kea-summary">
      <Header href={href} title="Kea DHCP" />

      <div className="nc-kea-ha">
        <Typography.Text type="secondary" className="nc-kea-ha-label">
          HA mode · <span className="nc-kea-ha-mode">{data.ha.mode}</span>
          {data.ha.active ? (
            <>
              {' · '}active <span className="nc-kea-ha-active">{data.ha.active}</span>
            </>
          ) : null}
        </Typography.Text>
        <div className="nc-kea-peers">
          {(data.ha.peers ?? []).map((peer) => (
            <Tooltip key={peer.name} title={`${peer.url}${peer.state ? ` · ${peer.state}` : ''}`}>
              <div className="nc-kea-peer">
                <StatusDot meta={peerStatusMeta(peer.reachable)} />
                <div className="nc-kea-peer-meta">
                  <span className="nc-kea-peer-name">{peer.name}</span>
                  <span className="nc-kea-peer-role">{peer.role}</span>
                </div>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="nc-kea-stats">
        <Stat label="Sites" value={totals.sites} />
        <Stat label="Pools" value={totals.pools} />
        <Stat label="Leased" value={totals.leased} />
        <Stat
          label="Pool util"
          value={`${utilization}%`}
          tone={utilization >= 85 ? 'error' : utilization >= 70 ? 'warning' : 'success'}
        />
      </div>

      {hottestPools.length > 0 ? (
        <div className="nc-kea-pools">
          <Typography.Text type="secondary" className="nc-kea-pools-label">
            <ClusterOutlined style={{ marginRight: 6 }} />
            Hottest pools
          </Typography.Text>
          <ul className="nc-kea-pools-list">
            {hottestPools.map((pool) => (
              <li key={`${pool.site}-${pool.subnetId}`}>
                <Link to={`/dhcp?site=${pool.site}&pool=${pool.subnetId}`} className="nc-kea-pool-row">
                  <span className="nc-kea-pool-name">{pool.site} · {pool.name}</span>
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
    <div className="nc-kea-head">
      <Typography.Text strong>
        <ApiOutlined style={{ marginRight: 6 }} />
        {title}
      </Typography.Text>
      <Link to={href} className="nc-kea-cta">
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
    <div className="nc-kea-stat">
      <div className="nc-kea-stat-label">{label}</div>
      <div className={`nc-kea-stat-value${tone !== 'default' ? ` is-${tone}` : ''}`}>{value}</div>
    </div>
  );
}
