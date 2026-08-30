import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceStatusMeta } from '@/design/status';
import type { DeviceStatus } from '@/types/device';
import type { FabricLink, FabricLinkKind, FabricNode, FabricRole } from '@/types/fabric';

const ROLE_LABEL: Record<FabricRole, string> = {
  core: 'Core',
  dist: 'Distribution',
  access: 'Access',
};

type Box = { cx: number; cy: number; top: number; bottom: number; left: number; right: number; w: number; h: number };
type Pt = { x: number; y: number };
type Side = 'top' | 'bottom' | 'left' | 'right';
type TextAnchor = 'start' | 'middle' | 'end';

function portLabel(port: string) {
  return port?.trim() || '—';
}

function sideOf(from: Box, to: Box): Side {
  if (Math.abs(from.cy - to.cy) < 40) return from.cx <= to.cx ? 'right' : 'left';
  return from.cy < to.cy ? 'bottom' : 'top';
}

function pointOnSide(box: Box, side: Side, index: number, count: number): Pt {
  const t = (index + 1) / (count + 1);
  if (side === 'bottom') return { x: box.left + box.w * t, y: box.bottom };
  if (side === 'top') return { x: box.left + box.w * t, y: box.top };
  if (side === 'right') return { x: box.right, y: box.top + box.h * t };
  return { x: box.left, y: box.top + box.h * t };
}

function outPoint(p: Pt, side: Side, dist: number): Pt {
  if (side === 'bottom') return { x: p.x, y: p.y + dist };
  if (side === 'top') return { x: p.x, y: p.y - dist };
  if (side === 'right') return { x: p.x + dist, y: p.y };
  return { x: p.x - dist, y: p.y };
}

function controls(p: Pt, q: Pt, horizontal: boolean): { c1: Pt; c2: Pt } {
  if (horizontal) {
    const midX = (p.x + q.x) / 2;
    return { c1: { x: midX, y: p.y }, c2: { x: midX, y: q.y } };
  }
  const reach = Math.max(36, Math.abs(q.y - p.y) * 0.42);
  return {
    c1: { x: p.x, y: p.y + (q.y >= p.y ? reach : -reach) },
    c2: { x: q.x, y: q.y + (q.y >= p.y ? -reach : reach) },
  };
}

function portTag(text: string, p: Pt, side: Side) {
  const label = portLabel(text);
  const width = Math.max(54, label.length * 6.6 + 12);
  const height = 16;
  if (side === 'bottom') {
    return { x: p.x, y: p.y + 13, anchor: 'middle' as TextAnchor, width, height, label };
  }
  if (side === 'top') {
    return { x: p.x, y: p.y - 13, anchor: 'middle' as TextAnchor, width, height, label };
  }
  if (side === 'right') {
    return { x: p.x + 8, y: p.y - 12, anchor: 'start' as TextAnchor, width, height, label };
  }
  return { x: p.x - 8, y: p.y - 12, anchor: 'end' as TextAnchor, width, height, label };
}

function tagRect(tag: ReturnType<typeof portTag>) {
  const x = tag.anchor === 'middle' ? tag.x - tag.width / 2 : tag.anchor === 'end' ? tag.x - tag.width : tag.x;
  return { x, y: tag.y - tag.height / 2, width: tag.width, height: tag.height };
}

function FabricNodeCard({ node }: { node: FabricNode }) {
  const meta = deviceStatusMeta((node.status as DeviceStatus) || 'UNKNOWN');
  return (
    <Link to={`/devices/${node.id}`} className={`nc-fabric-node is-${node.role}`} data-node={node.id} title={node.name}>
      <span className={`nc-fabric-status is-${meta.tone}`} title={meta.label} />
      <span className="nc-fabric-name">{node.shortName}</span>
      <span className="nc-fabric-ip">{node.ip}</span>
    </Link>
  );
}

function PortTag({ tag }: { tag: ReturnType<typeof portTag> }) {
  const rect = tagRect(tag);
  return (
    <g className="nc-fabric-port">
      <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={4} />
      <text x={tag.x} y={tag.y} textAnchor={tag.anchor} dominantBaseline="middle">
        {tag.label}
      </text>
    </g>
  );
}

export function FabricDiagram({
  nodes,
  links,
}: {
  nodes: FabricNode[];
  links: FabricLink[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});

  const cores = useMemo(() => nodes.filter((n) => n.role === 'core'), [nodes]);
  const dists = useMemo(() => nodes.filter((n) => n.role === 'dist'), [nodes]);
  const access = useMemo(
    () =>
      nodes
        .filter((n) => n.role === 'access')
        .sort((a, b) => (a.floorNumber ?? 99) - (b.floorNumber ?? 99) || a.shortName.localeCompare(b.shortName)),
    [nodes],
  );

  const layoutKey = `${nodes.map((n) => n.id).join(',')}|${access.length}|${links.length}`;

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const measure = () => {
      const wr = wrap.getBoundingClientRect();
      const next: Record<string, Box> = {};
      wrap.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
        const id = el.dataset.node;
        if (!id) return;
        const r = el.getBoundingClientRect();
        next[id] = {
          cx: r.left - wr.left + r.width / 2,
          cy: r.top - wr.top + r.height / 2,
          top: r.top - wr.top,
          bottom: r.bottom - wr.top,
          left: r.left - wr.left,
          right: r.right - wr.left,
          w: r.width,
          h: r.height,
        };
      });
      setBoxes(next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [layoutKey]);

  const drawn = useMemo(() => {
    const ready = links.filter((link) => boxes[link.fromDeviceId] && boxes[link.toDeviceId]);
    const slots = new Map<string, FabricLink[]>();
    for (const link of ready) {
      const a = boxes[link.fromDeviceId];
      const b = boxes[link.toDeviceId];
      const fromSide = sideOf(a, b);
      const toSide = sideOf(b, a);
      const fromKey = `${link.fromDeviceId}:${fromSide}`;
      const toKey = `${link.toDeviceId}:${toSide}`;
      (slots.get(fromKey) ?? slots.set(fromKey, []).get(fromKey)!).push(link);
      (slots.get(toKey) ?? slots.set(toKey, []).get(toKey)!).push(link);
    }
    const sortSlot = (key: string, list: FabricLink[]) => {
      const [id] = key.split(':');
      return [...list].sort((left, right) => {
        const otherL = left.fromDeviceId === id ? boxes[left.toDeviceId] : boxes[left.fromDeviceId];
        const otherR = right.fromDeviceId === id ? boxes[right.toDeviceId] : boxes[right.fromDeviceId];
        return otherL.cx - otherR.cx || otherL.cy - otherR.cy;
      });
    };

    return ready.map((link) => {
      const a = boxes[link.fromDeviceId];
      const b = boxes[link.toDeviceId];
      const fromSide = sideOf(a, b);
      const toSide = sideOf(b, a);
      const fromKey = `${link.fromDeviceId}:${fromSide}`;
      const toKey = `${link.toDeviceId}:${toSide}`;
      const fromList = sortSlot(fromKey, slots.get(fromKey) || []);
      const toList = sortSlot(toKey, slots.get(toKey) || []);
      const p = pointOnSide(a, fromSide, fromList.indexOf(link), fromList.length);
      const q = pointOnSide(b, toSide, toList.indexOf(link), toList.length);
      const s0 = outPoint(p, fromSide, 22);
      const s1 = outPoint(q, toSide, 22);
      const horizontal = fromSide === 'left' || fromSide === 'right';
      const { c1, c2 } = controls(s0, s1, horizontal);
      const d = `M ${p.x} ${p.y} L ${s0.x} ${s0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${s1.x} ${s1.y} L ${q.x} ${q.y}`;
      return {
        link,
        d,
        p,
        q,
        fromTag: portTag(link.fromPort, s0, fromSide),
        toTag: portTag(link.toPort, s1, toSide),
      };
    });
  }, [boxes, links]);

  const layers = (
    [
      { role: 'core' as const, nodes: cores },
      { role: 'dist' as const, nodes: dists },
      { role: 'access' as const, nodes: access },
    ] satisfies { role: FabricRole; nodes: FabricNode[] }[]
  ).filter((layer) => layer.nodes.length > 0);

  return (
    <div className="nc-fabric" ref={wrapRef}>
      <svg className="nc-fabric-svg">
        {drawn.map((item) => (
          <g key={item.link.id} className={`nc-fabric-link is-${item.link.kind}`}>
            <path className="nc-fabric-glow" d={item.d} />
            <path className="nc-fabric-line" d={item.d} />
            <title>
              {item.link.fromName} {item.link.fromPort} — {item.link.toName} {item.link.toPort}
              {item.link.note ? `\n${item.link.note}` : ''}
            </title>
            <circle className="nc-fabric-dot" cx={item.p.x} cy={item.p.y} r="3.2" />
            <circle className="nc-fabric-dot" cx={item.q.x} cy={item.q.y} r="3.2" />
            <PortTag tag={item.fromTag} />
            <PortTag tag={item.toTag} />
          </g>
        ))}
      </svg>

      {layers.map((layer) => (
        <section key={layer.role} className={`nc-fabric-layer is-${layer.role}`}>
          <div className="nc-fabric-layer-label">{ROLE_LABEL[layer.role]}</div>
          <div className="nc-fabric-row">
            {layer.nodes.map((node) => (
              <FabricNodeCard key={node.id} node={node} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export { ROLE_LABEL };
export type { FabricLinkKind };
