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
 * Visual contract (v2 — production polish):
 *   - Width: fills parent (100%).
 *   - Height: fixed `height` prop (default 240).
 *   - Y axis: bits/second, log scale when span > 1 Mbps to keep quiet
 *     counters visible next to saturating 1G/10G links.
 *   - X axis: time, labelled with HH:MM:SS tick marks on the edge.
 *   - **Gradient area fill** under each line — gives the chart the same
 *     visual weight as Grafana / Datadog without extra deps.
 *   - **Hover crosshair** + tooltip with timestamp + in/out bps — rendered
 *     as a small absolutely-positioned div on top of the SVG.
 *   - First sample is `null` (no prior baseline) — we bridge with a dotted
 *     segment so the chart doesn't drop a slice at the leftmost edge.
 */
import { useMemo, useState, useCallback } from 'react';

const IN_STROKE = 'var(--nc-success, #059669)';
const OUT_STROKE = 'var(--nc-accent, #2563eb)';
const IN_FILL_TOP = 'rgba(5, 150, 105, 0.32)';
const IN_FILL_BOT = 'rgba(5, 150, 105, 0.02)';
const OUT_FILL_TOP = 'rgba(37, 99, 235, 0.30)';
const OUT_FILL_BOT = 'rgba(37, 99, 235, 0.02)';
const GRID_COLOR = 'rgba(148, 163, 184, 0.18)';
const AXIS_COLOR = 'rgba(148, 163, 184, 0.55)';
const CROSSHAIR_COLOR = 'rgba(148, 163, 184, 0.55)';

export type Rate = { t: string; inBps: number | null; outBps: number | null };

type Props = {
  rates: Rate[];
  height?: number;
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

export function BandwidthChart({ rates, height = 240 }: Props) {
  const width = 720;
  const padL = 64;
  const padR = 16;
  const padT = 28;
  const padB = 24;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const points = useMemo(() => {
    const validIn = rates.map((r) => r.inBps).filter((v): v is number => v !== null && v > 0);
    const validOut = rates.map((r) => r.outBps).filter((v): v is number => v !== null && v > 0);
    const max = Math.max(0, ...validIn, ...validOut);
    return { max };
  }, [rates]);

  const onSvgMove = useCallback(
    (evt: React.MouseEvent<SVGSVGElement>) => {
      if (!rates.length) return;
      const target = evt.currentTarget;
      const rect = target.getBoundingClientRect();
      const innerW = width - padL - padR;
      const xRel = ((evt.clientX - rect.left) / rect.width) * width - padL;
      const clamped = Math.max(0, Math.min(innerW, xRel));
      const ratio = rates.length === 1 ? 0 : clamped / innerW;
      const idx = Math.round(ratio * (rates.length - 1));
      setHoverIdx(idx);
    },
    [rates.length],
  );

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

  const xAt = (i: number) =>
    padL + (rates.length === 1 ? innerW / 2 : (i * innerW) / (rates.length - 1));
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

  const buildAreaPath = (accessor: (r: Rate) => number | null): string => {
    const line = buildPath(accessor);
    if (!line) return '';
    // Append close-down-to-baseline + close-right + back to start to make a
    // filled region. The baseline Y is the bottom of the chart area.
    const baseline = padT + innerH;
    return `${line} L${xAt(rates.length - 1).toFixed(2)},${baseline} L${xAt(0).toFixed(2)},${baseline} Z`;
  };

  const inPath = buildPath((r) => r.inBps);
  const outPath = buildPath((r) => r.outBps);
  const inAreaPath = buildAreaPath((r) => r.inBps);
  const outAreaPath = buildAreaPath((r) => r.outBps);

  // Y-axis ticks (5 segments). We always label the top one as the max value
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

  // Latest non-null sample for the in-card "current" badge.
  const latestIdx = (() => {
    for (let i = rates.length - 1; i >= 0; i--) {
      if (rates[i].inBps !== null || rates[i].outBps !== null) return i;
    }
    return rates.length - 1;
  })();
  const latestIn = rates[latestIdx]?.inBps ?? 0;
  const latestOut = rates[latestIdx]?.outBps ?? 0;

  const hover = hoverIdx !== null ? rates[hoverIdx] : null;
  const hoverX = hoverIdx !== null ? xAt(hoverIdx) : null;

  return (
    <div className="nc-bandwidth-chart-wrap" style={{ position: 'relative' }}>
      <svg
        className="nc-bandwidth-chart"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Bandwidth utilization chart (in/out bps)"
        onMouseMove={onSvgMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="nc-bw-in" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={IN_FILL_TOP} />
            <stop offset="100%" stopColor={IN_FILL_BOT} />
          </linearGradient>
          <linearGradient id="nc-bw-out" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={OUT_FILL_TOP} />
            <stop offset="100%" stopColor={OUT_FILL_BOT} />
          </linearGradient>
        </defs>

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
              strokeDasharray="2 4"
            />
          );
        })}
        {/* y axis labels */}
        {ticks.map((t, i) => {
          const y = padT + innerH - (logScale && t > 0 ? (Math.log10(t) / yMax) * innerH : (t / yMax) * innerH);
          return (
            <text
              key={`yt-${i}`}
              x={padL - 8}
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
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          });
          return (
            <text key={`xt-${idx}`} x={x} y={height - 6} textAnchor="middle" fontSize="10" fill={AXIS_COLOR}>
              {hhmm}
            </text>
          );
        })}

        {/* area fills (drawn first so lines sit on top) */}
        {inAreaPath ? <path d={inAreaPath} fill="url(#nc-bw-in)" stroke="none" /> : null}
        {outAreaPath ? <path d={outAreaPath} fill="url(#nc-bw-out)" stroke="none" /> : null}

        {/* lines */}
        {inPath ? (
          <path
            d={inPath}
            fill="none"
            stroke={IN_STROKE}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {outPath ? (
          <path
            d={outPath}
            fill="none"
            stroke={OUT_STROKE}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* hover crosshair + sample dots */}
        {hoverX !== null ? (
          <>
            <line x1={hoverX} x2={hoverX} y1={padT} y2={padT + innerH} stroke={CROSSHAIR_COLOR} strokeDasharray="3 3" />
            {hover?.inBps && hover.inBps > 0 ? (
              <circle cx={hoverX} cy={yAt(hover.inBps) ?? 0} r={3.5} fill={IN_STROKE} stroke="white" strokeWidth={1} />
            ) : null}
            {hover?.outBps && hover.outBps > 0 ? (
              <circle cx={hoverX} cy={yAt(hover.outBps) ?? 0} r={3.5} fill={OUT_STROKE} stroke="white" strokeWidth={1} />
            ) : null}
          </>
        ) : null}

        {/* legend (top-right corner) — shows current in/out rates */}
        <g transform={`translate(${padL + 8}, ${padT - 16})`}>
          <rect x={-4} y={-9} width={innerW} height={18} fill="rgba(15,23,42,0.02)" rx={4} />
          <g transform="translate(0, 4)">
            <line x1={0} y1={0} x2={16} y2={0} stroke={IN_STROKE} strokeWidth={2.4} />
            <circle cx={8} cy={0} r={3} fill={IN_STROKE} />
            <text x={22} y={3} fontSize="10.5" fill="currentColor" fontWeight={500}>
              In
            </text>
            <text x={42} y={3} fontSize="10.5" fill={IN_STROKE} fontWeight={600} className="nc-mono">
              {formatBps(latestIn)}
            </text>
          </g>
          <g transform={`translate(${Math.min(innerW - 130, innerW / 2 + 20)}, 4)`}>
            <line x1={0} y1={0} x2={16} y2={0} stroke={OUT_STROKE} strokeWidth={2.4} />
            <circle cx={8} cy={0} r={3} fill={OUT_STROKE} />
            <text x={22} y={3} fontSize="10.5" fill="currentColor" fontWeight={500}>
              Out
            </text>
            <text x={48} y={3} fontSize="10.5" fill={OUT_STROKE} fontWeight={600} className="nc-mono">
              {formatBps(latestOut)}
            </text>
          </g>
        </g>
      </svg>

      {hover && hoverIdx !== null ? (
        <div
          className="nc-bandwidth-tooltip"
          style={{
            left: `${((hoverX ?? 0) / width) * 100}%`,
            transform: `translateX(${hoverX !== null && hoverX > width * 0.65 ? '-100%' : '12px'})`,
          }}
        >
          <div className="nc-bandwidth-tooltip-time">
            {new Date(hover.t).toLocaleString('vi-VN', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
              day: '2-digit',
              month: '2-digit',
            })}
          </div>
          <div className="nc-bandwidth-tooltip-row">
            <span className="nc-bandwidth-tooltip-dot" style={{ background: IN_STROKE }} />
            <span>In</span>
            <strong className="nc-mono">{formatBps(hover.inBps ?? 0)}</strong>
          </div>
          <div className="nc-bandwidth-tooltip-row">
            <span className="nc-bandwidth-tooltip-dot" style={{ background: OUT_STROKE }} />
            <span>Out</span>
            <strong className="nc-mono">{formatBps(hover.outBps ?? 0)}</strong>
          </div>
        </div>
      ) : null}
    </div>
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
