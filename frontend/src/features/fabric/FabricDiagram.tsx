/**
 * FabricDiagram — Network topology visualization.
 *
 * Layout model: columns-by-floor, top→bottom within column.
 *
 *   ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────────────────────┐
 *   │ F1   │  │ F2   │  │ F3   │  │ F6 (single column)       │
 *   │CORE  │  │CORE  │  │CORE  │  │ CORE-01                   │
 *   │DIST  │  │DIST  │  │DIST  │  │ CORE-02                   │
 *   │ACCESS│  │ACCESS│  │ACCESS│  │ DIST-01  DIST-02          │
 *   │      │  │      │  │AS-01 │  │ F1-AS…  F2-AS… F3-AS-01   │
 *   │AS-01 │  │AS-01 │  │AS-02 │  │ F3-AS-02                  │
 *   └──────┘  └──────┘  └──────┘  └──────────────────────────┘
 *
 * Inside each column nodes are placed top→bottom by role (core, dist, access).
 * Each column has its own vertical "spine" bus that runs down the centre.
 * Cross-column links use a shared horizontal bus at the source/dest's stub y.
 *
 * Parallel links between the same device pair get unique track offsets so they
 * fan out without overlapping.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceStatusMeta } from '@/design/status';
import type { DeviceStatus } from '@/types/device';
import type { FabricLink, FabricLinkKind, FabricNode, FabricRole } from '@/types/fabric';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NODE_W = 228;
const NODE_H = 96;
const PORT_STUB = 38;           // stub length from node edge to bus lane
const PORT_LABEL_GAP = 7;
const NODE_GAP_X = 64;          // gap between floor-columns
const NODE_GAP_Y = 36;          // gap between stacked nodes inside one column
const MARGIN_X = 60;
const MARGIN_Y = 110;
const RAIL_WIDTH = 136;
const TRACK_STEP = 18;          // parallel track offset between parallel links

const KIND_COLOR: Record<FabricLinkKind, string> = {
  trunk:   '#4f9cf9',
  peer:    '#8b93a7',
  l3:      '#f0a14a',
  uplink:  '#9aa3b6',
};

const KIND_STROKE: Record<FabricLinkKind, number> = {
  trunk:   2.5,
  peer:    2,
  l3:      2.6,
  uplink:  1.8,
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Pt   = { x: number; y: number };
type Box  = Pt & { w: number; h: number };
type Anchor = 'left' | 'right' | 'top' | 'bottom';

type PortEnd = {
  side: Anchor;
  portName: string;
  anchor:   Pt;   // point on the node edge
  stubEnd:  Pt;   // end of the short stub
  labelPos: Pt;
  labelSize: { w: number; h: number };
  labelAnchor: 'start' | 'middle' | 'end';
  trackOffset: number;  // perpendicular offset for parallel links
};

type EdgePath = {
  link:    FabricLink;
  d:       string;
  fromEnd: PortEnd;
  toEnd:   PortEnd;
};

type NodeLayout = {
  node: FabricNode;
  box:  Box;
};

type Column = {
  /** Display key (F1, F2, F3, F6…) */
  floor: string;
  floorNumber: number | null;
  /** Where this column's trunk spine x is. */
  trunkX: number;
  /** Stacked top→bottom by role. */
  nodes: NodeLayout[];
  /** y of the bottom edge of the last node (= bottom of column). */
  height: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Role labels
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<FabricRole, string> = {
  core:   'Core',
  dist:   'Distribution',
  access: 'Access',
};

// Roles ordered top→bottom inside a column
const ROLE_RANK: Record<FabricRole, number> = {
  core:   0,
  dist:   1,
  access: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Layout — columns by floor
// ─────────────────────────────────────────────────────────────────────────────

type LayoutResult = {
  positioned: NodeLayout[];
  totalWidth:  number;
  totalHeight: number;
  columns:     Column[];
};

function columnKey(node: FabricNode): string {
  if (node.floorNumber != null) return `F${node.floorNumber}`;
  return node.floor || 'Other';
}

function groupByFloor(nodes: FabricNode[]): { floor: string; floorNumber: number | null; nodes: FabricNode[] }[] {
  const buckets: Record<string, { floorNumber: number | null; nodes: FabricNode[] }> = {};
  for (const node of nodes) {
    const key = columnKey(node);
    if (!buckets[key]) buckets[key] = { floorNumber: node.floorNumber, nodes: [] };
    buckets[key].nodes.push(node);
  }
  // sort within column: by role rank, then by shortName
  for (const key of Object.keys(buckets)) {
    buckets[key].nodes.sort((a, b) => {
      const r = ROLE_RANK[a.role] - ROLE_RANK[b.role];
      if (r !== 0) return r;
      return a.shortName.localeCompare(b.shortName);
    });
  }
  // sort columns by floorNumber asc, null/other last
  const sorted = Object.entries(buckets)
    .map(([floor, info]) => ({
      floor,
      floorNumber: info.floorNumber,
      nodes: info.nodes,
    }))
    .sort((a, b) => {
      const an = a.floorNumber ?? 9999;
      const bn = b.floorNumber ?? 9999;
      if (an !== bn) return an - bn;
      return a.floor.localeCompare(b.floor);
    });
  return sorted;
}

function layoutNodes(nodes: FabricNode[]): LayoutResult {
  const buckets = groupByFloor(nodes);

  const colWidth = NODE_W;

  // First pass — compute per-column heights (sum of node heights + gaps)
  const columns: Column[] = buckets.map((bucket) => {
    const list = bucket.nodes.map((node) => ({ node, h: NODE_H }));
    const height = list.reduce((acc, cur, i) => acc + cur.h + (i > 0 ? NODE_GAP_Y : 0), 0);
    return {
      floor: bucket.floor,
      floorNumber: bucket.floorNumber,
      trunkX: 0, // will be filled in second pass
      nodes: [], // will be filled in second pass
      height,
    };
  });

  // Find tallest column to size the canvas vertically
  const maxColHeight = Math.max(1, ...columns.map((c) => c.height));

  // Compute column X (left edges)
  const totalWidth = MARGIN_X * 2 + columns.length * colWidth + Math.max(0, columns.length - 1) * NODE_GAP_X;
  let cursorX = MARGIN_X;
  for (const col of columns) {
    col.trunkX = cursorX + colWidth / 2;
    cursorX  += colWidth + NODE_GAP_X;
  }

  // Place nodes inside each column, vertically centred against the tallest column
  const positioned: NodeLayout[] = [];
  for (const col of columns) {
    const colNodes = nodes
      .filter((n) => columnKey(n) === col.floor)
      .sort((a, b) => {
        const r = ROLE_RANK[a.role] - ROLE_RANK[b.role];
        if (r !== 0) return r;
        return a.shortName.localeCompare(b.shortName);
      });
    let y = MARGIN_Y + Math.max(0, (maxColHeight - col.height) / 2);
    for (const node of colNodes) {
      const box: Box = { x: col.trunkX - NODE_W / 2, y, w: NODE_W, h: NODE_H };
      const layout: NodeLayout = { node, box };
      positioned.push(layout);
      col.nodes.push(layout);
      y += NODE_H + NODE_GAP_Y;
    }
  }

  return {
    positioned,
    totalWidth,
    totalHeight: MARGIN_Y * 2 + maxColHeight,
    columns,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Port placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Offsets along a side (left/right = y, top/bottom = x).
 * Distributes ports evenly within the usable edge length.
 */
function portOffset(portsOnSide: number, idx: number, side: Anchor): number {
  const totalLen = side === 'left' || side === 'right' ? NODE_H : NODE_W;
  if (portsOnSide <= 1) return totalLen / 2;
  const inset = 22;
  const usable = totalLen - inset * 2;
  return inset + (usable / (portsOnSide - 1)) * idx;
}

function buildPortEnd(
  box:        Box,
  side:       Anchor,
  idx:        number,
  total:      number,
  portName:   string,
  trackOffset: number,
): PortEnd {
  const off  = portOffset(total, idx, side);

  const labelSize = { w: Math.max(64, (portName?.length || 4) * 6.8 + 14), h: 20 };

  let anchor: Pt, stubEnd: Pt, labelPos: Pt;
  let labelAnchor: 'start' | 'middle' | 'end' = 'middle';

  switch (side) {
    case 'right': {
      anchor   = { x: box.x + box.w, y: box.y + off };
      stubEnd  = { x: box.x + box.w + PORT_STUB + trackOffset, y: box.y + off };
      labelPos = { x: stubEnd.x, y: stubEnd.y - PORT_LABEL_GAP - labelSize.h };
      break;
    }
    case 'left': {
      anchor   = { x: box.x, y: box.y + off };
      stubEnd  = { x: box.x - PORT_STUB - trackOffset, y: box.y + off };
      labelPos = { x: stubEnd.x, y: stubEnd.y - PORT_LABEL_GAP - labelSize.h };
      labelAnchor = 'end';
      break;
    }
    case 'bottom': {
      anchor   = { x: box.x + off, y: box.y + box.h };
      stubEnd  = { x: box.x + off + trackOffset, y: box.y + box.h + PORT_STUB };
      labelPos = { x: stubEnd.x, y: stubEnd.y + PORT_LABEL_GAP };
      break;
    }
    case 'top': {
      anchor   = { x: box.x + off, y: box.y };
      stubEnd  = { x: box.x + off + trackOffset, y: box.y - PORT_STUB };
      labelPos = { x: stubEnd.x, y: stubEnd.y - PORT_LABEL_GAP - labelSize.h };
      labelAnchor = 'start';
      break;
    }
  }

  return { side, portName, anchor, stubEnd, labelPos, labelSize, labelAnchor, trackOffset };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side picker — pick which edge of `from` faces `to`.
//
// When both devices are in the SAME column (same x), go top↔bottom.
// When they are in DIFFERENT columns, prefer left/right (so the link runs
// across the horizontal inter-column bus). If they're also on a similar row
// the line stays horizontal; if they're on different rows it uses a small
// mid-Y elbow.
// ─────────────────────────────────────────────────────────────────────────────

function pickSide(from: Box, to: Box): Anchor {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < 1) {
    return dy > 0 ? 'bottom' : 'top';
  }
  return dx > 0 ? 'right' : 'left';
}

// ─────────────────────────────────────────────────────────────────────────────
// Orthogonal path — from stub-end A → stub-end B with a single mid-Y elbow.
// Both stub ends are on the SIDE edges of their respective nodes, so the
// straight line connecting them is already horizontal-ish.
// ─────────────────────────────────────────────────────────────────────────────

function makePath(a: Pt, b: Pt): string {
  if (Math.abs(a.y - b.y) < 0.5) {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  const midY = (a.y + b.y) / 2;
  return `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
}

function makeVerticalPath(a: Pt, b: Pt): string {
  if (Math.abs(a.x - b.x) < 0.5) {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  const midX = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} L ${midX} ${a.y} L ${midX} ${b.y} L ${b.x} ${b.y}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

function FabricNodeCard({ node, box }: { node: FabricNode; box: Box }) {
  const meta = deviceStatusMeta((node.status as DeviceStatus) || 'UNKNOWN');
  return (
    <Link
      to={`/devices/${node.id}`}
      className={`nc-fabric-node is-${node.role}`}
      data-node={node.id}
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h }}
      title={`${node.name} (${node.ip})${node.floor ? ` · ${node.floor}` : ''}`}
    >
      <span className={`nc-fabric-status is-${meta.tone}`} title={meta.label} />
      <span className="nc-fabric-name">{node.shortName}</span>
      <span className="nc-fabric-ip">{node.ip}</span>
      <span className="nc-fabric-role-pill">{ROLE_LABEL[node.role]}</span>
    </Link>
  );
}

function PortLabel({ end }: { end: PortEnd }) {
  const label = end.portName?.trim() || '—';
  const { w, h } = end.labelSize;
  let rx = end.labelPos.x;
  if (end.labelAnchor === 'end')        rx -= w;
  else if (end.labelAnchor === 'start') rx += 0;
  else                                  rx -= w / 2;
  const textY = end.labelPos.y + h / 2 + 1;
  return (
    <g className="nc-fabric-port">
      <rect x={rx} y={end.labelPos.y} width={w} height={h} rx={6} />
      <text x={rx + w / 2} y={textY} textAnchor="middle" dominantBaseline="middle">{label}</text>
    </g>
  );
}

export function FabricDiagram({ nodes, links }: { nodes: FabricNode[]; links: FabricLink[] }) {
  const wrapRef   = useRef<HTMLDivElement>(null);
  const dragRef   = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [viewport,    setViewport]    = useState({ x: 0, y: 0, scale: 1 });
  const [hoverEdge,    setHoverEdge]  = useState<string | null>(null);

  const layout = useMemo(() => layoutNodes(nodes), [nodes]);

  // ── Build edges ────────────────────────────────────────────────────────────
  const edges = useMemo(() => {
    const idx: Record<string, NodeLayout> = {};
    for (const item of layout.positioned) idx[item.node.id] = item;

    // Group links by device-pair so parallel links get unique track offsets
    const pairKey  = (a: string, b: string) => (a < b ? `${a}||${b}` : `${b}||${a}`);
    const pairBuckets: Record<string, FabricLink[]> = {};
    for (const link of links) {
      (pairBuckets[pairKey(link.fromDeviceId, link.toDeviceId)] ||= []).push(link);
    }
    const linkTrackIdx: Record<string, number> = {};
    Object.entries(pairBuckets).forEach(([, bucket]) => {
      bucket.forEach((link, i) => { linkTrackIdx[link.id] = i; });
    });
    const totalForPair = (a: string, b: string) => pairBuckets[pairKey(a, b)]?.length ?? 1;

    // Per-node per-side port index counter (so we can distribute ports along an edge)
    type PortMap = Record<string, Record<Anchor, number>>;
    const portCount: PortMap = {};
    for (const item of layout.positioned) {
      portCount[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }
    // First pass: figure out which side each link uses, count per-side ports
    type Stub = { side: Anchor };
    const stubs: Record<string, { a?: Stub; b?: Stub }> = {};
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;
      const sideA = pickSide(a.box, b.box);
      const sideB = pickSide(b.box, a.box);
      stubs[link.id] = { a: { side: sideA }, b: { side: sideB } };
      portCount[link.fromDeviceId][sideA]++;
      portCount[link.toDeviceId][sideB]++;
    }

    // Second pass: assign port indices & geometry
    const portIdx: PortMap = {};
    for (const item of layout.positioned) {
      portIdx[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }
    const edgeList: EdgePath[] = [];
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;

      const sideA  = stubs[link.id]!.a!.side;
      const sideB  = stubs[link.id]!.b!.side;
      const trackA = linkTrackIdx[link.id];        // 0,1,2…
      const totalP = totalForPair(link.fromDeviceId, link.toDeviceId);
      const trackOffset = (trackA - (totalP - 1) / 2) * TRACK_STEP;

      const idxA = portIdx[link.fromDeviceId][sideA]++;
      const idxB = portIdx[link.toDeviceId][sideB]++;

      const fromEnd = buildPortEnd(a.box, sideA, idxA, portCount[link.fromDeviceId][sideA], link.fromPort, trackOffset);
      const toEnd   = buildPortEnd(b.box, sideB, idxB, portCount[link.toDeviceId][sideB], link.toPort, trackOffset);

      // Path uses mid-Y elbow (works for both same-row and different-row horizontal links).
      // For purely top↔bottom links inside one column, use vertical mid-X elbow.
      const isVertical = (sideA === 'top' || sideA === 'bottom') && (sideB === 'top' || sideB === 'bottom');
      const d = isVertical ? makeVerticalPath(fromEnd.stubEnd, toEnd.stubEnd) : makePath(fromEnd.stubEnd, toEnd.stubEnd);

      edgeList.push({ link, d, fromEnd, toEnd });
    }

    return edgeList;
  }, [links, layout]);

  // ── Fit to view ─────────────────────────────────────────────────────────────
  const fitToView = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = (wrap.clientWidth || 1) - RAIL_WIDTH;
    const h = wrap.clientHeight || 1;
    const scale = Math.min(1, Math.min(w / layout.totalWidth, h / layout.totalHeight));
    setViewport({
      x: RAIL_WIDTH + Math.max(0, (w - layout.totalWidth * scale) / 2),
      y: 28,
      scale,
    });
  };

  useEffect(() => { fitToView(); }, [layout.totalWidth, layout.totalHeight]);

  // ── Zoom / pan ─────────────────────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) && !e.shiftKey) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect  = wrap.getBoundingClientRect();
    const px    = e.clientX - rect.left;
    const py    = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next   = Math.max(0.3, Math.min(2.4, viewport.scale * factor));
    const ratio  = next / viewport.scale;
    setViewport({ scale: next, x: px - (px - viewport.x) * ratio, y: py - (py - viewport.y) * ratio });
  };

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('.nc-fabric-node, .nc-fabric-link, .nc-fabric-tier-label')) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: viewport.x, baseY: viewport.y };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setViewport(v => ({ ...v, x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) }));
  };
  const endDrag = () => { dragRef.current = null; };

  if (layout.positioned.length === 0) {
    return <div className="nc-fabric-empty">No devices to plot.</div>;
  }

  // Column backgrounds — one faint band per floor column
  const columnBands = layout.columns.map((col) => {
    const positions = col.nodes.map((n) => n.box);
    if (!positions.length) return null;
    const left  = Math.min(...positions.map((b) => b.x)) - 22;
    const right = Math.max(...positions.map((b) => b.x + b.w)) + 22;
    const top   = Math.min(...positions.map((b) => b.y)) - 22;
    const bot   = Math.max(...positions.map((b) => b.y + b.h)) + 22;
    return { floor: col.floor, left, right, top, bot };
  }).filter(Boolean) as { floor: string; left: number; right: number; top: number; bot: number }[];

  // Tier rail labels — derived from columns (one entry per column)
  const tierLabels: { label: string; tone: 'core' | 'dist' | 'access' | 'mixed'; y: number }[] = [];
  for (const col of layout.columns) {
    if (!col.nodes.length) continue;
    const sample = col.nodes[0];
    // Pick the dominant role in this column for the pill colour
    const roles = col.nodes.map((n) => n.node.role);
    let tone: 'core' | 'dist' | 'access' | 'mixed' = 'access';
    if (roles.includes('core') && !roles.includes('dist') && !roles.includes('access')) tone = 'core';
    else if (roles.includes('dist') && !roles.includes('access')) tone = 'dist';
    else if (roles.includes('core') || roles.includes('dist')) tone = 'mixed';
    tierLabels.push({
      label: col.floor,
      y: (sample.box.y + sample.box.y + sample.box.h) / 2,
      tone,
    });
  }

  return (
    <div
      ref={wrapRef}
      className="nc-fabric"
      onWheel={onWheel}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={endDrag}
    >
      {/* Controls */}
      <div className="nc-fabric-controls">
        <button type="button" onClick={() => setViewport(v => ({ ...v, scale: Math.min(2.4, v.scale * 1.2) }))} title="Zoom in">＋</button>
        <button type="button" onClick={() => setViewport(v => ({ ...v, scale: Math.max(0.3, v.scale / 1.2) }))} title="Zoom out">−</button>
        <button type="button" onClick={fitToView} title="Fit to view">⤢</button>
      </div>

      <div className="nc-fabric-grid" />

      <div
        className="nc-fabric-canvas"
        style={{
          width:  layout.totalWidth,
          height: layout.totalHeight,
          transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
        }}
      >
        <svg
          className="nc-fabric-svg"
          width={layout.totalWidth}
          height={layout.totalHeight}
          viewBox={`0 0 ${layout.totalWidth} ${layout.totalHeight}`}
        >
          <defs>
            {(Object.keys(KIND_COLOR) as FabricLinkKind[]).map((kind) => (
              <marker
                key={`nc-arrow-${kind}`}
                id={`nc-arrow-${kind}`}
                viewBox="0 0 8 8"
                refX="6" refY="4"
                markerWidth="6" markerHeight="6"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill={KIND_COLOR[kind]} />
              </marker>
            ))}
          </defs>

          {/* Floor column bands */}
          <g className="nc-fabric-floor-bands">
            {columnBands.map((band) => (
              <g key={`band-${band.floor}`}>
                <rect x={band.left} y={band.top} width={band.right - band.left}
                  height={band.bot - band.top} rx={14} className="nc-fabric-floor-band" />
                <text x={band.left + 16} y={band.top + 18}
                  className="nc-fabric-floor-label" dominantBaseline="middle">
                  {band.floor}
                </text>
              </g>
            ))}
          </g>

          {/* Edges */}
          {edges.map((edge) => {
            const isDown  = edge.link.operStatus === 'down';
            const isHover = hoverEdge === edge.link.id;
            const marker  = `nc-arrow-${edge.link.kind}`;
            const stroke  = KIND_STROKE[edge.link.kind];
            return (
              <g
                key={edge.link.id}
                className={`nc-fabric-link is-${edge.link.kind}${isDown ? ' is-down' : ''}${isHover ? ' is-hover' : ''}`}
                onPointerEnter={() => setHoverEdge(edge.link.id)}
                onPointerLeave={() => setHoverEdge((cur) => cur === edge.link.id ? null : cur)}
              >
                <line
                  x1={edge.fromEnd.anchor.x} y1={edge.fromEnd.anchor.y}
                  x2={edge.fromEnd.stubEnd.x} y2={edge.fromEnd.stubEnd.y}
                  className="nc-fabric-stub"
                  stroke={KIND_COLOR[edge.link.kind]} strokeWidth={stroke}
                />
                <line
                  x1={edge.toEnd.anchor.x} y1={edge.toEnd.anchor.y}
                  x2={edge.toEnd.stubEnd.x} y2={edge.toEnd.stubEnd.y}
                  className="nc-fabric-stub"
                  stroke={KIND_COLOR[edge.link.kind]} strokeWidth={stroke}
                />
                <path className="nc-fabric-line-hit" d={edge.d} />
                <path
                  className="nc-fabric-line"
                  d={edge.d}
                  stroke={KIND_COLOR[edge.link.kind]}
                  strokeWidth={stroke}
                  markerEnd={`url(#${marker})`}
                />
                {isHover && (
                  <path
                    className="nc-fabric-line-emph"
                    d={edge.d}
                    stroke={KIND_COLOR[edge.link.kind]}
                    strokeWidth={stroke + 2}
                    markerEnd={`url(#${marker})`}
                  />
                )}
                <title>
                  {edge.link.fromName} {edge.link.fromPort} — {edge.link.toName} {edge.link.toPort}
                  {edge.link.note ? `\n${edge.link.note}` : ''}
                  {isDown ? '\nLINK DOWN' : ''}
                </title>
                <PortLabel end={edge.fromEnd} />
                <PortLabel end={edge.toEnd} />
              </g>
            );
          })}
        </svg>

        {/* Node cards (rendered on top of SVG) */}
        {layout.positioned.map((item) => (
          <FabricNodeCard key={item.node.id} node={item.node} box={item.box} />
        ))}
      </div>

      {/* Tier rail */}
      <aside className="nc-fabric-tier-rail" aria-hidden="true">
        {tierLabels.map((tier) => (
          <div
            key={`rail-${tier.label}`}
            className={`nc-fabric-tier-pill is-${tier.tone}`}
            style={{ top: viewport.y + tier.y * viewport.scale }}
          >
            {tier.label}
          </div>
        ))}
      </aside>
    </div>
  );
}

export { ROLE_LABEL };
export type { FabricLinkKind };
