import { useCallback, useEffect, useState } from 'react';
import {
  BarChartOutlined,
  CodeOutlined,
  CloudDownloadOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, notification, Space, Table, Tooltip, Typography, App } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { collectDeviceInterfaces, fetchDeviceInterfaces, runInterfaceAction } from '@/api/interfaces';
import { JobWaitTimeoutError, waitForJob } from '@/api/jobs';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { IpAddress, MonoValue } from '@/components/display/MonoValue';
import { linkStatusMeta } from '@/design/status';
import { DeviceBusyError, toError } from '@/lib/errors';
import { tablePagination, tableScroll } from '@/lib/table';
import { PortStatsDrawer } from '@/features/ports/PortStatsDrawer';
import type { DeviceInterface, InterfaceAction } from '@/types/interfaces';
import { JOB_TYPE_LABELS } from '@/types/job';

function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s trước`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h trước`;
  return `${Math.floor(diffHr / 24)} ngày trước`;
}

function vlanIdFromRecord(record: DeviceInterface): string {
  const raw = record.accessVlan || '';
  const tagged = raw.match(/\((\d{1,4})\)\s*$/);
  if (tagged) return tagged[1];
  if (/^\d{1,4}$/.test(raw)) return raw;
  return '1';  // VLAN 1 is the default, not 10
}

function looksLikeTrunk(iface: DeviceInterface): boolean {
  const mode = (iface.mode || '').toLowerCase();
  if (mode === 'trunk') return true;
  const description = (iface.description || '').toLowerCase();
  if (description.includes('trunk') || description.includes('uplink')) return true;
  const vlan = (iface.accessVlan || '').trim().toLowerCase();
  return vlan === 'all' || vlan.includes(',');
}

function supportsAccessVlan(iface: DeviceInterface): boolean {
  // True for L2 access ports that can be switched to a single VLAN.
  // The check is keyed off the parsed switchport metadata (mode, address,
  // description) — NOT off the interface-name prefix. Filtering by
  // `name.startsWith('xe-')` / `name.startsWith('et-')` / `name.includes('ae')`
  // used to be here, but that hid the button on every vQFX / MX / EX access
  // port (they're all `xe-…`, `et-…`, or `aeN`). The intent was to skip L3
  // uplinks on those boxes, but `iface.address` below already rejects any
  // port with an IP, which is the actual L3 signal.
  const mode = (iface.mode || '').toLowerCase();
  const description = (iface.description || '').toLowerCase();
  if (mode === 'inet' || mode === 'l3' || mode === 'routed') return false;
  if (looksLikeTrunk(iface)) return false;
  if (description.includes('mgmt')) return false;
  if (iface.address) return false;
  return mode === 'access' || mode === 'eth-switch' || !mode;
}

function modeLabel(record: DeviceInterface): string {
  const mode = (record.mode || '').toLowerCase();
  if (mode === 'inet' || record.address) return 'L3';
  if (looksLikeTrunk(record)) return 'trunk';
  if (mode === 'access' || mode === 'eth-switch' || !mode) return 'access';
  return record.mode || '—';
}

export function PortsPanel({
  deviceId,
  deviceName,
  deviceIp,
  managed,
}: {
  deviceId: string;
  deviceName: string;
  deviceIp: string;
  managed?: boolean;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [interfaces, setInterfaces] = useState<DeviceInterface[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [collectedAt, setCollectedAt] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [showRunOpen, setShowRunOpen] = useState(false);
  const [showRunTitle, setShowRunTitle] = useState('');
  const [showRunText, setShowRunText] = useState('');
  const [vlanOpen, setVlanOpen] = useState(false);
  const [vlanIface, setVlanIface] = useState<string | null>(null);
  const [vlanValue, setVlanValue] = useState('10');
  const [confirm, setConfirm] = useState<{ action: InterfaceAction; iface: string; vlan?: string } | null>(
    null,
  );
  const [descOpen, setDescOpen] = useState(false);
  const [descIface, setDescIface] = useState<string | null>(null);
  const [descValue, setDescValue] = useState('');
  const [statsIface, setStatsIface] = useState<DeviceInterface | null>(null);

  const actionLabels: Record<InterfaceAction, string> = {
    shut: 'Shut',
    'no-shut': 'No shut',
    'set-access-vlan': 'Set access VLAN',
    'set-description': 'Set description',
    'remove-description': 'Remove description',
    'show-run': 'Show run',
  };

  const load = useCallback(
    async (options?: { collect?: boolean; silent?: boolean }) => {
      if (options?.collect) setCollecting(true);
      else if (!options?.silent) setLoading(true);
      try {
        if (options?.collect) {
          // Backend does REST-first (no job queue for read). Wait briefly so
          // the SUCCESS row commits before we re-fetch the cached result.
          await collectDeviceInterfaces(deviceId);
          await new Promise((r) => setTimeout(r, 300));
        }
        const inventory = await fetchDeviceInterfaces(deviceId);
        setInterfaces(Array.isArray(inventory.interfaces) ? inventory.interfaces : []);
        setCollectedAt(inventory.collectedAt);
        setSource(inventory.source);
        setError(null);
        setHasLoaded(true);
      } catch (cause) {
        setError(toError(cause, 'Could not load interfaces'));
      } finally {
        setLoading(false);
        setCollecting(false);
      }
    },
    [deviceId],
  );

  useEffect(() => {
    setInterfaces([]);
    setHasLoaded(false);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pending) return;
      void load({ silent: true });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load, pending]);

  const openConfirm = (action: InterfaceAction, iface: string, vlan?: string) => {
    setConfirm({ action, iface, vlan });
  };

  const runAction = async (action: InterfaceAction, iface: string, vlan?: string, description?: string) => {
    const key = `${iface}:${action}`;
    setPending(key);
    try {
      const { job } = await runInterfaceAction(deviceId, { action, interface: iface, vlan, description });
      message.loading({ content: `Committing ${action} on ${iface}…`, key, duration: 0 });
      const finished = await waitForJob(job.id, { timeoutMs: 90000, pollIntervalMs: 300 });
      if (finished.status === 'FAILED') throw new Error(finished.error || `${action} failed`);
      const result = (finished.result ?? {}) as {
        implemented?: boolean;
        message?: string;
        config?: string;
        adminStatus?: string;
        accessVlan?: string;
        description?: string;
        outputs?: { command: string; output: string }[];
      };
      if (result.implemented === false) throw new Error(result.message || `${action} failed`);
      if (action === 'show-run') {
        setShowRunTitle(`show configuration interfaces ${iface}`);
        setShowRunText(
          result.config ||
            result.outputs?.map((item) => `${item.command}\n${item.output}`).join('\n') ||
            result.message ||
            '',
        );
        setShowRunOpen(true);
      } else {
        setInterfaces((rows) =>
          rows.map((row) =>
            row.name === iface
              ? {
                  ...row,
                  ...(result.adminStatus ? { adminStatus: result.adminStatus } : {}),
                  ...(action === 'shut' ? { operStatus: 'down' } : {}),
                  ...(result.accessVlan ? { accessVlan: result.accessVlan } : {}),
                  ...(result.description !== undefined
                    ? { description: result.description === null ? '' : result.description }
                    : {}),
                }
              : row,
          ),
        );
        message.success(`${action} ${iface} committed`);
        void load({ silent: true });
        return;
      }
      const inventory = await fetchDeviceInterfaces(deviceId);
      setInterfaces(Array.isArray(inventory.interfaces) ? inventory.interfaces : []);
      setCollectedAt(inventory.collectedAt);
      setSource(inventory.source);
    } catch (cause) {
      if (cause instanceof DeviceBusyError) {
        const { username, jobType, jobCreatedAt } = cause.lockedBy;
        const label = JOB_TYPE_LABELS[jobType as keyof typeof JOB_TYPE_LABELS] ?? jobType;
        notification.warning({
          message: username
            ? `Device đang được cấu hình bởi user "${username}"`
            : `Device đang bận (job ${label})`,
          description: username
            ? 'Vui lòng chờ hoặc vào Jobs để hủy job đang chạy.'
            : `Job bắt đầu ${formatRelativeTime(jobCreatedAt)}. Vui lòng chờ hoặc vào Jobs để hủy.`,
          duration: 0,
        });
      } else if (cause instanceof JobWaitTimeoutError) {
        message.warning('Job is still queued. Open Jobs if it does not finish in a few seconds.');
      } else {
        message.error(cause instanceof Error ? cause.message : 'Action failed');
      }
    } finally {
      message.destroy(key);
      setPending(null);
    }
  };

  const columns: ColumnsType<DeviceInterface> = [
    { title: 'Interface', dataIndex: 'name', width: 160, render: (value: string) => <MonoValue value={value} /> },
    {
      title: 'Admin',
      dataIndex: 'adminStatus',
      width: 90,
      render: (value: string) => <StatusDot meta={linkStatusMeta(value)} />,
    },
    {
      title: 'Link',
      dataIndex: 'operStatus',
      width: 90,
      render: (value: string) => <StatusDot meta={linkStatusMeta(value)} />,
    },
    { title: 'Mode', width: 110, render: (_value, record) => modeLabel(record) },
    {
      title: 'VLAN',
      width: 140,
      render: (_value, record) => record.accessVlan || '—',
    },
    { title: 'Address', dataIndex: 'address', width: 160, render: (value?: string) => (value ? <IpAddress value={value} /> : '—') },
    {
      title: 'Description',
      dataIndex: 'description',
      width: 240,
      ellipsis: true,
      render: (_value: string | undefined, record: DeviceInterface) => {
        // Prefer the LLDP Port Description (e.g. LINK_TO_SW-F6-DS-01_ge-0/0/5)
        // over the device-set interface description so fabric link names are visible.
        const portDesc = (record as DeviceInterface & { portDescription?: string }).portDescription;
        const linkName = portDesc || record.remotePort;
        const ifaceDesc = record.description;
        if (linkName) {
          return (
            <Tooltip title={linkName}>
              <span>{linkName}</span>
            </Tooltip>
          );
        }
        return ifaceDesc || '—';
      },
    },
    {
      title: '',
      width: 180,
      align: 'right',
      render: (_value, record) => {
        const busy = pending?.startsWith(`${record.name}:`);
        const canMutate = managed !== false;
        return (
          <Space size={0}>
            <Tooltip title={!canMutate ? 'Device is not managed' : 'Shutdown'}>
              <span>
                <Button
                  type="text"
                  danger
                  aria-label={`Shut ${record.name}`}
                  icon={<PoweroffOutlined />}
                  disabled={!canMutate || busy}
                  loading={pending === `${record.name}:shut`}
                  onClick={() => openConfirm('shut', record.name)}
                />
              </span>
            </Tooltip>
            <Tooltip title={!canMutate ? 'Device is not managed' : 'No shut'}>
              <span>
                <Button
                  type="text"
                  aria-label={`No shut ${record.name}`}
                  icon={<PlayCircleOutlined />}
                  disabled={!canMutate || busy}
                  loading={pending === `${record.name}:no-shut`}
                  onClick={() => openConfirm('no-shut', record.name)}
                />
              </span>
            </Tooltip>
            {supportsAccessVlan(record) ? (
              <Tooltip title="Switch VLAN">
                <Button
                  type="text"
                  aria-label={`Set VLAN ${record.name}`}
                  icon={<SwapOutlined />}
                  disabled={!canMutate || busy}
                  onClick={() => {
                    setVlanIface(record.name);
                    setVlanValue(vlanIdFromRecord(record));
                    setVlanOpen(true);
                  }}
                />
              </Tooltip>
            ) : null}
            <Tooltip title="Edit description">
              <Button
                type="text"
                aria-label={`Edit description ${record.name}`}
                icon={<EditOutlined />}
                disabled={!canMutate || busy}
                loading={pending === `${record.name}:set-description` || pending === `${record.name}:remove-description`}
                onClick={() => {
                  setDescIface(record.name);
                  setDescValue(record.description || '');
                  setDescOpen(true);
                }}
              />
            </Tooltip>
            <Tooltip title="Show run">
              <Button
                type="text"
                aria-label={`Show run ${record.name}`}
                icon={<CodeOutlined />}
                disabled={busy}
                loading={pending === `${record.name}:show-run`}
                onClick={() => void runAction('show-run', record.name)}
              />
            </Tooltip>
            <Tooltip title="Bandwidth / errors / utilization">
              <Button
                type="text"
                aria-label={`Show stats for ${record.name}`}
                icon={<BarChartOutlined />}
                data-testid={`port-stats-${record.name}`}
                onClick={() => setStatsIface(record)}
              />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  if (error && !hasLoaded) {
    return <ErrorState title="Could not load interfaces" error={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <StaleDataBanner error={hasLoaded ? error : null} onRetry={() => void load()} />
      <DataTableShell
        title="Ports"
        count={interfaces.length}
        countLabel="loaded"
        freshness={<TableFreshness refreshing={loading || collecting} lastUpdatedAt={collectedAt} />}
        extra={
          <Space>
            {source ? <Typography.Text type="secondary">{source}</Typography.Text> : null}
            <Button icon={<CloudDownloadOutlined />} loading={collecting} onClick={() => void load({ collect: true })}>
              Collect
            </Button>
          </Space>
        }
      >
        {hasLoaded && interfaces.length === 0 ? (
          <EmptyState
            title="No interface data"
            description="Collect interfaces from the device."
            extra={
              <Button type="primary" icon={<CloudDownloadOutlined />} loading={collecting} onClick={() => void load({ collect: true })}>
                Collect interfaces
              </Button>
            }
          />
        ) : (
          <Table
            rowKey="name"
            size="small"
            loading={loading && hasLoaded}
            dataSource={interfaces}
            columns={columns}
            pagination={tablePagination}
            scroll={tableScroll}
            sticky
          />
        )}
      </DataTableShell>
      <Modal
        centered
        zIndex={2000}
        open={Boolean(confirm)}
        title={confirm ? `${actionLabels[confirm.action]} ${confirm.iface}?` : 'Confirm'}
        okText={confirm ? actionLabels[confirm.action] : 'OK'}
        okButtonProps={{ danger: confirm?.action === 'shut' }}
        confirmLoading={Boolean(pending)}
        onCancel={() => {
          if (!pending) setConfirm(null);
        }}
        onOk={async () => {
          if (!confirm) return;
          await runAction(confirm.action, confirm.iface, confirm.vlan);
          setConfirm(null);
        }}
      >
        <div>
          <div>
            Device <Typography.Text strong>{deviceName}</Typography.Text> ({deviceIp})
          </div>
          <div>
            Interface <Typography.Text code>{confirm?.iface}</Typography.Text>
            {confirm?.vlan ? <> → VLAN {confirm.vlan}</> : null}
          </div>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            This can affect forwarding on the live device.
          </Typography.Paragraph>
        </div>
      </Modal>
      <Modal open={showRunOpen} title={showRunTitle} onCancel={() => setShowRunOpen(false)} footer={<Button onClick={() => setShowRunOpen(false)}>Close</Button>} width={720}>
        <Input.TextArea className="nc-code-area" value={showRunText} readOnly autoSize={{ minRows: 12, maxRows: 20 }} />
      </Modal>
      <Modal
        open={vlanOpen}
        title={vlanIface ? `Switch VLAN · ${vlanIface}` : 'Switch VLAN'}
        onCancel={() => setVlanOpen(false)}
        okText="Apply"
        confirmLoading={Boolean(pending?.endsWith(':set-access-vlan'))}
        onOk={() => {
          const vlan = Number(vlanValue);
          if (!vlanIface || !Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
            message.warning('VLAN must be 1–4094');
            return Promise.reject();
          }
          return runAction('set-access-vlan', vlanIface, String(vlan)).then(() => setVlanOpen(false));
        }}
      >
        <Typography.Paragraph type="secondary">Access ports (L2) only.</Typography.Paragraph>
        <Input type="number" min={1} max={4094} value={vlanValue} onChange={(event) => setVlanValue(event.target.value)} />
      </Modal>
      <Modal
        open={descOpen}
        title={descIface ? `Description · ${descIface}` : 'Description'}
        onCancel={() => setDescOpen(false)}
        okText="Apply"
        confirmLoading={Boolean(pending?.endsWith(':set-description'))}
        onOk={() => {
          if (!descIface) return Promise.reject();
          const trimmed = descValue.trim();
          // Always include description in body (empty string = remove)
          return runAction('set-description', descIface, undefined, trimmed || '').then(() => setDescOpen(false));
        }}
      >
        <Typography.Paragraph type="secondary">
          Sets the interface description on the live device. Clear the field to remove it.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={descValue}
          placeholder="e.g. uplink-to-core, access-floor-3, trunk-vlan100"
          onChange={(e) => setDescValue(e.target.value)}
          maxLength={200}
          showCount
        />
      </Modal>
      <PortStatsDrawer
        deviceId={deviceId}
        deviceName={deviceName}
        deviceIp={deviceIp}
        iface={statsIface}
        open={Boolean(statsIface)}
        onClose={() => setStatsIface(null)}
      />
    </>
  );
}
