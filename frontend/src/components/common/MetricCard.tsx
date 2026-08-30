import { Card, Skeleton, Typography } from 'antd';

export function MetricCard({
  label,
  value,
  hint,
  loading,
  alert,
}: {
  label: string;
  value: string | number;
  hint?: string;
  loading?: boolean;
  alert?: boolean;
}) {
  return (
    <Card bordered={false} className="nc-metric-card">
      <div className="nc-metric-label">{label}</div>
      {loading ? (
        <Skeleton.Input active size="small" style={{ width: 72, marginTop: 8 }} />
      ) : (
        <div className="nc-metric-value" style={alert ? { color: 'var(--nc-danger, #f87171)' } : undefined}>
          {value}
        </div>
      )}
      {hint ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      ) : null}
    </Card>
  );
}
