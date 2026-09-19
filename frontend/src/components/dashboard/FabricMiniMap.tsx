import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  WarningFilled,
} from '@ant-design/icons';
import { Typography } from 'antd';
import { SITES, filterBySite, siteStats } from '@/data/bank';
import type { Device } from '@/types/device';
import { useSite } from '@/components/site-provider';
import { Timestamp } from '@/components/display/Timestamp';

/**
 * FabricMiniMap — top-right dashboard widget that previews site health.
 *
 * Why a custom preview instead of embedding `FabricDiagram`?
 *   - The full diagram is 720px and uses dagre layout — overkill for a
 *     280×160 tile in the dashboard.
 *   - Loading the topology on every dashboard refresh would double the
 *     network traffic. Instead we summarise the inventory we already loaded.
 *
 * Visual:
 *   - Per-site row: a 3-segment tier bar (core / dist / access) coloured by
 *     vendor family convention. Bar fill is the count; total length is the
 *     site total. A small dot at the right shows alarm state (down=amber/red).
 *   - Footer: "X sites · Y devices · Z down · last updated …".
 */
export function FabricMiniMap({
  devices,
  collectedAt,
  lastUpdatedAt,
  href = '/fabric',
}: {
  devices: Device[];
  /** Optional fabric-topology collectedAt for richer footer hint. */
  collectedAt?: string | null;
  /** When the inventory was last fetched — drives the freshness pill. */
  lastUpdatedAt?: string | null;
  href?: string;
}) {
  const { site } = useSite();

  const sitesToShow = useMemo(() => {
    if (site === 'all') return SITES;
    return SITES.filter((item) => item.code === site);
  }, [site]);

  const totalDevices = devices.length;
  const totalDown = useMemo(() => devices.filter((d) => d.status === 'OFFLINE').length, [devices]);

  return (
    <div className="nc-fabric-mini" aria-label="Fabric mini overview">
      <div className="nc-fabric-mini-rows">
        {sitesToShow.length === 0 ? (
          <Typography.Text type="secondary">No sites configured.</Typography.Text>
        ) : (
          sitesToShow.map((siteDef) => {
            const scoped = filterBySite(devices, siteDef.code);
            const stats = siteStats(devices, siteDef.code);
            const total = stats.total;
            return (
              <SiteRow
                key={siteDef.code}
                code={siteDef.code}
                total={total}
                core={stats.core}
                dist={stats.dist}
                access={stats.access}
                offline={stats.offline}
                managed={stats.managed}
                hasData={scoped.length > 0}
              />
            );
          })
        )}
      </div>

      <div className="nc-fabric-mini-legend" aria-hidden>
        <span className="nc-fabric-mini-legend-item">
          <span className="nc-fabric-mini-swatch is-core" />
          Core
        </span>
        <span className="nc-fabric-mini-legend-item">
          <span className="nc-fabric-mini-swatch is-dist" />
          Dist
        </span>
        <span className="nc-fabric-mini-legend-item">
          <span className="nc-fabric-mini-swatch is-access" />
          Access
        </span>
      </div>

      <div className="nc-fabric-mini-footer">
        <Typography.Text type="secondary" className="nc-fabric-mini-meta">
          <ApartmentOutlined style={{ marginRight: 6 }} />
          {sitesToShow.length} site{sitesToShow.length === 1 ? '' : 's'} · {totalDevices} devices ·{' '}
          <span className={totalDown > 0 ? 'is-error' : 'is-success'}>
            {totalDown} down
          </span>
        </Typography.Text>
        {lastUpdatedAt ? (
          <span className="nc-fabric-mini-stamp">
            <Timestamp value={lastUpdatedAt} />
          </span>
        ) : null}
      </div>

      {collectedAt ? null : null}
      <Link to={href} className="nc-fabric-mini-cta">
        Open fabric
        <ArrowRightOutlined />
      </Link>
    </div>
  );
}

function SiteRow({
  code,
  total,
  core,
  dist,
  access,
  offline,
  managed,
  hasData,
}: {
  code: string;
  total: number;
  core: number;
  dist: number;
  access: number;
  offline: number;
  managed: number;
  hasData: boolean;
}) {
  const downTone = offline > 0 ? 'is-error' : managed > 0 ? 'is-success' : 'is-neutral';
  return (
    <div className={`nc-fabric-mini-row${hasData ? '' : ' is-empty'}`}>
      <div className="nc-fabric-mini-row-head">
        <span className="nc-fabric-mini-code">{code}</span>
        <Typography.Text type="secondary" className="nc-fabric-mini-row-meta">
          {hasData ? `${total} devices · ${managed} managed` : 'No devices'}
        </Typography.Text>
        <span className={`nc-fabric-mini-dot ${downTone}`} aria-label={offline > 0 ? `${offline} offline` : 'all managed'}>
          {offline > 0 ? <WarningFilled /> : hasData ? <CheckCircleFilled /> : null}
        </span>
      </div>
      <div className="nc-fabric-mini-bar" role="img" aria-label={`${code} tier breakdown`}>
        <span className="nc-fabric-mini-seg is-core" style={{ flex: core }} title={`Core: ${core}`}>
          {core || ''}
        </span>
        <span className="nc-fabric-mini-seg is-dist" style={{ flex: dist }} title={`Dist: ${dist}`}>
          {dist || ''}
        </span>
        <span className="nc-fabric-mini-seg is-access" style={{ flex: access }} title={`Access: ${access}`}>
          {access || ''}
        </span>
        {total === 0 ? <span className="nc-fabric-mini-empty" /> : null}
        {/* keep ARIA truthful when totals are 0 */}
        <span className="visually-hidden">{total} devices total</span>
      </div>
    </div>
  );
}
