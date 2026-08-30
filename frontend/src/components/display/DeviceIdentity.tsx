import { Link } from 'react-router-dom';
import { Space, Tooltip, Typography } from 'antd';
import { IpAddress } from '@/components/display/MonoValue';
import { deviceFloor, deviceRole, deviceSite } from '@/data/bank';
import type { Device } from '@/types/device';

export function DeviceIdentity({
  device,
  compact = false,
  toDetail = true,
}: {
  device: Pick<Device, 'id' | 'name' | 'ip' | 'site' | 'floor' | 'model' | 'vendor'> & Partial<Pick<Device, 'role'>>;
  compact?: boolean;
  toDetail?: boolean;
}) {
  const name = toDetail ? (
    <Link to={`/devices/${device.id}`}>
      <Typography.Text strong>{device.name}</Typography.Text>
    </Link>
  ) : (
    <Typography.Text strong>{device.name}</Typography.Text>
  );

  if (compact) {
    return (
      <div>
        {name}
        <div>
          <IpAddress value={device.ip} copyable={false} />
        </div>
      </div>
    );
  }

  const inferred = !device.role;
  const role = deviceRole(device as Device);

  return (
    <Space>
      <div className="nc-device-avatar" aria-hidden>
        {(device.name || '?').slice(-2)}
      </div>
      <div>
        {name}
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {device.model || device.vendor || 'Unknown model'} · <IpAddress value={device.ip} />
          </Typography.Text>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {deviceSite(device)} / {deviceFloor(device)}
          {inferred ? (
            <Tooltip title="Inferred from device name">
              <span className="nc-role-chip" style={{ marginLeft: 6 }}>
                {role}
              </span>
            </Tooltip>
          ) : (
            <span className="nc-role-chip" style={{ marginLeft: 6 }}>
              {role}
            </span>
          )}
        </Typography.Text>
      </div>
    </Space>
  );
}
