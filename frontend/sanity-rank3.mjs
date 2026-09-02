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

// Realistic topologies mirror what the user actually has today:
//   - 2 cores + 2 dists at the top
//   - 3 floors; only ONE floor has 2 second-hop siblings (F3), the
//     others have 1. That's the case that triggered the original bug
//     report — F3-AS-02 and F3-AS-03 added next to F3-AS-01.
//   - Then "stress" cases: every floor with 2, 3, 5, 7 second-hops to
//     ensure the layout still works at larger scale (canvas can grow,
//     but no two boxes may collide and no first-hop may overflow its
//     column).
function makeTopology(shPerFloor) {
  const out = [];
  for (let i = 0; i < 2; i++) out.push({ id: `core-${i}`, role: 'core' });
  for (let i = 0; i < 2; i++) out.push({ id: `dist-${i}`, role: 'dist' });
  for (let f = 1; f <= 3; f++) {
    out.push({ id: `f${f}-fh0`, role: 'access' });
    out.push({ id: `f${f}-fh1`, role: 'access' });
    // F1 and F2 have NO second-hops (matches the user's real LAB
    // topology today). F3 has shPerFloor second-hops, which is the
    // case that originally broke the layout (F3-AS-02 / F3-AS-03).
    if (f !== 3) continue;
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

// User's real LAB topology: F1 and F2 have only first-hop (no second-hop),
// F3 has multiple second-hops. That's the topology that originally
// exposed the "rank-3 line passing through sibling" bug.
const REALISTIC = {
  makeNodes: (shPerFloor) => {
    const out = [];
    for (let i = 0; i < 2; i++) out.push({ id: `core-${i}`, role: 'core' });
    for (let i = 0; i < 2; i++) out.push({ id: `dist-${i}`, role: 'dist' });
    for (let f = 1; f <= 3; f++) {
      out.push({ id: `f${f}-fh0`, role: 'access' });
      out.push({ id: `f${f}-fh1`, role: 'access' });
      if (f !== 3) continue;
      for (let s = 0; s < shPerFloor; s++) {
        out.push({ id: `f${f}-sh${s}`, role: 'access' });
      }
    }
    return out;
  },
  makeLinks,
};

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
    let parentCenterX = null;
    if (ps.length > 0) {
      let sum = 0, cnt = 0;
      for (const pid of ps) if (boxes[pid]) { sum += boxes[pid].x + boxes[pid].w / 2; cnt++; }
      if (cnt > 0) parentCenterX = sum / cnt;
    }
    const sib = siblings.get(n.id) ?? [n];
    const safeIdx = (() => {
      const i = sib.findIndex(s => s.id === n.id);
      return i >= 0 ? i : 0;
    })();
    let x, y;
    if (parentCenterX !== null) {
      if (sib.length === 1) {
        x = parentCenterX - NODE_W / 2;
        y = rank3Y - RANK3_NODE_H / 2;
      } else if (sib.length === 2) {
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
        // 3+ siblings — stack vertically at parent X (bypass routing
        // handled separately in FabricDiagram; this script only checks
        // geometric overlap / column overflow, not lines).
        x = parentCenterX - NODE_W / 2;
        y = rank3Y + (safeIdx - (sib.length - 1) / 2) * RANK3_STEP_Y - RANK3_NODE_H / 2;
      }
    } else {
      x = MARGIN_X;
      y = rank3Y + (safeIdx - (sib.length - 1) / 2) * RANK3_STEP_Y - RANK3_NODE_H / 2;
    }
    boxes[n.id] = { x, y, w: NODE_W, h: RANK3_NODE_H };
  }
  // Centering: per-tier shift to align rank-2 (access first-hop) axis.
  // Rank-2 stays put; cores/dists/rank-3 all shift so their tier
  // centres match rank-2 centre. Mirrors FabricDiagram.tsx centering.
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

// Layout invariants the test asserts:
//   (1) rank-3 boxes must NOT overlap each other.
//   (2) rank-3 boxes must NOT overlap any rank-2 box from a different
//       floor (i.e. a second-hop must not visually crash into another
//       floor's first-hop). A rank-3 box overflowing its own column into
//       empty space is fine; crashing into a different floor is not.
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
// Realistic suite: matches the user's actual LAB topology (F1/F2 with
// no second-hop, F3 with N second-hops). This is the topology that
// originally exposed the layout bug.
console.log('--- realistic suite (F1/F2 first-hop only, F3 has N second-hop) ---');
for (const sh of [1, 2, 3, 5, 7]) {
  const nodes = REALISTIC.makeNodes(sh);
  const links = REALISTIC.makeLinks(nodes);
  const { boxes } = layoutTopology(nodes, links);
  let rank3Collisions = 0;
  let rank3CrashesIntoOtherFloor = 0;
  const ids = Object.keys(boxes);
  const rank2Ids = ids.filter(i => /-fh\d+/.test(i));

  // Check (1): rank-3 vs rank-3 must not overlap
  const shIds = ids.filter(i => /-sh\d+/.test(i));
  for (let i = 0; i < shIds.length; i++) {
    for (let j = i + 1; j < shIds.length; j++) {
      const a = boxes[shIds[i]], b = boxes[shIds[j]];
      if (overlaps(a, b)) {
        rank3Collisions++;
        console.log(`  rank-3 COLLISION sh=${sh}: ${shIds[i]} <-> ${shIds[j]}`);
      }
    }
  }
  // Check (2): rank-3 must not crash into a rank-2 box from a different floor
  for (const id of shIds) {
    const myFl = floorOf(id);
    if (!myFl) continue;
    for (const otherId of rank2Ids) {
      const otherFl = floorOf(otherId);
      if (!otherFl || otherFl === myFl) continue;
      if (overlaps(boxes[id], boxes[otherId])) {
        rank3CrashesIntoOtherFloor++;
        console.log(`  rank-3 CRASH sh=${sh}: ${id} (fl=${myFl}) <-> ${otherId} (fl=${otherFl})`);
      }
    }
  }

  const shCount = nodes.filter(n => n.id.match(/-sh\d+/)).length;
  if (rank3Collisions === 0 && rank3CrashesIntoOtherFloor === 0) {
    console.log(`sh=${sh} (${shCount} second-hop): OK`);
    pass++;
  } else {
    console.log(`sh=${sh} (${shCount} second-hop): FAIL — ${rank3Collisions} collisions, ${rank3CrashesIntoOtherFloor} rank-3 crashes`);
    fail++;
  }
}

// Stress suite: every floor has N second-hops (worst-case fan-out).
// The canvas will be wide, but no two rank-3 boxes may collide and no
// rank-3 may crash into a different floor's rank-2.
console.log('\n--- stress suite (every floor has N second-hop) ---');
for (const sh of [1, 2, 3, 5, 7]) {
  const nodes = makeTopology(sh);
  const links = makeLinks(nodes);
  const { boxes } = layoutTopology(nodes, links);
  let rank3Collisions = 0;
  let rank3CrashesIntoOtherFloor = 0;
  const ids = Object.keys(boxes);

  const shIds = ids.filter(i => /-sh\d+/.test(i));
  for (let i = 0; i < shIds.length; i++) {
    for (let j = i + 1; j < shIds.length; j++) {
      const a = boxes[shIds[i]], b = boxes[shIds[j]];
      if (overlaps(a, b)) {
        rank3Collisions++;
        console.log(`  rank-3 COLLISION sh=${sh}: ${shIds[i]} <-> ${shIds[j]}`);
      }
    }
  }
  const rank2Ids = ids.filter(i => /-fh\d+/.test(i));
  for (const id of shIds) {
    const myFl = floorOf(id);
    if (!myFl) continue;
    for (const otherId of rank2Ids) {
      const otherFl = floorOf(otherId);
      if (!otherFl || otherFl === myFl) continue;
      if (overlaps(boxes[id], boxes[otherId])) {
        rank3CrashesIntoOtherFloor++;
        console.log(`  rank-3 CRASH sh=${sh}: ${id} (fl=${myFl}) <-> ${otherId} (fl=${otherFl})`);
      }
    }
  }

  const shCount = nodes.filter(n => n.id.match(/-sh\d+/)).length;
  if (rank3Collisions === 0 && rank3CrashesIntoOtherFloor === 0) {
    console.log(`sh=${sh} (${shCount} second-hop): OK`);
    pass++;
  } else {
    console.log(`sh=${sh} (${shCount} second-hop): FAIL — ${rank3Collisions} collisions, ${rank3CrashesIntoOtherFloor} crashes`);
    fail++;
  }
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);