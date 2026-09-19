/**
 * Two-series inline SVG line chart for in/out bps.
 *
 * Why no chart library?
 *   - The existing dashboard Sparkline.tsx is already a self-contained SVG.
 *     Two-series (in + out) needs the same primitives — we render two
 *     polylines against shared axes and a y-axis scale.
 *   - Adding `recharts` (~70 KB gzip) for one chart with two lines is not
 *     worth it given the rest of the app uses raw SVG.
 *
 * Visual contract:
 *   - Width: fills parent (100%).
 *   - Height: fixed `height` prop (default 180).
 *   - Y axis: bits/second, log scale when span > 1000× to keep quiet
 *     counters visible next to saturating 1G/10G links.
 *   - X axis: time, labelled with HH:MM:SS tick marks on the edge.
 *   - First sample is `null` (no prior baseline) — we render with a dotted
 *     continuation so the chart doesn't drop a slice at the leftmost edge.
 */
import { useMemo } from 'react';

const IN_COLOR = 'var(--nc-success, #34d399)';
const OUT_COLOR = 'var(--nc-accent, #60a5fa)';
const GRID_COLOR = 'rgba(148, 163, 184, 0.18)';
const AXIS_COLOR = 'rgba(148, 163, 184, 0.45)';

export type Rate = { t: string; inBps: number | null; outBps: number | null };

type Props = {
  rates: Rate[];
  height?: number;
  /** When true, drop the chart down to 60% width and overlay legend. */
  compactLegend?: boolean;
};

function formatBps(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 bps';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[u]}`;
}

export function BandwidthChart({ rates, height = 180 }: Props) {
  const width = 720;
  const padL = 56;
  const padR = 12;
  const padT = 10;
  const padB = 18;

  const points = useMemo(() => {
    const validIn = rates.map((r) => r.inBps).filter((v): v is number => v !== null && v > 0);
    const validOut = rates.map((r) => r.outBps).filter((v): v is number => v !== null && v > 0);
    const max = Math.max(0, ...validIn, ...validOut);
    return { max };
  }, [rates]);

  if (!rates.length) {
    return (
      <div className="nc-bandwidth-chart-empty" style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--nc-text-muted)' }}>
        Chưa có dữ liệu — cấu hình 5 phút trước cần ít nhất 2 sample.
      </div>
    );
  }

  const allZero = points.max === 0;
  const logScale = points.max > 1_000_000; // >1Mbps → log scale keeps readings visible
  const yMax = allZero ? 1 : logScale ? Math.log10(points.max) : points.max;

  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const xAt = (i: number) => padL + (rates.length === 1 ? innerW / 2 : (i * innerW) / (rates.length - 1));
  const yAt = (raw: number | null) => {
    if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
    const v = logScale ? Math.log10(raw) : raw;
    if (!Number.isFinite(v)) return null;
    const ratio = v / yMax;
    return padT + innerH - ratio * innerH;
  };

  const buildPath = (accessor: (r: Rate) => number | null): string => {
    let d = '';
    let lastValid: number | null = null;
    let drawSegment = false;
    rates.forEach((rate, i) => {
      const v = accessor(rate);
      const y = yAt(v);
      if (y === null) {
        drawSegment = false;
        lastValid = null;
        return;
      }
      const x = xAt(i);
      if (!drawSegment && lastValid !== null) {
        // Open a dotted bridge from the previous valid point to this one so
        // we don't visually drop a counter that's momentarily null.
        const prevIdx: number = lastValid;
        const prevVal = accessor(rates[prevIdx]) ?? 0;
        const prevY = yAt(prevVal) ?? padT + innerH;
        d += ` M${xAt(prevIdx).toFixed(2)},${prevY.toFixed(2)}`;
      }
      d += `${drawSegment ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
      drawSegment = true;
      lastValid = i;
    });
    return d.trim();
  };

  const inPath = buildPath((r) => r.inBps);
  const outPath = buildPath((r) => r.outBps);

  // Y-axis ticks (4 segments). We always label the top one as the max value
  // formatted with units, and the rest as fractions of it.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);
  const xTicks = rates.length > 1 ? Math.min(6, rates.length) : 1;
  const xTickIdxs: number[] = [];
  if (rates.length >= 2) {
    for (let i = 0; i < xTicks; i++) {
      xTickIdxs.push(Math.round((i * (rates.length - 1)) / Math.max(xTicks - 1, 1)));
    }
  } else {
    xTickIdxs.push(0);
  }

  return (
    <svg
      className="nc-bandwidth-chart"
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Bandwidth utilization chart (in/out bps)"
    >
      {/* grid */}
      {ticks.map((t, i) => {
        const y = padT + innerH - (logScale && t > 0 ? (Math.log10(t) / yMax) * innerH : (t / yMax) * innerH);
        return (
          <line
            key={`gy-${i}`}
            x1={padL}
            x2={width - padR}
            y1={y}
            y2={y}
            stroke={GRID_COLOR}
            strokeDasharray="2 3"
          />
        );
      })}
      {/* y axis labels */}
      {ticks.map((t, i) => {
        const y = padT + innerH - (logScale && t > 0 ? (Math.log10(t) / yMax) * innerH : (t / yMax) * innerH);
        return (
          <text
            key={`yt-${i}`}
            x={padL - 6}
            y={y + 3}
            textAnchor="end"
            fontSize="10"
            fill={AXIS_COLOR}
          >
            {formatBps(t)}
          </text>
        );
      })}
      {/* x axis labels */}
      {xTickIdxs.map((idx) => {
        const x = xAt(idx);
        const t = rates[idx]?.t;
        if (!t) return null;
        const hhmm = new Date(t).toLocaleTimeString('vi-VN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        return (
          <text key={`xt-${idx}`} x={x} y={height - 4} textAnchor="middle" fontSize="10" fill={AXIS_COLOR}>
            {hhmm}
          </text>
        );
      })}
      {/* lines */}
      {inPath ? (
        <path d={inPath} fill="none" stroke={IN_COLOR} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      {outPath ? (
        <path d={outPath} fill="none" stroke={OUT_COLOR} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      {/* legend */}
      <g transform={`translate(${padL}, ${padT - 2})`}>
        <line x1={0} y1={6} x2={14} y2={6} stroke={IN_COLOR} strokeWidth={2} />
        <text x={18} y={9} fontSize="10" fill={AXIS_COLOR}>In</text>
        <line x1={48} y1={6} x2={62} y2={6} stroke={OUT_COLOR} strokeWidth={2} />
        <text x={66} y={9} fontSize="10" fill={AXIS_COLOR}>Out</text>
      </g>
    </svg>
  );
}

export function formatBytesNumber(s: string | null): string {
  if (!s || s === '0') return '0';
  let n: bigint;
  try {
    n = BigInt(s);
  } catch {
    return s;
  }
  return n.toString();
}
