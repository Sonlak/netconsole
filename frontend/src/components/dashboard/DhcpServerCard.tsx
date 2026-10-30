import { useCallback, useEffect, useState } from 'react';
import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Space, Tag, Tooltip, Typography } from 'antd';
import { fetchDhcpServer } from '@/api/dhcp';
import { StatusDot } from '@/components/common/StatusDot';
import { MonoValue } from '@/components/display/MonoValue';
import { peerStatusMeta } from '@/design/status';
import { errorMessage, toError } from '@/lib/errors';
import type { DhcpServer } from '@/types/dhcp';

const REFRESH_INTERVAL_MS = 15_000;

/**
 * DhcpServerCard — shows the identity + reachability of the switch that
 * runs the DHCP server.
 *
 * The Kea DC↔DR HA pair was removed on 2026-10-30: the distribution
 * switch (DS1) is the only DHCP server, so there is no failover state,
 * no switchover button and no failback scheduler to display.
 */
export function DhcpServerCard() {
  const [server, setServer] = useState<DhcpServer | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const payload = await fetchDhcpServer();
      setServer(payload.server);
      setError(null);
    } catch (cause) {
      setError(toError(cause, 'Cannot reach DHCP server'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (error && !server) {
    return (
      <Card bordered={false} size="small" title="DHCP server">
        <Alert
          type="error"
          showIcon
          message="Cannot reach DHCP server"
          description={errorMessage(error)}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  if (!server) {
    return (
      <Card bordered={false} size="small" title="DHCP server" loading>
        <Typography.Text type="secondary">Loading server state…</Typography.Text>
      </Card>
    );
  }

  return (
    <Card
      bordered={false}
      size="small"
      title={
        <Space>
          <ApiOutlined />
          <span>DHCP server</span>
          <Tag color={server.reachable ? 'success' : 'error'}>
            {server.reachable ? 'reachable' : 'unreachable'}
          </Tag>
        </Space>
      }
      extra={
        <Tooltip title="Refresh now">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined spin={loading} />}
            onClick={() => void load()}
          />
        </Tooltip>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot meta={peerStatusMeta(server.reachable)} />
          <Typography.Text strong>{server.name}</Typography.Text>
        </div>
        <Descriptions size="small" column={1} colon={false}>
          <Descriptions.Item
            label={<Typography.Text type="secondary" style={{ fontSize: 11 }}>Host</Typography.Text>}
          >
            <Typography.Text style={{ fontSize: 12 }}>
              <MonoValue value={server.host} />
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item
            label={<Typography.Text type="secondary" style={{ fontSize: 11 }}>Source</Typography.Text>}
          >
            <Tag color={server.source === 'restconf' ? 'blue' : 'default'}>{server.source}</Tag>
          </Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Single DHCP server — the Kea HA pair was removed, there is no failover peer.
        </Typography.Text>
      </Space>
    </Card>
  );
}
