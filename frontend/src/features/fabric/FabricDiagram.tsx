/**
 * FabricDiagram — Network topology visualization.
 *
 * Layout model: classic 3-tier pyramid with **gravitational alignment**.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │   CORE  ───────────────────────────────────────────────  │
 *   │       [CORE-01]                       [CORE-02]         │
 *   │            ╲                          ╱                  │
 *   │             ╲                        ╱                   │  ← L3 uplinks (straight diagonals)
 *   │              ╲──────────────────────╱                    │
 *   │               ╲                    ╱                     │
 *   │   DIST  [DS-01]                      [DS-02]             │
 *   │            │╲ │╲                  ╱│╱│                   │
 *   │            │  ╲ ╲                ╱ ╱ │                   │  ← trunk downlinks, fanned out
 *   │            │   ╲  ╲            ╱  ╱  │                   │
 *   │            │    ╲   ╲────────╱   ╱   │                   │
 *   │   ACCESS   [F1]   [F2]   [F3]   [F3-AS-02]              │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Tier placement (gravitational):
 *  - Access row is evenly spread across the bottom.
 *  - Each dist is centred above its access children. With full-mesh
 *    children, dists spread symmetrically around the shared centroid.
 *  - Each core is centred above its dist children — same scheme.
 *
 * Edge routing (straight diagonals):
 *  - One straight line per link, from source stub to target stub.
 *  - Source ports are sorted by target X so the source's ports fan out
 *    naturally (leftmost port → leftmost target, etc.).
 *  - Target ports are sorted by source X for the same reason.
 *  - No bus lanes, no orthogonal paths, no per-source vertical offsets.
 *  - Result: clean diagonal lines that fan out without crossing inside
 *    a single tier-to-tier span.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceStatusMeta } from '@/design/status';
import type { DeviceStatus } from '@/types/device';
import type { FabricLink, FabricLinkKind, FabricNode, FabricRole } from '@/types/fabric';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NODE_W      = 228;
const NODE_H      = 96;
const PORT_STUB   = 8;            // short stub from node edge to clear the border
const PORT_INSET  = 18;           // ports inset from node corners along the edge
const TIER_GAP    = 220;          // vertical gap between two tiers
const NODE_GAP_X  = 72;           // horizontal gap between sibling nodes
const MARGIN_X    = 60;
const MARGIN_Y    = 110;
const RAIL_WIDTH  = 136;

const KIND_COLOR: Record<FabricLinkKind, string> = {
  trunk:   '#4f9cf9',
  peer:    '#8b93a7',
  l3:      '#f0a14a',
  uplink:  '#9aa3b6',
};

const KIND_STROKE: Record<FabricLinkKind, number> = {
  trunk:   2.4,
  peer:    1.8,
  l3:      2.6,
  uplink:  1.6,
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry types
// ─────────────────────────────────────────────────────────────────────────────

type Pt   = { x: number; y: number };
type Box  = Pt & { w: number; h: number };
type Anchor = 'left' | 'right' | 'top' | 'bottom';

type PortEnd = {
  side: Anchor;
  portName: string;
  anchor:   Pt;       // point on the node edge
  stubEnd:  Pt;       // end of the short perpendicular stub
};

type EdgePath = {
  link:    FabricLink;
  d:       string;
  fromEnd: PortEnd;
  toEnd:   PortEnd;
};

type NodeLayout = { node: FabricNode; box: Box };
type TierLayout = { role: FabricRole; y: number; nodes: NodeLayout[] };
type LayoutResult = {
  positioned:   NodeLayout[];
  totalWidth:   number;
  totalHeight:  number;
  tiers:        TierLayout[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Role ordering (top → bottom in the canvas)
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
// Layout — 3 horizontal tiers with gravitational alignment
// ─────────────────────────────────────────────────────────────────────────────

function buildChildrenOf(nodes: FabricNode[], links: FabricLink[]): Record<string, FabricNode[]> {
  const byId = new Map<string, FabricNode>();
  for (const n of nodes) byId.set(n.id, n);
  const childrenOf: Record<string, FabricNode[]> = {};
  for (const link of links) {
    const a = byId.get(link.fromDeviceId);
    const b = byId.get(link.toDeviceId);
    if (!a || !b) continue;
    let parent: FabricNode, child: FabricNode;
    if (TIER_RANK[a.role] < TIER_RANK[b.role]) { parent = a; child = b; }
    else if (TIER_RANK[b.role] < TIER_RANK[a.role]) { parent = b; child = a; }
    else continue;
    (childrenOf[parent.id] ||= []).push(child);
  }
  return childrenOf;
}

function layoutNodes(nodes: FabricNode[], links: FabricLink[]): LayoutResult {
  const buckets: Record<FabricRole, FabricNode[]> = { core: [], dist: [], access: [] };
  for (const node of nodes) buckets[node.role].push(node);
  for (const role of TIER_ORDER) {
    buckets[role].sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));
  }

  const childrenOf = buildChildrenOf(nodes, links);

  const maxTierCount = Math.max(1, ...TIER_ORDER.map((r) => buckets[r].length));
  const tierWidth = maxTierCount * NODE_W + Math.max(0, maxTierCount - 1) * NODE_GAP_X;
  const totalWidth = MARGIN_X * 2 + tierWidth;

  const tierY: Record<FabricRole, number> = {
    core:   MARGIN_Y,
    dist:   MARGIN_Y + NODE_H + TIER_GAP,
    access: MARGIN_Y + 2 * (NODE_H + TIER_GAP),
  };
  const totalHeight = tierY.access + NODE_H + MARGIN_Y;

  const boxMap: Record<string, Box> = {};

  // ACCESS row — evenly placed
  const accessNodes = buckets.access;
  if (accessNodes.length > 0) {
    const rowWidth = accessNodes.length * NODE_W + Math.max(0, accessNodes.length - 1) * NODE_GAP_X;
    const startX = MARGIN_X + (tierWidth - rowWidth) / 2;
    for (let i = 0; i < accessNodes.length; i++) {
      const x = startX + i * (NODE_W + NODE_GAP_X);
      boxMap[accessNodes[i].id] = { x, y: tierY.access, w: NODE_W, h: NODE_H };
    }
  }

  // DIST and CORE — gravitational alignment
  function placeTier(role: FabricRole, childRole: FabricRole) {
    const tierNodes = buckets[role];
    if (tierNodes.length === 0) return;

    const items = tierNodes.map((node, idx) => {
      const children = (childrenOf[node.id] || []).filter((c) => c.role === childRole);
      let target: number;
      if (children.length > 0) {
        target = children.reduce((acc, c) => acc + (boxMap[c.id]?.x ?? 0), 0) / children.length;
      } else {
        const n = tierNodes.length;
        target = n === 1
          ? MARGIN_X + (tierWidth - NODE_W) / 2
          : MARGIN_X + idx * (tierWidth - NODE_W) / (n - 1);
      }
      return { id: node.id, target, idx };
    });

    items.sort((a, b) => a.target - b.target || a.idx - b.idx);

    const spacing = NODE_W + NODE_GAP_X + 24;
    const n = items.length;
    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * spacing;
      let x = items[i].target + offset;
      x = Math.max(MARGIN_X, Math.min(MARGIN_X + tierWidth - NODE_W, x));
      boxMap[items[i].id] = { x, y: tierY[role], w: NODE_W, h: NODE_H };
    }
  }

  placeTier('dist', 'access');
  placeTier('core', 'dist');

  const positioned: NodeLayout[] = [];
  const tiers: TierLayout[] = [];
  for (const role of TIER_ORDER) {
    const tierNodes = buckets[role];
    const tierLayout: NodeLayout[] = tierNodes.map((node) => ({
      node,
      box: boxMap[node.id],
    }));
    tiers.push({ role, y: tierY[role], nodes: tierLayout });
    positioned.push(...tierLayout);
  }

  return { positioned, totalWidth, totalHeight, tiers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Port placement — distribute evenly along node edge
// ─────────────────────────────────────────────────────────────────────────────

function portAnchorOnEdge(box: Box, side: Anchor, idx: number, total: number): Pt {
  const t = total <= 1 ? 0.5 : idx / Math.max(1, total - 1);
  if (side === 'top' || side === 'bottom') {
    return {
      x: box.x + PORT_INSET + (box.w - 2 * PORT_INSET) * t,
      y: side === 'bottom' ? box.y + box.h : box.y,
    };
  }
  return {
    x: side === 'right' ? box.x + box.w : box.x,
    y: box.y + PORT_INSET + (box.h - 2 * PORT_INSET) * t,
  };
}

function stubFromAnchor(anchor: Pt, side: Anchor, length: number): Pt {
  switch (side) {
    case 'top':    return { x: anchor.x, y: anchor.y - length };
    case 'bottom': return { x: anchor.x, y: anchor.y + length };
    case 'left':   return { x: anchor.x - length, y: anchor.y };
    case 'right':  return { x: anchor.x + length, y: anchor.y };
  }
}

function buildPortEnd(
  box: Box,
  side: Anchor,
  idx: number,
  total: number,
  portName: string,
): PortEnd {
  const anchor  = portAnchorOnEdge(box, side, idx, total);
  const stubEnd = stubFromAnchor(anchor, side, PORT_STUB);
  return { side, portName, anchor, stubEnd };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side picker for cross-tier / same-tier links
// ─────────────────────────────────────────────────────────────────────────────

function crossTierSides(fromRole: FabricRole, toRole: FabricRole): { fromSide: Anchor; toSide: Anchor } | null {
  const fr = TIER_RANK[fromRole];
  const tr = TIER_RANK[toRole];
  if (fr === tr) return null;
  if (fr < tr) return { fromSide: 'bottom', toSide: 'top' };
  return { fromSide: 'top', toSide: 'bottom' };
}

function pickSide(from: Box, to: Box): Anchor {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) < 1) return dy > 0 ? 'bottom' : 'top';
  return dx > 0 ? 'right' : 'left';
}

// ─────────────────────────────────────────────────────────────────────────────
// Path — single straight diagonal
// ─────────────────────────────────────────────────────────────────────────────

function makeStraightPath(a: Pt, b: Pt): string {
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
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

function PortLabel({ end, visible }: { end: PortEnd; visible: boolean }) {
  const label = end.portName?.trim() || '—';
  let x = end.stubEnd.x;
  let y = end.stubEnd.y;
  let anchor: 'start' | 'middle' | 'end' = 'middle';
  let dy = 4;

  switch (end.side) {
    case 'top':
      y -= 6;
      anchor = 'middle';
      dy = -2;
      break;
    case 'bottom':
      y += 14;
      anchor = 'middle';
      dy = 0;
      break;
    case 'left':
      x -= 4;
      anchor = 'end';
      dy = 4;
      break;
    case 'right':
      x += 4;
      anchor = 'start';
      dy = 4;
      break;
  }

  return (
    <text
      x={x}
      y={y + dy}
      textAnchor={anchor}
      dominantBaseline="middle"
      className={`nc-fabric-port-label${visible ? ' is-visible' : ''}`}
    >
      {label}
    </text>
  );
}

export function FabricDiagram({ nodes, links }: { nodes: FabricNode[]; links: FabricLink[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [viewport,   setViewport]   = useState({ x: 0, y: 0, scale: 1 });
  const [hoverEdge,  setHoverEdge]  = useState<string | null>(null);

  const layout = useMemo(() => layoutNodes(nodes, links), [nodes, links]);

  // ── Build edges ────────────────────────────────────────────────────────────
  const edges = useMemo(() => {
    const idx: Record<string, NodeLayout> = {};
    for (const item of layout.positioned) idx[item.node.id] = item;

    // Step 1: side pick + stub classification for every link
    type StubInfo = { fromSide: Anchor; toSide: Anchor; crossTier: boolean };
    const stubs: Record<string, StubInfo> = {};
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;
      const sides = crossTierSides(a.node.role, b.node.role);
      if (sides) {
        stubs[link.id] = { fromSide: sides.fromSide, toSide: sides.toSide, crossTier: true };
      } else {
        const fromSide = pickSide(a.box, b.box);
        const toSide   = pickSide(b.box, a.box);
        stubs[link.id] = { fromSide, toSide, crossTier: false };
      }
    }

    // Step 2: assign a port index for every (node, side).
    //   - On the source side, ports are filled in the order returned by
    //     linksBySource (already sorted by target X). Leftmost source
    //     port → leftmost target.
    //   - On the target side, ports are filled in the order returned by
    //     linksByTarget (sorted by source X). Leftmost target port ←
    //     leftmost source.
    const linksBySource: Record<string, FabricLink[]> = {};
    const linksByTarget: Record<string, FabricLink[]> = {};
    for (const link of links) {
      (linksBySource[link.fromDeviceId] ||= []).push(link);
      (linksByTarget[link.toDeviceId]   ||= []).push(link);
    }
    for (const srcId in linksBySource) {
      linksBySource[srcId].sort((a, b) => {
        const aBox = idx[a.toDeviceId]?.box;
        const bBox = idx[b.toDeviceId]?.box;
        if (!aBox || !bBox) return 0;
        return aBox.x - bBox.x;
      });
    }
    for (const tgtId in linksByTarget) {
      linksByTarget[tgtId].sort((a, b) => {
        const aBox = idx[a.fromDeviceId]?.box;
        const bBox = idx[b.fromDeviceId]?.box;
        if (!aBox || !bBox) return 0;
        return aBox.x - bBox.x;
      });
    }

    // Step 3: port count per (node, side). Two passes — first count,
    // then assign index by walking each source's sorted list once.
    type PortMap = Record<string, Record<Anchor, number>>;
    const portCount: PortMap = {};
    for (const item of layout.positioned) {
      portCount[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }
    for (const link of links) {
      const info = stubs[link.id];
      if (!info) continue;
      portCount[link.fromDeviceId][info.fromSide]++;
      portCount[link.toDeviceId][info.toSide]++;
    }

    // Step 4: build edges
    const sourceCursor: Record<string, Record<Anchor, number>> = {};
    const targetCursor: Record<string, Record<Anchor, number>> = {};
    for (const item of layout.positioned) {
      sourceCursor[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
      targetCursor[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }

    function sourcePortIdx(link: FabricLink, side: Anchor): number {
      const list = (linksBySource[link.fromDeviceId] || []).filter((l) => stubs[l.id]?.fromSide === side);
      return list.indexOf(link);
    }
    function targetPortIdx(link: FabricLink, side: Anchor): number {
      const list = (linksByTarget[link.toDeviceId] || []).filter((l) => stubs[l.id]?.toSide === side);
      return list.indexOf(link);
    }

    const edgeList: EdgePath[] = [];
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;
      const info = stubs[link.id]!;

      const fromIdx = sourcePortIdx(link, info.fromSide);
      const toIdx   = targetPortIdx(link, info.toSide);
      const fromTotal = portCount[link.fromDeviceId][info.fromSide];
      const toTotal   = portCount[link.toDeviceId][info.toSide];

      const fromEnd = buildPortEnd(a.box, info.fromSide, fromIdx, fromTotal, link.fromPort);
      const toEnd   = buildPortEnd(b.box, info.toSide,   toIdx,   toTotal,   link.toPort);

      const d = makeStraightPath(fromEnd.stubEnd, toEnd.stubEnd);
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
    const rect = wrap.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(0.3, Math.min(2.4, viewport.scale * factor));
    const ratio = next / viewport.scale;
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

  // Tier rail labels
  const tierRail: { label: string; tone: FabricRole; y: number }[] = layout.tiers
    .filter((t) => t.nodes.length > 0)
    .map((t) => ({ label: ROLE_LABEL[t.role].toUpperCase(), tone: t.role, y: t.y + NODE_H / 2 }));

  // Tier background bands
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
            const isVisible = isHover;       // labels only on hover — keeps canvas clean
            return (
              <g
                key={edge.link.id}
                className={`nc-fabric-link is-${edge.link.kind}${isDown ? ' is-down' : ''}${isHover ? ' is-hover' : ''}`}
                onPointerEnter={() => setHoverEdge(edge.link.id)}
                onPointerLeave={() => setHoverEdge((cur) => cur === edge.link.id ? null : cur)}
              >
                {/* Stub at source — short perpendicular segment */}
                <line
                  x1={edge.fromEnd.anchor.x} y1={edge.fromEnd.anchor.y}
                  x2={edge.fromEnd.stubEnd.x} y2={edge.fromEnd.stubEnd.y}
                  className="nc-fabric-stub"
                  stroke={KIND_COLOR[edge.link.kind]} strokeWidth={stroke}
                />
                {/* Stub at target */}
                <line
                  x1={edge.toEnd.anchor.x} y1={edge.toEnd.anchor.y}
                  x2={edge.toEnd.stubEnd.x} y2={edge.toEnd.stubEnd.y}
                  className="nc-fabric-stub"
                  stroke={KIND_COLOR[edge.link.kind]} strokeWidth={stroke}
                />
                {/* Hit area for hover */}
                <path className="nc-fabric-line-hit" d={edge.d} />
                {/* The link itself — single straight diagonal */}
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
                    strokeWidth={stroke + 2.2}
                    markerEnd={`url(#${marker})`}
                  />
                )}
                <title>
                  {edge.link.fromName} {edge.link.fromPort} — {edge.link.toName} {edge.link.toPort}
                  {edge.link.note ? `\n${edge.link.note}` : ''}
                  {isDown ? '\nLINK DOWN' : ''}
                </title>
                <PortLabel end={edge.fromEnd} visible={isVisible} />
                <PortLabel end={edge.toEnd}   visible={isVisible} />
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
