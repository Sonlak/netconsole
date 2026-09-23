import { useEffect, useRef, useState } from 'react';
import { Button, Space, Typography, Empty, Select, DatePicker, Tag } from 'antd';
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
  // Entry type colours
  applyBg: '#1a2d1a',
  applyBorder: '#2d5a2d',
  applyText: '#86efac',
  snapshotBg: '#1e2530',
  snapshotBorder: '#2a3444',
  snapshotText: '#9ca3af',
} as const;

interface ConfigCompareProps {
  deviceId: string;
  currentConfig: string;
}

// ── Entry type badge ─────────────────────────────────────────────────────────
function EntryBadge({ entry }: { entry: SavedConfigEntry }) {
  if (entry.entryType === 'apply') {
    // Show who applied + source
    const userLabel = entry.username ?? 'system';
    const sourceLabel = entry.source
      ? SOURCE_LABELS[entry.source] ?? entry.source
      : null;
    return (
      <Space size={4}>
        <Tag
          color="green"
          style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
        >
          web apply
        </Tag>
        <Typography.Text style={{ color: C.applyText, fontSize: 11 }}>
          {userLabel}
        </Typography.Text>
        {sourceLabel && (
          <Typography.Text style={{ color: C.textMuted, fontSize: 10 }}>
            via {sourceLabel}
          </Typography.Text>
        )}
        {entry.configRole && (
          <Typography.Text style={{ color: C.textMuted, fontSize: 10 }}>
            [{entry.configRole}]
          </Typography.Text>
        )}
      </Space>
    );
  }
  // Snapshot: show CLI/scheduler indicator
  const isCli = entry.username === null;
  return (
    <Space size={4}>
      <Tag
        style={{
          margin: 0,
          fontSize: 10,
          lineHeight: '16px',
          padding: '0 4px',
          background: C.snapshotBg,
          borderColor: C.snapshotBorder,
          color: C.snapshotText,
        }}
      >
        periodic snapshot
      </Tag>
      {isCli ? (
        <Typography.Text style={{ color: C.textMuted, fontSize: 11 }}>
          CLI/scheduler
        </Typography.Text>
      ) : (
        <Typography.Text style={{ color: C.snapshotText, fontSize: 11 }}>
          {entry.username}
        </Typography.Text>
      )}
    </Space>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  'eos-api': 'EOS eAPI',
  'ssh-cli': 'EOS SSH CLI',
  'junos-rest': 'Junos REST',
  'junos-netconf': 'Junos NETCONF',
  'nxos-api': 'NX-OS API',
  'iosxe-restconf': 'IOS-XE RESTCONF',
  'iosxe-ssh': 'IOS-XE SSH',
};

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
function SplitView({ leftLines, rightLines, leftLabel, rightLabel, rightEntry }: {
  leftLines: string[]; rightLines: string[]; leftLabel: string; rightLabel: string; rightEntry?: SavedConfigEntry;
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
    <div style={{ display: 'flex', height: 'calc(100vh - 360px)', minHeight: 400 }}>
      {/* Left = current running config */}
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

      {/* Right = old config */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          padding: '6px 12px', background: rightEntry?.entryType === 'apply' ? C.applyBg : C.panel,
          borderBottom: `1px solid ${rightEntry?.entryType === 'apply' ? C.applyBorder : C.border}`,
          fontSize: 11, color: rightEntry?.entryType === 'apply' ? C.applyText : C.accent, fontWeight: 600, flexShrink: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <span title={rightLabel}>{rightLabel}</span>
          {rightEntry && <EntryBadge entry={rightEntry} />}
        </div>
        <div ref={rightRef} onScroll={() => sync('right')} style={{ flex: 1, overflowY: 'auto', background: C.bg }}>
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
    </div>
  );
}

// ── Unified view ─────────────────────────────────────────────────────────────
function UnifiedView({ diffLines, leftLabel, rightLabel, rightEntry }: {
  diffLines: DiffLine[]; leftLabel: string; rightLabel: string; rightEntry?: SavedConfigEntry;
}) {
  const stats = {
    added: diffLines.filter(l => l.type === 'added').length,
    removed: diffLines.filter(l => l.type === 'removed').length,
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const isApply = rightEntry?.entryType === 'apply';

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', gap: 16, padding: '6px 12px', alignItems: 'center',
        background: isApply ? C.applyBg : C.panel,
        borderBottom: `1px solid ${isApply ? C.applyBorder : C.border}`,
        fontSize: 12, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <Typography.Text style={{ color: C.addedText }}>+{stats.added} dòng thêm</Typography.Text>
        <Typography.Text style={{ color: C.removedText }}>−{stats.removed} dòng bớt</Typography.Text>
        <Typography.Text style={{ color: isApply ? C.applyText : C.textMuted, fontSize: 11 }}>
          {leftLabel}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ color: C.textMuted, marginLeft: 'auto' }}>
          ← {rightLabel}
        </Typography.Text>
        {rightEntry && (
          <div style={{ marginLeft: 8 }}>
            <EntryBadge entry={rightEntry} />
          </div>
        )}
      </div>
      <div ref={containerRef} style={{
        maxHeight: 'calc(100vh - 420px)', overflowY: 'auto',
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
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs | null>(null);

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

  // All history entries (loaded once); filter by date client-side
  const filteredHistory = selectedDate
    ? history.filter((h) => dayjs(h.timestamp).isSame(selectedDate, 'day'))
    : history;

  if (filteredHistory.length === 0 && history.length > 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`Không có config nào trong ngày ${selectedDate?.format('DD/MM/YYYY')}. Chọn ngày khác hoặc bỏ lọc.`}
      />
    );
  }

  if (history.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Chưa có snapshot nào. ConfigCheck job cần chạy trước để lưu running config."
      />
    );
  }

  const selectedOld = filteredHistory.find((h) => h.id === selectedOldId) ?? filteredHistory[0];
  const leftLines = currentConfig.split('\n');
  const rightLines = (selectedOld?.content ?? '').split('\n');
  const diffLines = computeDiff(leftLines, rightLines);

  const leftLabel = `Running config hiện tại · ${leftLines.length} dòng · ${dayjs().format('DD/MM/YYYY HH:mm')}`;
  const rightLabel = selectedOld
    ? `${selectedOld.label} · ${rightLines.length} dòng · ${dayjs(selectedOld.timestamp).format('DD/MM/YYYY HH:mm')}`
    : 'Chưa chọn phiên bản';

  return (
    <div>
      {/* Controls */}
      <div style={{ marginBottom: 12 }}>
        <Space wrap align="center" size="middle">
          <Typography.Text style={{ color: C.textDim, fontSize: 12 }}>So với:</Typography.Text>
          <DatePicker
            size="small"
            placeholder="Lọc theo ngày"
            format="DD/MM/YYYY"
            allowClear
            value={selectedDate}
            onChange={(d) => {
              setSelectedDate(d);
              if (d) {
                const sameDay = history.filter((h) => dayjs(h.timestamp).isSame(d, 'day'));
                if (sameDay.length > 0) setSelectedOldId(sameDay[0].id);
              }
            }}
            style={{ fontSize: 11 }}
          />
          <Select
            size="small"
            style={{ minWidth: 360 }}
            value={selectedOldId || filteredHistory[0]?.id}
            onChange={(v) => setSelectedOldId(v)}
            options={filteredHistory.map((h) => ({
              value: h.id,
              label: (
                <Space size={4}>
                  <Typography.Text style={{ fontSize: 12, color: h.entryType === 'apply' ? C.applyText : C.text }}>
                    {dayjs(h.timestamp).format('DD/MM/YYYY HH:mm')}
                  </Typography.Text>
                  <Tag
                    color={h.entryType === 'apply' ? 'green' : 'default'}
                    style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
                  >
                    {h.entryType === 'apply' ? 'apply' : 'snapshot'}
                  </Tag>
                  <Typography.Text style={{ fontSize: 11, color: C.textMuted }}>
                    {h.username ?? 'CLI/scheduler'}
                  </Typography.Text>
                  <Typography.Text style={{ fontSize: 10, color: C.textMuted }}>
                    · {h.content.split('\n').length}L
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
        <SplitView
          leftLines={leftLines}
          rightLines={rightLines}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
          rightEntry={selectedOld}
        />
      ) : (
        <UnifiedView
          diffLines={diffLines}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
          rightEntry={selectedOld}
        />
      )}
    </div>
  );
}
