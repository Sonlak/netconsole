import { useCallback, useEffect, useState } from 'react';
import {
  ApiOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Modal,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  fetchHaState,
  setAutoFailback,
  triggerAutoFailbackCheck,
  triggerSwitchover,
} from '@/api/dhcp';
import { StatusDot } from '@/components/common/StatusDot';
import { MonoValue } from '@/components/display/MonoValue';
import { Timestamp } from '@/components/display/Timestamp';
import { peerStatusMeta } from '@/design/status';
import { errorMessage, toError } from '@/lib/errors';
import type {
  AutoFailbackStatus,
  HaStateResponse,
  HaStateSnapshot,
} from '@/types/dhcp';

const REFRESH_INTERVAL_MS = 10_000;

const peerStateColor = (state: string | undefined): string => {
  if (!state) return 'default';
  if (state === 'hot-standby') return 'success';
  if (state === 'partner-down') return 'warning';
  if (state === 'unavailable' || state === 'waiting' || state === 'syncing') return 'processing';
  if (state === 'communication-recovered') return 'cyan';
  if (state === 'terminated' || state === 'standalone') return 'default';
  return 'default';
};

const peerStateLabel = (state: string | undefined): string => {
  if (!state) return '—';
  return state;
};

const siteStateSummary = (
  site: 'DC' | 'DR',
  state: HaStateSnapshot | null,
): { reachable: boolean; state: string; active: boolean } => {
  if (!state) return { reachable: false, state: 'unknown', active: false };
  const peer = state.peers.find((p) => p.site === site);
  return {
    reachable: peer?.reachable ?? false,
    state: peer?.state ?? 'unknown',
    active: state.activeSite === site,
  };
};

export function KeaHaCard() {
  const [data, setData] = useState<HaStateResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchHaState();
      setData(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Tick once a second so the "next check in Xs" countdown updates.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const onToggleAutoFailback = async (next: boolean) => {
    try {
      setBusy(true);
      const status = await setAutoFailback(next);
      setData((prev) => (prev ? { ...prev, autoFailback: status } : prev));
      message.success(`Auto-failback ${next ? 'enabled' : 'disabled'}`);
    } catch (cause) {
      message.error(`Toggle failed: ${errorMessage(toError(cause))}`);
    } finally {
      setBusy(false);
    }
  };

  const onCheckNow = async () => {
    try {
      setBusy(true);
      const status = await triggerAutoFailbackCheck();
      setData((prev) => (prev ? { ...prev, autoFailback: status } : prev));
      void load(true);
      message.success('Failback check executed');
    } catch (cause) {
      message.error(`Check failed: ${errorMessage(toError(cause))}`);
    } finally {
      setBusy(false);
    }
  };

  const onSwitchover = (currentPrimary: 'DC' | 'DR') => {
    Modal.confirm({
      title: `Switch DHCP primary: ${currentPrimary} → ${currentPrimary === 'DC' ? 'DR' : 'DC'}?`,
      content: (
        <div>
          <p>
            This sends <Typography.Text code>ha-switch-partner</Typography.Text> to{' '}
            <Typography.Text strong>{currentPrimary}</Typography.Text>. The current primary
            demotes to standby; the standby promotes to primary. There will be a{' '}
            <Typography.Text strong>1-3s gap</Typography.Text> where no server serves DHCP.
          </p>
          <p style={{ marginBottom: 0 }}>
            Existing leases are unaffected. Only new DHCP requests during the gap will fail and
            retry.
          </p>
        </div>
      ),
      okText: 'Trigger switchover',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          setBusy(true);
          const result = await triggerSwitchover(currentPrimary);
          if (!result.ok) {
            message.error(`Kea rejected: ${result.result.text || 'unknown error'}`);
            return;
          }
          message.success(`Switchover complete. Active: ${currentPrimary === 'DC' ? 'DR' : 'DC'}`);
          await load(true);
        } catch (cause) {
          message.error(`Switchover failed: ${errorMessage(toError(cause))}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  if (error && !data) {
    return (
      <Card bordered={false} size="small" title="Kea DC↔DR HA">
        <Alert
          type="error"
          showIcon
          message="Cannot reach Kea control agents"
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

  if (!data) {
    return (
      <Card bordered={false} size="small" title="Kea DC↔DR HA" loading={!data}>
        <Typography.Text type="secondary">Loading HA state…</Typography.Text>
      </Card>
    );
  }

  const { ha, autoFailback } = data;
  const dc = siteStateSummary('DC', ha);
  const dr = siteStateSummary('DR', ha);
  // "standalone" = this deployment has a single Kea server, no DR peer.
  // Switchover and auto-failback are meaningless there, so the UI says
  // so instead of offering a button that would fail.
  const haMode = ha.mode ?? 'hot-standby';
  const standalone = haMode === 'standalone';
  const drPeer = ha.peers.find((p) => p.site === 'DR');

  const nextCheckIn =
    autoFailback.nextCheckAt != null
      ? Math.max(0, Math.floor((new Date(autoFailback.nextCheckAt).getTime() - now) / 1000))
      : null;

  return (
    <Card
      bordered={false}
      size="small"
      title={
        <Space>
          <ApiOutlined />
          <span>Kea DC↔DR HA</span>
          <Tag color={ha.activeSite ? 'success' : 'default'}>
            {ha.activeSite ? `${ha.activeSite} active` : 'no active'}
          </Tag>
        </Space>
      }
      extra={
        <Space size={4}>
          <Tooltip title="Refresh now">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined spin={loading} />}
              onClick={() => void load()}
            />
          </Tooltip>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Mode: <Typography.Text code>{haMode}</Typography.Text>
            {ha.recommendedAction !== 'none' ? ` · ${ha.reason}` : null}
          </Typography.Text>
        </div>

        <div>
          <SiteBlock
            site="DC"
            peer={ha.peers.find((p) => p.site === 'DC')}
            active={dc.active}
          />
          {drPeer ? (
            <SiteBlock site="DR" peer={drPeer} active={dr.active} />
          ) : null}
        </div>

        <AutoFailbackPanel
          status={autoFailback}
          nextCheckIn={nextCheckIn}
          onToggle={onToggleAutoFailback}
          onCheckNow={onCheckNow}
          busy={busy}
          standalone={standalone}
        />

        <FailoverHistory events={autoFailback.recentEvents} />

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <Tooltip
            title={
              standalone
                ? 'HA is not configured on this deployment (no DR peer)'
                : `Manual switchover (active: ${ha.activeSite ?? '?'})`
            }
          >
            <Button
              size="small"
              danger
              icon={<SwapOutlined />}
              disabled={standalone || !ha.activeSite || busy}
              onClick={() => onSwitchover(ha.activeSite as 'DC' | 'DR')}
            >
              Manual switchover
            </Button>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Checked{' '}
            <Timestamp value={autoFailback.lastCheckedAt} />
          </Typography.Text>
        </div>
      </Space>
    </Card>
  );
}

function SiteBlock({
  site,
  peer,
  active,
}: {
  site: 'DC' | 'DR';
  peer: { name: string; role: string; url: string; reachable: boolean; state?: string; lastHeartbeatAt?: string | null } | undefined;
  active: boolean;
}) {
  if (!peer) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 8px',
        borderRadius: 4,
        background: active ? 'rgba(82, 196, 26, 0.08)' : 'rgba(0,0,0,0.02)',
        marginBottom: 4,
        border: active ? '1px solid rgba(82, 196, 26, 0.3)' : '1px solid transparent',
      }}
    >
      <Space>
        <StatusDot meta={peerStatusMeta(peer.reachable)} />
        <div>
          <Space size={4}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              {site}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              ({peer.name})
            </Typography.Text>
            {active ? <Tag color="success" style={{ marginLeft: 4 }}>active</Tag> : null}
          </Space>
          <div>
            <Tag color={peerStateColor(peer.state)} style={{ marginRight: 4 }}>
              {peerStateLabel(peer.state)}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              <MonoValue value={peer.url.replace(/^https?:\/\//, '')} />
            </Typography.Text>
          </div>
        </div>
      </Space>
    </div>
  );
}

function AutoFailbackPanel({
  status,
  nextCheckIn,
  onToggle,
  onCheckNow,
  busy,
  standalone,
}: {
  status: AutoFailbackStatus;
  nextCheckIn: number | null;
  onToggle: (next: boolean) => void;
  onCheckNow: () => void;
  busy: boolean;
  standalone?: boolean;
}) {
  const cooldownMinutes = Math.ceil(status.cooldownRemainingSeconds / 60);
  return (
    <div
      style={{
        background: status.enabled ? 'rgba(82, 196, 26, 0.05)' : 'rgba(0,0,0,0.02)',
        border: `1px solid ${status.enabled ? 'rgba(82, 196, 26, 0.25)' : 'var(--nc-border-subtle)'}`,
        borderRadius: 4,
        padding: 8,
      }}
    >
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={4}>
          <ThunderboltOutlined
            style={{ color: status.enabled ? 'var(--nc-success)' : 'var(--nc-text-muted)' }}
          />
          <Typography.Text strong style={{ fontSize: 12 }}>
            Auto-failback
          </Typography.Text>
          <Tag color={status.enabled ? 'success' : 'default'} style={{ marginLeft: 4 }}>
            {status.enabled ? 'ON' : 'OFF'}
          </Tag>
        </Space>
        <Switch
          size="small"
          checked={status.enabled}
          disabled={busy || standalone}
          onChange={onToggle}
        />
      </Space>
      {standalone ? (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          HA is not configured on this deployment — a single Kea server, no DR peer to fail back
          from.
        </Typography.Text>
      ) : null}
      <Descriptions size="small" column={1} style={{ marginTop: 6 }} colon={false}>
        <Descriptions.Item label={<Typography.Text type="secondary" style={{ fontSize: 11 }}>Stability</Typography.Text>}>
          <Typography.Text style={{ fontSize: 11 }}>
            DC must be healthy {status.stabilityRequiredSeconds}s before failback
          </Typography.Text>
        </Descriptions.Item>
        {status.cooldownRemainingSeconds > 0 ? (
          <Descriptions.Item label={<Typography.Text type="secondary" style={{ fontSize: 11 }}>Cooldown</Typography.Text>}>
            <Typography.Text style={{ fontSize: 11 }}>
              {cooldownMinutes} min remaining since last failback
            </Typography.Text>
          </Descriptions.Item>
        ) : null}
        {status.lastFailbackAt ? (
          <Descriptions.Item label={<Typography.Text type="secondary" style={{ fontSize: 11 }}>Last failback</Typography.Text>}>
            <Typography.Text style={{ fontSize: 11 }}>
              {status.lastFailbackFrom} → {status.lastFailbackTo} ·{' '}
              <Timestamp value={status.lastFailbackAt} />
            </Typography.Text>
          </Descriptions.Item>
        ) : null}
        {status.lastFailoverAt ? (
          <Descriptions.Item label={<Typography.Text type="secondary" style={{ fontSize: 11 }}>Last failover</Typography.Text>}>
            <Typography.Text style={{ fontSize: 11 }}>
              DC → DR · <Timestamp value={status.lastFailoverAt} />
            </Typography.Text>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
        <Typography.Text type="secondary" style={{ fontSize: 10 }}>
          Next check: {nextCheckIn != null ? `${nextCheckIn}s` : 'paused'}
        </Typography.Text>
        <Button
          size="small"
          type="link"
          icon={<CheckCircleOutlined />}
          onClick={onCheckNow}
          disabled={busy}
          style={{ padding: 0, height: 'auto' }}
        >
          Check now
        </Button>
      </div>
    </div>
  );
}

function FailoverHistory({ events }: { events: AutoFailbackStatus['recentEvents'] }) {
  if (events.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        No HA events yet.
      </Typography.Text>
    );
  }
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>
        Recent events
      </Typography.Text>
      <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
        {events.slice(0, 5).map((event, idx) => {
          const icon =
            event.kind === 'failover' ? (
              <WarningOutlined style={{ color: 'var(--nc-warning)' }} />
            ) : event.kind === 'failback' ? (
              <CheckCircleOutlined style={{ color: 'var(--nc-success)' }} />
            ) : event.kind === 'switchover' ? (
              <SwapOutlined style={{ color: 'var(--nc-accent)' }} />
            ) : (
              <Badge status="default" />
            );
          return (
            <li
              key={`${event.at}-${idx}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                padding: '3px 0',
                fontSize: 11,
                borderBottom: '1px dashed var(--nc-border-subtle)',
              }}
            >
              {icon}
              <div style={{ flex: 1 }}>
                <Space size={4} wrap>
                  <Tag color={event.kind === 'failback' ? 'success' : event.kind === 'failover' ? 'warning' : 'default'}>
                    {event.kind}
                  </Tag>
                  {event.from && event.to ? (
                    <Typography.Text style={{ fontSize: 11 }}>
                      {event.from} → {event.to}
                    </Typography.Text>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                    <Timestamp value={event.at} />
                  </Typography.Text>
                </Space>
                <div style={{ marginTop: 2, color: 'var(--nc-text-muted)' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                    {event.reason}
                  </Typography.Text>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
