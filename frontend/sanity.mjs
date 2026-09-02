// Quick sanity check: simulate 18-floor topology with floor-grouping
// and confirm canvas dimensions and vertical rank separation are sane.
// Run from frontend/ with: node sanity.mjs
import dagre from 'dagre';

function makeNodes() {
  const out = [];
  for (let i = 0; i < 2; i++) out.push({ id: `core-${i}`, role: 'core', shortName: `core-${i}`, floor: '' });
  for (let i = 0; i < 4; i++) out.push({ id: `dist-${i}`, role: 'dist', shortName: `dist-${i}`, floor: '' });
  for (let f = 1; f <= 18; f++) {
    const fl = `F${String(f).padStart(2, '0')}`;
    for (let a = 0; a < 7; a++) out.push({ id: `f${f}-as${a}`, role: 'access', shortName: `f${f}-as${a}`, floor: fl });
  }
  return out;
}

function makeLinks(nodes) {
  const out = [];
  const cores = nodes.filter(n => n.role === 'core');
  const dists = nodes.filter(n => n.role === 'dist');
  for (const c of cores) for (const d of dists) out.push({ fromDeviceId: c.id, toDeviceId: d.id });
  for (let f = 1; f <= 18; f++) {
    const fh = [`f${f}-as0`, `f${f}-as1`];
    const sh = [`f${f}-as2`, `f${f}-as3`, `f${f}-as4`, `f${f}-as5`, `f${f}-as6`];
    for (let i = 0; i < fh.length; i++) {
      const d1 = dists[(f + i) % dists.length];
      const d2 = dists[(f + i + 1) % dists.length];
      out.push({ fromDeviceId: d1.id, toDeviceId: fh[i] });
      out.push({ fromDeviceId: d2.id, toDeviceId: fh[i] });
    }
    for (const t of fh) for (const s of sh) out.push({ fromDeviceId: t, toDeviceId: s });
  }
  return out;
}

const TIER_RANK = { core: 0, dist: 1, access: 2 };
const NODE_W = 228, NODE_H = 96, TIER_GAP = 232, MARGIN_X = 60, MARGIN_Y = 110;
const FLOOR_COL_WIDE = 320;

function bfsRank(nodes, links) {
  const adj = new Map(nodes.map(n => [n.id, new Set()]));
  for (const l of links) { adj.get(l.fromDeviceId).add(l.toDeviceId); adj.get(l.toDeviceId).add(l.fromDeviceId); }
  const rank = new Map();
  const queue = [];
  for (const n of nodes) if (n.role === 'core') { rank.set(n.id, 0); queue.push(n.id); }
  while (queue.length) {
    const id = queue.shift();
    const r = rank.get(id);
    for (const nb of adj.get(id)) {
      if (!rank.has(nb) || rank.get(nb) > r + 1) { rank.set(nb, r + 1); queue.push(nb); }
    }
  }
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, TIER_RANK[n.role]);
  return rank;
}

const nodes = makeNodes();
const links = makeLinks(nodes);
console.log(`nodes=${nodes.length} links=${links.length}`);

const rank = bfsRank(nodes, links);
const rank2Nodes = nodes.filter(n => rank.get(n.id) === 2);
const rank3Nodes = nodes.filter(n => rank.get(n.id) === 3);

const g = new dagre.graphlib.Graph({ multigraph: false });
g.setGraph({ rankdir: 'TB', ranksep: TIER_GAP, nodesep: 28, edgesep: 12, marginx: MARGIN_X, marginy: MARGIN_Y });
g.setDefaultEdgeLabel(() => ({}));
for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
for (const l of links) g.setEdge(l.fromDeviceId, l.toDeviceId);
dagre.layout(g);

// Build floor→colIdx from rank-2 dagre X centroid order
const rank2ByFloor = new Map();
for (const n of rank2Nodes) rank2ByFloor.set(n.floor, n);
const floors = [...rank2ByFloor.keys()].sort((a, b) => {
  const dnA = g.node(rank2ByFloor.get(a).id);
  const dnB = g.node(rank2ByFloor.get(b).id);
  return (dnA ? dnA.x : 0) - (dnB ? dnB.x : 0);
});
const floorColIdx = {};
floors.forEach((fl, i) => { floorColIdx[fl] = i; });

const dnRank2 = rank2Nodes[0] ? g.node(rank2Nodes[0].id) : null;
const dnRank3 = rank3Nodes[0] ? g.node(rank3Nodes[0].id) : null;
const rank2Y = dnRank2 ? dnRank2.y : 0;
const rank3Y = dnRank3 ? dnRank3.y : 0;

// Compute boxMap with floor grouping
const boxMap = {};
for (const node of nodes) {
  const r = rank.get(node.id) ?? 0;
  const dn = g.node(node.id);
  const dagreX = dn ? dn.x : 0;
  const dagreY = dn ? dn.y : 0;
  const fl = node.floor || node.id;

  let x = dagreX - NODE_W / 2;
  let y = dagreY - NODE_H / 2;

  if (r === 2) {
    const col = floorColIdx[fl] ?? 0;
    x = MARGIN_X + col * FLOOR_COL_WIDE + (FLOOR_COL_WIDE - NODE_W) / 2;
    y = rank2Y - NODE_H / 2;
  } else if (r === 3) {
    const col = floorColIdx[fl] ?? 0;
    const baseX = MARGIN_X + col * FLOOR_COL_WIDE + FLOOR_COL_WIDE / 2;
    const shNodesInFloor = rank3Nodes.filter(n => n.floor === node.floor);
    const idx = shNodesInFloor.indexOf(node);
    const SH_OFFSETS = [-60, 0, 60, -30, 30];
    const rank3NodeH = 68;
    x = baseX - NODE_W / 2 + (SH_OFFSETS[idx % SH_OFFSETS.length] ?? 0);
    y = rank3Y + (idx - (shNodesInFloor.length - 1) / 2) * (rank3NodeH + 8) - rank3NodeH / 2;
  }

  boxMap[node.id] = { x, y: Math.max(MARGIN_Y, y), w: NODE_W, h: r === 3 ? 68 : NODE_H };
}

const allBoxes = Object.values(boxMap);
const totalWidth  = allBoxes.length > 0 ? Math.max(...allBoxes.map(b => b.x + b.w)) + MARGIN_X : 0;
const totalHeight = allBoxes.length > 0 ? Math.max(...allBoxes.map(b => b.y + b.h)) + MARGIN_Y : 0;

console.log(`canvas: ${totalWidth.toFixed(0)} x ${totalHeight.toFixed(0)} px`);
console.log(`rank Y: core=${boxMap['core-0'].y.toFixed(0)}, dist=${boxMap['dist-0'].y.toFixed(0)}, fh=${boxMap['f1-as0'].y.toFixed(0)}, sh=${boxMap['f1-as2'].y.toFixed(0)}`);
console.log(`Floor columns (first 5):`);
for (const fl of floors.slice(0, 5)) {
  const n = rank2ByFloor.get(fl);
  console.log(`  ${fl}: x=${boxMap[n.id].x.toFixed(0)}`);
}
console.log(`Floor 1 second-hop stacked vertically:`);
for (const n of rank3Nodes.filter(n => n.floor === 'F01')) {
  console.log(`  ${n.shortName}: x=${boxMap[n.id].x.toFixed(0)}, y=${boxMap[n.id].y.toFixed(0)}`);
}
console.log(`Dists x spread: ${['dist-0','dist-1','dist-2','dist-3'].map(id => boxMap[id].x.toFixed(0)).join(', ')}`);
