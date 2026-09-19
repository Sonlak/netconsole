import { useMemo } from 'react';

type Tone = 'success' | 'warning' | 'error' | 'processing' | 'default';

const PALETTE: Record<Tone, string> = {
  success: 'var(--nc-success)',
  warning: 'var(--nc-warning)',
  error: 'var(--nc-error)',
  processing: 'var(--nc-accent)',
  default: 'var(--nc-text-muted)',
};

/**
 * Sparkline — minimal SVG sparkline with optional area fill.
 *
 * No external chart dep — we render a smooth polyline. Adds value to the
 * dashboard with ~80 LOC instead of pulling in recharts/echarts (~70 KB gzip).
 *
 * Behaviour:
 *  - If `data.length < 2` we render a thin flat baseline so the card height
 *    is consistent (a 0-line looks broken in a flex row).
 *  - We pad the y-domain by 8% above and below so the line never touches
 *    the chrome.
 *  - The stroke color follows `tone` (errors red, warnings amber, …).
 */
export function Sparkline({
  data,
  width = 88,
  height = 28,
  tone = 'default',
  area = true,
  strokeWidth = 1.5,
  ariaLabel,
}: {
  data: number[];
  width?: number;
  height?: number;
  tone?: Tone;
  area?: boolean;
  strokeWidth?: number;
  ariaLabel?: string;
}) {
  const color = PALETTE[tone];
  const id = useMemo(() => `spark-${Math.random().toString(36).slice(2, 9)}`, []);

  const { linePath, areaPath, minY, maxY } = useMemo(() => {
    if (!data.length) {
      return { linePath: '', areaPath: '', minY: 0, maxY: 0 };
    }
    const safe = data.length >= 2 ? data : [data[0], data[0]];
    const min = Math.min(...safe);
    const max = Math.max(...safe);
    const range = max - min || Math.max(Math.abs(max), 1);
    const pad = range * 0.08;
    const lo = min - pad;
    const hi = max + pad;
    const span = hi - lo || 1;
    const stepX = safe.length === 1 ? 0 : width / (safe.length - 1);

    const points = safe.map((value, index) => {
      const x = index * stepX;
      // Flip Y because SVG grows downward; we want 0 at the bottom.
      const y = height - ((value - lo) / span) * height;
      return [x, y] as const;
    });

    const linePoints = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L');
    const linePath = safe.length > 0 ? `M${linePoints}` : '';
    const last = points[points.length - 1];
    const areaPath =
      safe.length > 0
        ? `M${points[0][0].toFixed(2)},${height.toFixed(2)} L${linePoints} L${last[0].toFixed(2)},${height.toFixed(2)} Z`
        : '';

    return { linePath, areaPath, minY: lo, maxY: hi };
  }, [data, width, height]);

  return (
    <svg
      className="nc-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? `${data.length} samples, range ${minY.toFixed(0)} to ${maxY.toFixed(0)}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {area && areaPath ? (
        <path d={areaPath} fill={`url(#${id})`} stroke="none" />
      ) : null}
      {linePath ? (
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        // No history — draw a thin dotted baseline so layout stays stable.
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke={color} strokeOpacity={0.32} strokeDasharray="2 3" />
      )}
    </svg>
  );
}
