import { useCallback, useEffect, useState } from 'react';
import {
  CodeOutlined,
  CloudDownloadOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, Space, Table, Tooltip, Typography, App } from 'antd';
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
import { toError } from '@/lib/errors';
import { tablePagination, tableScroll } from '@/lib/table';
import type { DeviceInterface, InterfaceAction } from '@/types/interfaces';

function vlanIdFromRecord(record: DeviceInterface): string {
  const raw = record.accessVlan || '';
  const tagged = raw.match(/\((\d{1,4})\)\s*$/);
  if (tagged) return tagged[1];
  if (/^\d{1,4}$/.test(raw)) return raw;
  return '10';
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
  const mode = (iface.mode || '').toLowerCase();
  const description = (iface.description || '').toLowerCase();
  const name = (iface.name || '').toLowerCase();
  if (mode === 'inet' || mode === 'l3' || mode === 'routed') return false;
  if (looksLikeTrunk(iface)) return false;
  if (description.includes('mgmt')) return false;
  if (name.startsWith('xe-') || name.startsWith('et-') || name.includes('ae')) return false;
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

  const actionLabels: Record<InterfaceAction, string> = {
    shut: 'Shut',
    'no-shut': 'No shut',
    'set-access-vlan': 'Set access VLAN',
    'show-run': 'Show run',
  };

  const load = useCallback(
    async (options?: { collect?: boolean; silent?: boolean }) => {
      if (options?.collect) setCollecting(true);
      else if (!options?.silent) setLoading(true);
      try {
        if (options?.collect) {
          const { job } = await collectDeviceInterfaces(deviceId);
          const finished = await waitForJob(job.id, { timeoutMs: 45000 });
          if (finished.status === 'FAILED') throw new Error(finished.error || 'Interface collection failed');
        }
        const inventory = await fetchDeviceInterfaces(deviceId);
        setInterfaces(Array.isArray(inventory.interfaces) ? inventory.interfaces : []);
        setCollectedAt(inventory.collectedAt);
        setSource(inventory.source);
        setError(null);
        setHasLoaded(true);
      } catch (cause) {
        if (cause instanceof JobWaitTimeoutError) {
          message.warning(cause.message);
        } else {
          setError(toError(cause, 'Could not load interfaces'));
        }
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

  const runAction = async (action: InterfaceAction, iface: string, vlan?: string) => {
    const key = `${iface}:${action}`;
    setPending(key);
    try {
      const { job } = await runInterfaceAction(deviceId, { action, interface: iface, vlan });
      message.loading({ content: `Committing ${action} on ${iface}…`, key, duration: 0 });
      const finished = await waitForJob(job.id, { timeoutMs: 90000, pollIntervalMs: 300 });
      if (finished.status === 'FAILED') throw new Error(finished.error || `${action} failed`);
      const result = (finished.result ?? {}) as {
        implemented?: boolean;
        message?: string;
        config?: string;
        adminStatus?: string;
        accessVlan?: string;
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
      if (cause instanceof JobWaitTimeoutError) {
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
    { title: 'Description', dataIndex: 'description', ellipsis: true, render: (value?: string) => value || '—' },
    {
      title: '',
      width: 140,
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
    </>
  );
}
