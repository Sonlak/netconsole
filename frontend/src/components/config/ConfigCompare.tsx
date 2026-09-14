import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Space, Spin, Typography, Empty, Tooltip } from 'antd';
import { SwapOutlined, UserOutlined, ClockCircleOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { ConfigSnapshot, DiffResult, SnapshotSide } from '@/api/configCompare';
import { fetchConfigSnapshots, fetchConfigDiff } from '@/api/configCompare';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { ErrorState } from '@/components/common/ErrorState';

dayjs.extend(relativeTime);

type DiffLine = DiffResult['lines'][number];

function buildSnapshotMenu(
  snapshots: ConfigSnapshot[],
  selectedId: string,
  onSelect: (jobId: string) => void,
): MenuProps['items'] {
  return snapshots.map((s) => ({
    key: s.jobId,
    label: (
      <Space>
        <Typography.Text type={s.jobId === selectedId ? 'success' : undefined}>
          {dayjs(s.collectedAt).format('DD/MM/YYYY HH:mm')}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          ({s.lineCount} lines)
        </Typography.Text>
        {s.username && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            · {s.username}
          </Typography.Text>
        )}
        {s.collectMs > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            · {s.collectMs}ms
          </Typography.Text>
        )}
      </Space>
    ),
    disabled: s.jobId === selectedId,
    onClick: () => onSelect(s.jobId),
  }));
}

function SnapshotSelector({
  label,
  snapshots,
  selectedId,
  onSelect,
  side,
}: {
  label: string;
  snapshots: ConfigSnapshot[];
  selectedId: string;
  onSelect: (jobId: string) => void;
  side: SnapshotSide | null;
}) {
  const items = buildSnapshotMenu(snapshots, selectedId, onSelect);
  const selected = snapshots.find((s) => s.jobId === selectedId);

  return (
    <div style={{ marginBottom: 8 }}>
      <Typography.Text strong style={{ marginRight: 8 }}>{label}:</Typography.Text>
      <Dropdown menu={{ items }} trigger={['click']} disabled={snapshots.length < 2}>
        <Button size="small">
          {selected
            ? `${dayjs(selected.collectedAt).format('DD/MM/YYYY HH:mm')} · ${selected.username ?? 'system'} · ${selected.lineCount}L`
            : 'Chọn snapshot'}
        </Button>
      </Dropdown>
      {side && (
        <div style={{ marginTop: 4 }}>
          <Space size="small">
            <ClockCircleOutlined style={{ fontSize: 11, color: '#888' }} />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {dayjs(side.collectedAt).fromNow()}
            </Typography.Text>
            {side.username && (
              <>
                <UserOutlined style={{ fontSize: 11, color: '#888' }} />
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {side.username}
                </Typography.Text>
              </>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              · {side.lineCount} dòng
            </Typography.Text>
            {side.collectMs > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                · {side.collectMs}ms
              </Typography.Text>
            )}
          </Space>
        </div>
      )}
    </div>
  );
}

function DiffLineView({ lines }: { lines: DiffLine[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // Scroll to first changed line
    const firstChange = containerRef.current.querySelector('.diff-added, .diff-removed');
    if (firstChange) {
      firstChange.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [lines]);

  return (
    <div
      ref={containerRef}
      style={{
        maxHeight: 'calc(100vh - 340px)',
        overflowY: 'auto',
        fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        border: '1px solid #d9d9d9',
        borderRadius: 4,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <tbody>
          {lines.map((line, idx) => (
            <tr
              key={idx}
              className={`diff-${line.type}`}
              style={{
                background:
                  line.type === 'added'
                    ? '#f6ffed'
                    : line.type === 'removed'
                    ? '#fff1f0'
                    : idx % 2 === 0
                    ? '#fafafa'
                    : '#ffffff',
                color: line.type === 'added' ? '#389e0d' : line.type === 'removed' ? '#cf1322' : undefined,
              }}
            >
              <td
                style={{
                  width: 28,
                  textAlign: 'center',
                  color: '#888',
                  userSelect: 'none',
                  borderRight: '1px solid #e8e8e8',
                  padding: '1px 4px',
                  fontSize: 10,
                }}
              >
                {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
              </td>
              <td
                style={{
                  padding: '1px 8px',
                  whiteSpace: 'pre',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={line.content}
              >
                {line.content}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ConfigCompareProps {
  deviceId: string;
}

export function ConfigCompare({ deviceId }: ConfigCompareProps) {
  const [snapshots, setSnapshots] = useState<ConfigSnapshot[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(true);
  const [snapshotsError, setSnapshotsError] = useState<Error | null>(null);

  const [leftId, setLeftId] = useState<string>('');
  const [rightId, setRightId] = useState<string>('');

  const [diffData, setDiffData] = useState<{
    from: SnapshotSide;
    to: SnapshotSide;
    diff: DiffResult;
  } | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<Error | null>(null);

  // Load snapshot list
  useEffect(() => {
    setLoadingSnapshots(true);
    fetchConfigSnapshots(deviceId)
      .then((data) => {
        setSnapshots(data);
        // Default: newest vs second-newest
        if (data.length >= 2) {
          setRightId(data[0].jobId);
          setLeftId(data[1].jobId);
        } else if (data.length === 1) {
          setRightId(data[0].jobId);
          setLeftId(data[0].jobId);
        }
        setSnapshotsError(null);
      })
      .catch((e) => setSnapshotsError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoadingSnapshots(false));
  }, [deviceId]);

  // Load diff when both sides selected and different
  const loadDiff = useCallback(
    async (from: string, to: string) => {
      if (!from || !to || from === to) {
        setDiffData(null);
        return;
      }
      setLoadingDiff(true);
      setDiffError(null);
      try {
        const data = await fetchConfigDiff(deviceId, from, to);
        setDiffData(data);
      } catch (e) {
        setDiffError(e instanceof Error ? e : new Error(String(e)));
        setDiffData(null);
      } finally {
        setLoadingDiff(false);
      }
    },
    [deviceId],
  );

  useEffect(() => {
    if (leftId && rightId && leftId !== rightId) {
      void loadDiff(leftId, rightId);
    } else {
      setDiffData(null);
    }
  }, [leftId, rightId, loadDiff]);

  const handleSwap = () => {
    const tmp = leftId;
    setLeftId(rightId);
    setRightId(tmp);
  };

  if (loadingSnapshots) return <PageSkeleton />;
  if (snapshotsError) return <ErrorState title="Không tải được danh sách snapshot" error={snapshotsError} onRetry={() => window.location.reload()} />;

  if (snapshots.length < 2) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Cần ít nhất 2 lần collect config để so sánh."
      />
    );
  }

  return (
    <div>
      {/* Controls */}
      <div style={{ marginBottom: 16 }}>
        <SnapshotSelector
          label="Cũ hơn"
          snapshots={snapshots}
          selectedId={leftId}
          onSelect={setLeftId}
          side={diffData?.from ?? null}
        />
        <Space>
          <SnapshotSelector
            label="Mới hơn"
            snapshots={snapshots}
            selectedId={rightId}
            onSelect={setRightId}
            side={diffData?.to ?? null}
          />
          <Tooltip title="Đổi chỗ trái/phải">
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={handleSwap}
              disabled={leftId === rightId}
            />
          </Tooltip>
        </Space>

        {diffData && (
          <div style={{ marginTop: 8 }}>
            <Space size="large">
              <Typography.Text style={{ color: '#389e0d', fontSize: 12 }}>
                +{diffData.diff.added} dòng thêm
              </Typography.Text>
              <Typography.Text style={{ color: '#cf1322', fontSize: 12 }}>
                −{diffData.diff.removed} dòng bớt
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {diffData.diff.unchanged} dòng giữ nguyên
              </Typography.Text>
            </Space>
          </div>
        )}
      </div>

      {/* Diff view */}
      {loadingDiff && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">Đang so sánh…</Typography.Text>
          </div>
        </div>
      )}
      {diffError && !loadingDiff && (
        <ErrorState title="Lỗi so sánh" error={diffError} onRetry={() => void loadDiff(leftId, rightId)} />
      )}
      {diffData && !loadingDiff && <DiffLineView lines={diffData.diff.lines} />}
    </div>
  );
}
