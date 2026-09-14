import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Space, Spin, Typography, Empty, Tooltip, Select } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { SavedConfigEntry, DiffSides } from '@/api/configCompare';
import { fetchConfigHistory, fetchSavedConfigDiff } from '@/api/configCompare';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { ErrorState } from '@/components/common/ErrorState';

dayjs.extend(relativeTime);

// ── Theme colors (dark) ──────────────────────────────────────────────────────
const C = {
  bg: '#161d27',
  panel: '#1e2530',
  panelAlt: '#232c3b',
  border: '#2a3444',
  text: '#e4e4e7',
  textDim: '#9ca3af',
  textMuted: '#6b7280',
  added: '#2d4a2d',
  addedText: '#4ade80',
  removed: '#4a2d2d',
  removedText: '#f87171',
  lineNum: '#3a4556',
  highlight: '#1e3a5f',
  accent: '#60a5fa',
} as const;

interface ConfigCompareProps {
  deviceId: string;
  /** Current running config from ConfigTab */
  currentConfig: string;
}

// ── Split pane with synchronized scrolling ────────────────────────────────────

function SplitDiffView({
  leftLabel,
  leftLines,
  rightLabel,
  rightLines,
}: {
  leftLabel: string;
  leftLines: string[];
  rightLabel: string;
  rightLines: string[];
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  const handleScroll = (source: 'left' | 'right') => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const src = source === 'left' ? leftRef.current : rightRef.current;
    const dst = source === 'left' ? rightRef.current : leftRef.current;
    if (src && dst) {
      dst.scrollTop = src.scrollTop;
    }
    requestAnimationFrame(() => { syncingRef.current = false; });
  };

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 340px)', minHeight: 400 }}>
      {/* Left panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}` }}>
        <div style={{
          padding: '6px 12px',
          background: C.panel,
          borderBottom: `1px solid ${C.border}`,
          fontSize: 11,
          color: C.accent,
          fontWeight: 600,
          flexShrink: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={leftLabel}>
          {leftLabel}
        </div>
        <div
          ref={leftRef}
          onScroll={() => handleScroll('left')}
          style={{ flex: 1, overflowY: 'auto', background: C.bg, margin: 0, padding: 0 }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', margin: 0 }}>
            <tbody>
              {Array.from({ length: maxLines }, (_, i) => {
                const left = leftLines[i] ?? '';
                const isEmpty = !left;
                return (
                  <tr key={i} style={{ background: isEmpty ? C.panelAlt : undefined }}>
                    <td style={{
                      width: 42,
                      padding: '1px 4px',
                      textAlign: 'right',
                      color: C.textMuted,
                      fontSize: 11,
                      userSelect: 'none',
                      borderRight: `1px solid ${C.border}`,
                      fontFamily: '"JetBrains Mono", Consolas, monospace',
                    }}>
                      {i + 1}
                    </td>
                    <td style={{
                      padding: '1px 8px',
                      fontFamily: '"JetBrains Mono", Consolas, monospace',
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: isEmpty ? C.textMuted : C.text,
                      whiteSpace: 'pre',
                    }}>
                      {left || <span style={{ color: C.textMuted }}>…</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          padding: '6px 12px',
          background: C.panel,
          borderBottom: `1px solid ${C.border}`,
          fontSize: 11,
          color: C.accent,
          fontWeight: 600,
          flexShrink: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={rightLabel}>
          {rightLabel}
        </div>
        <div
          ref={rightRef}
          onScroll={() => handleScroll('right')}
          style={{ flex: 1, overflowY: 'auto', background: C.bg, margin: 0, padding: 0 }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', margin: 0 }}>
            <tbody>
              {Array.from({ length: maxLines }, (_, i) => {
                const right = rightLines[i] ?? '';
                const isEmpty = !right;
                return (
                  <tr key={i} style={{ background: isEmpty ? C.panelAlt : undefined }}>
                    <td style={{
                      width: 42,
                      padding: '1px 4px',
                      textAlign: 'right',
                      color: C.textMuted,
                      fontSize: 11,
                      userSelect: 'none',
                      borderRight: `1px solid ${C.border}`,
                      fontFamily: '"JetBrains Mono", Consolas, monospace',
                    }}>
                      {i + 1}
                    </td>
                    <td style={{
                      padding: '1px 8px',
                      fontFamily: '"JetBrains Mono", Consolas, monospace',
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: isEmpty ? C.textMuted : C.text,
                      whiteSpace: 'pre',
                    }}>
                      {right || <span style={{ color: C.textMuted }}>…</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Unified diff line view (fallback) ─────────────────────────────────────────

function UnifiedDiffView({ diff }: { diff: DiffSides }) {
  const leftLines = diff.from.content.split('\n');
  const rightLines = diff.to.content.split('\n');

  // Simple LCS diff
  const m = leftLines.length;
  const n = rightLines.length;
  let prev: number[] = Array(n + 1).fill(0);
  let curr: number[] = Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    const tmp = prev; prev = curr; curr = tmp;
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      if (leftLines[i - 1] === rightLines[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = Math.max(curr[j - 1], prev[j]);
    }
  }

  type LineType = 'unchanged' | 'removed' | 'added' | 'context';
  const result: Array<{ type: LineType; content: string; leftLine: number; rightLine: number }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && leftLines[i - 1] === rightLines[j - 1]) {
      result.unshift({ type: 'unchanged', content: leftLines[i - 1], leftLine: i, rightLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || curr[j] === curr[j - 1])) {
      result.unshift({ type: 'added', content: rightLines[j - 1], leftLine: -1, rightLine: j });
      j--;
    } else {
      result.unshift({ type: 'removed', content: leftLines[i - 1], leftLine: i, rightLine: -1 });
      i--;
    }
  }

  const stats = {
    added: result.filter(r => r.type === 'added').length,
    removed: result.filter(r => r.type === 'removed').length,
    unchanged: result.filter(r => r.type === 'unchanged').length,
  };

  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div>
      {/* Stats bar */}
      <div style={{
        display: 'flex', gap: 16, padding: '6px 12px',
        background: C.panel, borderBottom: `1px solid ${C.border}`,
        fontSize: 12, flexShrink: 0,
      }}>
        <Typography.Text style={{ color: C.addedText }}>+{stats.added} dòng thêm</Typography.Text>
        <Typography.Text style={{ color: C.removedText }}>−{stats.removed} dòng bớt</Typography.Text>
        <Typography.Text style={{ color: C.textDim }}>{stats.unchanged} dòng giữ nguyên</Typography.Text>
      </div>

      {/* Unified diff */}
      <div ref={containerRef} style={{
        maxHeight: 'calc(100vh - 400px)',
        overflowY: 'auto',
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        background: C.bg,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <tbody>
            {result.map((line, idx) => (
              <tr key={idx} style={{
                background: line.type === 'added' ? C.added
                  : line.type === 'removed' ? C.removed
                  : idx % 2 === 0 ? C.panelAlt : C.bg,
              }}>
                <td style={{
                  width: 28, padding: '1px 4px', textAlign: 'center',
                  color: C.textMuted, userSelect: 'none',
                  borderRight: `1px solid ${C.border}`, fontSize: 10,
                }}>
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
                </td>
                <td style={{
                  width: 50, padding: '1px 4px', textAlign: 'right',
                  color: C.textMuted, userSelect: 'none',
                  borderRight: `1px solid ${C.border}`, fontSize: 10,
                }}>
                  {line.leftLine > 0 ? line.leftLine : ''}
                </td>
                <td style={{
                  width: 50, padding: '1px 4px', textAlign: 'right',
                  color: C.textMuted, userSelect: 'none',
                  borderRight: `1px solid ${C.border}`, fontSize: 10,
                }}>
                  {line.rightLine > 0 ? line.rightLine : ''}
                </td>
                <td style={{
                  padding: '1px 8px',
                  color: line.type === 'added' ? C.addedText
                    : line.type === 'removed' ? C.removedText
                    : C.text,
                  whiteSpace: 'pre',
                }}>
                  {line.content}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ConfigCompare({ deviceId, currentConfig }: ConfigCompareProps) {
  const [history, setHistory] = useState<SavedConfigEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<Error | null>(null);

  const [selectedOldId, setSelectedOldId] = useState<string>('');
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('unified');

  const [diffData, setDiffData] = useState<DiffSides | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<Error | null>(null);

  // ── Load commit history
  useEffect(() => {
    setLoadingHistory(true);
    fetchConfigHistory(deviceId)
      .then((data) => {
        setHistory(data);
        if (data.length >= 1) setSelectedOldId(data[0].id);
        setHistoryError(null);
      })
      .catch((e) => setHistoryError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoadingHistory(false));
  }, [deviceId]);

  // ── Load diff when old config selected
  const loadDiff = useCallback(async (oldId: string) => {
    if (!oldId) { setDiffData(null); return; }
    setLoadingDiff(true);
    setDiffError(null);
    try {
      const data = await fetchSavedConfigDiff(deviceId, oldId, '__current__');
      // Inject current config as the "to" side
      setDiffData({
        from: data.from,
        to: {
          id: '__current__',
          label: 'Running config hiện tại',
          content: currentConfig,
          timestamp: new Date().toISOString(),
          lineCount: currentConfig.split('\n').length,
        },
      });
    } catch (e) {
      setDiffError(e instanceof Error ? e : new Error(String(e)));
      setDiffData(null);
    } finally {
      setLoadingDiff(false);
    }
  }, [deviceId, currentConfig]);

  useEffect(() => {
    if (selectedOldId) void loadDiff(selectedOldId);
  }, [selectedOldId, loadDiff]);

  if (loadingHistory) return <PageSkeleton />;
  if (historyError) return <ErrorState title="Không tải được lịch sử commit" error={historyError} onRetry={() => window.location.reload()} />;

  if (history.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Chưa có commit nào. Dùng Config Studio để commit config trước."
      />
    );
  }

  const selectedOld = history.find((h) => h.id === selectedOldId);

  return (
    <div>
      {/* Controls */}
      <div style={{ marginBottom: 12 }}>
        <Space wrap align="center" size="middle">
          {/* Old config selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text style={{ color: C.textDim, fontSize: 12 }}>So với:</Typography.Text>
            <Select
              size="small"
              style={{ minWidth: 280 }}
              value={selectedOldId || undefined}
              onChange={(v) => setSelectedOldId(v)}
              options={history.map((h) => ({
                value: h.id,
                label: (
                  <Space size={4}>
                    <span style={{
                      padding: '1px 6px',
                      borderRadius: 3,
                      fontSize: 10,
                      fontWeight: 600,
                      background: h.label.startsWith('Đã commit') ? '#1a3a2a' : h.label.startsWith('Rollback') ? '#3a2a1a' : '#1a2a3a',
                      color: h.label.startsWith('Đã commit') ? '#4ade80' : h.label.startsWith('Rollback') ? '#fbbf24' : '#60a5fa',
                    }}>
                      {h.label.startsWith('Đã commit') ? 'COMMIT' : h.label.startsWith('Rollback') ? 'ROLLBACK' : 'DRAFT'}
                    </span>
                    <Typography.Text style={{ fontSize: 12, color: C.text }}>
                      {dayjs(h.timestamp).format('DD/MM/YYYY HH:mm')} · {h.role} · {h.content.split('\n').length}L
                    </Typography.Text>
                  </Space>
                ),
              }))}
            />
          </div>

          {/* View mode toggle */}
          <Space size={4}>
            <Typography.Text style={{ color: C.textMuted, fontSize: 11 }}>Xem:</Typography.Text>
            <Button
              size="small"
              type={viewMode === 'unified' ? 'primary' : 'default'}
              onClick={() => setViewMode('unified')}
              style={{ fontSize: 11 }}
            >
              unified
            </Button>
            <Button
              size="small"
              type={viewMode === 'split' ? 'primary' : 'default'}
              onClick={() => setViewMode('split')}
              style={{ fontSize: 11 }}
            >
              split
            </Button>
          </Space>

          {/* Swap */}
          <Tooltip title="Đổi chỗ">
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={() => setViewMode(viewMode === 'split' ? 'split' : 'unified')}
              style={{ display: 'none' }} // hidden — left is always current
            />
          </Tooltip>
        </Space>

        {/* Stats */}
        {diffData && (
          <div style={{ marginTop: 6 }}>
            <Space size="middle">
              <Typography.Text style={{ color: C.addedText, fontSize: 11 }}>
                +{diffData.to.content.split('\n').filter((l) => {
                  return !diffData.from.content.split('\n').includes(l);
                }).length} dòng thêm
              </Typography.Text>
              <Typography.Text style={{ color: C.removedText, fontSize: 11 }}>
                −{diffData.from.content.split('\n').filter((l) => {
                  return !diffData.to.content.split('\n').includes(l);
                }).length} dòng bớt
              </Typography.Text>
              <Typography.Text style={{ color: C.textMuted, fontSize: 11 }}>
                {selectedOld ? `${selectedOld.content.split('\n').length}L → ${currentConfig.split('\n').length}L` : ''}
              </Typography.Text>
            </Space>
          </div>
        )}
      </div>

      {/* Loading */}
      {loadingDiff && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
          <div style={{ marginTop: 8 }}>
            <Typography.Text style={{ color: C.textDim }}>Đang so sánh…</Typography.Text>
          </div>
        </div>
      )}

      {/* Error */}
      {diffError && !loadingDiff && (
        <ErrorState title="Lỗi so sánh" error={diffError} onRetry={() => void loadDiff(selectedOldId)} />
      )}

      {/* Diff views */}
      {diffData && !loadingDiff && (
        <>
          {viewMode === 'split' ? (
            <SplitDiffView
              leftLabel={`Running config hiện tại · ${diffData.to.lineCount} dòng · ${dayjs().format('DD/MM/YYYY HH:mm')}`}
              leftLines={diffData.to.content.split('\n')}
              rightLabel={`${selectedOld?.label ?? selectedOldId} · ${diffData.from.lineCount} dòng · ${selectedOld ? dayjs(selectedOld.timestamp).format('DD/MM/YYYY HH:mm') : ''}`}
              rightLines={diffData.from.content.split('\n')}
            />
          ) : (
            <div style={{
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              overflow: 'hidden',
            }}>
              <UnifiedDiffView diff={diffData} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
