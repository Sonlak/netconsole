/**
 * FabricDiagram — Network topology visualization.
 *
 * Layout model: classic 3-tier pyramid with **gravitational alignment**.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │   CORE  ───────────────────────────────────────────────  │
 *   │       [CORE-01]                       [CORE-02]         │
 *   │            │   ╲                    ╱   │              │  ← L3 uplinks (orange)
 *   │            │    ╲──────────────────╱    │              │
 *   │            └─────┼────────────────┼─────┘              │  ← inter-tier bus
 *   │                  │                │                    │
 *   │            ┌─────┼────────────────┼─────┐              │
 *   │            ▼     ▼                ▼     ▼              │  ← trunk downlinks (blue)
 *   │   DIST  [DS-01]    [DS-02]                             │
 *   │            │  ╲       ╱  │                            │
 *   │            │   ╲─────╱   │                            │  ← inter-tier bus
 *   │            │    ╱───╲    │                            │
 *   │            ▼   ╱     ╲   ▼                            │
 *   │   ACCESS  [F1]  [F2]  [F3]  [F3-AS-02]                │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Each tier (access / dist / core) is laid out **gravitationally**:
 *  - Access is evenly distributed across the bottom row.
 *  - Each dist is centered above its access children (with symmetric
 *    spread when several dists share the same centroid, which happens
 *    in a full-mesh).
 *  - Each core is centered above its dist children — same scheme — so
 *    cores and dists end up in the same vertical columns and primary
 *    uplinks read as straight vertical lines.
 *
 * Edge routing:
 *  - Each source's outgoing cross-tier links share a **contiguous block
 *    of busY slots**, and different sources get different blocks. So
 *    links from different sources never overlap on the same bus line
 *    even when the topology is full-mesh.
 *  - Within a source, links are sorted by target X so the source's
 *    ports fan out from left (closest target) to right (farthest target)
 *    — matching the physical wiring intuition.
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
const PORT_STUB = 42;             // stub length from node edge into the bus
const TIER_GAP = 232;             // vertical gap between two tiers (extra room for per-source fan-out)
const NODE_GAP_X = 72;            // horizontal gap between sibling nodes in same tier
const MARGIN_X = 60;
const MARGIN_Y = 110;
const RAIL_WIDTH = 136;
const TRACK_STEP_BUS = 18;        // y-spacing between adjacent bus lanes — keeps lines from different sources on distinct busY rows

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
// Layout — 3 horizontal tiers with gravitational alignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a map: parentNodeId -> [childNode] where "parent" lives in a
 * higher tier (smaller rank) than "child". Same-tier links are dropped.
 */
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
  // Bucket by role
  const buckets: Record<FabricRole, FabricNode[]> = { core: [], dist: [], access: [] };
  for (const node of nodes) buckets[node.role].push(node);
  for (const role of TIER_ORDER) {
    buckets[role].sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true }));
  }

  const childrenOf = buildChildrenOf(nodes, links);

  // Canvas width — based on the widest tier
  const maxTierCount = Math.max(1, ...TIER_ORDER.map((r) => buckets[r].length));
  const tierWidth = maxTierCount * NODE_W + Math.max(0, maxTierCount - 1) * NODE_GAP_X;
  const totalWidth = MARGIN_X * 2 + tierWidth;

  // Tier Y positions
  const tierY: Record<FabricRole, number> = {
    core:   MARGIN_Y,
    dist:   MARGIN_Y + NODE_H + TIER_GAP,
    access: MARGIN_Y + 2 * (NODE_H + TIER_GAP),
  };
  const totalHeight = tierY.access + NODE_H + MARGIN_Y;

  const boxMap: Record<string, Box> = {};

  // ── Step 1: place ACCESS evenly across the canvas ────────────────────────────
  const accessNodes = buckets.access;
  if (accessNodes.length > 0) {
    const rowWidth = accessNodes.length * NODE_W + Math.max(0, accessNodes.length - 1) * NODE_GAP_X;
    const startX = MARGIN_X + (tierWidth - rowWidth) / 2;
    for (let i = 0; i < accessNodes.length; i++) {
      const x = startX + i * (NODE_W + NODE_GAP_X);
      boxMap[accessNodes[i].id] = { x, y: tierY.access, w: NODE_W, h: NODE_H };
    }
  }

  // ── Step 2: place DIST and CORE gravitationally ──────────────────────────────
  //
  // Each parent is positioned at the centroid of its children in the tier
  // below. When several parents share the same centroid (full-mesh case),
  // they are spread out symmetrically around that centroid. Because the
  // core tier uses the dist tier's positions as its children, cores land
  // in the same vertical columns as the dists — primary uplinks read as
  // straight vertical lines, only the cross-uplinks cross.
  function placeTier(role: FabricRole, childRole: FabricRole) {
    const tierNodes = buckets[role];
    if (tierNodes.length === 0) return;

    // Compute target X = centroid of children. If a parent has no
    // children in the target tier, fall back to even distribution
    // across the canvas.
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

    // Sort left-to-right by target. The secondary sort by `idx`
    // preserves the bucket order when targets tie (full-mesh).
    items.sort((a, b) => a.target - b.target || a.idx - b.idx);

    // Symmetric spread around each node's target so the row reads as a
    // regular sequence. Spacing is wider than a single NODE_W+NODE_GAP_X
    // so primary uplinks don't bunch up over their target.
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

  // Build result
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

  const layout = useMemo(() => layoutNodes(nodes, links), [nodes, links]);

  // ── Build edges ────────────────────────────────────────────────────────────
  const edges = useMemo(() => {
    const idx: Record<string, NodeLayout> = {};
    for (const item of layout.positioned) idx[item.node.id] = item;

    // Step 1: group links by source, then sort each source's outgoing
    // links by target X (left → right). Sorting by target X makes the
    // source's ports fan out naturally: port 0 (leftmost on the node) is
    // the link that goes to the leftmost target, etc. Without this sort
    // ports get filled in link-list order which can produce crossings on
    // a full-mesh where DS-02 → F1 ends up using DS-02's middle port.
    const linksBySource: Record<string, FabricLink[]> = {};
    for (const link of links) {
      (linksBySource[link.fromDeviceId] ||= []).push(link);
    }
    for (const srcId in linksBySource) {
      linksBySource[srcId].sort((a, b) => {
        const aBox = idx[a.toDeviceId]?.box;
        const bBox = idx[b.toDeviceId]?.box;
        if (!aBox || !bBox) return 0;
        return aBox.x - bBox.x;
      });
    }

    // Step 2: classify each link by (source, direction). 'up' means the
    // link crosses from a lower tier to a higher tier (e.g. dist→core);
    // 'down' means the opposite (dist→access).
    type Direction = 'up' | 'down';
    type SourceDir = { srcId: string; direction: Direction; count: number };
    function linkDirection(link: FabricLink): Direction | null {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) return null;
      if (a.node.role === b.node.role) return null;
      return TIER_RANK[b.node.role] > TIER_RANK[a.node.role] ? 'up' : 'down';
    }

    const sourceDirs: SourceDir[] = [];
    const sourceDirCount: Record<string, number> = {};
    for (const srcId in linksBySource) {
      let upCount = 0, downCount = 0;
      for (const link of linksBySource[srcId]) {
        const dir = linkDirection(link);
        if (dir === 'up') upCount++;
        else if (dir === 'down') downCount++;
      }
      if (downCount > 0) {
        const key = `${srcId}:down`;
        sourceDirs.push({ srcId, direction: 'down', count: downCount });
        sourceDirCount[key] = downCount;
      }
      if (upCount > 0) {
        const key = `${srcId}:up`;
        sourceDirs.push({ srcId, direction: 'up', count: upCount });
        sourceDirCount[key] = upCount;
      }
    }

    // Step 3: assign each (source, direction) a contiguous slice of bus
    // indices. Different sources get different slices, so lines from
    // different sources never share a busY row — that's how the diagram
    // stays readable when the topology is full-mesh.
    const totalCrossLinks = sourceDirs.reduce((acc, sd) => acc + sd.count, 0);
    const halfTotal = (totalCrossLinks - 1) / 2;
    const sourceDirBase: Record<string, number> = {};
    {
      let cursor = -halfTotal;
      for (const sd of sourceDirs) {
        const key = `${sd.srcId}:${sd.direction}`;
        sourceDirBase[key] = cursor;
        cursor += sd.count;
      }
    }

    const linkBusOffset: Record<string, number> = {};
    for (const sd of sourceDirs) {
      const key = `${sd.srcId}:${sd.direction}`;
      const filtered = linksBySource[sd.srcId].filter((l) => linkDirection(l) === sd.direction);
      filtered.forEach((link, i) => {
        linkBusOffset[link.id] = (sourceDirBase[key] + i) * TRACK_STEP_BUS;
      });
    }

    // Step 4: count and assign port indices per (node, side). The
    // source side uses the position of the link within the source's
    // already-sorted outgoing list (filtered by side) so ports fan
    // out by target X.
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

    // For the source side, use the position in the source's sorted
    // outgoing list so ports fan left-to-right by target X. The
    // destination side keeps the natural order — it doesn't matter
    // visually because both directions of a link converge on the
    // target.
    function sourcePortIdx(link: FabricLink, side: Anchor): number {
      const srcLinks = linksBySource[link.fromDeviceId] || [];
      const onSide = srcLinks.filter((l) => stubs[l.id]?.fromSide === side);
      const idxOnSide = onSide.indexOf(link);
      return idxOnSide < 0 ? 0 : idxOnSide;
    }

    const portIdxTarget: PortMap = {};
    for (const item of layout.positioned) {
      portIdxTarget[item.node.id] = { left: 0, right: 0, top: 0, bottom: 0 };
    }

    const edgeList: EdgePath[] = [];
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;

      const info   = stubs[link.id]!;
      const sideA  = info.fromSide;
      const sideB  = info.toSide;

      const idxA = sourcePortIdx(link, sideA);
      const idxB = portIdxTarget[link.toDeviceId][sideB]++;

      const trackX = 0;
      const busOffset = info.crossTier ? (linkBusOffset[link.id] ?? 0) : 0;

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