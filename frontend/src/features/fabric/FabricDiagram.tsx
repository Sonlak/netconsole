/**
 * FabricDiagram — Network topology visualization.
 *
 * Layout model: classic 3-tier pyramid.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │   CORE  ───────────────────────────────────────────────  │  ← y = MARGIN_Y
 *   │                                                          │
 *   │       [CORE-01]                       [CORE-02]         │
 *   │            │                              │              │
 *   │            └────────┬─────────────────────┘              │  ← inter-tier bus A
 *   │                     │                                    │
 *   │            ┌────────┼────────┐                           │
 *   │            ▼        ▼        ▼                           │
 *   │   DIST  [DS-01]   [DS-02]   [DS-03]   [DS-04]            │  ← y = MARGIN_Y + NODE_H + GAP
 *   │            │        │        │                           │
 *   │            └────────┼────────┴──────────┐                │  ← inter-tier bus B
 *   │                     │                   │                │
 *   │            ┌────────┼────────┐          │                │
 *   │            ▼        ▼        ▼          ▼                │
 *   │   ACCESS [AS-01] [AS-02] [AS-03] [AS-04] [AS-05] [AS-06]│  ← y = MARGIN_Y + 2*(NODE_H + GAP)
 *   └──────────────────────────────────────────────────────────┘
 *
 * Each role forms its own horizontal row, evenly distributed.
 * Cross-tier links use orthogonal paths with a mid-Y bus that
 *  aligns all the lines landing at the same row. Parallel links
 *  get a small x-track offset so they fan out cleanly.
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
const PORT_STUB = 46;             // stub length from node edge into the bus
const TIER_GAP = 188;             // vertical gap between two tiers (extra room for fan-out)
const NODE_GAP_X = 72;            // horizontal gap between sibling nodes in same tier
const MARGIN_X = 60;
const MARGIN_Y = 110;
const RAIL_WIDTH = 136;
const TRACK_STEP_X = 18;          // x-offset for parallel links at stub level
const TRACK_STEP_BUS = 26;        // y-offset per-link for cross-tier bus level (separates parallel links)

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
  stubEnd:  Pt;   // end of the short stub into the bus lane
  labelPos: Pt;
  labelSize: { w: number; h: number };
  labelAnchor: 'start' | 'middle' | 'end';
  trackOffsetX: number;
  trackOffsetY: number;
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

type TierLayout = {
  role: FabricRole;
  y: number;
  nodes: NodeLayout[];
};

type LayoutResult = {
  positioned:   NodeLayout[];
  totalWidth:   number;
  totalHeight:  number;
  tiers:        TierLayout[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Role ordering (top→bottom in the canvas)
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: FabricRole[] = ['core', 'dist', 'access'];

const ROLE_LABEL: Record<FabricRole, string> = {
  core:   'Core',
  dist:   'Distribution',
  access: 'Access',
};

const TIER_RANK: Record<FabricRole, number> = {
  core:   0,
  dist:   1,
  access: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Layout — 3 horizontal tiers
// ─────────────────────────────────────────────────────────────────────────────

function layoutNodes(nodes: FabricNode[]): LayoutResult {
  // Bucket by role
  const buckets: Record<FabricRole, FabricNode[]> = { core: [], dist: [], access: [] };
  for (const node of nodes) buckets[node.role].push(node);
  for (const role of TIER_ORDER) {
    buckets[role].sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));
  }

  const maxTierCount = Math.max(1, ...TIER_ORDER.map((r) => buckets[r].length));
  const tierWidth = maxTierCount * NODE_W + Math.max(0, maxTierCount - 1) * NODE_GAP_X;
  const totalWidth = MARGIN_X * 2 + tierWidth;

  const positioned: NodeLayout[] = [];
  const tiers: TierLayout[] = [];

  let y = MARGIN_Y;
  for (const role of TIER_ORDER) {
    const tierNodes = buckets[role];
    const count = tierNodes.length;

    if (count === 0) {
      tiers.push({ role, y, nodes: [] });
      y += NODE_H + TIER_GAP;
      continue;
    }

    const rowWidth = count * NODE_W + (count - 1) * NODE_GAP_X;
    const startX = MARGIN_X + Math.max(0, (tierWidth - rowWidth) / 2);

    const placed: NodeLayout[] = [];
    for (let i = 0; i < count; i++) {
      const x = startX + i * (NODE_W + NODE_GAP_X);
      const box: Box = { x, y, w: NODE_W, h: NODE_H };
      const layout: NodeLayout = { node: tierNodes[i], box };
      positioned.push(layout);
      placed.push(layout);
    }

    tiers.push({ role, y, nodes: placed });
    y += NODE_H + TIER_GAP;
  }

  const totalHeight = y - TIER_GAP + MARGIN_Y;

  return { positioned, totalWidth, totalHeight, tiers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Port placement helpers
// ─────────────────────────────────────────────────────────────────────────────

function portOffset(portsOnSide: number, idx: number, side: Anchor): number {
  const totalLen = side === 'left' || side === 'right' ? NODE_H : NODE_W;
  if (portsOnSide <= 1) return totalLen / 2;
  const inset = 28;
  const usable = totalLen - inset * 2;
  return inset + (usable / (portsOnSide - 1)) * idx;
}

function portLabelWidth(name: string): number {
  return Math.max(64, (name?.length || 4) * 6.8 + 14);
}

function buildPortEnd(
  box:        Box,
  side:       Anchor,
  idx:        number,
  total:      number,
  portName:   string,
  trackOffsetX: number,
  trackOffsetY: number,
): PortEnd {
  const off  = portOffset(total, idx, side);
  const labelSize = { w: portLabelWidth(portName || ''), h: 20 };

  let anchor: Pt, stubEnd: Pt, labelPos: Pt;
  let labelAnchor: 'start' | 'middle' | 'end' = 'middle';

  switch (side) {
    case 'right': {
      anchor   = { x: box.x + box.w, y: box.y + off };
      stubEnd  = { x: box.x + box.w + PORT_STUB + trackOffsetX, y: box.y + off + trackOffsetY };
      // Label sits just to the right of the node, beside the port — out of the bus zone.
      labelPos = { x: anchor.x + 6, y: anchor.y - labelSize.h / 2 };
      labelAnchor = 'start';
      break;
    }
    case 'left': {
      anchor   = { x: box.x, y: box.y + off };
      stubEnd  = { x: box.x - PORT_STUB - trackOffsetX, y: box.y + off + trackOffsetY };
      labelPos = { x: anchor.x - 6, y: anchor.y - labelSize.h / 2 };
      labelAnchor = 'end';
      break;
    }
    case 'bottom': {
      anchor   = { x: box.x + off, y: box.y + box.h };
      stubEnd  = { x: box.x + off + trackOffsetX, y: box.y + box.h + PORT_STUB + trackOffsetY };
      // Label centred directly under the port — stays with the source node,
      // keeps the inter-tier bus zone free of stacked labels.
      labelPos = { x: anchor.x, y: anchor.y + 6 };
      labelAnchor = 'middle';
      break;
    }
    case 'top': {
      anchor   = { x: box.x + off, y: box.y };
      stubEnd  = { x: box.x + off + trackOffsetX, y: box.y - PORT_STUB - trackOffsetY };
      labelPos = { x: anchor.x, y: anchor.y - 6 - labelSize.h };
      labelAnchor = 'middle';
      break;
    }
  }

  return { side, portName, anchor, stubEnd, labelPos, labelSize, labelAnchor, trackOffsetX, trackOffsetY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side picker for cross-tier links
// ─────────────────────────────────────────────────────────────────────────────

function crossTierSides(fromRole: FabricRole, toRole: FabricRole): { fromSide: Anchor; toSide: Anchor } | null {
  const fr = TIER_RANK[fromRole];
  const tr = TIER_RANK[toRole];
  if (fr === tr) return null;        // same tier → use side routing
  if (fr < tr) return { fromSide: 'bottom', toSide: 'top' };
  return { fromSide: 'top', toSide: 'bottom' };
}

function pickSide(from: Box, to: Box): Anchor {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < 1) return dy > 0 ? 'bottom' : 'top';
  return dx > 0 ? 'right' : 'left';
}

// ─────────────────────────────────────────────────────────────────────────────
// Path builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-tier orthogonal path with PER-LINK busY offset.
 *
 * Each link gets its own busY (midY plus a per-source busOffset), so
 * parallel links from the same source fan out vertically and never
 * share a horizontal segment with each other. The result is 4
 * individually visible lines for 4 parallel links instead of one
 * bundled cable.
 */
function makeCrossTierPath(a: Pt, b: Pt, busOffset: number): string {
  if (Math.abs(a.x - b.x) < 1) {
    return `M ${a.x} ${a.y + busOffset} L ${b.x} ${b.y - busOffset}`;
  }
  const busY = (a.y + b.y) / 2 + busOffset;
  return `M ${a.x} ${a.y} L ${a.x} ${busY} L ${b.x} ${busY} L ${b.x} ${b.y}`;
}

function makeSidePath(a: Pt, b: Pt): string {
  // Same-tier side routing — horizontal with a small mid-y elbow.
  if (Math.abs(a.y - b.y) < 0.5) {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  const midY = (a.y + b.y) / 2;
  return `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Components
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

    // Per-SOURCE indexing: a source's links fan out vertically so they don't
    // share a horizontal bus segment. Per-PAIR indexing (the previous logic)
    // collapsed every parallel link onto the same busY → looked bundled.
    const linksBySource: Record<string, FabricLink[]> = {};
    for (const link of links) {
      (linksBySource[link.fromDeviceId] ||= []).push(link);
    }
    const sourceOrder: Record<string, number> = {};
    const sourceCount: Record<string, number> = {};
    Object.entries(linksBySource).forEach(([src, bucket]) => {
      sourceCount[src] = bucket.length;
      bucket.forEach((link, i) => { sourceOrder[link.id] = i; });
    });

    // Determine per-node, per-side port count. For cross-tier links we use
    // top/bottom edges; for same-tier links, left/right.
    type PortMap = Record<string, Record<Anchor, number>>;
    const portCount: PortMap = {};
    for (const item of layout.positioned) {
      portCount[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }

    type StubInfo = { fromSide: Anchor; toSide: Anchor; crossTier: boolean };
    const stubs: Record<string, StubInfo> = {};
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;
      const sides = crossTierSides(a.node.role, b.node.role);
      let fromSide: Anchor;
      let toSide: Anchor;
      let crossTier: boolean;
      if (sides) {
        fromSide = sides.fromSide;
        toSide   = sides.toSide;
        crossTier = true;
      } else {
        fromSide = pickSide(a.box, b.box);
        toSide   = pickSide(b.box, a.box);
        crossTier = false;
      }
      stubs[link.id] = { fromSide, toSide, crossTier };
      portCount[link.fromDeviceId][fromSide]++;
      portCount[link.toDeviceId][toSide]++;
    }

    const portIdx: PortMap = {};
    for (const item of layout.positioned) {
      portIdx[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }

    const edgeList: EdgePath[] = [];
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;

      const info   = stubs[link.id]!;
      const sideA  = info.fromSide;
      const sideB  = info.toSide;
      const order  = sourceOrder[link.id];
      const total  = sourceCount[link.fromDeviceId];
      // Centred fan-out around 0
      const trackX = (order - (total - 1) / 2) * TRACK_STEP_X;
      const busOffset = info.crossTier ? (order - (total - 1) / 2) * TRACK_STEP_BUS : 0;

      const idxA = portIdx[link.fromDeviceId][sideA]++;
      const idxB = portIdx[link.toDeviceId][sideB]++;

      const fromEnd = buildPortEnd(a.box, sideA, idxA, portCount[link.fromDeviceId][sideA], link.fromPort, trackX, 0);
      const toEnd   = buildPortEnd(b.box, sideB, idxB, portCount[link.toDeviceId][sideB], link.toPort,   trackX, 0);

      const d = info.crossTier ? makeCrossTierPath(fromEnd.stubEnd, toEnd.stubEnd, busOffset)
                               : makeSidePath(fromEnd.stubEnd, toEnd.stubEnd);

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
      y: 36,
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

  // Tier rail labels (CORE / DIST / ACCESS) — anchored to tier y
  const tierRail: { label: string; tone: FabricRole; y: number }[] = layout.tiers
    .filter((t) => t.nodes.length > 0)
    .map((t) => ({ label: ROLE_LABEL[t.role].toUpperCase(), tone: t.role, y: t.y + NODE_H / 2 }));

  // Tier background bands — full-width faint strips behind each tier
  const tierBands = layout.tiers
    .filter((t) => t.nodes.length > 0)
    .map((t) => ({
      role: t.role,
      left:  MARGIN_X - 24,
      right: layout.totalWidth - MARGIN_X + 24,
      top:   t.y - 14,
      bot:   t.y + NODE_H + 14,
    }));

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

          {/* Tier background bands */}
          <g className="nc-fabric-tier-bands">
            {tierBands.map((band) => (
              <rect
                key={`tier-band-${band.role}`}
                x={band.left} y={band.top}
                width={band.right - band.left}
                height={band.bot - band.top}
                rx={14}
                className={`nc-fabric-tier-band is-${band.role}`}
              />
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
        {tierRail.map((tier) => (
          <div
            key={`rail-${tier.tone}`}
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