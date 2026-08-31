import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Select, Space, Typography } from 'antd';
import { fetchFabricTopology } from '@/api/fabric';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { DataTableToolbar } from '@/components/data-table/DataTableToolbar';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { FabricDiagram } from '@/features/fabric/FabricDiagram';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { SITES, isKnownSite, type SiteCode } from '@/data/bank';
import { toError } from '@/lib/errors';
import type { FabricLink, FabricNode, FabricTopology } from '@/types/fabric';

function siteOptionsFrom(nodes: FabricNode[]) {
  const extra = [...new Set(nodes.map((node) => node.site).filter(Boolean))];
  const codes = [...new Set([...SITES.map((item) => item.code), ...extra])];
  return codes.map((code) => ({ value: code, label: code }));
}

function filterTopology(data: FabricTopology, floor: string | null): { nodes: FabricNode[]; links: FabricLink[] } {
  if (!floor) return { nodes: data.nodes, links: data.links };
  const keep = new Set(
    data.nodes
      .filter((node) => node.role !== 'access' || String(node.floorNumber) === floor || node.floor === floor)
      .map((node) => node.id),
  );
  const nodes = data.nodes.filter((node) => keep.has(node.id));
  const links = data.links.filter((link) => keep.has(link.fromDeviceId) && keep.has(link.toDeviceId));
  return { nodes, links };
}

export default function FabricPage() {
  const { site, setSite, get, patch } = useSiteFilter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<FabricTopology | null>(null);

  const activeSite: SiteCode | string = site !== 'all' && site ? site : isKnownSite(get('site') || '') ? (get('site') as SiteCode) : 'LAB';
  const floorParam = get('floor') || '';
  const floorFilter = floorParam === 'all' ? '' : floorParam;

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setData(await fetchFabricTopology(String(activeSite)));
        setError(null);
      } catch (cause) {
        setError(toError(cause, 'Could not load fabric'));
      } finally {
        setLoading(false);
      }
    },
    [activeSite],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const floors = useMemo(() => {
    const values = new Set<string>();
    for (const node of data?.nodes ?? []) {
      if (node.role !== 'access') continue;
      if (node.floorNumber != null) values.add(String(node.floorNumber));
      else if (node.floor) values.add(node.floor);
    }
    return [...values].sort((a, b) => Number(a) - Number(b));
  }, [data]);

  const view = useMemo(() => (data ? filterTopology(data, floorFilter || null) : { nodes: [], links: [] }), [data, floorFilter]);

  const selectFloor = (next: string) => {
    patch({ floor: next || null, site: String(activeSite) });
  };

  if (loading && !data && !error) return <PageSkeleton />;
  if (error && !data) {
    return <ErrorState title="Could not load fabric" error={error} onRetry={() => void load()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={data ? error : null} onRetry={() => void load(true)} />
      <DataTableToolbar
        leading={
          <Space wrap>
            <Select
              style={{ minWidth: 140 }}
              value={String(activeSite)}
              onChange={(value) => {
                setSite(isKnownSite(value) ? value : 'all');
                patch({ site: value, floor: null });
              }}
              options={siteOptionsFrom(data?.nodes ?? [])}
            />
            <Button type={!floorFilter ? 'primary' : 'default'} onClick={() => selectFloor('')}>
              All floors
            </Button>
            {floors.map((floor) => (
              <Button key={floor} type={floorFilter === floor ? 'primary' : 'default'} onClick={() => selectFloor(floor)}>
                Floor {floor}
              </Button>
            ))}
          </Space>
        }
        trailing={
          <Space>
            <TableFreshness lastUpdatedAt={data?.collectedAt ?? null} />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              Reload
            </Button>
          </Space>
        }
      />

      <Card
        bordered={false}
        className="nc-fabric-card"
        title={`${activeSite}${floorFilter ? ` · Floor ${floorFilter}` : ' · all floors'}`}
        extra={
          <Space size="middle">
            <span className="nc-fabric-legend">
              <span className="nc-fabric-legend-item is-trunk" /> Trunk
              <span className="nc-fabric-legend-item is-peer" /> Peer
              <span className="nc-fabric-legend-item is-l3" /> L3
              <span className="nc-fabric-legend-item is-uplink" /> Uplink
            </span>
            <Typography.Text type="secondary">
              {view.nodes.length} devices · {view.links.length} links
            </Typography.Text>
          </Space>
        }
      >
        {view.nodes.length === 0 ? (
          <EmptyState
            title={`No devices in ${activeSite}${floorFilter ? ` floor ${floorFilter}` : ''}`}
            description="Pick another site or run Discovery."
            extra={
              <Link to="/discovery">
                <Button type="primary">Run Discovery</Button>
              </Link>
            }
          />
        ) : (
          <FabricDiagram nodes={view.nodes} links={view.links} />
        )}
      </Card>
    </div>
  );
}
