import { Tooltip, Typography } from 'antd';
import { formatAbsolute, formatRelative } from '@/lib/format';

export function Timestamp({
  value,
  mode = 'relative',
}: {
  value: string | null | undefined;
  mode?: 'relative' | 'absolute';
}) {
  const relative = formatRelative(value);
  const absolute = formatAbsolute(value);
  if (mode === 'absolute') {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {absolute}
      </Typography.Text>
    );
  }
  return (
    <Tooltip title={absolute}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {relative}
      </Typography.Text>
    </Tooltip>
  );
}

export function FreshnessLabel({
  refreshing,
  lastUpdatedAt,
}: {
  refreshing?: boolean;
  lastUpdatedAt?: string | null;
}) {
  if (refreshing) return <span className="nc-refresh">Refreshing…</span>;
  if (!lastUpdatedAt) return null;
  return (
    <span className="nc-refresh">
      Updated <Timestamp value={lastUpdatedAt} />
    </span>
  );
}
