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
  /**
   * True for the L-path used by lower-sibling links. The path's first
   * segment is the horizontal "source stub" (anchor → bypass point), so
   * we skip rendering the separate `<line>` stub at the source.
   */
  bypass?: boolean;
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
  /**
   * For each rank-3 node, its index among its siblings (nodes that share
   * at least one rank-2 parent). Used by the link routing to detect
   * "lower sibling in a vertical stack" — those need an L-path that
   * bypasses the upper sibling's box instead of a straight diagonal
   * that would visually cross the upper sibling.
   *
   * Index 0 = top sibling (closest to parent).
   * Index N-1 = bottom sibling (furthest from parent).
   */
  siblingIdx:   Map<string, number>;
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
      siblingIdx: new Map(),
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
    // nodesep is the horizontal gap between sibling nodes (e.g. the 2
    // cores sit side-by-side at rank 0). User wants the 2 cores visibly
    // apart so the L3 interconnect link between them is readable —
    // keep this >= 80 so the link between same-rank peers is not
    // visually crushed into a tiny stub.
    nodesep: 110,
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
  // Tier-Y baselines (centred Y from dagre for each rank tier). We
  // need them because rank-2 nodes are arranged in a compact column
  // (not spread by dagre), so we re-anchor them to a single Y line
  // per tier rather than trusting dagre's per-node coords.
  const rank2Y = rank2Nodes[0]
    ? (g.node(rank2Nodes[0].id) as { y: number }).y
    : (MARGIN_Y + 2 * (NODE_H + TIER_GAP));
  const rank3Y = rank3Nodes[0]
    ? (g.node(rank3Nodes[0].id) as { y: number }).y
    : (MARGIN_Y + 3 * (NODE_H + TIER_GAP));
  const rank3NodeH = 68; // second-hop nodes are slightly shorter to save vertical space

  // Pre-compute parent ID for every rank-3 node: each rank-3 switch has
  // at least one rank-2 (first-hop) neighbour. We use those neighbours to
  // anchor the rank-3 node vertically under its first-hop parent.
  // A rank-3 node may have multiple rank-2 parents (full-mesh typical
  // for second-hop wiring); in that case we average their X so the
  // child lands between its parents.
  const rank3Parents = new Map<string, string[]>();
  for (const n of rank3Nodes) {
    const parents: string[] = [];
    for (const l of links) {
      let otherId: string | null = null;
      if (l.toDeviceId === n.id) otherId = l.fromDeviceId;
      else if (l.fromDeviceId === n.id) otherId = l.toDeviceId;
      if (!otherId) continue;
      if ((rankById.get(otherId) ?? 0) === 2) parents.push(otherId);
    }
    rank3Parents.set(n.id, parents);
  }

  // Sibling groups: two rank-3 nodes are siblings if they share at least
  // one rank-2 parent. All siblings are stacked vertically under their
  // shared parent so they never overlap, regardless of how many there
  // are.
  const rank3Siblings = new Map<string, FabricNode[]>();
  const rank3SafeIdx  = new Map<string, number>();
  for (const n of rank3Nodes) {
    const myParents = new Set(rank3Parents.get(n.id) ?? []);
    if (myParents.size === 0) {
      rank3Siblings.set(n.id, [n]);
      rank3SafeIdx.set(n.id, 0);
      continue;
    }
    const set = new Set<FabricNode>([n]);
    for (const m of rank3Nodes) {
      if (m.id === n.id) continue;
      const mp = rank3Parents.get(m.id) ?? [];
      if (mp.some((p) => myParents.has(p))) set.add(m);
    }
    const sibs = [...set].sort((a, b) => a.id.localeCompare(b.id));
    rank3Siblings.set(n.id, sibs);
    rank3SafeIdx.set(n.id, sibs.findIndex((s) => s.id === n.id));
  }

  const boxMap: Record<string, Box> = {};

  // ── Pass 1: rank 0 + rank 1 (cores, dists) use dagre's centre coords. ──
  for (const node of nodes) {
    const r = rankById.get(node.id) ?? TIER_RANK[node.role];
    if (r > 1) continue;
    const dn = g.node(node.id) as { x: number; y: number };
    const dagreX = dn?.x ?? 0;
    const dagreY = dn?.y ?? 0;
    boxMap[node.id] = {
      x: dagreX - NODE_W / 2,
      y: Math.max(MARGIN_Y, dagreY - NODE_H / 2),
      w: NODE_W,
      h: NODE_H,
    };
  }

  // ── Pass 2: rank 2 (first-hop access) — one column per floor, evenly ─
  // spaced across the column width. Constrained so all first-hops stay
  // inside their own column (no overflow into the next floor). Boxes
  // may overlap each other within a column (the card visuals are
  // narrower than the bounding box), but they never cross column
  // boundaries, so cards on different floors stay visually separated.
  for (const node of nodes) {
    const r = rankById.get(node.id) ?? TIER_RANK[node.role];
    if (r !== 2) continue;
    const fl = node.floor || node.id;
    const col = floorColIdx[fl] ?? 0;
    const fhNodesInFloor = rank2Nodes.filter((n) => n.floor === node.floor);
    const fhIdx = fhNodesInFloor.indexOf(node);
    const fhCount = Math.max(1, fhNodesInFloor.length);
    // Max total spread inside the column = FLOOR_COL_WIDE - NODE_W (the
    // slack). Divide it evenly between the (fhCount - 1) gaps.
    const maxSpread = FLOOR_COL_WIDE - NODE_W; // 92 px for 320/228
    const slotW = fhCount > 1 ? maxSpread / (fhCount - 1) : 0;
    const fhOffset = (fhIdx - (fhCount - 1) / 2) * slotW;
    const x = MARGIN_X + col * FLOOR_COL_WIDE + (FLOOR_COL_WIDE - NODE_W) / 2 + fhOffset;
    const y = rank2Y - NODE_H / 2;
    boxMap[node.id] = { x, y, w: NODE_W, h: NODE_H };
  }

  // ── Pass 3: rank 3 (second-hop access) — siblings placed in F3's column.
  //
  // Two cases based on sibling count:
  //   (a) **1 sibling**: place directly under parent at parent X.
  //   (b) **2 siblings**: side-by-side under parent, BOTH at the same Y
  //       (rank3Y baseline). One sits left of parent X, the other right
  //       of parent X. Both stay inside the floor column
  //       (FLOOR_COL_WIDE = 320). Two clean diagonal uplinks — no line
  //       crosses any sibling box.
  //   (c) **3+ siblings**: stack vertically at parent X with
  //       RANK3_STEP_Y = rank3NodeH + 16 spacing. Lower siblings need
  //       L-path (bypass) routing so the uplink lines don't pass through
  //       the upper siblings' boxes.
  //
  // User clarification (2026-09-03 01:51): "nằm dọc với F3-AS-01" means
  // "in the same column as F3-AS-01" — NOT "stacked vertically on top
  // of each other". For 2 siblings, the canonical reading is side-by-side
  // in that column. Vertical stacking is only for 3+ siblings where
  // side-by-side won't fit.
  const RANK3_STEP_Y = rank3NodeH + 16;
  for (const node of nodes) {
    const r = rankById.get(node.id) ?? TIER_RANK[node.role];
    if (r !== 3) continue;

    const parents = rank3Parents.get(node.id) ?? [];
    const siblings = rank3Siblings.get(node.id) ?? [node];
    const safeIdx = (() => {
      const i = siblings.findIndex((s) => s.id === node.id);
      return i >= 0 ? i : 0;
    })();

    // Parent centre X — average of all rank-2 parents' box centres.
    let parentCenterX: number | null = null;
    if (parents.length > 0) {
      let sum = 0;
      let count = 0;
      for (const pid of parents) {
        const pb = boxMap[pid];
        if (pb) { sum += pb.x + pb.w / 2; count++; }
      }
      if (count > 0) parentCenterX = sum / count;
    }

    let x: number;
    let y: number;

    if (parentCenterX !== null) {
      if (siblings.length === 1) {
        // Single child — under parent, parent X.
        x = parentCenterX - NODE_W / 2;
        y = rank3Y - rank3NodeH / 2;
      } else if (siblings.length === 2) {
        // Two siblings — side-by-side, paired SHIFTED RIGHT under the
        // parent. Layout reads as: F3-AS-02 sits directly under
        // F3-AS-01 (same X), F3-AS-03 sits to the right of F3-AS-02
        // (same Y, side-by-side). The pair shares one horizontal
        // baseline under the parent.
        //
        // User spec (2026-09-03 02:00): "F3-AS-02, F3-AS-03 nằm
        // ngang hàng, dịch qua phải nằm dưới con F3-AS-01". The pair
        // starts at parent's left edge and extends right.
        const gap = 20;
        const parentLeftX = parentCenterX - NODE_W / 2;
        if (safeIdx === 0) {
          // Left sibling — starts at parent's left edge (directly
          // under parent's left half).
          x = parentLeftX;
        } else {
          // Right sibling — starts after left sibling + gap.
          x = parentLeftX + NODE_W + gap;
        }
        y = rank3Y - rank3NodeH / 2;
      } else {
        // 3+ siblings — stack vertically at parent X with dynamic
        // RANK3_STEP_Y spacing. Lower siblings use bypass routing
        // (see makeBypassPath) so their uplink lines don't pass
        // through the upper siblings' boxes.
        x = parentCenterX - NODE_W / 2;
        y = rank3Y + (safeIdx - (siblings.length - 1) / 2) * RANK3_STEP_Y - rank3NodeH / 2;
      }
    } else {
      // No rank-2 parent known — fall back to the floor column centre.
      const fl = node.floor || node.id;
      const col = floorColIdx[fl] ?? 0;
      x = MARGIN_X + col * FLOOR_COL_WIDE + (FLOOR_COL_WIDE - NODE_W) / 2;
      y = rank3Y + (safeIdx - (siblings.length - 1) / 2) * RANK3_STEP_Y - rank3NodeH / 2;
    }

    boxMap[node.id] = {
      x: Math.max(MARGIN_X, x),
      y: Math.max(MARGIN_Y, y),
      w: NODE_W,
      h: rank3NodeH,
    };
  }

  // ── Centering pass: per-tier shift so every tier shares ONE vertical ──
  // axis = the centre of the rank-2 (access first-hop) tier. Rank-2
  // stays where its floor columns put it; cores, dists, and rank-3 all
  // shift to align with rank-2's centre.
  //
  // Why per-tier and not uniform graph-bbox shift: with side-by-side
  // rank-3 siblings under F3, the rank-3 tier is wider than rank-2
  // (extends past F3 column). Using the graph bbox centre would drag
  // rank-2 leftward and could push F1 first-hop off the canvas. Using
  // rank-2 centre as the axis keeps every tier balanced on the
  // floor-column axis (F1/F2/F3 first-hop column).
  if (Object.keys(boxMap).length > 0) {
    const tierInfo = new Map<number, { left: number; right: number; centre: number }>();
    for (const id of Object.keys(boxMap)) {
      const r = rankById.get(id) ?? 0;
      const b = boxMap[id];
      const cur = tierInfo.get(r);
      if (!cur) {
        tierInfo.set(r, { left: b.x, right: b.x + b.w, centre: b.x + b.w / 2 });
      } else {
        cur.left  = Math.min(cur.left, b.x);
        cur.right = Math.max(cur.right, b.x + b.w);
        cur.centre = (cur.left + cur.right) / 2;
      }
    }
    // Rank-2 (access first-hop) is the axis reference.
    const axisInfo = tierInfo.get(2);
    let axisX = 0;
    if (axisInfo) {
      axisX = axisInfo.centre;
    } else {
      // No rank-2 nodes — fall back to the widest tier.
      let mw = -1;
      for (const info of tierInfo.values()) {
        const w = info.right - info.left;
        if (w > mw) { mw = w; axisX = info.centre; }
      }
    }
    for (const id of Object.keys(boxMap)) {
      const r = rankById.get(id) ?? 0;
      // rank-3 stays where Pass 3 placed it (relative to rank-2 parent).
      // Don't shift it to the rank-2 axis — that drags rank-3 sideways
      // away from its parent and out of the floor column.
      if (r === 3) continue;
      const tc = tierInfo.get(r);
      if (!tc) continue;
      boxMap[id].x += axisX - tc.centre;
    }
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
  const placed = Object.values(boxMap);
  const totalWidth  = placed.length > 0
    ? Math.max(...placed.map((b) => b.x + b.w)) + MARGIN_X
    : 0;
  const totalHeight = placed.length > 0
    ? Math.max(...placed.map((b) => b.y + b.h)) + MARGIN_Y
    : 0;

  return {
    positioned,
    totalWidth,
    totalHeight,
    tiers: tierLayouts,
    tierMeta,
    rankById,
    siblingIdx: rank3SafeIdx,
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
// Path — L-shape that bypasses an upper sibling.
//
// Used when a rank-3 node is the LOWER sibling in a vertically-stacked
// sibling column under a rank-2 parent. The straight-diagonal path would
// pass straight through the upper sibling's box, which looks like a
// phantom link between siblings. Instead we route the line around the
// upper sibling:
//
//   ┌─────────────┐
//   │  rank-2     │
//   │  parent     │──┐                        ← horizontal stub right
//   └─────────────┘  │
//                    │                        ← vertical, well clear of upper sibling
//   ┌─────────────┐  │
//   │  upper sib  │  │
//   └─────────────┘  │
//                    │
//   ┌─────────────┐  │
//   │  lower sib  │◄─┘                        ← horizontal entry from right
//   └─────────────┘
//
// The bypass side (left/right) alternates by sibling index so 3+ siblings
// in a stack get clear separation instead of all colliding on one side.
// ─────────────────────────────────────────────────────────────────────────────

function makeBypassPath(a: Pt, b: Pt, side: 'left' | 'right'): string {
  // Horizontal offset to clear the upper sibling and parent boxes.
  // 30 px is enough: the parent's right edge is at most NODE_W/2 to the
  // side of parent center, the upper sibling is at the same center, so
  // 30 px right of any of their edges is in clear space.
  const OFFSET = 30;
  const dir = side === 'right' ? 1 : -1;
  const x1 = a.x + dir * OFFSET;
  const x2 = b.x + dir * OFFSET;
  return [
    `M ${a.x.toFixed(2)} ${a.y.toFixed(2)}`,
    `L ${x1.toFixed(2)} ${a.y.toFixed(2)}`,
    `L ${x2.toFixed(2)} ${b.y.toFixed(2)}`,
    `L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
  ].join(' ');
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

      // Detect stacked-sibling situation: link is from rank 2 to rank 3
      // and the target is the LOWER sibling in a VERTICALLY-stacked
      // column under the rank-2 parent. Without bypass routing, the
      // straight diagonal would cross the upper sibling's box —
      // visually creating a phantom link between siblings.
      //
      // Important: only fire when the target is actually at the same
      // X as the parent (true vertical stack). For 2 siblings laid
      // out side-by-side inside the floor column, both targets are at
      // different X and the uplink lines are clean diagonals — no
      // bypass is needed (and using bypass there would push the
      // line OUTSIDE the floor column).
      const fromRank = layout.rankById.get(a.node.id) ?? TIER_RANK[a.node.role];
      const toRank   = layout.rankById.get(b.node.id) ?? TIER_RANK[b.node.role];
      const targetSiblingIdx = layout.siblingIdx?.get(b.node.id) ?? 0;
      const targetAtParentX = Math.abs(
        (b.box.x + b.box.w / 2) - (a.box.x + a.box.w / 2),
      ) < 1;
      const isLowerSibling =
        info.crossTier &&
        fromRank < toRank &&
        toRank === 3 &&
        targetSiblingIdx > 0 &&
        targetAtParentX;

      let d: string;
      let bypass = false;
      if (isLowerSibling) {
        // Alternate bypass side by sibling index so 3+ siblings in a
        // stack spread their bypass routes (right, left, right, …)
        // instead of all crashing into the same corridor.
        const side: 'right' | 'left' = targetSiblingIdx % 2 === 1 ? 'right' : 'left';
        // The bypass path's first segment IS the source stub (horizontal
        // exit from the source port), so we inline it into the path
        // and skip the separate `<line>` stub at the source.
        d = makeBypassPath(fromEnd.anchor, toEnd.stubEnd, side);
        bypass = true;
      } else {
        d = makeStraightPath(fromEnd.stubEnd, toEnd.stubEnd);
      }
      edgeList.push({ link, d, fromEnd, toEnd, bypass });
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
                {/* Stub at source — short perpendicular segment. Skipped for
                    bypass paths because the L-path's first segment is the
                    horizontal source stub, already drawn in `edge.d`. */}
                {!edge.bypass && (
                  <line
                    x1={edge.fromEnd.anchor.x} y1={edge.fromEnd.anchor.y}
                    x2={edge.fromEnd.stubEnd.x} y2={edge.fromEnd.stubEnd.y}
                    className="nc-fabric-stub"
                    stroke={KIND_COLOR[edge.link.kind]} strokeWidth={stroke}
                  />
                )}
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
