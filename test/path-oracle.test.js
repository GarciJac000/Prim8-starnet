/* test/path-oracle.test.js — worldmodel.js path() must answer EXACTLY what the old BFS answered.

   path() used to allocate and fill a COLS*ROWS Int32Array on every call and re-derive every BFS edge
   (two footPoint objects, a dozen "x,y" strings and Set lookups) each time it was asked, so one wander
   decision (up to 48 calls) re-proved the same edges over and over (idle-CPU lane, 2026-10-20). The
   rewrite keeps per-geo scratch arrays and memoizes each edge's extra-independent verdict. That is an
   invisible change only if every route is unchanged, so this test carries a VERBATIM copy of the old
   path() + smoothPath() + losClear() as the oracle and compares them on seeded random stations:
   rooms, abutting rooms, hallways of every width (north mouth lanes included), blocking and flat
   props, sealed airlocks, several wall heights, and every shape of `extra` the callers pass (null,
   Sets, Maps, odd keys, a has()-only object) — interleaved so a memo filled under one `extra` is read
   under another. The oracle reaches the geometry only through exports the rewrite leaves untouched
   (walkable, canStep, footPoint, clearFootSegment, idx).

   It also pins the point of the rewrite: once warm, a path() call allocates no typed array (the old
   one allocated a COLS*ROWS Int32Array per call). Pure model, plain require(), seeded RNG only. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');

/* ---- the OLD implementation, copied verbatim from worldmodel.js before the 2026-10-20 rewrite ----
   segmentClear is only ever reached here with physical=false (the tile-centre leg of losClear): its
   clearFace is then the identity and clearMouths is never called, so those branches are left out. The
   physical (foot) leg is the exported clearFootSegment, exactly as before. */
function oracleFor(g) {
  const { TILE, COLS, ROWS, idx, walkable, canStep, footPoint, clearFootSegment } = g;
  function segmentClear(ax, ay, bx, by, extra) {
    if (![ax, ay, bx, by].every(Number.isFinite)) return false;
    const x0 = Math.floor(ax), y0 = Math.floor(ay), x1 = Math.floor(bx), y1 = Math.floor(by);
    let x = x0, y = y0;
    const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
    const xi = bx > ax ? 1 : -1, yi = by > ay ? 1 : -1;
    const stepX = dx ? 1 / dx : Infinity, stepY = dy ? 1 / dy : Infinity;
    let nextX = dx ? (xi > 0 ? x + 1 - ax : ax - x) / dx : Infinity;
    let nextY = dy ? (yi > 0 ? y + 1 - ay : ay - y) / dy : Infinity;
    let guard = Math.abs(x1 - x0) + Math.abs(y1 - y0) + 1;
    while ((x !== x1 || y !== y1) && guard-- > 0) {
      if (!walkable(x, y, extra)) return false;
      if (nextX < nextY - 1e-10) {
        if (!walkable(x + xi, y, extra) || !canStep(x, y, x + xi, y)) return false;
        x += xi; nextX += stepX;
      } else if (nextY < nextX - 1e-10) {
        if (!walkable(x, y + yi, extra) || !canStep(x, y, x, y + yi)) return false;
        y += yi; nextY += stepY;
      } else {
        // At a grid corner both orthogonal passages must be open.
        if (!walkable(x + xi, y, extra) || !walkable(x, y + yi, extra)) return false;
        if (!canStep(x, y, x + xi, y) || !canStep(x, y, x, y + yi)) return false;
        if (!canStep(x + xi, y, x + xi, y + yi) || !canStep(x, y + yi, x + xi, y + yi)) return false;
        x += xi; y += yi; nextX += stepX; nextY += stepY;
      }
    }
    return guard > 0 && walkable(x1, y1, extra);
  }
  function losClear(x0, y0, x1, y1, extra) {
    const a = footPoint(x0, y0), b = footPoint(x1, y1);
    return segmentClear(x0 + .5, y0 + .5, x1 + .5, y1 + .5, extra)
      && clearFootSegment(a.x, a.y, b.x, b.y, extra);   // == segmentClear(a.x/TILE, …, extra, true)
  }
  function smoothPath(pts, sx, sy, extra) {
    if (!pts || pts.length < 3) return pts;
    const out = [];
    let ax = sx, ay = sy, i = 0;
    while (i < pts.length) {
      let best = i;
      for (let j = pts.length - 1; j > i; j--) {
        if (losClear(ax, ay, pts[j].x, pts[j].y, extra)) { best = j; break; }
      }
      out.push(pts[best]);
      ax = pts[best].x; ay = pts[best].y;
      i = best + 1;
    }
    return out;
  }
  function path(sx, sy, tx, ty, extra) {
    if (!walkable(tx, ty, extra)) return null;
    if (sx === tx && sy === ty) return [];
    const prev = new Int32Array(COLS * ROWS).fill(-1);
    const start = idx(sx, sy), target = idx(tx, ty);
    prev[start] = start;
    const q = [start]; let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      if (cur === target) break;
      const cx = cur % COLS, cy = (cur / COLS) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const ni = idx(nx, ny);
        if (prev[ni] !== -1 || !walkable(nx, ny, extra) || !canStep(cx, cy, nx, ny)) continue;
        const a=footPoint(cx,cy),b=footPoint(nx,ny);
        if(!clearFootSegment(a.x,a.y,b.x,b.y,extra))continue;
        prev[ni] = cur; q.push(ni);
      }
    }
    if (prev[target] === -1) return null;
    const out = []; let cur = target;
    while (cur !== start) { out.push({ x: cur % COLS, y: (cur / COLS) | 0 }); cur = prev[cur]; }
    out.reverse();
    return smoothPath(out, sx, sy, extra);   // collapse the BFS staircase into straight runs + diagonals
  }
  return path;
}

/* ---- seeded generators ---- */
function rng(seed) {
  let s = seed >>> 0 || 1;
  const f = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  return { f, int: (a, b) => a + Math.floor(f() * (b - a + 1)), pick: arr => arr[Math.floor(f() * arr.length)] };
}
const WALLS = [undefined, {}, { up: 0 }, { up: 3 }, { up: 12, capH: 2 }, { up: 40, capH: 6 }, { up: 30, capH: 4 }];
function makeStation(seed) {
  const R = rng(seed);
  const s = WM.create();
  const gap = R.pick([0, 2, 2, 3]);
  const cols = R.int(2, 5), rows = R.int(1, 4);
  const cw = [], ch = [], xs = [], ys = [];
  for (let i = 0; i < cols; i++) cw.push(R.int(3, 10));
  for (let j = 0; j < rows; j++) ch.push(R.int(3, 8));
  // WM.create() seeds the 18x11 starter room at 0,0..17,10: the lattice starts right of it
  let x = 18 + gap; for (let i = 0; i < cols; i++) { xs.push(x); x += cw[i] + gap; }
  let y = 0; for (let j = 0; j < rows; j++) { ys.push(y); y += ch[j] + gap; }
  const has = {};
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (i + j > 0 && R.f() < 0.15) continue;
    const r = s.addRoom({ kind: R.pick(['hab', 'lab', 'storage', 'quarters']), rect: { x1: xs[i], y1: ys[j], x2: xs[i] + cw[i] - 1, y2: ys[j] + ch[j] - 1 } });
    if (r.ok) has[i + ',' + j] = true;
  }
  if (gap > 0) {
    const hw = R.int(1, Math.min(3, ch[0])), yy = R.int(0, Math.min(10, ch[0] - 1) - hw + 1);
    s.placeHallway({ rect: { x1: 18, y1: yy, x2: 18 + gap - 1, y2: yy + hw - 1 } });   // starter room -> lattice
    for (let j = 0; j < rows; j++) for (let i = 0; i + 1 < cols; i++) {
      if (!has[i + ',' + j] || !has[(i + 1) + ',' + j] || R.f() < 0.1) continue;
      const hw = R.int(1, Math.min(3, ch[j])), yy = ys[j] + R.int(0, ch[j] - hw);
      s.placeHallway({ rect: { x1: xs[i] + cw[i], y1: yy, x2: xs[i + 1] - 1, y2: yy + hw - 1 } });
    }
    for (let j = 0; j + 1 < rows; j++) for (let i = 0; i < cols; i++) {
      if (!has[i + ',' + j] || !has[i + ',' + (j + 1)] || R.f() < 0.1) continue;
      const hw = R.int(1, Math.min(4, cw[i])), xx = xs[i] + R.int(0, cw[i] - hw);
      s.placeHallway({ rect: { x1: xx, y1: ys[j] + ch[j], x2: xx + hw - 1, y2: ys[j + 1] - 1 } });
    }
  }
  const PROPS = [
    { t: 'crate', w: 1, h: 1 }, { t: 'crate', w: 1, h: 1 }, { t: 'desk', w: 2, h: 1 }, { t: 'desk', w: 1, h: 2 },
    { t: 'console', w: 2, h: 2 }, { t: 'rug', w: 2, h: 2, block: false }, { t: 'rug_small', w: 1, h: 1, block: false },
  ];
  const nProps = R.int(0, 28);
  for (let k = 0; k < nProps; k++) {
    const p = R.pick(PROPS);
    s.addProp(Object.assign({}, p, { x: R.int(0, x), y: R.int(0, y) }));
  }
  if (R.f() < 0.35) s.addProp({ t: 'airlock', w: 1, h: 1, block: false, door: R.pick(['open', 'closed', 'jammed']), x: R.int(0, x), y: R.int(0, y) });
  return { st: s, walls: R.pick(WALLS) };
}

/* every shape of `extra` a caller can hand path(): the old code only ever asked extra.has("x,y") */
function makeExtra(R, g, W, a, b) {
  const key = t => t.x + ',' + t.y;
  const some = p => { const s = new Set(); for (const t of W) if (R.f() < p) s.add(key(t)); return s; };
  const roll = R.f();
  if (roll < 0.22) return null;
  if (roll < 0.26) return undefined;
  if (roll < 0.50) return some(R.pick([0.02, 0.08, 0.25]));
  if (roll < 0.56) {   // around the endpoints: blocked start, blocked target, walled-in target (full-component BFS)
    const s = some(0.03);
    if (R.f() < 0.4) s.add(a.x + ',' + a.y);
    if (R.f() < 0.15) s.add(b.x + ',' + b.y);
    if (R.f() < 0.6) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) s.add((b.x + dx) + ',' + (b.y + dy));
    return s;
  }
  if (roll < 0.66) {   // keys walkable() never builds must never block (and the real ones still must)
    const s = some(0.05);
    for (let k = 0; k < 12; k++) {
      const t = R.pick(W);
      s.add(R.pick(['0' + t.x + ',' + t.y, t.x + ', ' + t.y, ' ' + t.x + ',' + t.y, t.x + ',' + t.y + '.0', t.x + '.0,' + t.y,
        '-0,' + t.y, t.x + ',' + t.y + ',', t.x + '' + t.y, '-1,' + t.y, (g.COLS + 1) + ',' + t.y, t.x + ',' + (g.ROWS + 2), (t.x + 0.5) + ',' + t.y]));
      if (R.f() < 0.3) s.add(t.x * 1000 + t.y);
    }
    return s;
  }
  if (roll < 0.76) { const m = new Map(); for (const k of some(0.08)) m.set(k, R.f() < 0.5 ? 0 : 1); return m; }
  if (roll < 0.86) { const blocked = some(0.1); return { has: k => blocked.has(k) }; }   // has()-only, no keys()
  if (roll < 0.91) return new Set();
  return some(0.4);
}

function queriesFor(R, g, W, n) {
  const out = [];
  const anyTile = () => ({ x: R.int(0, g.COLS - 1), y: R.int(0, g.ROWS - 1) });
  for (let k = 0; k < n; k++) {
    let a = R.pick(W), b = R.pick(W);
    const roll = R.f();
    let sx = a.x, sy = a.y, tx = b.x, ty = b.y;
    if (roll < 0.10) { const t = anyTile(); sx = t.x; sy = t.y; }                         // start anywhere (walls, void, props)
    else if (roll < 0.15) { const t = anyTile(); tx = t.x; ty = t.y; }                    // target anywhere
    else if (roll < 0.19) { tx = sx; ty = sy; }                                           // already there
    else if (roll < 0.23) {                                                               // off the grid / wrapped / between tiles
      const v = R.int(0, 6);
      if (v === 0) sx = -1; else if (v === 1) sx = g.COLS + R.int(0, 2); else if (v === 2) sy = -1;
      else if (v === 3) sy = g.ROWS + 1; else if (v === 4) sx = a.x + 0.5; else if (v === 5) { sx = -1; sy = a.y + 1; }
      else { sx = 0.5; sy = a.y + 0.5 / g.COLS; }
    } else if (roll < 0.25) { sx = b.x - 1; sy = b.y; }                                   // a neighbour
    out.push({ sx, sy, tx, ty, a: { x: sx | 0, y: sy | 0 }, b: { x: tx, y: ty } });
  }
  return out;
}

/* ---- the golden comparison ---- */
let geos = 0, calls = 0, cold = 0, mismatches = 0, routed = 0, nulls = 0, empties = 0, longest = 0, lanesSeen = 0;
const shown = [];
for (let seed = 1; seed <= 36; seed++) {
  const { st, walls } = makeStation(seed * 7919);
  const g = st.projectGeometry(walls);
  const W = [];
  for (let yy = 0; yy < g.ROWS; yy++) for (let xx = 0; xx < g.COLS; xx++) if (g.walkable(xx, yy, null)) W.push({ x: xx, y: yy });
  if (W.length < 2) continue;
  geos++;
  // a foot pulled toward a north doorway's lane is the one place a foot is not its tile's centre
  for (const t of W) { const f = g.footPoint(t.x, t.y); if (f.x !== t.x * g.TILE + g.TILE / 2) { lanesSeen++; break; } }
  const oracle = oracleFor(g);
  const R = rng(seed * 104729);
  for (const [n, q] of queriesFor(R, g, W, 110).entries()) {
    const extra = makeExtra(R, g, W, q.a, q.b);
    const want = oracle(q.sx, q.sy, q.tx, q.ty, extra);
    // a geo's first call takes its own road (no memo yet): give a few queries a throwaway geo each
    const fresh = n < 6 ? st.projectGeometry(walls) : g;
    const got = fresh.path(q.sx, q.sy, q.tx, q.ty, extra);
    calls++; if (fresh !== g) cold++;
    const sw = JSON.stringify(want), sg = JSON.stringify(got);
    if (sw !== sg) { mismatches++; if (shown.length < 5) shown.push('seed ' + seed + ' ' + JSON.stringify(q) + ' want ' + sw + ' got ' + sg); }
    if (want === null) nulls++; else if (!want.length) empties++; else { routed++; longest = Math.max(longest, want.length); }
  }
}
for (const s of shown) console.log('  MISMATCH ' + s);
A.ok(geos >= 30, 'enough random stations exercised (' + geos + ')');
A.ok(lanesSeen >= 3, 'some stations clamp feet into north mouth lanes (' + lanesSeen + ')');
A.ok(routed > 1500 && nulls > 300 && empties > 60, 'routes, refusals and already-there answers all exercised (' + routed + '/' + nulls + '/' + empties + ')');
A.eq(mismatches, 0, 'path() answers exactly what the old BFS answered on every query (' + calls + ' calls, ' + cold + ' on a fresh geo)');

/* ---- once warm, a call allocates no typed array ---- */
{
  const { st, walls } = makeStation(4242), g = st.projectGeometry(walls);
  const W = [];
  for (let yy = 0; yy < g.ROWS; yy++) for (let xx = 0; xx < g.COLS; xx++) if (g.walkable(xx, yy, null)) W.push({ x: xx, y: yy });
  const R = rng(99);
  const qs = queriesFor(R, g, W, 120).map(q => Object.assign(q, { extra: makeExtra(R, g, W, q.a, q.b) }));
  const run = () => qs.map(q => JSON.stringify(g.path(q.sx, q.sy, q.tx, q.ty, q.extra)));
  const first = run();
  const real = {};
  let made = 0;
  for (const name of ['Int32Array', 'Uint32Array', 'Uint8Array', 'Float64Array']) {
    real[name] = globalThis[name];
    globalThis[name] = new Proxy(real[name], { construct(t, args, nt) { made++; return Reflect.construct(t, args, nt); } });
  }
  let again;
  try { again = run(); } finally { for (const name in real) globalThis[name] = real[name]; }
  A.eq(made, 0, 'a warm path() allocates no typed arrays (' + qs.length + ' calls)');
  A.eq(again, first, 'a warm geo answers exactly what it answered cold');
}

console.log('  ' + geos + ' stations (' + lanesSeen + ' with doorway lanes), ' + calls + ' calls: ' + routed + ' routed (longest '
  + longest + ' waypoints), ' + nulls + ' refused, ' + empties + ' already there, ' + mismatches + ' mismatches');
A.report('path-oracle');
