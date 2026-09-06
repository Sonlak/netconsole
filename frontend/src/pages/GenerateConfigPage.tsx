import { Link } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckSquareOutlined,
  CloudDownloadOutlined,
  FilterOutlined,
  RocketOutlined,
  RollbackOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { triggerDeviceConfig } from '@/api/deviceOperations';
import {
  ackCommitJob,
  ackRollbackJob,
  bulkCommitGenerateConfig,
  commitGenerateConfig,
  fetchConfigTemplates,
  fetchGenerateConfig,
  previewBulkConfig,
  renderConfigTemplate,
  rollbackGenerateConfig,
  saveGenerateConfig,
  type BulkCommitResult,
  type ConfigRole,
  type ConfigTemplateMeta,
  type DeviceSavedConfig,
} from '@/api/generateConfig';
import { JobWaitTimeoutError, waitForJob, waitForJobIfNeeded } from '@/api/jobs';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { StatusDot } from '@/components/common/StatusDot';
import { StaleDataBanner } from '@/components/common/StaleDataBanner';
import { Timestamp } from '@/components/display/Timestamp';
import ManagedChecksTags from '@/components/ManagedChecksTags';
import { SITES, deviceFloor, deviceRole, deviceSite, floorLabel, floorNumbers, floorsMatch, isKnownSite } from '@/data/bank';
import { useDevices } from '@/hooks/useDevices';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { toError } from '@/lib/errors';
import type { Device } from '@/types/device';

const BULK_ROLE_OPTIONS: Exclude<ConfigRole, 'custom'>[] = ['core', 'dist', 'access'];
const BULK_ROLE_LABEL: Record<Exclude<ConfigRole, 'custom'>, string> = {
  core: 'Core (L3)',
  dist: 'Distribution (L2/L3)',
  access: 'Access switch',
};

export default function GenerateConfigPage() {
  return (
    <div className="nc-page">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Config Studio
      </Typography.Title>
      <Tabs
        defaultActiveKey="single"
        items={[
          {
            key: 'single',
            label: 'Single device',
            children: <SingleDevicePanel />,
          },
          {
            key: 'bulk',
            label: 'Bulk deploy',
            children: <BulkDeployPanel />,
          },
        ]}
      />
    </div>
  );
}

function SingleDevicePanel() {
  const { site, setSite, get, patch } = useSiteFilter();
  const { devices, isLoading: loadingDevices, error: devicesError, refetch: refetchDevices } = useDevices();
  const [templates, setTemplates] = useState<ConfigTemplateMeta[]>([]);
  const [templatesError, setTemplatesError] = useState<Error | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [floor, setFloor] = useState(get('floor') || '');
  const [deviceId, setDeviceId] = useState(get('device') || '');
  const [role, setRole] = useState<Exclude<ConfigRole, 'custom'>>('core');
  const [running, setRunning] = useState('');
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [saved, setSaved] = useState<DeviceSavedConfig | null>(null);
  const [collectedAt, setCollectedAt] = useState<string | null>(null);
  const [runningSource, setRunningSource] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [stateError, setStateError] = useState<Error | null>(null);
  const [renderError, setRenderError] = useState<Error | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [deviceRpcError, setDeviceRpcError] = useState<string | null>(null);
  const dirty = draft !== baseline;
  const urlDevice = get('device') || '';
  const urlFloor = get('floor') || '';

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const list = await fetchConfigTemplates();
      setTemplates(Array.isArray(list) ? list : []);
      setTemplatesError(null);
    } catch (cause) {
      setTemplatesError(toError(cause, 'Could not load templates'));
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (urlDevice !== deviceId) setDeviceId(urlDevice);
  }, [urlDevice]);

  useEffect(() => {
    if (urlFloor !== floor) setFloor(urlFloor);
  }, [urlFloor]);

  const floorOptions = useMemo(() => {
    if (site !== 'all' && isKnownSite(site)) {
      return ['CORE', 'DIST', ...floorNumbers(site).map((n) => floorLabel(n))];
    }
    return Array.from(
      new Set(
        devices
          .filter((item) => site === 'all' || deviceSite(item) === site)
          .map((item) => deviceFloor(item))
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [devices, site]);

  const deviceOptions = useMemo(
    () => devices.filter((item) => (site === 'all' || deviceSite(item) === site) && (!floor || floorsMatch(item, floor))),
    [devices, site, floor],
  );

  const selectedDevice = useMemo(() => devices.find((item) => item.id === deviceId) ?? null, [devices, deviceId]);

  const loadState = useCallback(async (id: string, options?: { keepRunning?: boolean; keepDraft?: boolean }) => {
    setLoadingState(true);
    setStateError(null);
    try {
      const state = await fetchGenerateConfig(id);
      setRole(state.suggestedRole === 'dist' || state.suggestedRole === 'access' ? state.suggestedRole : 'core');
      if (!options?.keepRunning) {
        setRunning(state.running?.config || '');
        setCollectedAt(state.running?.collectedAt ?? null);
        setRunningJobId(state.running?.jobId ?? null);
        setRunningSource(state.running?.source ?? null);
      }
      setSaved(state.saved);
      if (!options?.keepDraft) {
        const nextDraft = state.saved?.content || '';
        setDraft(nextDraft);
        setBaseline(nextDraft);
      }
    } catch (cause) {
      setStateError(toError(cause, 'Could not load config state'));
    } finally {
      setLoadingState(false);
    }
  }, []);

  useEffect(() => {
    setStateError(null);
    setRenderError(null);
    setDeviceRpcError(null);
    if (deviceId) void loadState(deviceId);
    else {
      setRunning('');
      setDraft('');
      setBaseline('');
      setSaved(null);
      setCollectedAt(null);
    }
  }, [deviceId, loadState]);

  const confirmIfDirty = (next: () => void) => {
    if (!dirty) {
      next();
      return;
    }
    Modal.confirm({
      title: 'Discard unsaved draft?',
      content: 'The current draft has unsaved changes.',
      okText: 'Discard',
      onOk: next,
    });
  };

  const changeDevice = (nextId: string) => {
    confirmIfDirty(() => {
      setDeviceId(nextId);
      patch({ device: nextId || null });
    });
  };

  const collectRunning = async () => {
    if (!deviceId || !selectedDevice) return;
    setCollecting(true);
    try {
      const { job } = await triggerDeviceConfig(deviceId);
      const finished = await waitForJobIfNeeded(job, { timeoutMs: 20000 });
      if (!finished) throw new Error('Job not available');
      if (finished.status === 'FAILED') throw new Error(finished.error || 'Config collection failed');
      await loadState(deviceId, { keepDraft: true });
      message.success('Collected running config from device');
    } catch (cause) {
      if (cause instanceof JobWaitTimeoutError) {
        message.warning(
          <span>
            {cause.message} — <Link to="/jobs">open Jobs</Link>
          </span>,
        );
      } else {
        message.error(cause instanceof Error ? cause.message : 'Could not collect config');
      }
    } finally {
      setCollecting(false);
    }
  };

  const applyTemplate = async (nextRole: Exclude<ConfigRole, 'custom'>) => {
    if (!deviceId || !selectedDevice) return;
    const run = async () => {
      try {
        const rendered = await renderConfigTemplate(nextRole, deviceId);
        setRole(nextRole);
        setDraft(rendered.content);
        setRenderError(null);
        message.success(`Loaded ${nextRole} template`);
      } catch (cause) {
        setRenderError(toError(cause, 'Could not render template'));
        message.error(cause instanceof Error ? cause.message : 'Could not render template');
      }
    };
    confirmIfDirty(() => void run());
  };

  const onSave = async () => {
    if (!deviceId || !selectedDevice) return;
    setSaving(true);
    try {
      const next = await saveGenerateConfig(deviceId, { content: draft, role });
      setSaved(next);
      setBaseline(draft);
      message.success('Draft saved in NetConsole (not pushed to the device)');
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const showDeviceRpcError = (title: string, detail: string) => {
    setDeviceRpcError(detail);
    Modal.error({
      title,
      width: 720,
      content: (
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
          {detail}
        </Typography.Paragraph>
      ),
    });
  };

  const onCommit = () => {
    if (!deviceId || !selectedDevice || !draft.trim()) return;
    Modal.confirm({
      title: `Commit config to ${selectedDevice.name}?`,
      content: (
        <div>
          <div>
            {selectedDevice.name} · {selectedDevice.ip} · {deviceSite(selectedDevice)} / {deviceFloor(selectedDevice)}
          </div>
          <div>Draft length: {draft.length} characters</div>
          <Typography.Paragraph type="warning" style={{ marginTop: 8, marginBottom: 0 }}>
            This pushes configuration onto the live device.
          </Typography.Paragraph>
        </div>
      ),
      okText: 'Commit to device',
      onOk: async () => {
        setCommitting(true);
        setDeviceRpcError(null);
        try {
          const { job } = await commitGenerateConfig(deviceId, { content: draft, role });
          try {
            const finished = await waitForJob(job.id, { timeoutMs: 90000 });
            if (finished.status === 'FAILED') {
              throw new Error(finished.error || 'Commit failed');
            }
            const next = await ackCommitJob(job.id);
            setSaved(next);
            setBaseline(draft);
            await loadState(deviceId, { keepDraft: true });
            message.success('Committed to device');
          } catch (cause) {
            if (cause instanceof JobWaitTimeoutError) {
              message.warning(
                <span>
                  Commit still running — <Link to={`/jobs?q=${job.id}`}>open Jobs</Link>
                </span>,
              );
              return;
            }
            throw cause;
          }
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : 'Commit failed';
          showDeviceRpcError('Commit failed', detail);
        } finally {
          setCommitting(false);
        }
      },
    });
  };

  const onRollback = () => {
    if (!deviceId || !selectedDevice || !saved?.rollbackContent) return;
    Modal.confirm({
      title: `Rollback ${selectedDevice.name}?`,
      content: (
        <div>
          Restore the previous committed config on {selectedDevice.name} ({selectedDevice.ip}).
        </div>
      ),
      okText: 'Rollback',
      onOk: async () => {
        setRollingBack(true);
        setDeviceRpcError(null);
        try {
          const { job } = await rollbackGenerateConfig(deviceId);
          try {
            const finished = await waitForJob(job.id, { timeoutMs: 90000 });
            if (finished.status === 'FAILED') {
              throw new Error(finished.error || 'Rollback failed');
            }
            const next = await ackRollbackJob(job.id);
            setSaved(next);
            setDraft(next.content);
            setBaseline(next.content);
            await loadState(deviceId, { keepDraft: true });
            message.success('Rolled back on device');
          } catch (cause) {
            if (cause instanceof JobWaitTimeoutError) {
              message.warning(
                <span>
                  Rollback still running — <Link to={`/jobs?q=${job.id}`}>open Jobs</Link>
                </span>,
              );
              return;
            }
            throw cause;
          }
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : 'Rollback failed';
          showDeviceRpcError('Rollback failed', detail);
        } finally {
          setRollingBack(false);
        }
      },
    });
  };

  const managed = selectedDevice?.status === 'MANAGED';
  const runningLabel = running
    ? `Source: ${runningSource || 'device collection'}${runningJobId ? ` · job ${runningJobId}` : ''}`
    : 'Not collected';

  if (templatesLoading && templates.length === 0) return <PageSkeleton />;
  if (templatesError && templates.length === 0) {
    return <ErrorState title="Could not load config templates" error={templatesError} onRetry={() => void loadTemplates()} />;
  }

  return (
    <>
      <StaleDataBanner error={templates.length ? templatesError : null} onRetry={() => void loadTemplates()} />
      {devicesError && devices.length === 0 ? (
        <ErrorState title="Could not load devices" error={devicesError} onRetry={() => void refetchDevices()} />
      ) : null}

      <Card bordered={false} style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select
            value={site}
            disabled={loadingDevices}
            style={{ width: 140 }}
            onChange={(value) => {
              confirmIfDirty(() => {
                setSite(value);
                setFloor('');
                setDeviceId('');
                patch({ floor: null, device: null });
              });
            }}
            options={[{ value: 'all', label: 'All sites' }, ...SITES.map((item) => ({ value: item.code, label: item.code }))]}
          />
          <Select
            value={floor}
            style={{ width: 140 }}
            onChange={(value) => {
              confirmIfDirty(() => {
                setFloor(value);
                setDeviceId('');
                patch({ floor: value || null, device: null });
              });
            }}
            options={[{ value: '', label: 'All floors' }, ...floorOptions.map((value) => ({ value, label: value }))]}
          />
          <Select
            value={deviceId}
            style={{ minWidth: 280 }}
            onChange={changeDevice}
            options={[{ value: '', label: 'Select device' }, ...deviceOptions.map((item) => ({ value: item.id, label: `${item.name} (${item.ip})` }))]}
          />
          {selectedDevice ? <StatusDot status={selectedDevice.status} /> : null}
          {selectedDevice ? <ManagedChecksTags checks={selectedDevice.managedChecks} /> : null}
          {selectedDevice ? <Link to={`/devices/${selectedDevice.id}?tab=config`}>{selectedDevice.name}</Link> : null}
        </Space>
      </Card>

      {!deviceId ? (
        <EmptyState title="Select a device" description="Choose site, floor, and device to load running config and draft from the API." />
      ) : stateError && !running && !draft ? (
        <ErrorState title="Could not load config state" error={stateError} onRetry={() => void loadState(deviceId)} />
      ) : (
        <>
          {selectedDevice && !managed ? (
            <Alert
              showIcon
              type="warning"
              style={{ marginBottom: 12 }}
              message="Commit / rollback only run when the device is MANAGED"
            />
          ) : null}
          {deviceRpcError ? (
            <Alert
              showIcon
              closable
              type="error"
              style={{ marginBottom: 12 }}
              message="Device rejected the config"
              description={<pre className="nc-code-block" style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{deviceRpcError}</pre>}
              onClose={() => setDeviceRpcError(null)}
            />
          ) : null}
          {dirty ? (
            <Alert showIcon type="info" style={{ marginBottom: 12 }} message="Unsaved draft changes" />
          ) : null}
          <StaleDataBanner error={renderError} />
          <StaleDataBanner error={stateError} onRetry={() => void loadState(deviceId, { keepDraft: true, keepRunning: true })} />

          <div className="nc-config-grid">
            <Card
              bordered={false}
              title="Running config"
              extra={
                <Button icon={<CloudDownloadOutlined />} loading={collecting} onClick={() => void collectRunning()}>
                  Collect
                </Button>
              }
            >
              <Typography.Paragraph type="secondary">
                {runningLabel}
                {collectedAt ? (
                  <>
                    {' '}
                    · collected <Timestamp value={collectedAt} />
                  </>
                ) : (
                  ' · Not collected'
                )}
              </Typography.Paragraph>
              <Input.TextArea
                className="nc-code-area"
                value={running}
                readOnly
                autoSize={{ minRows: 22, maxRows: 28 }}
                placeholder="No running config collected"
              />
            </Card>
            <Card
              bordered={false}
              title="Draft"
              extra={
                saved?.updatedAt ? (
                  <span>
                    Saved in NetConsole <Timestamp value={saved.updatedAt} />
                  </span>
                ) : (
                  'Unsaved'
                )
              }
            >
              <Space wrap style={{ marginBottom: 8 }}>
                {templates.map((item) => (
                  <Button
                    key={item.id}
                    type={role === item.id ? 'primary' : 'default'}
                    disabled={!deviceId}
                    onClick={() => void applyTemplate(item.id)}
                  >
                    {item.label}
                  </Button>
                ))}
              </Space>
              <Typography.Paragraph type="secondary">
                Template: {templates.find((item) => item.id === role)?.label || role}
                {saved ? ` · last saved role ${saved.role}` : ''}
              </Typography.Paragraph>
              <Input.TextArea
                className="nc-code-area"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoSize={{ minRows: 18, maxRows: 24 }}
                disabled={!deviceId || loadingState}
                placeholder="Load a Core / Dist / Access template from the API"
              />
            </Card>
          </div>

          <Card bordered={false} style={{ marginTop: 12 }} title="Review actions">
            <Space wrap>
              <Button icon={<SaveOutlined />} disabled={!deviceId} loading={saving} onClick={() => void onSave()}>
                Save draft
              </Button>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                disabled={!deviceId || !managed || !draft.trim()}
                loading={committing}
                onClick={onCommit}
              >
                Commit
              </Button>
              <Button
                icon={<RollbackOutlined />}
                disabled={!deviceId || !managed || !saved?.rollbackContent}
                loading={rollingBack}
                onClick={onRollback}
              >
                Rollback
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              Save draft stores config in NetConsole only. Commit pushes to the device.
              {saved?.committedAt ? (
                <>
                  {' '}
                  Last commit <Timestamp value={saved.committedAt} />.
                </>
              ) : (
                ' No commit recorded.'
              )}
              {saved?.rollbackContent ? ' Rollback is available.' : ' No rollback state.'}
            </Typography.Paragraph>
          </Card>
        </>
      )}
    </>
  );
}

function BulkDeployPanel() {
  const { site, setSite } = useSiteFilter();
  const { devices, isLoading: loadingDevices, error: devicesError, refetch: refetchDevices } = useDevices();

  type BulkMode = 'template' | 'draft';

  const [mode, setMode] = useState<BulkMode>('template');
  const [role, setRole] = useState<Exclude<ConfigRole, 'custom'>>('access');
  const [draft, setDraft] = useState('');
  const [floorFilter, setFloorFilter] = useState('');
  const [search, setSearch] = useState('');
  const [managedOnly, setManagedOnly] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [previewDeviceId, setPreviewDeviceId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [lastResult, setLastResult] = useState<BulkCommitResult | null>(null);

  // Devices in scope for the chosen role (+ site + floor + search + managed-only).
  // In draft mode every role is in scope — the user is writing their own
  // config, so role-based filtering doesn't apply.
  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return devices
      .filter((d) => mode === 'draft' || deviceRole(d) === role)
      .filter((d) => site === 'all' || deviceSite(d) === site)
      .filter((d) => !floorFilter || floorsMatch(d, floorFilter))
      .filter((d) => !needle || `${d.name} ${d.ip}`.toLowerCase().includes(needle))
      .filter((d) => !managedOnly || d.status === 'MANAGED');
  }, [devices, role, site, floorFilter, search, managedOnly, mode]);

  // Floor options scoped to the chosen role so the dropdown doesn't offer
  // empty buckets ("ACCESS at F12" when no access switch lives on F12).
  const floorOptions = useMemo(() => {
    const inScope =
      mode === 'draft'
        ? devices.filter((d) => site === 'all' || deviceSite(d) === site)
        : devices.filter((d) => deviceRole(d) === role && (site === 'all' || deviceSite(d) === site));
    const set = new Set(inScope.map((d) => deviceFloor(d)).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [devices, role, site, mode]);

  // Stats per role for the segmented header.
  const roleCounts = useMemo(() => {
    const out: Record<Exclude<ConfigRole, 'custom'>, { total: number; managed: number }> = {
      core: { total: 0, managed: 0 },
      dist: { total: 0, managed: 0 },
      access: { total: 0, managed: 0 },
    };
    for (const d of devices) {
      const r = deviceRole(d);
      out[r].total += 1;
      if (d.status === 'MANAGED') out[r].managed += 1;
    }
    return out;
  }, [devices]);

  // Drop selections that fell out of the candidate set (e.g. floor changed).
  useEffect(() => {
    const candidateIds = new Set(candidates.map((d) => d.id));
    setSelected((current) => current.filter((id) => candidateIds.has(id)));
    if (previewDeviceId && !candidateIds.has(previewDeviceId)) {
      setPreviewDeviceId(null);
      setPreviewContent('');
    }
  }, [candidates, previewDeviceId]);

  const previewDevice = useMemo(
    () => (previewDeviceId ? candidates.find((d) => d.id === previewDeviceId) ?? null : null),
    [candidates, previewDeviceId],
  );

  const loadPreview = useCallback(
    async (deviceId: string) => {
      setPreviewDeviceId(deviceId);
      setPreviewContent('');
      setPreviewLoading(true);
      try {
        if (mode === 'template') {
          const out = await previewBulkConfig(role, deviceId);
          setPreviewContent(out.content);
        } else {
          // Draft mode: every device receives the same literal string.
          setPreviewContent(draft);
        }
      } catch (cause) {
        setPreviewContent('');
        message.error(cause instanceof Error ? cause.message : 'Could not render template for preview');
      } finally {
        setPreviewLoading(false);
      }
    },
    [role, mode, draft],
  );

  // When switching into draft mode, refresh the preview pane so the user
  // sees the literal draft (not a stale template render).
  useEffect(() => {
    if (mode === 'draft' && previewDeviceId) {
      setPreviewContent(draft);
      setPreviewLoading(false);
    }
  }, [mode, previewDeviceId, draft]);

  const toggleDevice = (id: string, checked: boolean) => {
    setSelected((current) => {
      const set = new Set(current);
      if (checked) set.add(id);
      else set.delete(id);
      return Array.from(set);
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? candidates.map((d) => d.id) : []);
  };

  const allChecked = candidates.length > 0 && candidates.every((d) => selected.includes(d.id));
  const someChecked = !allChecked && candidates.some((d) => selected.includes(d.id));

  const selectedDevices = useMemo(
    () => candidates.filter((d) => selected.includes(d.id)),
    [candidates, selected],
  );

  const managedSelected = selectedDevices.filter((d) => d.status === 'MANAGED').length;
  const unmanagedSelected = selectedDevices.length - managedSelected;

  const draftValid = mode === 'draft' ? draft.trim().length > 0 : true;
  const canDeploy = selectedDevices.length > 0 && managedSelected > 0 && draftValid;

  const deployDescription = () => {
    if (mode === 'template') {
      return (
        <Typography.Paragraph style={{ marginBottom: 6 }}>
          Renders the <strong>{BULK_ROLE_LABEL[role]}</strong> template per device and queues one
          <code> APPLY_CONFIG </code>job each. Worker runs them in parallel.
        </Typography.Paragraph>
      );
    }
    return (
      <Typography.Paragraph style={{ marginBottom: 6 }}>
        Pushes the literal draft below verbatim to every selected device and queues one
        <code> APPLY_CONFIG </code>job each. The same {draft.trim().length} characters of config
        land on every device — no per-device rendering.
      </Typography.Paragraph>
    );
  };

  const confirmDeploy = () => {
    if (!canDeploy) return;
    const okLabel = mode === 'template'
      ? `Deploy to ${managedSelected}`
      : `Push draft to ${managedSelected}`;
    const titleSuffix = mode === 'template'
      ? `${BULK_ROLE_LABEL[role]} template to ${managedSelected} device(s)?`
      : `this literal draft to ${managedSelected} device(s)?`;
    Modal.confirm({
      width: 720,
      title: mode === 'template' ? `Deploy ${titleSuffix}` : `Push ${titleSuffix}`,
      content: (
        <div>
          {deployDescription()}
          {unmanagedSelected > 0 ? (
            <Alert
              showIcon
              type="warning"
              style={{ marginBottom: 8 }}
              message={`${unmanagedSelected} selected device(s) are not MANAGED — they will be skipped.`}
            />
          ) : null}
          <Typography.Paragraph type="secondary" style={{ marginBottom: 6 }}>
            First 10 selected:
          </Typography.Paragraph>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {selectedDevices.slice(0, 10).map((d) => (
              <li key={d.id}>
                <code>{d.name}</code> · {d.ip} · {deviceSite(d)} / {deviceFloor(d)} · {d.status}
              </li>
            ))}
            {selectedDevices.length > 10 ? <li>… and {selectedDevices.length - 10} more</li> : null}
          </ul>
          <Typography.Paragraph type="warning" style={{ marginTop: 8, marginBottom: 0 }}>
            This pushes configuration onto the live devices.
          </Typography.Paragraph>
        </div>
      ),
      okText: okLabel,
      onOk: async () => {
        setDeploying(true);
        try {
          const managedIds = selectedDevices.filter((d) => d.status === 'MANAGED').map((d) => d.id);
          const result =
            mode === 'template'
              ? await bulkCommitGenerateConfig(managedIds, { role })
              : await bulkCommitGenerateConfig(managedIds, { content: draft });
          setLastResult(result);
          if (result.jobs.length > 0) {
            message.success(
              <span>
                Queued {result.jobs.length} job(s) —{' '}
                <Link to={`/jobs?type=APPLY_CONFIG`}>open Jobs</Link>
              </span>,
            );
          }
          if (result.skipped.length > 0) {
            message.warning(`Skipped ${result.skipped.length} device(s): ${result.skipped[0].reason}`);
          }
          // Deselect everything that just got a job; keep selection visible
          // for unmanaged devices so the user can fix their status first.
          setSelected((current) =>
            current.filter((id) => !result.jobs.some((j) => j.deviceId === id)),
          );
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : 'Bulk deploy failed');
        } finally {
          setDeploying(false);
        }
      },
    });
  };

  if (loadingDevices && devices.length === 0) return <PageSkeleton />;
  if (devicesError && devices.length === 0) {
    return <ErrorState title="Could not load devices" error={devicesError} onRetry={() => void refetchDevices()} />;
  }

  return (
    <>
      <Card bordered={false} style={{ marginBottom: 12 }} title="Bulk deploy config to many devices">
        <Space wrap size={12} align="center">
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as BulkMode)}
            options={[
              { value: 'template', label: 'By template (rendered per device)' },
              { value: 'draft', label: 'Custom draft (applied as-is)' },
            ]}
          />
        </Space>
        <Space wrap size={12} align="center" style={{ marginTop: 12 }}>
          {mode === 'template' ? (
            <Segmented
              value={role}
              onChange={(value) => setRole(value as Exclude<ConfigRole, 'custom'>)}
              options={BULK_ROLE_OPTIONS.map((r) => ({
                value: r,
                label: `${BULK_ROLE_LABEL[r]} (${roleCounts[r].managed}/${roleCounts[r].total})`,
              }))}
            />
          ) : (
            <Typography.Text type="secondary">
              Draft mode — all roles are eligible. Pick any device below.
            </Typography.Text>
          )}
          <Select
            value={site}
            style={{ width: 140 }}
            onChange={setSite}
            options={[{ value: 'all', label: 'All sites' }, ...SITES.map((item) => ({ value: item.code, label: item.code }))]}
          />
          <Select
            value={floorFilter}
            style={{ width: 140 }}
            onChange={setFloorFilter}
            options={[{ value: '', label: 'All floors' }, ...floorOptions.map((value) => ({ value, label: value }))]}
          />
          <Input
            prefix={<FilterOutlined />}
            placeholder="Search name or IP"
            style={{ width: 220 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
          <Checkbox checked={managedOnly} onChange={(e) => setManagedOnly(e.target.checked)}>
            Managed only
          </Checkbox>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          {candidates.length} candidate(s){' '}
          {mode === 'template' ? (
            <>
              for the <strong>{BULK_ROLE_LABEL[role]}</strong> template
            </>
          ) : (
            <>across all roles</>
          )}
          {managedOnly ? ' (managed only)' : ''}. Selected {selected.length}.
        </Typography.Paragraph>
      </Card>

      {mode === 'draft' ? (
        <Card
          bordered={false}
          style={{ marginBottom: 12 }}
          title="Draft config (applied verbatim to every selected device)"
          extra={
            <Space size={4}>
              <Tag>{draft.length} chars</Tag>
              <Tag color={draft.trim() ? 'green' : 'orange'}>
                {draft.trim() ? 'ready' : 'empty'}
              </Tag>
            </Space>
          }
        >
          <Input.TextArea
            className="nc-code-area"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 14, maxRows: 28 }}
            placeholder={`# Same content sent to every selected device.
# Use plain Junos set ... lines — no per-device templating.
set system host-name PLACEHOLDER
set system services ssh
set system services netconf ssh`}
          />
          <Typography.Paragraph type="warning" style={{ marginTop: 8, marginBottom: 0 }}>
            The exact bytes you write here are pushed to every selected device. There is no
            per-device hostname/IP substitution. Use the template mode if each device needs its
            own identity.
          </Typography.Paragraph>
        </Card>
      ) : null}

      <div className="nc-config-grid">
        <Card
          bordered={false}
          title={
            <Space>
              <Checkbox
                indeterminate={someChecked}
                checked={allChecked}
                disabled={candidates.length === 0}
                onChange={(e) => toggleAll(e.target.checked)}
              >
                Devices
              </Checkbox>
              <Tag color="blue">{candidates.length}</Tag>
            </Space>
          }
          extra={
            <Button
              size="small"
              type="link"
              disabled={selected.length === 0}
              onClick={() => setSelected([])}
            >
              Clear
            </Button>
          }
          bodyStyle={{ padding: 0 }}
        >
          {candidates.length === 0 ? (
            <div style={{ padding: 24 }}>
              <Empty description="No devices match the current filter" />
            </div>
          ) : (
            <ul className="nc-bulk-device-list">
              {candidates.map((d) => (
                <BulkDeviceRow
                  key={d.id}
                  device={d}
                  checked={selected.includes(d.id)}
                  previewing={previewDeviceId === d.id}
                  onToggle={(checked) => toggleDevice(d.id, checked)}
                  onPreview={() => void loadPreview(d.id)}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card
          bordered={false}
          title={mode === 'template' ? 'Preview (per device)' : 'Preview (literal draft)'}
        >
          {mode === 'template' ? (
            previewDevice ? (
              <>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  <strong>{previewDevice.name}</strong> · {previewDevice.ip} · {deviceSite(previewDevice)} /{' '}
                  {deviceFloor(previewDevice)} · <Tag>{BULK_ROLE_LABEL[role]}</Tag>
                </Typography.Paragraph>
                <Input.TextArea
                  className="nc-code-area"
                  value={previewLoading ? '' : previewContent}
                  readOnly
                  autoSize={{ minRows: 22, maxRows: 28 }}
                  placeholder={previewLoading ? 'Rendering template…' : 'Click a device to preview the rendered config'}
                />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  Each device gets the same template rendered with its own hostname + IP. Selecting more devices
                  does NOT change this preview — only the chosen device drives the rendering.
                </Typography.Paragraph>
              </>
            ) : (
              <Empty description="Pick a device on the left to preview what will be applied." />
            )
          ) : (
            <>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                <Tag color="purple">Draft mode</Tag>
                <Typography.Text type="secondary">
                  Below is the verbatim draft that will be pushed to every selected device.
                </Typography.Text>
              </Typography.Paragraph>
              <Input.TextArea
                className="nc-code-area"
                value={previewLoading ? '' : previewContent}
                readOnly
                autoSize={{ minRows: 22, maxRows: 28 }}
                placeholder={
                  draft.trim()
                    ? 'Waiting for click — click any device to view the draft in this pane.'
                    : 'Type your draft in the card above. It will appear here once you pick a device.'
                }
              />
              {previewDevice ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  Target: <strong>{previewDevice.name}</strong> · {previewDevice.ip}
                </Typography.Paragraph>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Card bordered={false} style={{ marginTop: 12 }} title="Deploy">
        <Space wrap align="center">
          <Button
            type="primary"
            icon={<RocketOutlined />}
            disabled={!canDeploy}
            loading={deploying}
            onClick={confirmDeploy}
          >
            {mode === 'template'
              ? `Deploy ${BULK_ROLE_LABEL[role]} template to ${managedSelected} device(s)`
              : `Push draft to ${managedSelected} device(s)`}
          </Button>
          <Button
            icon={<CheckSquareOutlined />}
            disabled={selected.length === 0}
            onClick={() => setSelected([])}
          >
            Clear selection
          </Button>
          <Typography.Text type="secondary">
            {selected.length} selected · {managedSelected} managed · {unmanagedSelected} skipped
            {mode === 'draft' && !draftValid ? ' · draft empty' : ''}
          </Typography.Text>
        </Space>
        {lastResult ? (
          <Alert
            showIcon
            type={lastResult.skipped.length === 0 ? 'success' : 'warning'}
            style={{ marginTop: 12 }}
            message={
              <span>
                Last deploy: <strong>{lastResult.jobs.length}</strong> job(s) queued,{' '}
                <strong>{lastResult.skipped.length}</strong> skipped.{' '}
                <Link to="/jobs?type=APPLY_CONFIG">Track on Jobs page</Link>
              </span>
            }
          />
        ) : null}
      </Card>
    </>
  );
}

function BulkDeviceRow({
  device,
  checked,
  previewing,
  onToggle,
  onPreview,
}: {
  device: Device;
  checked: boolean;
  previewing: boolean;
  onToggle: (checked: boolean) => void;
  onPreview: () => void;
}) {
  const managed = device.status === 'MANAGED';
  return (
    <li className={`nc-bulk-device-row${previewing ? ' is-previewing' : ''}`}>
      <Checkbox checked={checked} disabled={!managed} onChange={(e) => onToggle(e.target.checked)}>
        <span className="nc-bulk-device-row-name">{device.name}</span>
        <span className="nc-bulk-device-row-meta">{device.ip} · {deviceSite(device)} / {deviceFloor(device)}</span>
        <StatusDot status={device.status} />
        {!managed ? <Tag color="orange">skip — not MANAGED</Tag> : null}
      </Checkbox>
      <Button size="small" type="link" onClick={onPreview}>
        {previewing ? 'Re-render' : 'Preview'}
      </Button>
    </li>
  );
}
