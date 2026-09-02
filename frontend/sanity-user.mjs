// Verify the layout for the user's actual LAB topology:
//   2 cores (F6) + 2 dists (F6) + 1 first-hop on F1/F2 + 1 first-hop + 2 second-hop on F3
import dagre from 'dagre';

const NODE_W = 228, NODE_H = 96;
const TIER_GAP = 232, MARGIN_X = 60, MARGIN_Y = 110;
const FLOOR_COL_WIDE = 320;
const RANK3_NODE_H = 68;
const RANK3_STEP_Y = RANK3_NODE_H + 16;

const nodes = [
  { id: 'F6-CORE-01', name: 'LAB-F6-CORE-01', role: 'core', floor: '6' },
  { id: 'F6-CORE-02', name: 'LAB-F6-CORE-02', role: 'core', floor: '6' },
  { id: 'F6-DS-01',   name: 'LAB-F6-DS-01',   role: 'dist', floor: '6' },
  { id: 'F6-DS-02',   name: 'LAB-F6-DS-02',   role: 'dist', floor: '6' },
  { id: 'F1-AS-01',   name: 'LAB-F1-AS-01',   role: 'access', floor: '1' },
  { id: 'F2-AS-01',   name: 'LAB-F2-AS-01',   role: 'access', floor: '2' },
  { id: 'F3-AS-01',   name: 'LAB-F3-AS-01',   role: 'access', floor: '3' },
  { id: 'F3-AS-02',   name: 'LAB-F3-AS-02',   role: 'access', floor: '3' },
  { id: 'F3-AS-03',   name: 'LAB-F3-AS-03',   role: 'access', floor: '3' },
];

// Mirrors the real interface descriptions (parent → child):
//   F6-CORE-01 <-> F6-CORE-02 (L3 interconnect)
//   F6-CORE-01 -> F6-DS-01, F6-CORE-01 -> F6-DS-02
//   F6-CORE-02 -> F6-DS-01, F6-CORE-02 -> F6-DS-02
//   F6-DS-01 -> F1-AS-01, F6-DS-02 -> F1-AS-01 (full-mesh)
//   F6-DS-01 -> F2-AS-01, F6-DS-02 -> F2-AS-01
//   F6-DS-01 -> F3-AS-01, F6-DS-02 -> F3-AS-01
//   F3-AS-01 -> F3-AS-02, F3-AS-01 -> F3-AS-03 (both uplink to first-hop)
// NO direct dist → F3-AS-02/03 uplinks in the real data. The second-hop
// switches only see their first-hop parent (verified via Job.result
// interface descriptions — F3-AS-02 port ge-0/0/8 → F3-AS-01; F3-AS-03
// port ge-0/0/7 → F3-AS-01).
const links = [
  { from: 'F6-CORE-01', to: 'F6-CORE-02' }, // L3 interconnect
  { from: 'F6-CORE-01', to: 'F6-DS-01' }, { from: 'F6-CORE-01', to: 'F6-DS-02' },
  { from: 'F6-CORE-02', to: 'F6-DS-01' }, { from: 'F6-CORE-02', to: 'F6-DS-02' },
  { from: 'F6-DS-01', to: 'F1-AS-01' }, { from: 'F6-DS-02', to: 'F1-AS-01' },
  { from: 'F6-DS-01', to: 'F2-AS-01' }, { from: 'F6-DS-02', to: 'F2-AS-01' },
  { from: 'F6-DS-01', to: 'F3-AS-01' }, { from: 'F6-DS-02', to: 'F3-AS-01' },
  { from: 'F3-AS-01', to: 'F3-AS-02' }, { from: 'F3-AS-01', to: 'F3-AS-03' },
];

function inferRanks(nodes, links) {
  const adj = new Map(nodes.map(n => [n.id, new Set()]));
  for (const l of links) { adj.get(l.from).add(l.to); adj.get(l.to).add(l.from); }
  const rank = new Map(); const q = [];
  for (const n of nodes) if (n.role === 'core') { rank.set(n.id, 0); q.push(n.id); }
  while (q.length) {
    const id = q.shift();
    const r = rank.get(id);
    for (const nb of adj.get(id)) {
      const cand = r + 1;
      if (rank.get(nb) === undefined || rank.get(nb) > cand) { rank.set(nb, cand); q.push(nb); }
    }
  }
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 2);
  return rank;
}

function layout(nodes, links) {
  const rank = inferRanks(nodes, links);
  const rank2 = nodes.filter(n => rank.get(n.id) === 2);
  const rank3 = nodes.filter(n => rank.get(n.id) === 3);

  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: 'TB', ranksep: TIER_GAP, nodesep: 110 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const l of links) {
    const fr = rank.get(l.from), tr = rank.get(l.to);
    if (fr === tr) continue;
    const parent = fr < tr ? l.from : l.to;
    const child  = fr < tr ? l.to : l.from;
    g.setEdge(parent, child);
  }
  dagre.layout(g);

  const rank2Y = rank2.length ? Math.min(...rank2.map(n => g.node(n.id).y)) : MARGIN_Y + 2 * (NODE_H + TIER_GAP);
  const rank3Y = rank3.length ? Math.min(...rank3.map(n => g.node(n.id).y)) : MARGIN_Y + 3 * (NODE_H + TIER_GAP);

  const floors = [...new Set(rank2.map(n => 'f' + n.floor))].sort();
  const floorColIdx = Object.fromEntries(floors.map((f, i) => [f, i]));

  const boxes = {};
  // Pass 1 (rank 0/1)
  for (const n of nodes) {
    const r = rank.get(n.id);
    if (r > 1) continue;
    const dn = g.node(n.id);
    boxes[n.id] = { x: dn.x - NODE_W / 2, y: Math.max(MARGIN_Y, dn.y - NODE_H / 2), w: NODE_W, h: NODE_H };
  }
  // Pass 2 (rank 2)
  for (const n of rank2) {
    const fl = 'f' + n.floor;
    const col = floorColIdx[fl];
    const fhInFloor = rank2.filter(x => x.floor === n.floor);
    const fhIdx = fhInFloor.indexOf(n);
    const fhCount = fhInFloor.length;
    const maxSpread = FLOOR_COL_WIDE - NODE_W;
    const slotW = fhCount > 1 ? maxSpread / (fhCount - 1) : 0;
    const fhOff = (fhIdx - (fhCount - 1) / 2) * slotW;
    boxes[n.id] = {
      x: MARGIN_X + col * FLOOR_COL_WIDE + (FLOOR_COL_WIDE - NODE_W) / 2 + fhOff,
      y: rank2Y - NODE_H / 2, w: NODE_W, h: NODE_H,
    };
  }
  // Pass 3 (rank 3)
  const parents = new Map();
  for (const n of rank3) {
    const ps = [];
    for (const l of links) {
      let o = null;
      if (l.from === n.id) o = l.to;
      else if (l.to === n.id) o = l.from;
      if (o && rank.get(o) === 2) ps.push(o);
    }
    parents.set(n.id, ps);
  }
  const siblings = new Map();
  for (const n of rank3) {
    const myP = new Set(parents.get(n.id) ?? []);
    const set = new Set([n]);
    for (const m of rank3) {
      if (m.id === n.id) continue;
      const mp = parents.get(m.id) ?? [];
      if (mp.some(p => myP.has(p))) set.add(m);
    }
    siblings.set(n.id, [...set].sort((a, b) => a.id.localeCompare(b.id)));
  }
  for (const n of rank3) {
    const ps = parents.get(n.id) ?? [];
    let parentCenterX = null;
    if (ps.length > 0) {
      let sum = 0, cnt = 0;
      for (const pid of ps) if (boxes[pid]) { sum += boxes[pid].x + boxes[pid].w / 2; cnt++; }
      if (cnt > 0) parentCenterX = sum / cnt;
    }
    const sib = siblings.get(n.id) ?? [n];
    const safeIdx = (() => { const i = sib.findIndex(s => s.id === n.id); return i >= 0 ? i : 0; })();
    let x, y;
    if (parentCenterX !== null) {
      if (sib.length === 1) { x = parentCenterX - NODE_W / 2; y = rank3Y - RANK3_NODE_H / 2; }
      else if (sib.length === 2) {
        // Side-by-side, shifted right under parent. Left sibling
        // starts at parent's left edge (under parent's left half),
        // right sibling sits to the right of left sibling. Both at
        // the same Y baseline. Mirror FabricDiagram.tsx Pass 3.
        const gap = 20;
        const parentLeftX = parentCenterX - NODE_W / 2;
        if (safeIdx === 0) x = parentLeftX;
        else              x = parentLeftX + NODE_W + gap;
        y = rank3Y - RANK3_NODE_H / 2;
      } else {
        // 3+ siblings — stack vertically at parent X.
        x = parentCenterX - NODE_W / 2;
        y = rank3Y + (safeIdx - (sib.length - 1) / 2) * RANK3_STEP_Y - RANK3_NODE_H / 2;
      }
    } else { x = MARGIN_X; y = rank3Y + (safeIdx - (sib.length - 1) / 2) * RANK3_STEP_Y - RANK3_NODE_H / 2; }
    boxes[n.id] = { x, y, w: NODE_W, h: RANK3_NODE_H };
  }
  // Centering: per-tier shift to align rank-2 (access first-hop) axis.
  // Mirrors FabricDiagram.tsx centering.
  const allB = Object.values(boxes);
  if (allB.length > 0) {
    const tierInfo = new Map();
    for (const id of Object.keys(boxes)) {
      const r = rank.get(id);
      const b = boxes[id];
      const cur = tierInfo.get(r);
      if (!cur) tierInfo.set(r, { left: b.x, right: b.x + b.w, centre: b.x + b.w / 2 });
      else {
        cur.left = Math.min(cur.left, b.x);
        cur.right = Math.max(cur.right, b.x + b.w);
        cur.centre = (cur.left + cur.right) / 2;
      }
    }
    const axisInfo = tierInfo.get(2);
    let axisX;
    if (axisInfo) axisX = axisInfo.centre;
    else {
      let mw = -1;
      for (const info of tierInfo.values()) {
        const w = info.right - info.left;
        if (w > mw) { mw = w; axisX = info.centre; }
      }
    }
    for (const id of Object.keys(boxes)) {
      const r = rank.get(id);
      // rank-3 stays where Pass 3 placed it (relative to rank-2 parent).
      if (r === 3) continue;
      const tc = tierInfo.get(r);
      if (!tc) continue;
      boxes[id].x += axisX - tc.centre;
    }
  }
  return { boxes, rank };
}

const { boxes, rank } = layout(nodes, links);
console.log('Rank assignments:');
for (const n of nodes) console.log(`  ${n.id.padEnd(14)} rank=${rank.get(n.id)}`);
console.log('\nBox positions (top-left x, y, w, h):');
const sorted = nodes.map(n => n.id).sort((a, b) => {
  const ra = rank.get(a), rb = rank.get(b);
  if (ra !== rb) return ra - rb;
  return boxes[a].x - boxes[b].x;
});
for (const id of sorted) {
  const b = boxes[id], n = nodes.find(x => x.id === id);
  console.log(`  rank${rank.get(id)} ${id.padEnd(14)} x=${b.x.toFixed(0).padStart(4)} y=${b.y.toFixed(0).padStart(4)} w=${b.w} h=${b.h} (${n.name})`);
}

const totalW = Math.max(...Object.values(boxes).map(b => b.x + b.w)) + MARGIN_X;
const totalH = Math.max(...Object.values(boxes).map(b => b.y + b.h)) + MARGIN_Y;
console.log(`\nCanvas: ${totalW} x ${totalH} px`);

// Sanity: parent→child line must NOT cross any other box
function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}
function lineCrossesBox(a, b, box) {
  // Sample the segment; if any sample is inside the box, it's a hit.
  const N = 50;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h) return true;
  }
  return false;
}
console.log('\nLine-vs-box collision check:');
let anyCrash = false;
for (const l of links) {
  const fr = rank.get(l.from), tr = rank.get(l.to);
  if (fr === tr) continue;
  const parent = fr < tr ? l.from : l.to;
  const child  = fr < tr ? l.to : l.from;
  const pb = boxes[parent], cb = boxes[child];
  if (!pb || !cb) continue;

  // Cross-tier rank 2 → rank 3 lines. The current topology has at most
  // 2 second-hop siblings per first-hop, which the layout places
  // SIDE-BY-SIDE inside the floor column. Both uplink lines are clean
  // diagonals — no bypass path is needed and no collision should be
  // reported. (For 3+ siblings the layout stacks vertically and
  // FabricDiagram.tsx uses an L-path bypass around the upper sibling;
  // that case isn't exercised in this test topology.)
  const from = { x: pb.x + pb.w / 2, y: pb.y + pb.h };
  const to   = { x: cb.x + cb.w / 2, y: cb.y };
  for (const [otherId, ob] of Object.entries(boxes)) {
    if (otherId === parent || otherId === child) continue;
    if (lineCrossesBox(from, to, ob)) {
      console.log(`  CRASH: ${parent} -> ${child} crosses ${otherId}`);
      anyCrash = true;
    }
  }
}
if (!anyCrash) console.log('  OK — no parent->child line crosses any other box');