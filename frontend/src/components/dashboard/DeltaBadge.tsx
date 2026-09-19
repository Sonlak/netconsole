import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from '@ant-design/icons';

type Tone = 'success' | 'warning' | 'error' | 'neutral';

/**
 * DeltaBadge — small inline pill showing a numeric delta with arrow.
 *
 * Convention:
 *  - For "bad-when-up" metrics (offline count, failed jobs) invert good/bad
 *    via `direction="inverse"`. Otherwise leave as default.
 *  - Zero deltas render as a neutral dash so the eye doesn't read them as
 *    a trend.
 */
export function DeltaBadge({
  value,
  percent = false,
  inverse = false,
  suffix,
}: {
  value: number;
  percent?: boolean;
  /** Set true for metrics where going down is good (offline, failed jobs, …). */
  inverse?: boolean;
  suffix?: string;
}) {
  if (value === 0 || !Number.isFinite(value)) {
    return (
      <span className="nc-delta nc-delta--neutral" aria-label="no change">
        <MinusOutlined style={{ fontSize: 10 }} />
        <span>0{suffix ?? (percent ? '%' : '')}</span>
      </span>
    );
  }
  const up = value > 0;
  const icon = up ? <ArrowUpOutlined style={{ fontSize: 10 }} /> : <ArrowDownOutlined style={{ fontSize: 10 }} />;

  // Tone: if value is "good" we show success; "bad" we show error.
  // "good" = up when not inverse, down when inverse.
  const good = up !== inverse;
  const tone: Tone = good ? 'success' : value === 0 ? 'neutral' : value > 0 ? 'error' : 'error';

  return (
    <span className={`nc-delta nc-delta--${tone}`} aria-label={`${up ? 'up' : 'down'} ${Math.abs(value)}`}>
      {icon}
      <span>
        {Math.abs(value)}
        {suffix ?? (percent ? '%' : '')}
      </span>
    </span>
  );
}
