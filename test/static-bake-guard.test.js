/* node test/static-bake-guard.test.js — STATIC BAKE (2026-10-10, "slower since the new textures").

   The deck/wall/light bake costs ~2.5 s of frozen main thread on a large industrial station, and the world used to re-bake
   it after EVERY station edit — turning a stool froze the app. A props-only edit (WorldModel's staticBakeUnchanged) now
   keeps the bake, with one exact guard: furniture reaches the bake only through WorldSurface.planFixtures, which puts a
   wall lamp's light sample on clear deck in the 3 rows below its north wall, skipping past furniture. world.js
   fingerprints walkability on those tiles (fixtureAnchorKey); a props-only edit that changes it re-bakes.

   This proves the guard can never let the lamp plan go stale: every legal one-tile move of every prop on a furnished
   station either leaves planFixtures' plan identical or changes the fingerprint. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const WM = require('../frontend/app/worldmodel.js');
const WS = require('../frontend/app/worldsurface.js');

const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const from = world.indexOf('  function fixtureAnchorKey(g) {'), to = world.indexOf('  function rebake() {');
A.ok(from > 0 && to > from, 'world.js carries fixtureAnchorKey right before rebake()');
const fixtureAnchorKey = new Function(world.slice(from, to) + '; return fixtureAnchorKey;')();

// the wiring: only a bake-changing edit (or a moved frame, or a moved lamp anchor) marks the bake dirty
// (the STILL tier's wake rides after it: a layout edit is drawn on the next vsync — test/render-still.test.js)
A.ok(/station\.onChange\(p => \{ geoDirty = true; if \(!p \|\| !p\.staticBakeUnchanged \|\| p\.global\) bakeEditPending = true; motionWake\(\); \}\)/.test(world),
  'the floor subscription marks the bake only for an edit WorldModel says changes it');
A.ok(/if \(bakeEditPending \|\| frameMoved \|\| fixtureAnchorKey\(geo\) !== bakedAnchorKey\) bakeDirty = true;/.test(world),
  'rederive re-bakes for a bake edit, a moved frame, or a moved lamp anchor — nothing else');
// (a floor BUILD MODE hands back is checked against the CURRENT fixture plan before it is stitched — StationBake.stitchWhole)
A.ok(/cache = [^;]*\? handed\.bake : StationBake\.bake\(geo\);\s*bakedAnchorKey = fixtureAnchorKey\(geo\);/.test(world), 'every bake records the anchors it was planned with');

// a furnished room: tables against the north wall (where lamps anchor) and out in the middle
const st = WM.create(); st.projectGeometry();
A.ok(st.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 60, y2: 20 } }).ok, 'room laid');
const room = st.doc().rooms[st.doc().order[0]] || Object.values(st.doc().rooms)[0];
const r = room.rect || { x1: 30, y1: 0, x2: 60, y2: 20 };
const placed = [];
for (let x = r.x1 + 1; x < r.x2 - 1; x += 3) for (const y of [r.y1 + 1, r.y1 + 2, r.y1 + 7]) {
  const res = st.addProp({ t: 'crate', x, y, w: 1, h: 1 });
  if (res && res.ok) placed.push(res.id);
}
A.ok(placed.length >= 12, 'props placed both under the north wall and in the open (' + placed.length + ')');

const plan = g => JSON.stringify(WS.planFixtures(g, { wallUp: 30, infillFixtures: true }).map(f => [f.id, f.x, f.y, f.r, f.gain]));
const g0 = st.projectGeometry(), plan0 = plan(g0), key0 = fixtureAnchorKey(g0);
A.ok(WS.planFixtures(g0, { wallUp: 30 }).length > 0, '(the room has wall lamps to anchor)');
let patch = null; st.onChange(p => { patch = p; });
let moves = 0, planMoves = 0, guarded = 0, skipped = 0, missed = 0, unflagged = 0;
for (const id of st.doc().props.map(p => p.id)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
  patch = null;
  const m = st.moveProp(id, dx, dy); if (!m || !m.ok) continue;
  moves++; if (!(patch && patch.staticBakeUnchanged)) unflagged++;
  const g = st.projectGeometry(), pc = plan(g) !== plan0, kc = fixtureAnchorKey(g) !== key0;
  if (pc) planMoves++; if (kc) guarded++; else skipped++; if (pc && !kc) missed++;
  st.undo();
}
A.ok(moves > 40, 'every prop was moved a tile each way (' + moves + ' legal moves)');
A.eq(unflagged, 0, 'every prop move is flagged staticBakeUnchanged by WorldModel');
A.ok(planMoves > 0, 'some moves really do move a lamp\'s light (' + planMoves + ')');
A.eq(missed, 0, 'no move that changes the lamp plan gets past the guard');
A.ok(skipped > 0, 'and moves that cannot touch a lamp skip the bake (' + skipped + ' of ' + moves + ')');
const g1 = st.projectGeometry();
A.ok(plan(g1) === plan0 && fixtureAnchorKey(g1) === key0, 'undo restores the plan and the fingerprint exactly');

// world-render-03: prop ART never reaches the station bake (planFixtures reads walkability, never sprites), so a prop-art
// change (a remaster repair batch after a GPU reset, a user prop decoded) must repaint only the prop-shadow layer — a
// full World.rebake() there was another ~2.5 s freeze per batch on a large station.
const propsSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'propsprites.js'), 'utf8');
const inval = A.fnBody(world, 'function invalidatePropShadows()');
A.ok(inval && /propShadowLayer\.stamp\s*=\s*null/.test(inval) && !/rebake|StationBake/.test(inval), 'World.invalidatePropShadows only clears the shadow layer stamp (no bake)');
A.ok(/return (?:wakeOnCall\()?\{ init, rebake, invalidatePropShadows,/.test(world), 'World exports invalidatePropShadows');   // (through the STILL WAKE wrapper, 2026-10-21)
const artLine = (propsSrc.match(/userArtChanged\(\) \{[^\n]*/) || [''])[0];
A.ok(/World\.invalidatePropShadows\(\)/.test(artLine), 'userArtChanged repaints the shadow layer instead of baking: ' + artLine.slice(0, 160));
A.ok(!/World\.rebake\(\)/.test(artLine.replace(/else if \(typeof World\.rebake === 'function'\) World\.rebake\(\);/, '')), 'userArtChanged rebakes only on a World without the cheap invalidation');
const readyBlock = (propsSrc.split('PropRemaster.ready.then(() => {')[1] || '').split('});')[0];
A.ok(/World\.invalidatePropShadows\(\)/.test(readyBlock) && !/World\.rebake\(\);\s*$/m.test(readyBlock.replace(/else if \(typeof World\.rebake === 'function'\) World\.rebake\(\);/, '')), 'the remaster-ready refresh repaints shadows instead of baking');

A.report('static-bake-guard');
