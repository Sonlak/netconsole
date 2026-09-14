import { useEffect, useRef, useState } from 'react';
import { Button, Space, Typography, Empty, Select } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { SavedConfigEntry } from '@/api/configCompare';
import { fetchConfigHistory } from '@/api/configCompare';
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
  accent: '#60a5fa',
} as const;

interface ConfigCompareProps {
  deviceId: string;
  currentConfig: string;
}

// ── Diff computation (LCS) ────────────────────────────────────────────────────
type DiffLine = { type: 'unchanged' | 'removed' | 'added'; content: string; leftLine: number; rightLine: number };

function computeDiff(leftLines: string[], rightLines: string[]): DiffLine[] {
  const m = leftLines.length;
  const n = rightLines.length;
  let prev = Array(n + 1).fill(0);
  let curr = Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const tmp = prev; prev = curr; curr = tmp;
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      if (leftLines[i - 1] === rightLines[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = Math.max(curr[j - 1], prev[j]);
    }
  }
  const result: DiffLine[] = [];
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
  return result;
}

// ── Split view (synchronized) ────────────────────────────────────────────────
function SplitView({ leftLines, rightLines, leftLabel, rightLabel }: {
  leftLines: string[]; rightLines: string[]; leftLabel: string; rightLabel: string;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const sync = (src: 'left' | 'right') => {
    if (syncing.current) return;
    syncing.current = true;
    const srcEl = src === 'left' ? leftRef.current : rightRef.current;
    const dstEl = src === 'left' ? rightRef.current : leftRef.current;
    if (srcEl && dstEl) dstEl.scrollTop = srcEl.scrollTop;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 340px)', minHeight: 400 }}>
      {/* Left = current */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}` }}>
        <div style={{
          padding: '6px 12px', background: C.panel, borderBottom: `1px solid ${C.border}`,
          fontSize: 11, color: C.accent, fontWeight: 600, flexShrink: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={leftLabel}>{leftLabel}</div>
        <div ref={leftRef} onScroll={() => sync('left')} style={{ flex: 1, overflowY: 'auto', background: C.bg }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <tbody>
              {Array.from({ length: maxLines }, (_, idx) => {
                const right = rightLines[idx] ?? '';
                const isGap = !right;
                return (
                  <tr key={idx} style={{ background: isGap ? C.panelAlt : undefined }}>
                    <td style={{ width: 44, padding: '1px 4px', textAlign: 'right', color: C.textMuted, fontSize: 11, userSelect: 'none', borderRight: `1px solid ${C.border}`, fontFamily: '"JetBrains Mono", Consolas, monospace' }}>{idx + 1}</td>
                    <td style={{ padding: '1px 8px', fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 12, lineHeight: 1.6, color: isGap ? C.textMuted : C.text, whiteSpace: 'pre' }}>
                      {right || <span style={{ color: C.textMuted }}>…</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right = old */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          padding: '6px 12px', background: C.panel, borderBottom: `1px solid ${C.border}`,
          fontSize: 11, color: C.accent, fontWeight: 600, flexShrink: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={rightLabel}>{rightLabel}</div>
        <div ref={rightRef} onScroll={() => sync('right')} style={{ flex: 1, overflowY: 'auto', background: C.bg }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <tbody>
              {Array.from({ length: maxLines }, (_, idx) => {
                const left = leftLines[idx] ?? '';
                const isGap = !left;
                return (
                  <tr key={idx} style={{ background: isGap ? C.panelAlt : undefined }}>
                    <td style={{ width: 44, padding: '1px 4px', textAlign: 'right', color: C.textMuted, fontSize: 11, userSelect: 'none', borderRight: `1px solid ${C.border}`, fontFamily: '"JetBrains Mono", Consolas, monospace' }}>{idx + 1}</td>
                    <td style={{ padding: '1px 8px', fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 12, lineHeight: 1.6, color: isGap ? C.textMuted : C.text, whiteSpace: 'pre' }}>
                      {left || <span style={{ color: C.textMuted }}>…</span>}
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

// ── Unified view ─────────────────────────────────────────────────────────────
function UnifiedView({ diffLines, leftLabel, rightLabel }: {
  diffLines: DiffLine[]; leftLabel: string; rightLabel: string;
}) {
  const stats = {
    added: diffLines.filter(l => l.type === 'added').length,
    removed: diffLines.filter(l => l.type === 'removed').length,
  };
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', gap: 16, padding: '6px 12px',
        background: C.panel, borderBottom: `1px solid ${C.border}`, fontSize: 12, flexShrink: 0,
      }}>
        <Typography.Text style={{ color: C.addedText }}>+{stats.added} dòng thêm</Typography.Text>
        <Typography.Text style={{ color: C.removedText }}>−{stats.removed} dòng bớt</Typography.Text>
        <Typography.Text style={{ color: C.textMuted }}>{leftLabel}</Typography.Text>
        <Typography.Text type="secondary" style={{ color: C.textMuted, marginLeft: 'auto' }}>← {rightLabel}</Typography.Text>
      </div>
      <div ref={containerRef} style={{
        maxHeight: 'calc(100vh - 400px)', overflowY: 'auto',
        fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 12, lineHeight: 1.6, background: C.bg,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <tbody>
            {diffLines.map((line, idx) => (
              <tr key={idx} style={{
                background: line.type === 'added' ? C.added
                  : line.type === 'removed' ? C.removed
                  : idx % 2 === 0 ? C.panelAlt : C.bg,
              }}>
                <td style={{ width: 20, padding: '1px 4px', textAlign: 'center', color: C.textMuted, userSelect: 'none', borderRight: `1px solid ${C.border}`, fontSize: 10 }}>
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
                </td>
                <td style={{ width: 48, padding: '1px 4px', textAlign: 'right', color: C.textMuted, userSelect: 'none', borderRight: `1px solid ${C.border}`, fontSize: 10 }}>
                  {line.leftLine > 0 ? line.leftLine : ''}
                </td>
                <td style={{ width: 48, padding: '1px 4px', textAlign: 'right', color: C.textMuted, userSelect: 'none', borderRight: `1px solid ${C.border}`, fontSize: 10 }}>
                  {line.rightLine > 0 ? line.rightLine : ''}
                </td>
                <td style={{ padding: '1px 8px', color: line.type === 'added' ? C.addedText : line.type === 'removed' ? C.removedText : C.text, whiteSpace: 'pre' }}>
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

// ── Main component ───────────────────────────────────────────────────────────
export function ConfigCompare({ deviceId, currentConfig }: ConfigCompareProps) {
  const [history, setHistory] = useState<SavedConfigEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<Error | null>(null);
  const [selectedOldId, setSelectedOldId] = useState<string>('');
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('unified');

  // Load commit history
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

  const selectedOld = history.find((h) => h.id === selectedOldId) ?? history[0];
  const leftLines = currentConfig.split('\n');
  const rightLines = (selectedOld?.content ?? '').split('\n');
  const diffLines = computeDiff(leftLines, rightLines);

  const leftLabel = `Running config hiện tại · ${leftLines.length} dòng · ${dayjs().format('DD/MM/YYYY HH:mm')}`;
  const rightLabel = `${selectedOld.label} · ${rightLines.length} dòng · ${dayjs(selectedOld.timestamp).format('DD/MM/YYYY HH:mm')}`;

  return (
    <div>
      {/* Controls */}
      <div style={{ marginBottom: 12 }}>
        <Space wrap align="center" size="middle">
          <Typography.Text style={{ color: C.textDim, fontSize: 12 }}>So với:</Typography.Text>
          <Select
            size="small"
            style={{ minWidth: 300 }}
            value={selectedOldId || history[0]?.id}
            onChange={(v) => setSelectedOldId(v)}
            options={history.map((h) => ({
              value: h.id,
              label: (
                <Space size={4}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                    background: h.label.startsWith('Đã commit') ? '#1a3a2a'
                      : h.label.startsWith('Rollback') ? '#3a2a1a' : '#1a2a3a',
                    color: h.label.startsWith('Đã commit') ? '#4ade80'
                      : h.label.startsWith('Rollback') ? '#fbbf24' : '#60a5fa',
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
          <Space size={4}>
            <Typography.Text style={{ color: C.textMuted, fontSize: 11 }}>Xem:</Typography.Text>
            <Button size="small" type={viewMode === 'unified' ? 'primary' : 'default'} onClick={() => setViewMode('unified')} style={{ fontSize: 11 }}>unified</Button>
            <Button size="small" type={viewMode === 'split' ? 'primary' : 'default'} onClick={() => setViewMode('split')} style={{ fontSize: 11 }}>split</Button>
          </Space>
          <Typography.Text style={{ color: C.textMuted, fontSize: 11 }}>
            {diffLines.filter(l => l.type === 'added').length} thêm · {diffLines.filter(l => l.type === 'removed').length} bớt
          </Typography.Text>
        </Space>
      </div>

      {viewMode === 'split' ? (
        <SplitView leftLines={leftLines} rightLines={rightLines} leftLabel={leftLabel} rightLabel={rightLabel} />
      ) : (
        <UnifiedView diffLines={diffLines} leftLabel={leftLabel} rightLabel={rightLabel} />
      )}
    </div>
  );
}
