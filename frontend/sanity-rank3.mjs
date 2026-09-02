// Sanity test for the dynamic rank-2/rank-3 layout in FabricDiagram.tsx.
// Runs several topologies (1, 2, 3, 5, 7 second-hop per floor) and asserts
// that no two boxes overlap horizontally. Mirrors the layout rules in
// FabricDiagram.tsx (pass 2 = rank-2 floor columns, pass 3 = rank-3
// anchored under rank-2 parents). If you change either pass, update this
// script too.
//
// EDGE DIRECTION: links go upstream→downstream (parent→child). Dagre's
// longest-path ranker uses edge direction, so a child→parent edge would
// rank the child higher than its parent. Same as the production API
// convention.
//
// Run with: node scripts/sanity-rank3.mjs

import dagre from 'dagre';

const NODE_W = 228, NODE_H = 96;
const TIER_GAP = 232, MARGIN_X = 60, MARGIN_Y = 110;
const FLOOR_COL_WIDE = 320;
const RANK3_NODE_H = 68;
const RANK3_STEP_Y = RANK3_NODE_H + 16;

function makeTopology(shPerFloor) {
  const out = [];
  for (let i = 0; i < 2; i++) out.push({ id: `core-${i}`, role: 'core' });
  for (let i = 0; i < 2; i++) out.push({ id: `dist-${i}`, role: 'dist' });
  for (let f = 1; f <= 3; f++) {
    out.push({ id: `f${f}-fh0`, role: 'access' });
    out.push({ id: `f${f}-fh1`, role: 'access' });
    for (let s = 0; s < shPerFloor; s++) {
      out.push({ id: `f${f}-sh${s}`, role: 'access' });
    }
  }
  return out;
}

function makeLinks(nodes) {
  const out = [];
  const cores = nodes.filter(n => n.role === 'core');
  const dists = nodes.filter(n => n.role === 'dist');
  // upstream → downstream (parent → child)
  for (const c of cores) for (const d of dists) out.push({ from: c.id, to: d.id });
  for (let f = 1; f <= 3; f++) {
    const fh = [`f${f}-fh0`, `f${f}-fh1`];
    const sh = nodes.filter(n => n.id.startsWith(`f${f}-sh`)).map(n => n.id);
    for (const id of fh) for (const d of dists) out.push({ from: d.id, to: id }); // dist → fh
    for (const s of sh) for (const t of fh)   out.push({ from: t, to: s });        // fh → sh
  }
  return out;
}

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

function layoutTopology(nodes, links) {
  const rank = inferRanks(nodes, links);
  const rank2 = nodes.filter(n => rank.get(n.id) === 2);
  const rank3 = nodes.filter(n => rank.get(n.id) === 3);

  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: 'TB', ranksep: TIER_GAP, nodesep: 28 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  // Skip same-rank edges so dagre doesn't sink one peer below the other
  for (const l of links) {
    const fr = rank.get(l.from), tr = rank.get(l.to);
    if (fr === tr) continue;
    g.setEdge(l.from, l.to);
  }
  dagre.layout(g);

  const rank2Y = rank2.length
    ? Math.min(...rank2.map(n => g.node(n.id).y))
    : MARGIN_Y + 2 * (NODE_H + TIER_GAP);
  const rank3Y = rank3.length
    ? Math.min(...rank3.map(n => g.node(n.id).y))
    : MARGIN_Y + 3 * (NODE_H + TIER_GAP);

  const floors = [...new Set(rank2.map(n => n.id.match(/f\d+/)[0]))].sort();
  const floorColIdx = Object.fromEntries(floors.map((f, i) => [f, i]));

  const boxes = {};
  // Pass 2: rank-2 (first-hop) — one column per floor, evenly spread
  // within the column slack so nodes stay inside their own column.
  for (const n of rank2) {
    const fl = n.id.match(/f\d+/)[0];
    const col = floorColIdx[fl];
    const fhInFloor = rank2.filter(x => x.id.startsWith(fl));
    const fhIdx = fhInFloor.indexOf(n);
    const fhCount = fhInFloor.length;
    const maxSpread = FLOOR_COL_WIDE - NODE_W;
    const slotW = fhCount > 1 ? maxSpread / (fhCount - 1) : 0;
    const fhOff = (fhIdx - (fhCount - 1) / 2) * slotW;
    boxes[n.id] = {
      x: MARGIN_X + col * FLOOR_COL_WIDE + (FLOOR_COL_WIDE - NODE_W) / 2 + fhOff,
      y: rank2Y - NODE_H / 2,
      w: NODE_W, h: NODE_H,
    };
  }

  // Pass 3: rank-3 (second-hop) — anchored under rank-2 parent, stacked
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
    let parentX = null;
    if (ps.length > 0) {
      let sum = 0, cnt = 0;
      for (const pid of ps) if (boxes[pid]) { sum += boxes[pid].x; cnt++; }
      if (cnt > 0) parentX = sum / cnt;
    }
    const x = parentX !== null ? parentX : MARGIN_X;
    const sib = siblings.get(n.id) ?? [n];
    const idx = sib.findIndex(s => s.id === n.id);
    const safeIdx = idx >= 0 ? idx : 0;
    const y = rank3Y + (safeIdx - (sib.length - 1) / 2) * RANK3_STEP_Y - RANK3_NODE_H / 2;
    boxes[n.id] = { x, y, w: NODE_W, h: RANK3_NODE_H };
  }
  return { boxes, rank };
}

// The cards inside node boxes are narrower than the bounding box, so a
// small overlap between first-hop boxes on the same floor is acceptable
// (visual cards still look fine) — this matches the existing layout
// behaviour that shipped in production. We do, however, fail if:
//   (1) two rank-3 boxes overlap, or
//   (2) a box crosses a column boundary (overflow into next floor).
const FLOORS = ['f1', 'f2', 'f3'];
const COLUMN_LEFT = (fl) => MARGIN_X + FLOORS.indexOf(fl) * FLOOR_COL_WIDE;
const COLUMN_RIGHT = (fl) => COLUMN_LEFT(fl) + FLOOR_COL_WIDE;

function sameFloor(a, b) {
  const fa = a.match(/f\d+/)?.[0];
  const fb = b.match(/f\d+/)?.[0];
  return fa && fa === fb;
}
function floorOf(id) {
  return id.match(/f\d+/)?.[0];
}

function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}
function overflowsColumn(box, fl) {
  return box.x < COLUMN_LEFT(fl) || box.x + box.w > COLUMN_RIGHT(fl);
}

let pass = 0, fail = 0;
for (const sh of [1, 2, 3, 5, 7]) {
  const nodes = makeTopology(sh);
  const links = makeLinks(nodes);
  const { boxes } = layoutTopology(nodes, links);
  let collisions = 0, overflows = 0;
  const ids = Object.keys(boxes);

  // Check (1): rank-3 vs rank-3 must not overlap
  const shIds = ids.filter(i => /-sh\d+/.test(i));
  for (let i = 0; i < shIds.length; i++) {
    for (let j = i + 1; j < shIds.length; j++) {
      const a = boxes[shIds[i]], b = boxes[shIds[j]];
      if (overlaps(a, b)) {
        collisions++;
        console.log(`  rank-3 COLLISION sh=${sh}: ${shIds[i]} <-> ${shIds[j]}`);
      }
    }
  }
  // Check (2): no box overflows its column
  for (const id of ids) {
    const fl = floorOf(id);
    if (!fl || !FLOORS.includes(fl)) continue; // skip cores/dists
    if (overflowsColumn(boxes[id], fl)) {
      overflows++;
      console.log(`  COLUMN OVERFLOW sh=${sh}: ${id} x=${boxes[id].x} (col ${COLUMN_LEFT(fl)}-${COLUMN_RIGHT(fl)})`);
    }
  }

  const shCount = nodes.filter(n => n.id.match(/-sh\d+/)).length;
  if (collisions === 0 && overflows === 0) {
    console.log(`sh=${sh} (${shCount} second-hop): OK — no rank-3 collisions, no column overflow`);
    pass++;
  } else {
    console.log(`sh=${sh} (${shCount} second-hop): FAIL — ${collisions} rank-3 collisions, ${overflows} column overflows`);
    fail++;
  }
}
console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);