import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiOutlined } from '@ant-design/icons';
import { Button, Card, Select, Space, Typography } from 'antd';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { SITES } from '@/data/bank';
import { useDevices } from '@/hooks/useDevices';
import { useSiteFilter } from '@/hooks/useSiteFilter';

export default function InterfacesPage() {
  const navigate = useNavigate();
  const { site, setSite, get } = useSiteFilter();
  const deviceParam = get('device');
  const { devices, isLoading, error, refetch } = useDevices();
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    if (deviceParam) {
      navigate(`/devices/${deviceParam}?tab=ports`, { replace: true });
    }
  }, [deviceParam, navigate]);

  const deviceOptions = useMemo(
    () => devices.filter((item) => site === 'all' || item.site === site),
    [devices, site],
  );

  const selected = deviceOptions.find((item) => item.id === deviceId) ?? null;

  if (deviceParam) {
    return <PageSkeleton />;
  }

  if (isLoading && devices.length === 0) return <PageSkeleton />;
  if (error && devices.length === 0) {
    return <ErrorState title="Could not load devices" error={error} onRetry={() => void refetch()} />;
  }

  return (
    <div className="nc-page">
      <Card bordered={false} title="Ports">
        <Typography.Paragraph type="secondary">
          Port workflow lives on Device Detail. Pick a device to open its Ports tab. Route <Typography.Text code>/interfaces</Typography.Text> stays compatible.
        </Typography.Paragraph>
        <Space wrap>
          <Select
            value={site}
            style={{ width: 140 }}
            onChange={setSite}
            options={[{ value: 'all', label: 'All sites' }, ...SITES.map((item) => ({ value: item.code, label: item.code }))]}
          />
          <Select
            showSearch
            optionFilterProp="label"
            value={deviceId || undefined}
            placeholder="Select device"
            style={{ minWidth: 280 }}
            onChange={setDeviceId}
            options={deviceOptions.map((item) => ({
              value: item.id,
              label: `${item.name} (${item.ip})`,
            }))}
          />
          {selected ? <StatusDot status={selected.status} /> : null}
          <Button
            type="primary"
            icon={<ApiOutlined />}
            disabled={!deviceId}
            onClick={() => navigate(`/devices/${deviceId}?tab=ports`)}
          >
            Open ports
          </Button>
        </Space>
        {devices.length === 0 ? (
          <EmptyState title="No devices in inventory" description="Add a device or run Discovery first." />
        ) : null}
      </Card>
    </div>
  );
}
