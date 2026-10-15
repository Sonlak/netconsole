/**
 * NetBox Import / Copy page.
 *
 * Workflow:
 *   1. Pick target NetBox instance (production / netbox2 / etc.)
 *   2. Choose data:
 *        - Upload CSV file (parsed client-side, sent as JSON rows)
 *        - Copy from another instance (paste source instance + filters)
 *   3. Configure (overwrite vs skip conflict)
 *   4. Preview dry-run → confirm → import
 *
 * CSV format (one of):
 *   - Name-based: prefix, status, description, site, vrf, tenant, vlan, role, tags
 *     (tags = semicolon-separated slugs, e.g. "production;cn-pgd")
 *   - ID-based (output of _dump_netbox_prefixes_v2.py):
 *     prefix, status, description, site_id, vrf_id, tenant_id, vlan_id,
 *     role_id, is_pool, mark_utilized, comments, tags, custom_fields
 */

import { useCallback, useEffect, useState } from 'react';
import { CloudServerOutlined, CopyOutlined, FileExcelOutlined, ImportOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { UploadProps } from 'antd';
import {
  copyPrefixes,
  fetchNetboxHealth,
  fetchNetboxInstances,
  fetchNetboxPrefixes,
  importPrefixes,
  type ImportPrefixRow,
} from '@/api/netbox';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { toError } from '@/lib/errors';

const { Dragger } = Upload;
const { Title: MyTitle } = Typography;

// ─── CSV parsing (name-based) ─────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    if (cols.length === 0) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length && j < cols.length; j++) {
      row[headers[j]] = cols[j].trim();
    }
    if (row.prefix) rows.push(row);
  }
  return rows;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Detect whether the CSV uses *_id columns (output of v2 export). */
function detectCsvFormat(headers: string[]): 'id' | 'name' {
  const lower = headers.map((h) => h.toLowerCase());
  return lower.includes('site_id') || lower.includes('vrf_id') ? 'id' : 'name';
}

function csvRowsToImportRows(rows: Record<string, string>[]): ImportPrefixRow[] {
  if (rows.length === 0) return [];
  const format = detectCsvFormat(Object.keys(rows[0]));
  return rows.map((r) => {
    if (format === 'id') {
      // Pass site_id/vrf_id/etc directly as name fields too — the backend
      // tries to resolve them via get-or-create. If the column is a
      // numeric ID and no matching object exists, it falls through.
      // For pure ID-based import we send the raw ID; backend will
      // numeric-validate and skip on mismatch.
      return {
        prefix: r.prefix,
        status: r.status || 'active',
        description: r.description || '',
        site: r.site || r.site_id,
        vrf: r.vrf || r.vrf_id,
        tenant: r.tenant || r.tenant_id,
        vlan: r.vlan ? Number(r.vlan) : undefined,
        role: r.role || r.role_id,
        tags: r.tags ? r.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : undefined,
      };
    }
    return {
      prefix: r.prefix,
      status: r.status || 'active',
      description: r.description || '',
      site: r.site || undefined,
      vrf: r.vrf || undefined,
      tenant: r.tenant || undefined,
      vlan: r.vlan ? Number(r.vlan) : undefined,
      role: r.role || undefined,
      tags: r.tags ? r.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : undefined,
    };
  });
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function NetBoxImportPage() {
  const [instances, setInstances] = useState<string[]>([]);
  const [defaultInstance, setDefaultInstance] = useState<string>('production');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Target instance + health
  const [target, setTarget] = useState<string>('');
  const [targetHealth, setTargetHealth] = useState<{ ok: boolean } | null>(null);

  // Tab 1 — CSV upload
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvRows, setCsvRows] = useState<ImportPrefixRow[]>([]);
  const [csvFormat, setCsvFormat] = useState<'name' | 'id'>('name');
  const [overwrite, setOverwrite] = useState(false);

  // Tab 2 — Copy from instance
  const [copySource, setCopySource] = useState<string>('');
  const [copyTenant, setCopyTenant] = useState<string>('');
  const [copySite, setCopySite] = useState<string>('');
  const [copyOverwrite, setCopyOverwrite] = useState(false);
  const [copyPreviewCount, setCopyPreviewCount] = useState<number | null>(null);

  // Result
  const [importResult, setImportResult] = useState<{
    total: number;
    created: number;
    skipped: number;
    updated: number;
    errors: number;
    details?: Array<{ action: string; prefix: string; error?: string }>;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  // Load instances on mount
  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchNetboxInstances();
        setInstances(data.instances);
        setDefaultInstance(data.default);
        setTarget(data.default);
        setCopySource(data.default);
      } catch (cause) {
        setError(toError(cause, 'Could not load NetBox instances'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Check target health when target changes
  useEffect(() => {
    if (!target) return;
    void (async () => {
      try {
        const h = await fetchNetboxHealth(target);
        setTargetHealth({ ok: h.ok });
      } catch {
        setTargetHealth({ ok: false });
      }
    })();
  }, [target]);

  // CSV file handler
  const handleFile: UploadProps['beforeUpload'] = (file) => {
    setCsvFile(file);
    void (async () => {
      try {
        const text = await file.text();
        const parsed = parseCsv(text);
        const fmt = parsed.length > 0 ? detectCsvFormat(Object.keys(parsed[0])) : 'name';
        setCsvFormat(fmt);
        setCsvRows(csvRowsToImportRows(parsed));
        message.success(`Loaded ${parsed.length} rows from ${file.name} (${fmt === 'id' ? 'ID-based' : 'name-based'} format)`);
      } catch (cause) {
        message.error(`Could not read CSV: ${toError(cause).message}`);
      }
    })();
    return false; // prevent auto-upload
  };

  // Pre-flight preview for copy-from-instance
  const previewCopy = useCallback(async () => {
    if (!copySource || !target) return;
    try {
      const rows = await fetchNetboxPrefixes(copySource, 1000);
      const filtered = rows.filter((r) => {
        if (copyTenant && r.tenant?.name !== copyTenant) return false;
        if (copySite && r.site?.name !== copySite) return false;
        return true;
      });
      setCopyPreviewCount(filtered.length);
    } catch (cause) {
      setError(toError(cause, 'Could not preview copy'));
    }
  }, [copySource, copyTenant, copySite, target]);

  // Run copy
  const runCopy = useCallback(async () => {
    if (!copySource || !target) {
      message.error('Source and target instances required');
      return;
    }
    if (copySource === target) {
      message.error('Source and target must differ');
      return;
    }
    setImporting(true);
    try {
      const result = await copyPrefixes(copySource, target, {
        overwrite: copyOverwrite,
        tenant_filter: copyTenant || undefined,
        site_filter: copySite || undefined,
      });
      setImportResult(result);
      message.success(`Copied ${result.total} prefixes to ${target}`);
    } catch (cause) {
      message.error(`Copy failed: ${toError(cause).message}`);
    } finally {
      setImporting(false);
    }
  }, [copySource, copyTenant, copySite, target, copyOverwrite]);

  // Run CSV import
  const runCsvImport = useCallback(async () => {
    if (csvRows.length === 0) {
      message.error('No rows to import — upload a CSV first');
      return;
    }
    if (!target) {
      message.error('Pick a target instance');
      return;
    }
    setImporting(true);
    try {
      const result = await importPrefixes(csvRows, {
        instance: target,
        overwrite,
      });
      setImportResult(result);
      message.success(`Imported ${result.total} prefixes to ${target}`);
    } catch (cause) {
      message.error(`Import failed: ${toError(cause).message}`);
    } finally {
      setImporting(false);
    }
  }, [csvRows, target, overwrite]);

  if (loading) return <PageSkeleton />;
  if (error) {
    return <Alert type="error" message="Failed to load" description={error.toString()} showIcon />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Row gutter={16} align="middle">
          <Col flex="auto">
            <Space size="middle">
              <CloudServerOutlined style={{ fontSize: 28, color: '#1677ff' }} />
              <div>
                <MyTitle level={4} style={{ margin: 0 }}>NetBox Import / Copy</MyTitle>
                <Typography.Text type="secondary">
                  Upload CSV hoặc copy prefix từ 1 NetBox instance sang instance khác.
                </Typography.Text>
              </div>
            </Space>
          </Col>
          <Col>
            <Form layout="inline">
              <Form.Item label="Target instance">
                <Space>
                  <Select
                    value={target}
                    onChange={setTarget}
                    style={{ width: 240 }}
                    options={instances.map((i) => ({ value: i, label: i === defaultInstance ? `${i} (default)` : i }))}
                  />
                  {targetHealth && (
                    <Tag color={targetHealth.ok ? 'success' : 'error'}>
                      {targetHealth.ok ? 'reachable' : 'unreachable'}
                    </Tag>
                  )}
                </Space>
              </Form.Item>
            </Form>
          </Col>
        </Row>
      </Card>

      <Tabs
        defaultActiveKey="csv"
        items={[
          {
            key: 'csv',
            label: <span><FileExcelOutlined /> Upload CSV</span>,
            children: (
              <Card>
                <Steps
                  current={csvRows.length > 0 ? 1 : 0}
                  items={[
                    { title: 'Upload', description: 'Pick a CSV file' },
                    { title: 'Preview', description: `${csvRows.length} rows (${csvFormat === 'id' ? 'ID' : 'name'}-based)` },
                    { title: 'Import', description: `Send to "${target}"` },
                  ]}
                />
                <Divider />

                <Dragger
                  name="file"
                  accept=".csv,text/csv"
                  multiple={false}
                  beforeUpload={handleFile}
                  showUploadList={false}
                  style={{ padding: 16 }}
                >
                  <p className="ant-upload-drag-icon">
                    <FileExcelOutlined />
                  </p>
                  <p className="ant-upload-text">
                    {csvFile ? csvFile.name : 'Kéo thả CSV vào đây, hoặc click để chọn file'}
                  </p>
                  <p className="ant-upload-hint">
                    Cột bắt buộc: <code>prefix</code>. Tuỳ chọn: status, description, site, vrf, tenant, vlan, role, tags (semicolon-separated).
                    Hỗ trợ cả 2 format: name-based và ID-based (output của _dump_netbox_prefixes_v2.py).
                  </p>
                </Dragger>

                <Divider />

                <Form layout="vertical">
                  <Row gutter={16}>
                    <Col flex="auto">
                      <Form.Item label="Options">
                        <Checkbox
                          checked={overwrite}
                          onChange={(e) => setOverwrite(e.target.checked)}
                        >
                          Overwrite existing prefixes (PATCH) — nếu không tick thì skip hành động đã tồn tại (mặc định, an toàn)
                        </Checkbox>
                      </Form.Item>
                    </Col>
                    <Col>
                      <Space>
                        <Button onClick={() => { setCsvFile(null); setCsvRows([]); }} disabled={!csvFile}>
                          Clear
                        </Button>
                        <Button
                          type="primary"
                          icon={<ImportOutlined />}
                          loading={importing}
                          disabled={csvRows.length === 0 || !target}
                          onClick={() => void runCsvImport()}
                        >
                          Import {csvRows.length} prefixes
                        </Button>
                      </Space>
                    </Col>
                  </Row>
                </Form>

                {csvRows.length > 0 && (
                  <Card type="inner" title={`Preview (first 20 of ${csvRows.length} rows)`} style={{ marginTop: 16 }}>
                    <Table
                      size="small"
                      dataSource={csvRows.slice(0, 20)}
                      rowKey={(row) => `${row.prefix}-${row.site}-${row.vlan}`}
                      pagination={false}
                      scroll={{ x: true }}
                      columns={[
                        { title: 'prefix', dataIndex: 'prefix', width: 150 },
                        { title: 'status', dataIndex: 'status', width: 90 },
                        { title: 'description', dataIndex: 'description', ellipsis: true },
                        { title: 'site', dataIndex: 'site', width: 100 },
                        { title: 'vrf', dataIndex: 'vrf', width: 100 },
                        { title: 'tenant', dataIndex: 'tenant', width: 130 },
                        { title: 'vlan', dataIndex: 'vlan', width: 70 },
                        { title: 'role', dataIndex: 'role', width: 100 },
                        {
                          title: 'tags',
                          dataIndex: 'tags',
                          render: (t: string[] | undefined) => (t ?? []).map((x) => <Tag key={x}>{x}</Tag>),
                        },
                      ]}
                    />
                  </Card>
                )}
              </Card>
            ),
          },
          {
            key: 'copy',
            label: <span><CopyOutlined /> Copy từ instance</span>,
            children: (
              <Card>
                <Steps
                  current={copyPreviewCount !== null ? 1 : 0}
                  items={[
                    { title: 'Configure', description: 'Source + filters' },
                    { title: 'Preview', description: copyPreviewCount !== null ? `${copyPreviewCount} prefixes` : 'count' },
                    { title: 'Copy', description: `Send to "${target}"` },
                  ]}
                />
                <Divider />

                <Form layout="vertical">
                  <Row gutter={16}>
                    <Col span={8}>
                      <Form.Item label="Source instance" required>
                        <Select
                          value={copySource}
                          onChange={setCopySource}
                          options={instances.map((i) => ({ value: i, label: i }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item label="Filter by tenant (optional)">
                        <Input
                          value={copyTenant}
                          onChange={(e) => setCopyTenant(e.target.value)}
                          placeholder="TTDL Binh Duong"
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item label="Filter by site (optional)">
                        <Input
                          value={copySite}
                          onChange={(e) => setCopySite(e.target.value)}
                          placeholder="LAB"
                        />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item>
                    <Checkbox
                      checked={copyOverwrite}
                      onChange={(e) => setCopyOverwrite(e.target.checked)}
                    >
                      Overwrite existing prefixes ở target (PATCH) — không tick = skip
                    </Checkbox>
                  </Form.Item>

                  <Form.Item>
                    <Space>
                      <Button icon={<ReloadOutlined />} onClick={() => void previewCopy()}>
                        Preview count
                      </Button>
                      <Button
                        type="primary"
                        icon={<ThunderboltOutlined />}
                        loading={importing}
                        disabled={!copySource || copySource === target || !target}
                        onClick={() => void runCopy()}
                      >
                        Copy sang {target}
                      </Button>
                    </Space>
                  </Form.Item>

                  {copyPreviewCount !== null && (
                    <Alert
                      type="info"
                      showIcon
                      message={`Sẽ copy ${copyPreviewCount} prefixes từ "${copySource}" → "${target}"`}
                    />
                  )}
                </Form>
              </Card>
            ),
          },
        ]}
      />

      {importResult && (
        <Modal
          open={!!importResult}
          title={
            <Space>
              <ImportOutlined />
              <span>Import / Copy result</span>
            </Space>
          }
          onCancel={() => setImportResult(null)}
          footer={[
            <Button key="close" type="primary" onClick={() => setImportResult(null)}>
              Close
            </Button>,
          ]}
          width={720}
        >
          <Result
            status={importResult.errors === 0 ? 'success' : 'warning'}
            title={`${importResult.errors === 0 ? 'All done' : 'Completed with errors'}`}
            subTitle={
              <Space size="large" wrap>
                <Statistic title="Total" value={importResult.total} />
                <Statistic title="Created" value={importResult.created} valueStyle={{ color: '#3f8600' }} />
                <Statistic title="Updated" value={importResult.updated} valueStyle={{ color: '#1677ff' }} />
                <Statistic title="Skipped" value={importResult.skipped} />
                <Statistic title="Errors" value={importResult.errors} valueStyle={{ color: importResult.errors > 0 ? '#cf1322' : undefined }} />
              </Space>
            }
          />
          {importResult.details && importResult.details.length > 0 && (
            <Table
              size="small"
              dataSource={importResult.details}
              rowKey={(r, idx) => `${r.prefix}-${idx}`}
              pagination={{ pageSize: 10 }}
              scroll={{ y: 240 }}
              columns={[
                { title: 'prefix', dataIndex: 'prefix', width: 160 },
                {
                  title: 'action',
                  dataIndex: 'action',
                  width: 90,
                  render: (a: string) => (
                    <Tag color={a === 'created' ? 'green' : a === 'updated' ? 'blue' : a === 'skipped' ? 'default' : 'red'}>
                      {a}
                    </Tag>
                  ),
                },
                { title: 'error', dataIndex: 'error', ellipsis: true },
              ]}
            />
          )}
        </Modal>
      )}
    </Space>
  );
}