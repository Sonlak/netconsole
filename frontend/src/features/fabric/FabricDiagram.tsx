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

type Pt = { x: number; y: number };
type Box = Pt & { w: number; h: number };
type Anchor = 'left' | 'right' | 'top' | 'bottom';

type LayeredNode = {
  node: FabricNode;
  col: number;
  row: number;
  colCount: number;
  rowCount: number;
  box: Box;
};

type EdgePath = {
  link: FabricLink;
  d: string;
  mid: Pt;
  fromAnchor: Anchor;
  toAnchor: Anchor;
  p1: Pt;
  p2: Pt;
};

const NODE_W = 132;
const NODE_H = 56;
const NODE_GAP_X = 36;
const FLOOR_GAP_Y = 36;
const DIST_GAP_Y = 64;
const CORE_GAP_Y = 72;
const MARGIN = { top: 56, right: 56, bottom: 56, left: 56 };

function portLabel(text: string) {
  return text?.trim() || '—';
}

function pickAnchor(from: Box, to: Box): Anchor {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy) * 1.1) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

function anchorPoint(box: Box, side: Anchor): Pt {
  switch (side) {
    case 'right': return { x: box.x + box.w, y: box.y + box.h / 2 };
    case 'left': return { x: box.x, y: box.y + box.h / 2 };
    case 'bottom': return { x: box.x + box.w / 2, y: box.y + box.h };
    case 'top': return { x: box.x + box.w / 2, y: box.y };
  }
}

function edgePath(p1: Pt, p2: Pt, sideA: Anchor, sideB: Anchor) {
  const reach = (p: Pt, q: Pt, side: Anchor) => {
    const minReach = 28;
    if (side === 'left' || side === 'right') return Math.max(minReach, Math.abs(p.x - q.x) / 2);
    return Math.max(minReach, Math.abs(p.y - q.y) / 2);
  };
  const r1 = reach(p1, p2, sideA);
  const r2 = reach(p2, p1, sideB);
  const c1 = steer(p1, sideA, r1);
  const c2 = steer(p2, sideB, r2);
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

function steer(p: Pt, side: Anchor, reach: number): Pt {
  switch (side) {
    case 'right': return { x: p.x + reach, y: p.y };
    case 'left': return { x: p.x - reach, y: p.y };
    case 'bottom': return { x: p.x, y: p.y + reach };
    case 'top': return { x: p.x, y: p.y - reach };
  }
}

function edgeMid(p1: Pt, p2: Pt): Pt {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

function edgeBundleOffset(link: FabricLink, allLinks: FabricLink[]): number {
  const peers = allLinks.filter(
    (l) =>
      (l.fromDeviceId === link.fromDeviceId && l.toDeviceId === link.toDeviceId) ||
      (l.fromDeviceId === link.toDeviceId && l.toDeviceId === link.fromDeviceId),
  );
  const idx = peers.findIndex((l) => l.id === link.id);
  if (idx < 0) return 0;
  const fan = peers.length;
  const spread = Math.min(14, 3 + fan * 2);
  return (idx - (fan - 1) / 2) * spread;
}

function applyBundle(mid: Pt, p1: Pt, p2: Pt, offset: number): { p1: Pt; p2: Pt; mid: Pt } {
  if (!offset) return { p1, p2, mid };
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const op1 = { x: p1.x + nx * offset, y: p1.y + ny * offset };
  const op2 = { x: p2.x + nx * offset, y: p2.y + ny * offset };
  return { p1: op1, p2: op2, mid: edgeMid(op1, op2) };
}

function layoutNodes(nodes: FabricNode[]) {
  const cores = nodes.filter((n) => n.role === 'core').sort((a, b) => a.shortName.localeCompare(b.shortName));
  const dists = nodes.filter((n) => n.role === 'dist').sort((a, b) => a.shortName.localeCompare(b.shortName));
  const access = nodes
    .filter((n) => n.role === 'access')
    .sort((a, b) => (a.floorNumber ?? 99) - (b.floorNumber ?? 99) || a.shortName.localeCompare(b.shortName));

  const grouped: { floor: string | null; list: FabricNode[] }[] = [];
  if (access.length) {
    let current: string | null = null;
    let bucket: FabricNode[] = [];
    for (const node of access) {
      const label = node.floorNumber != null ? `F${node.floorNumber}` : node.floor || 'Other';
      if (label !== current) {
        if (bucket.length) grouped.push({ floor: current, list: bucket });
        current = label;
        bucket = [];
      }
      bucket.push(node);
    }
    if (bucket.length) grouped.push({ floor: current, list: bucket });
  }

  const maxAccessRow = Math.max(8, ...grouped.map((g) => g.list.length));
  const colsNeeded = maxAccessRow;
  const contentW = MARGIN.left + MARGIN.right + colsNeeded * NODE_W + (colsNeeded - 1) * NODE_GAP_X;
  const xForCol = (col: number, total: number) => {
    const groupWidth = total * NODE_W + (total - 1) * NODE_GAP_X;
    const start = (contentW - groupWidth) / 2;
    return start + col * (NODE_W + NODE_GAP_X);
  };

  const positioned: LayeredNode[] = [];
  let cursorY = MARGIN.top;

  if (cores.length) {
    for (let i = 0; i < cores.length; i++) {
      const node = cores[i];
      const x = xForCol(i, cores.length) + NODE_W / 2;
      positioned.push({
        node,
        col: i,
        row: 0,
        colCount: cores.length,
        rowCount: 1,
        box: { x: x - NODE_W / 2, y: cursorY, w: NODE_W, h: NODE_H },
      });
    }
    cursorY += NODE_H + CORE_GAP_Y;
  }

  if (dists.length) {
    for (let i = 0; i < dists.length; i++) {
      const node = dists[i];
      const x = xForCol(i, dists.length) + NODE_W / 2;
      positioned.push({
        node,
        col: i,
        row: 0,
        colCount: dists.length,
        rowCount: 1,
        box: { x: x - NODE_W / 2, y: cursorY, w: NODE_W, h: NODE_H },
      });
    }
    cursorY += NODE_H + DIST_GAP_Y;
  }

  for (const group of grouped) {
    for (let i = 0; i < group.list.length; i++) {
      const node = group.list[i];
      const x = xForCol(i, group.list.length) + NODE_W / 2;
      positioned.push({
        node,
        col: i,
        row: 0,
        colCount: group.list.length,
        rowCount: 1,
        box: { x: x - NODE_W / 2, y: cursorY, w: NODE_W, h: NODE_H },
      });
    }
    cursorY += NODE_H + FLOOR_GAP_Y;
  }

  return { positioned, totalHeight: cursorY + MARGIN.bottom - FLOOR_GAP_Y, totalWidth: contentW, groups: grouped };
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

function PortLabel({ x, y, text, anchor }: { x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end' }) {
  const label = portLabel(text);
  const width = Math.max(48, label.length * 6.6 + 12);
  const height = 16;
  const rx = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  const ry = y - height / 2;
  return (
    <g className="nc-fabric-port" transform={`translate(${rx}, ${ry})`}>
      <rect width={width} height={height} rx={4} />
      <text x={width / 2} y={height / 2 + 1} textAnchor="middle" dominantBaseline="middle">
        {label}
      </text>
    </g>
  );
}

export function FabricDiagram({ nodes, links }: { nodes: FabricNode[]; links: FabricLink[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const layout = useMemo(() => layoutNodes(nodes), [nodes]);
  const nodeIndex = useMemo(() => {
    const map: Record<string, LayeredNode> = {};
    for (const item of layout.positioned) map[item.node.id] = item;
    return map;
  }, [layout]);

  const edges = useMemo<EdgePath[]>(() => {
    const out: EdgePath[] = [];
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const a = nodeIndex[link.fromDeviceId];
      const b = nodeIndex[link.toDeviceId];
      if (!a || !b) continue;
      const sideA = pickAnchor(a.box, b.box);
      const sideB = pickAnchor(b.box, a.box);
      let p1 = anchorPoint(a.box, sideA);
      let p2 = anchorPoint(b.box, sideB);
      const bundleOffset = edgeBundleOffset(link, links);
      const bundled = applyBundle(edgeMid(p1, p2), p1, p2, bundleOffset);
      p1 = bundled.p1;
      p2 = bundled.p2;
      const d = edgePath(p1, p2, sideA, sideB);
      out.push({ link, d, mid: bundled.mid, fromAnchor: sideA, toAnchor: sideB, p1, p2 });
    }
    return out;
  }, [links, nodeIndex]);

  const fitToView = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.clientWidth || 1;
    const h = wrap.clientHeight || 1;
    const scale = Math.min(1, Math.min(w / layout.totalWidth, h / layout.totalHeight));
    setViewport({ x: (w - layout.totalWidth * scale) / 2, y: 32, scale });
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
            <marker id="nc-arrow-trunk" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#5b9dff" />
            </marker>
            <marker id="nc-arrow-peer" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#8b93a7" />
            </marker>
            <marker id="nc-arrow-l3" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#f0a14a" />
            </marker>
            <marker id="nc-arrow-uplink" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#9aa3b6" />
            </marker>
          </defs>

          {layout.groups.length > 0 && (
            <g className="nc-fabric-floor-bands">
              {layout.groups.map((group) => {
                const sample = layout.positioned.find((p) => group.list.includes(p.node));
                if (!sample) return null;
                const left = Math.min(...group.list.map((n) => nodeIndex[n.id]?.box.x ?? 0)) - 18;
                const right =
                  Math.max(...group.list.map((n) => (nodeIndex[n.id]?.box.x ?? 0) + NODE_W)) + 18;
                const top = sample.box.y - 18;
                const bottom = sample.box.y + NODE_H + 18;
                return (
                  <g key={`band-${group.floor}`}>
                    <rect
                      x={left}
                      y={top}
                      width={right - left}
                      height={bottom - top}
                      rx={14}
                      className="nc-fabric-floor-band"
                    />
                    <text
                      x={left + 12}
                      y={top + 18}
                      className="nc-fabric-floor-label"
                      dominantBaseline="middle"
                    >
                      {group.floor}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {edges.map((edge) => {
            const marker = `nc-arrow-${edge.link.kind}`;
            return (
              <g key={edge.link.id} className={`nc-fabric-link is-${edge.link.kind}`}>
                <path className="nc-fabric-glow" d={edge.d} markerEnd={`url(#${marker})`} />
                <path className="nc-fabric-line" d={edge.d} markerEnd={`url(#${marker})`} />
                <title>
                  {edge.link.fromName} {edge.link.fromPort} — {edge.link.toName} {edge.link.toPort}
                  {edge.link.note ? `\n${edge.link.note}` : ''}
                  {edge.link.operStatus === 'down' ? '\nLINK DOWN' : ''}
                </title>
                {edge.fromAnchor === 'right' || edge.fromAnchor === 'left' ? (
                  <PortLabel x={edge.p1.x + (edge.fromAnchor === 'right' ? 6 : -6)} y={edge.p1.y - 9} text={edge.link.fromPort} anchor={edge.fromAnchor === 'right' ? 'start' : 'end'} />
                ) : (
                  <PortLabel x={edge.p1.x} y={edge.p1.y + (edge.fromAnchor === 'bottom' ? 14 : -14)} text={edge.link.fromPort} anchor="middle" />
                )}
                {edge.toAnchor === 'right' || edge.toAnchor === 'left' ? (
                  <PortLabel x={edge.p2.x + (edge.toAnchor === 'right' ? 6 : -6)} y={edge.p2.y - 9} text={edge.link.toPort} anchor={edge.toAnchor === 'right' ? 'start' : 'end'} />
                ) : (
                  <PortLabel x={edge.p2.x} y={edge.p2.y + (edge.toAnchor === 'bottom' ? 14 : -14)} text={edge.link.toPort} anchor="middle" />
                )}
              </g>
            );
          })}
        </svg>

        {layout.positioned.map((item) => (
          <FabricNodeCard key={item.node.id} node={item.node} box={item.box} />
        ))}
      </div>
    </div>
  );
}

export { ROLE_LABEL };
export type { FabricLinkKind };