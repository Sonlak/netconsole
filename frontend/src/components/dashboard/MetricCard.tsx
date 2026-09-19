import { Card, Skeleton, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { DeltaBadge } from '@/components/dashboard/DeltaBadge';
import { Sparkline } from '@/components/dashboard/Sparkline';

type Tone = 'success' | 'warning' | 'error' | 'processing' | 'default';

/**
 * MetricCard v2 — superset of the v1 plain variant.
 *
 * Adds (when provided):
 *   - sparkline (auto-tinted to `alert`/`warning` state)
 *   - delta badge ("+12 since 5m ago", arrows + color)
 *   - up to 2 secondaries on the right (tags, status chips)
 *   - tooltip with last update moment
 *
 *  v1 callers (no sparkline, no delta) keep working — all new fields are
 *  optional and the layout collapses to v1 cleanly.
 */
export function MetricCard({
  label,
  value,
  hint,
  loading,
  alert,
  variant = 'warning',
  history,
  delta,
  deltaPercent = false,
  deltaInverse = false,
  tag,
  icon,
  tooltip,
}: {
  label: string;
  value: string | number;
  hint?: string;
  loading?: boolean;
  alert?: boolean;
  /** Which color to use when `alert` is true. Default "warning" (amber). */
  variant?: 'warning' | 'error' | 'success';
  /** Numeric samples for the sparkline, oldest → newest. */
  history?: number[];
  /** Period over period change. 0 shows as neutral. */
  delta?: number;
  /** If true, format `delta` as a percentage. */
  deltaPercent?: boolean;
  /** If true, "down is good" — used for offline/failed counts. */
  deltaInverse?: boolean;
  /** Optional right-aligned tag (eg. "since 5m ago"). */
  tag?: ReactNode;
  /** Optional small icon prefix, e.g. an AntD icon font. */
  icon?: ReactNode;
  /** Tooltip text shown on hover over the metric value. */
  tooltip?: string;
}) {
  const sparkTone: Tone = alert
    ? variant === 'error'
      ? 'error'
      : variant === 'success'
        ? 'success'
        : 'warning'
    : 'processing';

  const valueNode = loading ? (
    <Skeleton.Input active size="small" style={{ width: 72, marginTop: 8 }} />
  ) : (
    <div className="nc-metric-value-row">
      <Tooltip title={tooltip}>
        <div
          className="nc-metric-value"
          style={
            alert
              ? { color: variant === 'error' ? 'var(--nc-error)' : variant === 'success' ? 'var(--nc-success)' : 'var(--nc-warning)' }
              : undefined
          }
        >
          {value}
        </div>
      </Tooltip>
      {tag ? <span className="nc-metric-tag">{tag}</span> : null}
    </div>
  );

  return (
    <Card bordered={false} className={`nc-metric-card${alert ? ' is-alert' : ''}`} styles={{ body: { padding: '12px 14px 14px' } }}>
      <div className="nc-metric-head">
        <span className="nc-metric-label">
          {icon ? <span className="nc-metric-label-icon">{icon}</span> : null}
          {label}
        </span>
        {history && history.length > 0 ? (
          <Sparkline
            data={history}
            width={72}
            height={26}
            tone={sparkTone}
            ariaLabel={`${label} last ${history.length} samples`}
          />
        ) : null}
      </div>
      {valueNode}
      <div className="nc-metric-foot">
        {hint ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        ) : null}
        {typeof delta === 'number' ? (
          <DeltaBadge value={delta} percent={deltaPercent} inverse={deltaInverse} />
        ) : null}
      </div>
    </Card>
  );
}
