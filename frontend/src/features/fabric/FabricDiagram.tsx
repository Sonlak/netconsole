import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceStatusMeta } from '@/design/status';
import type { DeviceStatus } from '@/types/device';
import type { FabricLink, FabricLinkKind, FabricNode, FabricRole } from '@/types/fabric';

const ROLE_LABEL: Record<FabricRole, string> = {
  core: 'Core',
  dist: 'Distribution',
  access: 'Access',
};

const TIER_LABEL: Record<FabricRole, string> = {
  core: 'CORE LAYER',
  dist: 'DISTRIBUTION LAYER',
  access: 'ACCESS LAYER',
};

type Pt = { x: number; y: number };
type Box = Pt & { w: number; h: number };
type Anchor = 'left' | 'right' | 'top' | 'bottom';

type PortEnd = {
  side: Anchor;
  portName: string;
  /** Point on the node edge (anchor) */
  anchor: Pt;
  /** End of the stub — line begins/ends here */
  stubEnd: Pt;
  /** Where the port label sits (relative to the stub end) */
  labelPos: Pt;
  /** Background rect for the label */
  labelSize: { w: number; h: number };
  /** Anchor for the label text */
  labelAnchor: 'start' | 'middle' | 'end';
};

type EdgePath = {
  link: FabricLink;
  d: string;
  p1: Pt;
  p2: Pt;
  fromEnd: PortEnd;
  toEnd: PortEnd;
};

type NodeLayout = {
  node: FabricNode;
  box: Box;
  /** map from link id -> PortEnd (this node is the source of the link) */
  ports: Record<string, PortEnd>;
};

const NODE_W = 224;
const NODE_H = 92;
const PORT_STUB = 36;
const PORT_LABEL_GAP = 6;
const FLOOR_GAP_Y = 76;
const TIER_GAP_Y = 132;
const NODE_GAP_X = 64;
const MARGIN_X = 56;
const MARGIN_Y = 96;
const RAIL_WIDTH = 132;

const KIND_COLOR: Record<FabricLinkKind, string> = {
  trunk: '#5b9dff',
  peer: '#8b93a7',
  l3: '#f0a14a',
  uplink: '#9aa3b6',
};

const KIND_STROKE: Record<FabricLinkKind, number> = {
  trunk: 2.5,
  peer: 2,
  l3: 2.6,
  uplink: 2,
};

function pickSide(from: Box, to: Box): Anchor {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Strong horizontal/vertical bias based on the dominant direction.
  if (Math.abs(dy) > Math.abs(dx) * 1.05) {
    return dy > 0 ? 'bottom' : 'top';
  }
  return dx > 0 ? 'right' : 'left';
}

function portOffsetForIndex(idx: number, total: number, side: Anchor): number {
  const inset = 18; // keep ports a bit away from corners
  const length = (side === 'left' || side === 'right' ? NODE_H : NODE_W) - inset * 2;
  if (total === 1) return (side === 'left' || side === 'right' ? NODE_H : NODE_W) / 2;
  const step = length / (total - 1);
  return inset + step * idx;
}

function buildPortEnd(box: Box, side: Anchor, idx: number, total: number, portName: string): PortEnd {
  const off = portOffsetForIndex(idx, total, side);

  let anchor: Pt;
  let stubEnd: Pt;
  let labelPos: Pt;
  let labelAnchor: 'start' | 'middle' | 'end' = 'middle';
  const labelSize = { w: Math.max(64, (portName?.length || 4) * 6.8 + 14), h: 20 };

  switch (side) {
    case 'right':
      anchor = { x: box.x + box.w, y: box.y + off };
      stubEnd = { x: box.x + box.w + PORT_STUB, y: anchor.y };
      // Horizontal stub: place label ABOVE the stub end so it doesn't overlap the next node.
      labelPos = { x: stubEnd.x, y: stubEnd.y - PORT_LABEL_GAP - labelSize.h };
      labelAnchor = 'middle';
      break;
    case 'left':
      anchor = { x: box.x, y: box.y + off };
      stubEnd = { x: box.x - PORT_STUB, y: anchor.y };
      labelPos = { x: stubEnd.x, y: stubEnd.y - PORT_LABEL_GAP - labelSize.h };
      labelAnchor = 'middle';
      break;
    case 'bottom':
      anchor = { x: box.x + off, y: box.y + box.h };
      stubEnd = { x: anchor.x, y: box.y + box.h + PORT_STUB };
      // Vertical stub: place label BELOW the stub end (between this node and the next row).
      labelPos = { x: stubEnd.x, y: stubEnd.y + PORT_LABEL_GAP };
      labelAnchor = 'middle';
      break;
    case 'top':
      anchor = { x: box.x + off, y: box.y };
      stubEnd = { x: anchor.x, y: box.y - PORT_STUB };
      // Vertical stub: place label ABOVE the stub end (between previous row and this node).
      labelPos = { x: stubEnd.x, y: stubEnd.y - PORT_LABEL_GAP - labelSize.h };
      labelAnchor = 'middle';
      break;
  }

  return { side, portName, anchor, stubEnd, labelPos, labelSize, labelAnchor };
}

/**
 * Orthogonal routing between two stub ends. The line leaves the stub
 * horizontally/vertically and reaches the destination via one elbow.
 */
function orthogonalPath(p1: Pt, p2: Pt, sideA: Anchor, sideB: Anchor): string {
  const isVerticalA = sideA === 'top' || sideA === 'bottom';
  const isVerticalB = sideB === 'top' || sideB === 'bottom';

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
  }

  // Same orientation: 90° elbow.
  if (isVerticalA === isVerticalB) {
    if (isVerticalA) {
      // both vertical → go vertical to midY, then horizontal, then vertical
      const midY = (p1.y + p2.y) / 2;
      return `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
    }
    const midX = (p1.x + p2.x) / 2;
    return `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;
  }

  // Different orientation: one segment straight, then a single bend.
  if (isVerticalA) {
    // A is vertical (top/bottom), B is horizontal (left/right)
    return `M ${p1.x} ${p1.y} L ${p2.x} ${p1.y} L ${p2.x} ${p2.y}`;
  }
  // A is horizontal, B is vertical
  return `M ${p1.x} ${p1.y} L ${p1.x} ${p2.y} L ${p2.x} ${p2.y}`;
}

type FloorGroup = { floor: string; floorNumber: number | null; nodes: FabricNode[] };

function groupAccessByFloor(nodes: FabricNode[]): FloorGroup[] {
  const access = nodes.filter((n) => n.role === 'access');
  access.sort((a, b) => {
    const fa = a.floorNumber ?? 99;
    const fb = b.floorNumber ?? 99;
    if (fa !== fb) return fa - fb;
    return a.shortName.localeCompare(b.shortName);
  });
  const groups: FloorGroup[] = [];
  let current: FloorGroup | null = null;
  for (const node of access) {
    const label = node.floorNumber != null ? `F${node.floorNumber}` : node.floor || 'Other';
    if (!current || current.floor !== label) {
      current = { floor: label, floorNumber: node.floorNumber, nodes: [] };
      groups.push(current);
    }
    current.nodes.push(node);
  }
  return groups;
}

type LayoutResult = {
  positioned: NodeLayout[];
  totalWidth: number;
  totalHeight: number;
  widthByTier: number;
  floorGroups: FloorGroup[];
  cores: FabricNode[];
  dists: FabricNode[];
};

function layoutNodes(nodes: FabricNode[]): LayoutResult {
  const cores = nodes.filter((n) => n.role === 'core').sort((a, b) => a.shortName.localeCompare(b.shortName));
  const dists = nodes.filter((n) => n.role === 'dist').sort((a, b) => a.shortName.localeCompare(b.shortName));
  const floorGroups = groupAccessByFloor(nodes);

  const tierCounts = [
    cores.length,
    dists.length,
    ...floorGroups.map((g) => g.nodes.length),
  ];
  const maxRowCount = Math.max(1, ...tierCounts);
  const contentW = MARGIN_X * 2 + maxRowCount * NODE_W + (maxRowCount - 1) * NODE_GAP_X;

  const xForCol = (col: number, total: number) => {
    const groupW = total * NODE_W + (total - 1) * NODE_GAP_X;
    const start = MARGIN_X + (contentW - MARGIN_X * 2 - groupW) / 2;
    return start + col * (NODE_W + NODE_GAP_X);
  };

  const positioned: NodeLayout[] = [];
  let cursorY = MARGIN_Y;

  const placeRow = (list: FabricNode[]) => {
    for (let i = 0; i < list.length; i++) {
      const x = xForCol(i, list.length);
      positioned.push({
        node: list[i],
        box: { x, y: cursorY, w: NODE_W, h: NODE_H },
        ports: {},
      });
    }
    cursorY += NODE_H;
  };

  if (cores.length) {
    placeRow(cores);
    cursorY += TIER_GAP_Y;
  }
  if (dists.length) {
    placeRow(dists);
    cursorY += TIER_GAP_Y;
  }
  for (const group of floorGroups) {
    placeRow(group.nodes);
    cursorY += FLOOR_GAP_Y;
  }
  cursorY -= FLOOR_GAP_Y;
  cursorY += MARGIN_Y;

  return {
    positioned,
    totalWidth: contentW,
    totalHeight: cursorY,
    widthByTier: maxRowCount * NODE_W + (maxRowCount - 1) * NODE_GAP_X,
    floorGroups,
    cores,
    dists,
  };
}

function FabricNodeCard({ node, box }: { node: FabricNode; box: Box }) {
  const meta = deviceStatusMeta((node.status as DeviceStatus) || 'UNKNOWN');
  return (
    <Link
      to={`/devices/${node.id}`}
      className={`nc-fabric-node is-${node.role}`}
      data-node={node.id}
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
      }}
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
  let ry = end.labelPos.y;
  if (end.labelAnchor === 'start') rx = end.labelPos.x;
  else if (end.labelAnchor === 'end') rx = end.labelPos.x - w;
  else rx = end.labelPos.x - w / 2;

  // For top side, label sits above the stub end (y < stubEnd.y); for bottom,
  // below. We always center the text vertically.
  const textY = ry + h / 2 + 1;

  return (
    <g className="nc-fabric-port">
      <rect x={rx} y={ry} width={w} height={h} rx={6} />
      <text
        x={rx + w / 2}
        y={textY}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {label}
      </text>
    </g>
  );
}

export function FabricDiagram({ nodes, links }: { nodes: FabricNode[]; links: FabricLink[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  const layout = useMemo(() => layoutNodes(nodes), [nodes]);

  const { edges } = useMemo(() => {
    const idx: Record<string, NodeLayout> = {};
    for (const item of layout.positioned) idx[item.node.id] = item;

    // First pass: decide which side each link endpoint uses.
    const portBuckets: Record<string, Record<Anchor, string[]>> = {};
    for (const item of layout.positioned) {
      portBuckets[item.node.id] = { left: [], right: [], top: [], bottom: [] };
    }
    const linkKey = (from: string, to: string) => (from < to ? `${from}::${to}` : `${to}::${from}`);
    const linkIndexByPair: Record<string, FabricLink[]> = {};
    for (const link of links) {
      const key = linkKey(link.fromDeviceId, link.toDeviceId);
      (linkIndexByPair[key] ||= []).push(link);
    }
    const linkPeerIdx: Record<string, number> = {};
    for (const key of Object.keys(linkIndexByPair)) {
      linkIndexByPair[key].forEach((link, i) => {
        linkPeerIdx[link.id] = i;
      });
    }

    const edgeList: EdgePath[] = [];
    for (const link of links) {
      const a = idx[link.fromDeviceId];
      const b = idx[link.toDeviceId];
      if (!a || !b) continue;

      const sideA = pickSide(a.box, b.box);
      const sideB = pickSide(b.box, a.box);

      const bucketA = portBuckets[a.node.id][sideA];
      const bucketB = portBuckets[b.node.id][sideB];
      bucketA.push(link.id);
      bucketB.push(link.id);

      // We'll know the total after the pass; rebuild ports with totals later.
      const stubA: PortEnd = {
        side: sideA,
        portName: link.fromPort,
        anchor: { x: 0, y: 0 },
        stubEnd: { x: 0, y: 0 },
        labelPos: { x: 0, y: 0 },
        labelSize: { w: 0, h: 22 },
        labelAnchor: 'middle',
      };
      const stubB: PortEnd = {
        side: sideB,
        portName: link.toPort,
        anchor: { x: 0, y: 0 },
        stubEnd: { x: 0, y: 0 },
        labelPos: { x: 0, y: 0 },
        labelSize: { w: 0, h: 22 },
        labelAnchor: 'middle',
      };
      edgeList.push({ link, d: '', p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, fromEnd: stubA, toEnd: stubB });
    }

    // Second pass: build actual port ends with known totals per side.
    for (const item of layout.positioned) {
      const buckets = portBuckets[item.node.id];
      const totals: Record<Anchor, number> = {
        left: buckets.left.length,
        right: buckets.right.length,
        top: buckets.top.length,
        bottom: buckets.bottom.length,
      };
      const indices: Record<Anchor, number> = { left: 0, right: 0, top: 0, bottom: 0 };
      for (const edge of edgeList) {
        for (const end of [edge.fromEnd, edge.toEnd] as const) {
          if (end.portName && (edge.link.fromDeviceId === item.node.id || edge.link.toDeviceId === item.node.id)) {
            const nodeId = edge.link.fromDeviceId === item.node.id ? edge.link.fromDeviceId : edge.link.toDeviceId;
            if (nodeId !== item.node.id) continue;
            if (totals[end.side] <= 0) continue;
            // Only rebuild when this end belongs to this node.
            const portName = end === edge.fromEnd ? edge.link.fromPort : edge.link.toPort;
            const built = buildPortEnd(item.box, end.side, indices[end.side], totals[end.side], portName);
            end.anchor = built.anchor;
            end.stubEnd = built.stubEnd;
            end.labelPos = built.labelPos;
            end.labelSize = built.labelSize;
            end.labelAnchor = built.labelAnchor;
            indices[end.side] += 1;
          }
        }
      }
    }

    // Third pass: build paths now that stub ends are known.
    for (const edge of edgeList) {
      edge.p1 = edge.fromEnd.stubEnd;
      edge.p2 = edge.toEnd.stubEnd;
      edge.d = orthogonalPath(edge.p1, edge.p2, edge.fromEnd.side, edge.toEnd.side);
    }

    return { edges: edgeList };
  }, [links, layout]);

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

  useEffect(() => {
    fitToView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.totalWidth, layout.totalHeight]);

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) < Math.abs(event.deltaY) && event.shiftKey === false) return;
    event.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextScale = Math.max(0.3, Math.min(2.4, viewport.scale * factor));
    const ratio = nextScale / viewport.scale;
    setViewport({
      scale: nextScale,
      x: px - (px - viewport.x) * ratio,
      y: py - (py - viewport.y) * ratio,
    });
  };

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('.nc-fabric-node, .nc-fabric-link, .nc-fabric-tier-label')) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: viewport.x, baseY: viewport.y };
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setViewport((v) => ({
      ...v,
      x: drag.baseX + (event.clientX - drag.startX),
      y: drag.baseY + (event.clientY - drag.startY),
    }));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  if (layout.positioned.length === 0) {
    return <div className="nc-fabric-empty">No devices to plot.</div>;
  }

  // Build floor band backgrounds for access rows
  const floorBands = layout.floorGroups
    .map((group) => {
      const positions = group.nodes
        .map((n) => layout.positioned.find((p) => p.node.id === n.id)?.box)
        .filter((b): b is Box => Boolean(b));
      if (!positions.length) return null;
      const left = Math.min(...positions.map((b) => b.x)) - 24;
      const right = Math.max(...positions.map((b) => b.x + b.w)) + 24;
      const top = Math.min(...positions.map((b) => b.y)) - 22;
      const bottom = Math.max(...positions.map((b) => b.y + b.h)) + 22;
      return { floor: group.floor, left, right, top, bottom };
    })
    .filter((b): b is NonNullable<typeof b> => Boolean(b));

  // Build tier labels on the left
  const tierLabels: { label: string; y: number; tone: FabricRole }[] = [];
  if (layout.cores.length) {
    const y = layout.positioned.find((p) => p.node.role === 'core')!.box.y + NODE_H / 2;
    tierLabels.push({ label: TIER_LABEL.core, y, tone: 'core' });
  }
  if (layout.dists.length) {
    const y = layout.positioned.find((p) => p.node.role === 'dist')!.box.y + NODE_H / 2;
    tierLabels.push({ label: TIER_LABEL.dist, y, tone: 'dist' });
  }
  for (const group of layout.floorGroups) {
    if (!group.nodes.length) continue;
    const sample = layout.positioned.find((p) => p.node.id === group.nodes[0].id)!;
    tierLabels.push({ label: group.floor, y: sample.box.y + NODE_H / 2, tone: 'access' });
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
      <div className="nc-fabric-controls">
        <button type="button" onClick={() => setViewport((v) => ({ ...v, scale: Math.min(2.4, v.scale * 1.2) }))} title="Zoom in">＋</button>
        <button type="button" onClick={() => setViewport((v) => ({ ...v, scale: Math.max(0.3, v.scale / 1.2) }))} title="Zoom out">−</button>
        <button type="button" onClick={fitToView} title="Fit to view">⤢</button>
      </div>

      <div className="nc-fabric-grid" />

      <div
        className="nc-fabric-canvas"
        style={{
          width: layout.totalWidth,
          height: layout.totalHeight,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
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
                refX="6"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill={KIND_COLOR[kind]} />
              </marker>
            ))}
          </defs>

          {/* Floor bands */}
          <g className="nc-fabric-floor-bands">
            {floorBands.map((band) => (
              <g key={`band-${band.floor}`}>
                <rect
                  x={band.left}
                  y={band.top}
                  width={band.right - band.left}
                  height={band.bottom - band.top}
                  rx={14}
                  className="nc-fabric-floor-band"
                />
              </g>
            ))}
          </g>

          {/* Edges */}
          {edges.map((edge) => {
            const isDown = edge.link.operStatus === 'down';
            const isHover = hoverEdge === edge.link.id;
            const marker = `nc-arrow-${edge.link.kind}`;
            const stroke = KIND_STROKE[edge.link.kind];
            return (
              <g
                key={edge.link.id}
                className={`nc-fabric-link is-${edge.link.kind}${isDown ? ' is-down' : ''}${isHover ? ' is-hover' : ''}`}
                onPointerEnter={() => setHoverEdge(edge.link.id)}
                onPointerLeave={() => setHoverEdge((current) => (current === edge.link.id ? null : current))}
              >
                {/* Stub lines (from node edge to stub end) */}
                <line
                  x1={edge.fromEnd.anchor.x}
                  y1={edge.fromEnd.anchor.y}
                  x2={edge.fromEnd.stubEnd.x}
                  y2={edge.fromEnd.stubEnd.y}
                  className="nc-fabric-stub"
                  stroke={KIND_COLOR[edge.link.kind]}
                  strokeWidth={stroke}
                />
                <line
                  x1={edge.toEnd.anchor.x}
                  y1={edge.toEnd.anchor.y}
                  x2={edge.toEnd.stubEnd.x}
                  y2={edge.toEnd.stubEnd.y}
                  className="nc-fabric-stub"
                  stroke={KIND_COLOR[edge.link.kind]}
                  strokeWidth={stroke}
                />
                {/* Main orthogonal path */}
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

        {layout.positioned.map((item) => (
          <FabricNodeCard key={item.node.id} node={item.node} box={item.box} />
        ))}
      </div>

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