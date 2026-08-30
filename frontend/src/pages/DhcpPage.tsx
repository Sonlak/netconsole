import { useCallback, useEffect, useMemo, useState } from 'react';
import { DeleteOutlined, LockOutlined, PlusOutlined, ReloadOutlined, UnlockOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  addDhcpLease,
  deleteDhcpLease,
  fetchDhcpDashboard,
  fetchPoolLeases,
  fixStaticDhcpLease,
  unfixStaticDhcpLease,
  wipePoolLeases,
} from '@/api/dhcp';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { DataTableShell } from '@/components/data-table/DataTableShell';
import { DataTableToolbar } from '@/components/data-table/DataTableToolbar';
import { TableFreshness } from '@/components/data-table/TableFreshness';
import { IpAddress, MacAddress, MonoValue } from '@/components/display/MonoValue';
import { Timestamp } from '@/components/display/Timestamp';
import { dhcpUtilMeta, peerStatusMeta } from '@/design/status';
import { SITES } from '@/data/bank';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { toError } from '@/lib/errors';
import { tablePagination, tableScroll } from '@/lib/table';
import type { DhcpDashboard, DhcpLease, DhcpPool } from '@/types/dhcp';

export default function DhcpPage() {
  const { site, setSite, get, patch } = useSiteFilter();
  const poolParam = get('pool');
  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState<DhcpDashboard | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [leases, setLeases] = useState<DhcpLease[]>([]);
  const [leasesLoading, setLeasesLoading] = useState(false);
  const [leasesError, setLeasesError] = useState<Error | null>(null);
  const [leasesLoaded, setLeasesLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [fixTarget, setFixTarget] = useState<DhcpLease | null>(null);
  const [form] = Form.useForm();
  const [fixForm] = Form.useForm();

  const loadDashboard = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchDhcpDashboard();
      setDashboard(data);
      setError(null);
    } catch (cause) {
      setError(toError(cause, 'Could not load DHCP dashboard'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLeases = useCallback(async (subnetId: number, silent = false) => {
    if (!silent) setLeasesLoading(true);
    try {
      setLeases(await fetchPoolLeases(subnetId));
      setLeasesError(null);
      setLeasesLoaded(true);
    } catch (cause) {
      setLeasesError(toError(cause, 'Could not load leases'));
    } finally {
      setLeasesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const filteredPools = useMemo(() => {
    const pools = dashboard?.pools ?? [];
    if (site === 'all') return pools;
    return pools.filter((pool) => pool.site === site);
  }, [dashboard, site]);

  const selectedPool = useMemo(() => {
    const id = Number(poolParam);
    if (!Number.isFinite(id)) return null;
    return filteredPools.find((pool) => pool.subnetId === id) ?? dashboard?.pools?.find((pool) => pool.subnetId === id) ?? null;
  }, [dashboard, filteredPools, poolParam]);

  useEffect(() => {
    if (selectedPool && site !== 'all' && selectedPool.site !== site) {
      patch({ pool: null });
    }
  }, [patch, selectedPool, site]);

  const selectedSubnetId = selectedPool?.subnetId;

  useEffect(() => {
    if (selectedSubnetId == null) {
      setLeasesLoaded(false);
      return;
    }
    void loadLeases(selectedSubnetId);
  }, [selectedSubnetId, loadLeases]);

  const selectPool = (pool: DhcpPool) => {
    patch({ pool: String(pool.subnetId), site: pool.site });
  };

  const openFixStatic = (record: DhcpLease) => {
    setFixTarget(record);
    fixForm.setFieldsValue({ note: record.note || '' });
    setFixOpen(true);
  };

  const confirmUnfixStatic = (record: DhcpLease) => {
    Modal.confirm({
      title: `Bỏ fix IP ${record.ip}?`,
      content: (
        <div>
          Xóa host reservation của <Typography.Text code>{record.ip}</Typography.Text> /{' '}
          <Typography.Text code>{record.mac}</Typography.Text>
          {record.note ? (
            <>
              . Note: <Typography.Text type="secondary">{record.note}</Typography.Text>
            </>
          ) : null}
          . Lease hiện tại vẫn giữ, IP sẽ trở lại pool động.
        </div>
      ),
      okText: 'Bỏ fix IP',
      onOk: async () => {
        await unfixStaticDhcpLease({
          ip: record.ip,
          mac: record.mac,
          subnetId: record.subnetId,
        });
        message.success(`Đã bỏ fix IP ${record.ip}`);
        if (selectedPool) await loadLeases(selectedPool.subnetId, true);
        await loadDashboard(true);
      },
    });
  };

  const confirmDeleteLease = (record: DhcpLease) => {
    Modal.confirm({
      title: `Delete lease ${record.ip}?`,
      content: (
        <div>
          Call Kea lease4-del for {record.ip} / {record.mac}
          {selectedPool ? ` in ${selectedPool.name}` : ''}.
        </div>
      ),
      okText: 'Delete lease',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteDhcpLease(record.ip);
        message.success(`Deleted lease ${record.ip}`);
        if (selectedPool) await loadLeases(selectedPool.subnetId, true);
        await loadDashboard(true);
      },
    });
  };

  const confirmWipePool = () => {
    if (!selectedPool) return;
    Modal.confirm({
      title: `Wipe ALL leases in ${selectedPool.name}?`,
      content: (
        <div>
          This deletes every lease in {selectedPool.site} {selectedPool.name} ({selectedPool.subnet}). This cannot be undone from NetConsole.
        </div>
      ),
      okText: 'Wipe pool',
      okButtonProps: { danger: true },
      onOk: async () => {
        await wipePoolLeases(selectedPool.subnetId);
        message.success('Wiped leases');
        await loadLeases(selectedPool.subnetId, true);
        await loadDashboard(true);
      },
    });
  };

  if (loading && !dashboard) return <PageSkeleton />;
  if (error && !dashboard) {
    return <ErrorState title="DHCP unavailable" error={error} onRetry={() => void loadDashboard()} />;
  }

  return (
    <div className="nc-page">
      <StaleDataBanner error={dashboard ? error : null} onRetry={() => void loadDashboard(true)} />
      <DataTableToolbar
        leading={
          <Select
            style={{ minWidth: 160 }}
            value={site}
            onChange={setSite}
            options={[{ value: 'all', label: 'All sites' }, ...SITES.map((item) => ({ value: item.code, label: item.code }))]}
          />
        }
        trailing={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadDashboard()}>
            Reload
          </Button>
        }
      />

      {dashboard ? (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} lg={8}>
              <Card bordered={false} size="small" title="Kea DC HA">
                <Typography.Text type="secondary">Mode: {dashboard.ha?.mode || '—'}</Typography.Text>
                <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={8}>
                  {(dashboard.ha?.peers ?? []).map((peer) => (
                    <Space key={peer.name} style={{ width: '100%', justifyContent: 'space-between' }}>
                      <div>
                        <Typography.Text strong>{peer.name}</Typography.Text>
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {peer.role}
                            {peer.state ? ` · ${peer.state}` : ''}
                            {dashboard.ha?.active === peer.name ? ' · active' : ''}
                          </Typography.Text>
                        </div>
                      </div>
                      <StatusDot meta={peerStatusMeta(peer.reachable)} />
                    </Space>
                  ))}
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={16}>
              <Card bordered={false} size="small" title="Pools">
                {filteredPools.length === 0 ? (
                  <EmptyState title="No pools" />
                ) : (
                  <Row gutter={[8, 8]}>
                    {filteredPools.map((pool) => {
                      const active = selectedPool?.subnetId === pool.subnetId;
                      const util = dhcpUtilMeta(pool.utilization);
                      return (
                        <Col xs={24} md={12} xl={8} key={pool.subnetId}>
                          <Card
                            size="small"
                            hoverable
                            onClick={() => selectPool(pool)}
                            style={{
                              borderColor: active ? 'var(--nc-accent, #3b82f6)' : undefined,
                              cursor: 'pointer',
                            }}
                          >
                            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                              <Typography.Text strong>{pool.name}</Typography.Text>
                              <StatusDot meta={util} />
                            </Space>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {pool.site} · VLAN {pool.vlan}
                            </Typography.Text>
                            <div>
                              <MonoValue value={pool.subnet} />
                            </div>
                            <Progress
                              percent={pool.utilization}
                              size="small"
                              status={util.tone === 'error' ? 'exception' : util.tone === 'warning' ? 'active' : 'normal'}
                              format={() => `${pool.utilization}% · ${pool.leased}/${pool.poolSize}`}
                            />
                          </Card>
                        </Col>
                      );
                    })}
                  </Row>
                )}
              </Card>
            </Col>
          </Row>

          <StaleDataBanner error={leasesLoaded ? leasesError : null} onRetry={() => selectedPool && void loadLeases(selectedPool.subnetId, true)} />
          <DataTableShell
            title={selectedPool ? `Leases · ${selectedPool.name}` : 'Leases'}
            count={selectedPool ? leases.length : 0}
            freshness={<TableFreshness refreshing={leasesLoading} />}
            extra={
              selectedPool ? (
                <Space wrap>
                  <Button
                    icon={<PlusOutlined />}
                    onClick={() => {
                      form.setFieldsValue({ subnetId: selectedPool.subnetId, ip: '', mac: '', hostname: '' });
                      setAddOpen(true);
                    }}
                  >
                    Add lease
                  </Button>
                  <Button danger icon={<DeleteOutlined />} onClick={confirmWipePool}>
                    Wipe pool
                  </Button>
                  <Button icon={<ReloadOutlined />} loading={leasesLoading} onClick={() => void loadLeases(selectedPool.subnetId)}>
                    Refresh
                  </Button>
                </Space>
              ) : null
            }
          >
            {!selectedPool ? (
              <EmptyState title="Select a pool" description="Choose a DHCP pool to load leases." />
            ) : leasesError && !leasesLoaded ? (
              <ErrorState title="Could not load leases" error={leasesError} onRetry={() => void loadLeases(selectedPool.subnetId)} />
            ) : (
              <Table
                rowKey={(record) => `${record.ip}-${record.mac}`}
                size="small"
                loading={leasesLoading && leases.length === 0}
                dataSource={leases}
                locale={{ emptyText: <EmptyState title="No leases in this pool" /> }}
                pagination={tablePagination}
                scroll={tableScroll}
                sticky
                columns={[
                  { title: 'IP', dataIndex: 'ip', width: 140, render: (value: string) => <IpAddress value={value} /> },
                  { title: 'MAC', dataIndex: 'mac', width: 160, render: (value: string) => <MacAddress value={value} /> },
                  { title: 'Hostname', dataIndex: 'hostname', ellipsis: true, render: (value: string) => value || '—' },
                  {
                    title: 'Note',
                    dataIndex: 'note',
                    ellipsis: true,
                    width: 180,
                    render: (value: string | undefined) => value || '—',
                  },
                  {
                    title: 'State',
                    width: 100,
                    render: (_value, record) => (
                      <Tag color={record.reserved || record.stateLabel === 'static' ? 'success' : 'blue'}>
                        {record.reserved ? 'static' : record.stateLabel}
                      </Tag>
                    ),
                  },
                  {
                    title: 'Expires',
                    dataIndex: 'expiresAt',
                    width: 140,
                    render: (value: string | null) => <Timestamp value={value} />,
                  },
                  {
                    title: '',
                    width: 210,
                    align: 'right',
                    render: (_value, record) => (
                      <Space>
                        {record.reserved ? (
                          <Button
                            size="small"
                            icon={<UnlockOutlined />}
                            onClick={() => confirmUnfixStatic(record)}
                          >
                            Bỏ fix IP
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            type="primary"
                            icon={<LockOutlined />}
                            onClick={() => openFixStatic(record)}
                          >
                            Fix IP
                          </Button>
                        )}
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDeleteLease(record)}>
                          Delete
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </DataTableShell>
        </>
      ) : null}

      <Modal
        open={addOpen}
        destroyOnClose
        title="Add DHCP lease"
        okText="Add"
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const values = await form.validateFields();
          await addDhcpLease({
            ip: values.ip,
            mac: values.mac,
            subnetId: Number(values.subnetId),
            hostname: values.hostname,
          });
          message.success(`Added lease ${values.ip}`);
          setAddOpen(false);
          if (selectedPool) await loadLeases(selectedPool.subnetId, true);
          await loadDashboard(true);
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="subnetId" label="Subnet ID" rules={[{ required: true }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="ip" label="IP address" rules={[{ required: true, message: 'Enter IP' }]}>
            <Input placeholder="172.30.10.130" />
          </Form.Item>
          <Form.Item name="mac" label="MAC address" rules={[{ required: true, message: 'Enter MAC' }]}>
            <Input placeholder="aa:bb:cc:10:01:30" />
          </Form.Item>
          <Form.Item name="hostname" label="Hostname">
            <Input placeholder="optional" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={fixOpen}
        destroyOnClose
        title={fixTarget ? `Fix static IP ${fixTarget.ip}` : 'Fix static IP'}
        okText="Fix IP"
        onCancel={() => {
          setFixOpen(false);
          setFixTarget(null);
        }}
        onOk={async () => {
          if (!fixTarget) return;
          const values = await fixForm.validateFields();
          await fixStaticDhcpLease({
            ip: fixTarget.ip,
            mac: fixTarget.mac,
            subnetId: fixTarget.subnetId,
            hostname: fixTarget.hostname || undefined,
            note: values.note,
          });
          message.success(`Fixed static IP ${fixTarget.ip} ↔ ${fixTarget.mac}`);
          setFixOpen(false);
          setFixTarget(null);
          if (selectedPool) await loadLeases(selectedPool.subnetId, true);
          await loadDashboard(true);
        }}
      >
        {fixTarget ? (
          <Form form={fixForm} layout="vertical">
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              Reserve <Typography.Text code>{fixTarget.ip}</Typography.Text> for MAC{' '}
              <Typography.Text code>{fixTarget.mac}</Typography.Text>
              {fixTarget.hostname ? <> ({fixTarget.hostname})</> : null}.
            </Typography.Paragraph>
            <Form.Item name="note" label="Note" extra="Ghi chú cho reservation này (tùy chọn, tối đa 200 ký tự).">
              <Input.TextArea rows={3} maxLength={200} showCount placeholder="VD: VPC5 lab / máy kế toán" />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
