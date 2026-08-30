import { Link } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudDownloadOutlined, RollbackOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Input, Modal, Select, Space, Typography, message } from 'antd';
import { triggerDeviceConfig } from '@/api/deviceOperations';
import {
  ackCommitJob,
  ackRollbackJob,
  commitGenerateConfig,
  fetchConfigTemplates,
  fetchGenerateConfig,
  renderConfigTemplate,
  rollbackGenerateConfig,
  saveGenerateConfig,
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
import { SITES, deviceFloor, deviceSite, floorLabel, floorNumbers, floorsMatch, isKnownSite } from '@/data/bank';
import { useDevices } from '@/hooks/useDevices';
import { useSiteFilter } from '@/hooks/useSiteFilter';
import { toError } from '@/lib/errors';

export default function GenerateConfigPage() {
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
    <div className="nc-page">
      <StaleDataBanner error={templates.length ? templatesError : null} onRetry={() => void loadTemplates()} />
      {devicesError && devices.length === 0 ? (
        <ErrorState title="Could not load devices" error={devicesError} onRetry={() => void refetchDevices()} />
      ) : null}

      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Config Studio
      </Typography.Title>

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
    </div>
  );
}
