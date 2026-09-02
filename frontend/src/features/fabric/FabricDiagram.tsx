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
import dagre from 'dagre';
import { deviceStatusMeta } from '@/design/status';
import type { DeviceStatus } from '@/types/device';
import type { FabricLink, FabricLinkKind, FabricNode, FabricRole } from '@/types/fabric';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NODE_W      = 228;
const NODE_H      = 96;
// Stubs must extend past the port label rect so the line itself is
// visible. Port label for `left/right` is ~34px wide and ~20px tall,
// sitting at offset (LABEL_OFFSET=14, 22) above the node midline. Stub
// needs to clear that.
const PORT_STUB   = 18;
const LABEL_OFFSET = 18;           // how far above the node midline a port label sits
const PORT_INSET  = 18;           // ports inset from node corners along the edge
const TIER_GAP    = 232;          // vertical gap between two tiers
// (NODE_GAP_X was the old heuristic spacing — dagre now uses nodesep.)
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
  // Geometric position of the label, already offset away from the line so
  // it never overlaps the diagonal itself.
  labelPos: Pt;
  labelAnchor: 'start' | 'middle' | 'end';
};

type EdgePath = {
  link:    FabricLink;
  d:       string;
  fromEnd: PortEnd;
  toEnd:   PortEnd;
};

type NodeLayout = { node: FabricNode; box: Box };
type TierLayout = { role: FabricRole; y: number; nodes: NodeLayout[] };
type TierMeta = {
  /** 0-based rank, top of pyramid first. */
  rank: number;
  /** Short label for the rail pill. */
  label: string;
  /** CSS tone suffix for the band and the node card class. */
  tone: 'core' | 'dist' | 'access' | 'leaf';
  /** Fallback FabricRole for CSS class injection. */
  role: FabricRole;
};
type LayoutResult = {
  positioned:   NodeLayout[];
  totalWidth:   number;
  totalHeight:  number;
  tiers:        TierLayout[];
  /** Rank metadata (label + tone) keyed by rank number, top first. */
  tierMeta:     TierMeta[];
  /** Map from device id to inferred 0-based rank. */
  rankById:     Map<string, number>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Role ordering (top → bottom in the canvas)
// ─────────────────────────────────────────────────────────────────────────────

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
// Layout — rank-inferred + dagre
//
// Topology can be more than 3 tiers: a typical bank has
//   CORE  (rank 0)
//   DIST  (rank 1)
//   ACCESS first-hop  (rank 2 — uplinks to DIST)
//   ACCESS second-hop (rank 3 — uplinks to ACCESS first-hop)
//
// We infer rank via BFS from cores so the layout stays correct when
// devices are added/removed. Dagre handles the actual X/Y placement so
// the result remains tidy for any N (e.g. 18 floors × 7 access each).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BFS-rank every node from any 'core' (rank 0). A node with multiple
 * parents gets rank = max(parent.rank) + 1, so a second-hop access
 * connected to a first-hop access lands at rank 3 (not 2). Orphan nodes
 * (no path from any core) fall back to their role-based TIER_RANK so
 * they still show up at a sensible vertical position.
 */
function inferTiers(
  nodes: FabricNode[],
  links: FabricLink[],
): { rankById: Map<string, number>; tiers: TierMeta[] } {
  const byId = new Map<string, FabricNode>();
  nodes.forEach((n) => byId.set(n.id, n));

  // Build adjacency (undirected) so BFS can travel either direction.
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const link of links) {
    if (!byId.has(link.fromDeviceId) || !byId.has(link.toDeviceId)) continue;
    adj.get(link.fromDeviceId)!.add(link.toDeviceId);
    adj.get(link.toDeviceId)!.add(link.fromDeviceId);
  }

  // Seed BFS with every core. Rank grows outward from cores — a dist
  // attached to a core gets rank 1; an access attached only to that
  // dist gets rank 2; another access attached only to that first-hop
  // access gets rank 3.
  const rankById = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (n.role === 'core') {
      rankById.set(n.id, 0);
      queue.push(n.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const r = rankById.get(id) ?? 0;
    for (const nb of adj.get(id) ?? []) {
      const existing = rankById.get(nb);
      const candidate = r + 1;
      if (existing === undefined || candidate < existing) {
        rankById.set(nb, candidate);
        queue.push(nb);
      }
    }
  }

  // Orphans → fall back to role-based TIER_RANK so they still render.
  for (const n of nodes) {
    if (!rankById.has(n.id)) {
      rankById.set(n.id, TIER_RANK[n.role]);
    }
  }

  // Bucket nodes per rank so we know how many tier bands to draw.
  const maxRank = nodes.length > 0 ? Math.max(...Array.from(rankById.values())) : 0;
  const tiers: TierMeta[] = [];
  for (let r = 0; r <= maxRank; r++) {
    let label: string;
    let tone: TierMeta['tone'];
    let role: FabricRole;
    switch (r) {
      case 0: label = 'Core';          tone = 'core';   role = 'core';   break;
      case 1: label = 'Distribution';  tone = 'dist';   role = 'dist';   break;
      case 2: label = 'Access L1';    tone = 'access'; role = 'access'; break;
      case 3: label = 'Access L2';    tone = 'leaf';   role = 'access'; break;
      default: label = `Tier ${r}`;    tone = 'leaf';   role = 'access';
    }
    tiers.push({ rank: r, label, tone, role });
  }
  return { rankById, tiers };
}

function layoutNodes(nodes: FabricNode[], links: FabricLink[]): LayoutResult {
  if (nodes.length === 0) {
    return {
      positioned: [],
      totalWidth: 0,
      totalHeight: 0,
      tiers: [],
      tierMeta: [],
      rankById: new Map(),
    };
  }

  // 1) BFS-rank every node.
  const { rankById, tiers: tierMeta } = inferTiers(nodes, links);

  // 2) Build a dagre graph. Dagre assigns ranks (top-to-bottom) via
  //    longest-path from a SOURCE node to a SINK node. Dagre picks
  //    sources = nodes with NO incoming edges, sinks = nodes with NO
  //    outgoing edges.
  //
  //    The DB stores edges as `local-port → remote-port` per device
  //    (the description parser records the local port as `from`).
  //    That means in practice an access switch's uplink to a dist is
  //    stored as `access → dist`, and a dist's downlink to a core is
  //    stored as `dist → core`. If we feed those edges to dagre as-is,
  //    dagre will treat the access switch as the SOURCE (rank 0, top
  //    of canvas) and the core as a sink (rank N, bottom) — the
  //    pyramid flips upside-down.
  //
  //    Fix: use our BFS-inferred rank to **normalize** every edge so
  //    it always points parent → child (lower rank → higher rank).
  //    The link's from/to/port fields stay unchanged (we still need
  //    those to label the ports correctly); only the dagre edge is
  //    flipped when needed.
  const g = new dagre.graphlib.Graph({ multigraph: false, compound: false });
  g.setGraph({
    rankdir: 'TB',
    ranksep: TIER_GAP,
    nodesep: 28,
    edgesep: 12,
    marginx: MARGIN_X,
    marginy: MARGIN_Y,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  }
  for (const link of links) {
    if (!g.hasNode(link.fromDeviceId) || !g.hasNode(link.toDeviceId)) continue;
    const fromRank = rankById.get(link.fromDeviceId) ?? 0;
    const toRank   = rankById.get(link.toDeviceId)   ?? 0;
    // Only feed STRICTLY parent → child edges to dagre. Skip:
    //   - same-rank peer links (CORE↔CORE, DIST↔DIST, etc.) — otherwise
    //     one core would land at rank 0 and the other at rank 1 because
    //     the edge makes the sink have an incoming dependency.
    //   - child→parent links after BFS flip — we flip them but only
    //     when there is an actual rank difference to avoid creating
    //     a self-loop in dagre's longest-path.
    if (fromRank === toRank) continue;
    // Always point parent (lower rank) → child (higher rank).
    const parentId = fromRank < toRank ? link.fromDeviceId : link.toDeviceId;
    const childId  = fromRank < toRank ? link.toDeviceId   : link.fromDeviceId;
    g.setEdge(parentId, childId, { id: link.id });
  }

  dagre.layout(g);

  // ── 3) Floor-based X grouping for access tiers ────────────────────────────
  // Dagre spreads rank-2/3 nodes horizontally across the full canvas to
  // avoid edge crossings, which makes a 90-node tier ~24 000 px wide.
  // Instead, group by floor so all switches on the same floor are near
  // each other. We infer a node's floor from its `floor` field.
  //
  // Strategy: for each unique floor, compute its centroid X from dagre's
  // output, then re-centre every node on that floor's column. This keeps
  // the horizontal ordering dagre chose but compresses each floor cluster
  // to FLOOR_COL_WIDE px instead of letting it sprawl.
  //
  // For second-hop (rank 3): additionally stack vertically within the
  // floor column so the 5 nodes fan out above each other.

  // Collect nodes per rank for access tiers
  const rank2Nodes: FabricNode[] = [];
  const rank3Nodes: FabricNode[] = [];
  for (const node of nodes) {
    const r = rankById.get(node.id) ?? TIER_RANK[node.role];
    if (r === 2) rank2Nodes.push(node);
    if (r === 3) rank3Nodes.push(node);
  }

  // Build a floor→index map from rank-2 nodes (one per floor in the
  // typical topology). Use `floor` field as the key; fall back to node id.
  const rank2ByFloor = new Map<string, FabricNode>();
  for (const n of rank2Nodes) rank2ByFloor.set(n.floor || n.id, n);
  const floors = [...rank2ByFloor.keys()].sort();
  const FLOOR_COL_WIDE = 320; // px per floor column (node 228 + gap 92)

  // Centroid X per floor from dagre's rank-2 output
  const floorX: Record<string, number> = {};
  for (const [fl, n] of rank2ByFloor) {
    const dn = g.node(n.id) as { x: number };
    floorX[fl] = dn?.x ?? 0;
  }

  // Sort floors by their dagre centroid X so ordering is preserved
  floors.sort((a, b) => (floorX[a] ?? 0) - (floorX[b] ?? 0));

  // Assign a compact column index to each floor
  const floorColIdx: Record<string, number> = {};
  floors.forEach((fl, i) => { floorColIdx[fl] = i; });

  // ── 4) Map dagre nodes to top-left boxMap with floor grouping ──────────
  const boxMap: Record<string, Box> = {};
  const rank2Y = rank2Nodes[0] ? (g.node(rank2Nodes[0].id) as { y: number }).y : (MARGIN_Y + 2 * (NODE_H + TIER_GAP));
  const rank3Y = rank3Nodes[0] ? (g.node(rank3Nodes[0].id) as { y: number }).y : (MARGIN_Y + 3 * (NODE_H + TIER_GAP));
  const rank3NodeH = 68; // second-hop nodes are slightly shorter to save vertical space

  for (const node of nodes) {
    const r = rankById.get(node.id) ?? TIER_RANK[node.role];
    const dn = g.node(node.id) as { x: number; y: number };
    const dagreX = dn?.x ?? 0;
    const dagreY = dn?.y ?? 0;

    // Default: dagre's center coords → top-left
    let x = dagreX - NODE_W / 2;
    let y = dagreY - NODE_H / 2;
    const fl = node.floor || node.id;

    if (r === 2) {
      // First-hop: compact to FLOOR_COL_WIDE column, stay on rank-2 Y.
      // If multiple first-hop nodes share the same floor (e.g. two access
      // switches on one floor), spread them horizontally so they don't
      // overlap at the same X coordinate.
      const col = floorColIdx[fl] ?? 0;
      const fhNodesInFloor = rank2Nodes.filter((n) => n.floor === node.floor);
      const fhIdx = fhNodesInFloor.indexOf(node);
      const FH_OFFSETS = [-50, 0, 50, -25, 25, -12, 12]; // up to 7 first-hop nodes
      const fhOffset = FH_OFFSETS[fhIdx % FH_OFFSETS.length] ?? 0;
      x = MARGIN_X + col * FLOOR_COL_WIDE + (FLOOR_COL_WIDE - NODE_W) / 2 + fhOffset;
      y = rank2Y - NODE_H / 2;
    } else if (r === 3) {
      // Second-hop: compact to same column, stack vertically.
      // Group by floor: all second-hop nodes on the same floor share the
      // same column X. Within a column, order by dagre's X relative
      // position to preserve left-to-right order.
      const col = floorColIdx[fl] ?? 0;
      // Base X = column start + half column width (center of column)
      const baseX = MARGIN_X + col * FLOOR_COL_WIDE + FLOOR_COL_WIDE / 2;
      // Offset: use dagre's relative order within the floor to pick
      // a fixed sub-column offset, so nodes don't all pile on the same X.
      const shNodesInFloor = rank3Nodes.filter((n) => n.floor === node.floor);
      const idx = shNodesInFloor.indexOf(node);
      const SH_OFFSETS = [-60, 0, 60, -30, 30]; // 5 fixed sub-offsets for 2nd-hop nodes
      x = baseX - NODE_W / 2 + (SH_OFFSETS[idx % SH_OFFSETS.length] ?? 0);
      // Stack vertically within rank-3 band
      y = rank3Y + (idx - (shNodesInFloor.length - 1) / 2) * (rank3NodeH + 8) - rank3NodeH / 2;
    }

    boxMap[node.id] = { x, y: Math.max(MARGIN_Y, y), w: NODE_W, h: r === 3 ? rank3NodeH : NODE_H };
  }

  // 4) Group positioned nodes by rank for the tier rail and bands.
  const tierNodes: Record<number, NodeLayout[]> = {};
  for (const node of nodes) {
    const r = rankById.get(node.id) ?? 0;
    (tierNodes[r] ||= []).push({ node, box: boxMap[node.id] });
  }
  // Sort each tier left-to-right so the rail pill label order is stable.
  for (const r in tierNodes) {
    tierNodes[r].sort((a, b) => a.box.x - b.box.x);
  }

  const tierLayouts: TierLayout[] = tierMeta.map((t) => ({
    role: ('access' as FabricRole), // legacy field — unused now that we use rank
    y: tierNodes[t.rank]?.[0]?.box.y ?? (MARGIN_Y + t.rank * (NODE_H + TIER_GAP)),
    nodes: tierNodes[t.rank] ?? [],
  }));

  const positioned: NodeLayout[] = [];
  for (const r in tierNodes) positioned.push(...tierNodes[r]);

  // Compute canvas bounding box from the actual boxMap extents so
  // pan/zoom and tier bands are accurate.
  const allBoxes = Object.values(boxMap);
  const totalWidth  = allBoxes.length > 0
    ? Math.max(...allBoxes.map((b) => b.x + b.w)) + MARGIN_X
    : 0;
  const totalHeight = allBoxes.length > 0
    ? Math.max(...allBoxes.map((b) => b.y + b.h)) + MARGIN_Y
    : 0;

  return {
    positioned,
    totalWidth,
    totalHeight,
    tiers: tierLayouts,
    tierMeta,
    rankById,
  };
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

  // Label sits in a quiet zone BESIDE the line so it never sits on the
  // diagonal itself. For left/right (same-tier horizontal) ports, the
  // line goes horizontally so we offset the label vertically — above the
  // node midline — instead of stacking it on top of the line.
  let labelPos: Pt;
  let labelAnchor: 'start' | 'middle' | 'end' = 'middle';
  switch (side) {
    case 'top':
      // pill is 20px tall → push it 22px above the stub end
      labelPos = { x: anchor.x, y: anchor.y - PORT_STUB - 22 };
      labelAnchor = 'middle';
      break;
    case 'bottom':
      labelPos = { x: anchor.x, y: anchor.y + PORT_STUB + 22 };
      labelAnchor = 'middle';
      break;
    case 'left':
      // Place label ABOVE the horizontal line that exits the left edge,
      // not on top of it. offsetY = -(node midline padding + half label
      // height) so the 20px-tall pill clears the line that runs through
      // the node midline.
      labelPos = { x: anchor.x - PORT_STUB - 6, y: anchor.y - LABEL_OFFSET };
      labelAnchor = 'end';
      break;
    case 'right':
      labelPos = { x: anchor.x + PORT_STUB + 6, y: anchor.y - LABEL_OFFSET };
      labelAnchor = 'start';
      break;
  }

  return { side, portName, anchor, stubEnd, labelPos, labelAnchor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side picker for cross-tier / same-tier links.
function crossTierSides(fr: number, tr: number): { fromSide: Anchor; toSide: Anchor } | null {
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

function PortLabel({ end }: { end: PortEnd }) {
  const label = end.portName?.trim();
  // Skip empty port names — they add noise without telling the user anything.
  if (!label) return null;

  const PAD_X = 9;
  const CHAR_W = 6.6;
  const H = 20;
  const w = Math.max(34, label.length * CHAR_W + PAD_X * 2);

  let x = end.labelPos.x;
  let y = end.labelPos.y;
  if (end.labelAnchor === 'end')     x -= w;
  else if (end.labelAnchor === 'start') x += 0;
  else                                x -= w / 2;

  const rectY = y - H / 2;
  const textX = end.labelPos.x;
  const textY = y;

  return (
    <g className="nc-fabric-port">
      <rect x={x} y={rectY} width={w} height={H} rx={6} className="nc-fabric-port-bg" />
      <text
        x={textX}
        y={textY}
        textAnchor={end.labelAnchor}
        dominantBaseline="central"
        className="nc-fabric-port-text"
      >
        {label}
      </text>
    </g>
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

    // Step 1: side pick + stub classification for every link.
    // Use the BFS-inferred rank (not the role-based rank) so a
    // second-hop access uses top/bottom stubs relative to its first-hop
    // parent, not relative to dist.
    type StubInfo = { fromSide: Anchor; toSide: Anchor; crossTier: boolean };
    const stubs: Record<string, StubInfo> = {};
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;
      const fr = layout.rankById.get(a.node.id) ?? TIER_RANK[a.node.role];
      const tr = layout.rankById.get(b.node.id) ?? TIER_RANK[b.node.role];
      const sides = crossTierSides(fr, tr);
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

  // Tier rail labels — driven by rank-based tierMeta now (5+ tiers
  // possible: Core, Distribution, Access L1, Access L2, ...).
  const tierRail: { label: string; tone: 'core' | 'dist' | 'access' | 'leaf'; y: number }[] =
    layout.tierMeta
      .filter((t) => (layout.tiers[t.rank]?.nodes.length ?? 0) > 0)
      .map((t) => {
        const tier = layout.tiers[t.rank];
        return {
          label: t.label.toUpperCase(),
          tone: t.tone,
          y: (tier?.y ?? MARGIN_Y + t.rank * (NODE_H + TIER_GAP)) + NODE_H / 2,
        };
      });

  // Tier background bands — each band hugs its OWN nodes' X-bbox plus a
  // small padding. Empty space between tiers stays the canvas background,
  // not part of any band. Uses tierMeta.tone for the CSS class.
  const tierBands = layout.tierMeta
    .map((t) => {
      const tier = layout.tiers[t.rank];
      if (!tier || tier.nodes.length === 0) return null;
      const xs = tier.nodes.map((n) => n.box.x);
      const xe = tier.nodes.map((n) => n.box.x + n.box.w);
      const xLeft  = Math.min(...xs);
      const xRight = Math.max(...xe);
      const PAD_X = 24;
      const PAD_Y = 18;
      return {
        tone: t.tone,
        left:  xLeft - PAD_X,
        right: xRight + PAD_X,
        top:   tier.y - PAD_Y,
        bot:   tier.y + NODE_H + PAD_Y,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

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
                key={`tier-band-${band.tone}`}
                x={band.left} y={band.top}
                width={band.right - band.left}
                height={band.bot - band.top}
                rx={14}
                className={`nc-fabric-tier-band is-${band.tone}`}
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
