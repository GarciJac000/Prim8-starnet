/* node test/render-still-readouts.test.js — the readouts the STILL verdict (world.js) reads from the modules that DRAW.

   Andrew, 2026-10-21 (approved): "draw 30/s while nothing on screen moves, snap back to 60 the instant anything moves".
   The verdict cannot see pixels (it never reads them back) and must not walk the scene again, so each module that draws
   something which moves on its own clock reports it, allocation-free, in one shape: the next time what it last drew
   changes — the draw's own clock while it is moving now, a later edge for a stepped animation, Infinity for static art,
   alpha-only glow and a frozen (reduced-motion) draw. "Unsure is motion" is the rule every one of them is written to.
     1. SpaceBG.nextChange — a meteor, the bolide, the belt's ember shower and fireball, a city's cars are motion; the next
        one is due; and CITY traffic covers the same ground per wall second at any draw rate (it used to move 16 ms per DRAW).
     2. PropSprites.clockNext / pulsing — every native prop draw is motion; the remaster's report is folded in; a live
        native layer and a tool-fire surge are motion; a frozen draw never counts; a sleeper's quilt breathes on an edge.
     3. ProjectionPropEffects / ApprovedSheetEffects / PropRemaster lastChange — per effect kind, on the real modules. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const noop = () => {};

// ---- 1. SpaceBG ----------------------------------------------------------------------------------------------------
const skySrc = read('frontend/app/spacebg.js');
function sky(opts = {}) {
  const images = [];
  const scratch = () => new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop: noop }), createLinearGradient: () => ({ addColorStop: noop }) },
  { get: (o, k) => k in o ? o[k] : noop, set: (o, k, v) => { o[k] = v; return true; } });
  const document = { createElement: () => { const c = { width: 0, height: 0 }, g = scratch(); c.getContext = () => g; images.push(c); return c; } };
  const mql = { matches: !!opts.reduced };
  const window = { devicePixelRatio: 1, screen: { width: 1920, height: 1080 }, matchMedia: () => mql };
  const SpaceBG = new Function('document', 'window', 'performance', skySrc + '\nreturn SpaceBG;')(document, window, undefined);
  const rects = [];
  let fs_ = '#000', frameRects = null, frameImgs = null;   // frameImgs: every image the draw blitted, in order (r.imgs)
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', set fillStyle(v) { fs_ = v; }, get fillStyle() { return fs_; },
    fillRect(x, y, w, h) { if (frameRects) frameRects.push([fs_, x, y, w, h]); }, drawImage(img) { if (frameImgs) frameImgs.push(img); }, createRadialGradient: () => ({ addColorStop: noop }) };
  return { SpaceBG, mql, draw(id, now, w = 1280, h = 720) { SpaceBG.setBackdrop(id); frameRects = []; frameImgs = []; SpaceBG.draw(ctx, w, h, now); const r = frameRects; r.imgs = frameImgs; frameRects = frameImgs = null; rects.push(r); return r; } };
}
function seeded(fn) {
  const random = Math.random; let s = 0x2545F491;
  Math.random = () => { s = Math.imul(s ^ (s >>> 15), 0x2C1B3C6D) + 0x6D2B79F5 | 0; return (s >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = random; }
}
seeded(() => {
  const s = sky();
  s.SpaceBG.setBackdrop('void');
  A.eq(s.SpaceBG.nextChange(1000), 1000, 'a sky that has not been built yet is a change in progress (now)');
  const t0 = 100000;
  s.draw('void', t0);
  const due = s.SpaceBG.nextChange(t0);
  A.ok(due >= t0 + 20000 && due <= t0 + 60000, 'THE VOID with no meteor live: the next meteor is due (+' + Math.round((due - t0) / 1000) + ' s; 20-60 s after the first draw)');
  s.draw('void', due);   // the meteor spawns on the draw at its clock
  A.eq(s.SpaceBG.nextChange(due), due, '...a meteor crossing the sky is motion (the fastest thing on screen)');
  let t = due, guard = 0;
  while (s.SpaceBG.nextChange(t) <= t && guard++ < 200) { t += 1000 / 60; s.draw('void', t); }
  const after = s.SpaceBG.nextChange(t);
  A.ok(guard < 200 && t - due >= 900 && t - due <= 1450, '...for its whole 0.9-1.4 s life (' + Math.round(t - due) + ' ms)');
  A.ok(after >= t + 45000 && after < Infinity, '...and then the next one is due (+' + Math.round((after - t) / 1000) + ' s)');
  s.mql.matches = true;
  A.eq(s.SpaceBG.nextChange(t), Infinity, 'under reduced motion no meteor is added, so nothing is due');
  s.mql.matches = false;
  s.SpaceBG.setBackdrop('nursery');
  A.eq(s.SpaceBG.nextChange(t + 10), t + 10, 'a backdrop switch not yet built (or still baking off-thread) is a change in progress');
  s.draw('nursery', t + 20);
  A.ok(s.SpaceBG.nextChange(t + 20) > t + 20, 'THE NURSERY carries the same weather (a meteor is due)');
  // OCEAN (final fixes 10-21): the water STEPS — draw() swaps its wave plate every 340 ms — so the next plate edge is due (the
  // swell's slide, the glitter and the clouds stay ambient drift); proven on the draw itself: the plate it blits changes exactly there
  s.draw('ocean', t + 30); s.draw('ocean', t + 40);
  const oNow = t + 40, edge = s.SpaceBG.nextChange(oNow);
  A.ok(edge > oNow && edge - oNow <= 340 && edge % 340 === 0, 'ocean: the next wave-plate edge is due (+' + Math.round(edge - oNow) + ' ms, on the 340 ms plate clock), never Infinity');
  const plate = tq => s.draw('ocean', tq).imgs[0];
  A.ok(plate(edge - 1) === plate(oNow) && plate(edge) !== plate(edge - 1), '...and the plate the draw blits changes exactly at that edge (not before it)');
  A.eq(s.SpaceBG.nextChange(edge), edge + 340, '...then the edge after it');
  A.eq(s.SpaceBG.nextChange(edge + 100), edge + 340, '...between edges, the coming one');
  s.mql.matches = true;
  A.eq(s.SpaceBG.nextChange(edge + 100), Infinity, '...under reduced motion the water holds plate 0: nothing due');
  A.ok(plate(edge + 100) === plate(edge + 500), '(and the draw really holds one plate then)');
  s.mql.matches = false;
  // NIGHT CITY's cars are separate objects crossing the screen, never drift (review 10-21: they were classed as ambient, so a
  // city floor drew them at 30/s): a city sky with traffic driving is changing on every draw
  s.draw('city', t + 30); s.draw('city', t + 40);
  A.eq(s.SpaceBG.nextChange(t + 40), t + 40, 'city: the cars driving the arterials are motion (now), so the city sky never goes still');
  A.eq(s.SpaceBG.nextChange(t + 40 + 3600000), t + 40 + 3600000, '...on every frame, however long the floor has stood still');
  s.mql.matches = true;
  A.eq(s.SpaceBG.nextChange(t + 50), Infinity, '...while reduced motion holds every car still, only the ambient layers are left: nothing due');
  s.mql.matches = false;
  s.draw('belt', t + 50); s.draw('belt', t + 60);
  A.eq(s.SpaceBG.nextChange(t + 60), t + 60, "THE BELT's ember shower is always crossing (300-780 px/s): motion");
});
// ANDROMEDA (the 2nd pick in the menu) draws the same meteor and bolide: the same lifecycle as THE VOID (review 10-21: it
// had no readout, so a meteor crossing it was drawn at the still pace and the next one was never due)
seeded(() => {
  const s = sky();
  const t0 = 200000;
  s.draw('galaxy', t0);
  const due = s.SpaceBG.nextChange(t0);
  A.ok(due >= t0 + 20000 && due <= t0 + 60000, 'ANDROMEDA with no meteor live: the next meteor is due (+' + Math.round((due - t0) / 1000) + ' s)');
  const r = s.draw('galaxy', due);
  A.ok(r.some(([f]) => /^rgba\(220,230,255,/.test(f)), '(the meteor spawned and drew on the draw at its clock)');
  A.eq(s.SpaceBG.nextChange(due), due, '...a meteor crossing ANDROMEDA is motion');
  let t = due, guard = 0;
  while (s.SpaceBG.nextChange(t) <= t && guard++ < 200) { t += 1000 / 60; s.draw('galaxy', t); }
  const after = s.SpaceBG.nextChange(t);
  A.ok(guard < 200 && t - due >= 900 && t - due <= 1450, '...for its whole life (' + Math.round(t - due) + ' ms)');
  A.ok(after >= t + 45000 && after < Infinity, '...and then the next one is due (+' + Math.round((after - t) / 1000) + ' s)');
});
// RATCHET: a backdrop that draws the weather must report it. (a) source: every *_BG whose draw calls drawMeteor/drawBolide
// defines nextChange; (b) live: on every backdrop in the menu, a draw that painted a meteor or the bolide reports `now`.
{
  const starts = [...skySrc.matchAll(/const (\w+_BG) = \{/g)];
  A.ok(starts.length >= 6, '(found ' + starts.length + ' backdrop blocks)');
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : skySrc.indexOf('const BACKDROPS = {');
    const block = skySrc.slice(starts[i].index, end);
    if (/draw(Meteor|Bolide)\(ctx/.test(block)) A.ok(/\n {4}nextChange[:(]/.test(block), starts[i][1] + ' draws the meteor/bolide, so it defines nextChange (the STILL readout)');
  }
  const ids = sky().SpaceBG.list().map(b => b.id);
  A.ok(ids.length >= 6, '(the menu lists ' + ids.length + ' backdrops)');
  for (const id of ids) seeded(() => {
    const s = sky(), t0 = 300000, weather = r => r.some(([f]) => /^rgba\((220,230,255|240,255,250),/.test(f));
    s.draw(id, t0);                                    // arms the meteor (20-60 s) and bolide (30 min-3 h) clocks
    const tm = t0 + 61000, tb = t0 + 181 * 60000;
    const m = s.draw(id, tm), mNext = s.SpaceBG.nextChange(tm);
    const b = s.draw(id, tb), bNext = s.SpaceBG.nextChange(tb);
    A.ok((!weather(m) || mNext === tm) && (!weather(b) || bNext === tb),
      id + ': a draw that painted a meteor or the bolide reports motion (' + (weather(m) || weather(b) ? 'weather drawn' : 'no weather') + ')');
  });
}
seeded(() => {
  const s = sky({ reduced: true });
  s.draw('belt', 5000); s.draw('belt', 5017);
  A.eq(s.SpaceBG.nextChange(5017), Infinity, '...a belt built under reduced motion has no shower and no fireball: nothing due');
});
{
  // CITY traffic: the same wall time at 30, 60 and 144 draws/s puts every car in the same place
  const runAt = hz => seeded(() => { const s = sky(); let last = null; for (let f = 0; f <= 2 * hz; f++) last = s.draw('city', 50000 + f * 1000 / hz); return last; });
  const cars = r => r.filter(([, , , w, h]) => (w === 2 && h === 1) || (w === 1 && h === 2));
  const at60 = cars(runAt(60)), at30 = cars(runAt(30)), at144 = cars(runAt(144));
  const first = cars(seeded(() => sky().draw('city', 50000)));
  const same = (a, b) => a.length === b.length && a.every((r, i) => Math.abs(r[1] - b[i][1]) < 1e-6 && Math.abs(r[2] - b[i][2]) < 1e-6);
  A.ok(at60.length > 5 && !same(at60, first), 'CITY: the cars drive (' + at60.length + ' on screen, moved in 2 s)');
  A.ok(same(at60, at30), '...and after 2 s at 30 draws/s every car is exactly where it is at 60 (time-based, not per draw)');
  A.ok(same(at60, at144), '...and at 144 draws/s too');
  A.ok(/car\.u \+= car\.spd \/ 1000 \* cityStep;/.test(skySrc) && /const cityStep = cityDt \* \(16 \* 60 \/ 1000\);/.test(skySrc),
    '...advancing by the elapsed time at the 16-per-60 Hz-frame rate the shipped look was tuned at');
}

// ---- 2. PropSprites ------------------------------------------------------------------------------------------------
const psSrc = read('frontend/app/propsprites.js');
const utilSrc = read('frontend/js/util.js');
const U = new Function(utilSrc + '; return U;')();
const recorder = () => new Proxy({}, { get: (o, k) => k in o ? o[k] : (k === 'measureText' ? () => ({ width: 0 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : k === 'getTransform' ? () => ({ a: 1 }) : noop),
  set: (o, k, v) => { o[k] = v; return true; } });
function props(remaster, industrial) {
  const window = { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) };
  const document = { addEventListener: noop, documentElement: { style: { setProperty: noop } }, createElement: () => ({ getContext: () => null, style: {} }) };
  return new Function('window', 'document', 'U', 'PropRemaster', 'IndustrialTextures', psSrc + '\nreturn PropSprites;')(window, document, U, remaster, industrial);
}
{
  const PS = props(undefined);   // no remaster loaded (classic textures, a failed load): every prop is its native draw
  PS.setCtx(recorder());
  PS.setNow(1000); PS.clockBegin();
  A.eq(PS.clockNext(), Infinity, 'clockBegin: nothing drawn yet, nothing moving');
  PS.draw({ t: 'crate', x: 3, y: 3, w: 1, h: 1, id: 'c1' }, false);
  A.eq(PS.clockNext(), 1000, 'a NATIVE prop draw runs on its own clock: motion (unsure is motion — even a crate)');
  PS.setNow(0); PS.clockBegin(); PS.draw({ t: 'fishtank', x: 3, y: 3, w: 2, h: 1, id: 'f1' }, false);
  A.eq(PS.clockNext(), Infinity, 'a draw with the clock frozen (now = 0: a shadow silhouette) never counts');
  PS.setNow(2000); PS.clockBegin();
  A.eq(PS.pulsing(2000), false, 'no harness pulse: nothing decaying');
  PS.pulseProp('cab1', 'cabinet', true);
  A.ok(PS.pulsing(2000) && PS.pulsing(2899) && !PS.pulsing(2900), "a capability prop's tool-fire surge decays for 900 ms (PULSE_MS)");
  PS.setNow(3000); PS.pulseConnector('mcp1');
  A.ok(PS.pulsing(3500) && !PS.pulsing(3900), "a connector's packet pulse");
  PS.setNow(4000); PS.pulseWorkbench(false, 'wb1');
  A.ok(PS.pulsing(4100) && !PS.pulsing(4900), "a workbench's per-instance shell/verify flash");
  PS.setNow(5000); PS.pulseWorkbench(true);
  A.ok(PS.pulsing(5800) && !PS.pulsing(5900), "the global workbench flash");
  // O(1) (final fixes 10-21): pulsing() reads one stamp — no walk of connState, which goes dictionary-mode once
  // reconcileConnectors deletes from it (a for-in over it built a key list every frame)
  PS.setNow(6000); for (let i = 0; i < 40; i++) PS.pulseConnector('mcp' + i);
  PS.setNow(6200); PS.pulseProp('cab9', 'cabinet', false); PS.reconcileConnectors(['mcp3']);
  A.ok(PS.pulsing(7099) && !PS.pulsing(7100), 'the latest of many pulses (40 connectors, then a surge) holds it for its full 900 ms, and no longer');
  PS.setNow(8000); PS.pulseConnector('mcp3'); PS.setNow(8100); PS.pulseWorkbench(true, 'wbX');
  A.ok(PS.pulsing(8999) && !PS.pulsing(9000), '...each kind of pulse stamps it (a connector packet, then a workbench flash)');
  const PS0 = props(undefined); PS0.setNow(0); PS0.pulseProp('cab0', 'cabinet', true);
  A.ok(!PS0.pulsing(100), 'a pulse fired with the clock frozen (now = 0) never counts, as before');
  const pulsingSrc = (psSrc.match(/function pulsing\(t\) \{[^\n]*\}/) || [''])[0];
  A.ok(/^function pulsing\(t\) \{ return lastPulseAt > 0 && t - lastPulseAt < PULSE_MS; \}$/.test(pulsingSrc), 'pulsing() is one comparison: no map walk, no allocation per frame (' + pulsingSrc.length + ' chars)');
  A.ok(['function pulseConnector(id)', 'function pulseWorkbench(ok, id)', 'function pulseProp(id, cap, ok)'].every(h => /notePulse\(\);/.test(A.fnBody(psSrc, h))),
    '...every pulse writer stamps it (notePulse)');
  // the occupied quilt's breath: the next crossing of sin(t / 2000) > 0.2, computed
  PS.setNow(7777); PS.clockBegin(); PS.drawOver({ t: 'bunk', x: 2, y: 2, w: 2, h: 3 });
  const edge = PS.clockNext(), on = t => Math.sin(t / 2000) > 0.2;
  let flips = 0; for (let t = 7777; t < edge - 1; t += 5) if (on(t) !== on(7777)) flips++;
  A.ok(edge > 7777 && edge < 7777 + 4 * Math.PI * 1000 && !flips && on(edge - 1) !== on(edge + 1),
    "a sleeper's quilt (native drawOver) is due at its next breath edge (+" + Math.round(edge - 7777) + ' ms), not every frame');
}
{
  // the remaster wrapper: what PropRemaster reports for itself is the prop's clock
  const stub = { ret: true, change: Infinity, native: false, calls: 0 };
  const PR = { draw(ctx, id, facing, x, y, w, h, state, paintNative) { stub.calls++; stub.state = state; if (stub.native && paintNative) paintNative(ctx); return stub.ret; },
    lastChange: () => stub.change, ready: Promise.resolve(), revision: () => 0, enabled: () => false, isProjection: () => false,
    viewGeometry: () => null, drawForeground: () => false, hitTest: () => null, emitter: () => null, screenEmission: () => null };
  const PS = props(PR);
  PS.setCtx(recorder());
  const drawAt = (t, f, work, live) => { PS.setNow(t); PS.clockBegin(); PS.draw(Object.assign({ x: 3, y: 3, w: 2, h: 1, id: 'p1' }, f), work, live); return PS.clockNext(); };
  A.eq(drawAt(1000, { t: 'desk' }), Infinity, 'a remastered prop whose art is static reports Infinity');
  A.ok(stub.calls === 1 && stub.state.now === 1000, '(the remaster drew it, on the frame clock)');
  stub.change = 1050;
  A.eq(drawAt(1000, { t: 'desk' }), 1050, "...a stepped remaster layer reports its next edge (an occupied screen's beam)");
  stub.change = 1000;
  A.eq(drawAt(1000, { t: 'fishtank' }), 1000, '...a moving remaster overlay is motion');
  stub.change = Infinity; stub.native = true;
  A.eq(drawAt(1000, { t: 'tank' }), 1000, '...a native layer painted into the remaster on the live clock is motion');
  A.eq(drawAt(1000, { t: 'tank' }, false, { still: true }), Infinity, '...and frozen under reduced motion (still) it is not');
  stub.native = false; stub.ret = false;
  A.eq(drawAt(1000, { t: 'desk' }), 1000, '...a prop the remaster declines (a custom box) falls back to its native draw: motion');
  stub.ret = true;
  PS.setNow(2000); PS.pulseProp('p1', 'dish', true);
  A.eq(drawAt(2300, { t: 'comms_dish' }), 2300, "...a tool-fire surge drawn on a static prop is motion while it decays");
  A.eq(drawAt(3100, { t: 'comms_dish' }), Infinity, '...and static again once it has');
  const row = PS.registerUserProp({ id: 'user_lamp_01', label: 'lamp', footprint: { w: 1, h: 1 } });
  A.ok(row && row.user, '(a player-made prop registers)');
  A.eq(drawAt(4000, { t: 'user_lamp_01', w: 1, h: 1 }), Infinity, 'a player-made prop is its art: static unless the remaster reports otherwise');
  stub.ret = false;
  A.eq(drawAt(4000, { t: 'user_lamp_01', w: 1, h: 1 }), Infinity, '...its placeholder is static too');
}

{
  // a native draw that hands its whole body to IndustrialTextures knows its clock exactly (the shipped desk is drawn this way:
  // its 2x1 catalog box is not the 3x1 authored view, so the remaster declines it and F.desk's workstation art paints it)
  const it = { next: Infinity, calls: 0, isRemaster: () => true, enabled: () => true,
    workstation(ctx, x, y, w, h, facing, state) { it.calls++; it.state = state; return true; }, workstationNext: () => it.next,
    chair: () => true, crate: () => true, furniture: () => true, propPanel: noop, ready: Promise.resolve(), lighting: () => null };
  const PS = props(undefined, it);
  PS.setCtx(recorder());
  const drawAt = (t, f, work, live) => { PS.setNow(t); PS.clockBegin(); PS.draw(Object.assign({ x: 3, y: 3, w: 2, h: 1, id: 'd1' }, f), work, live); return PS.clockNext(); };
  A.eq(drawAt(1000, { t: 'desk' }), Infinity, "the workstation art (IndustrialTextures) of a vacant desk is its static plate: not motion");
  A.ok(it.calls === 1 && it.state.now === 1000, '(F.desk handed its body to IndustrialTextures.workstation, on the frame clock)');
  it.next = 1050;
  A.eq(drawAt(1000, { t: 'desk2' }), 1050, "...an occupied desk's screen sweep steps every 175 ms: its next edge is due");
  A.eq(drawAt(1000, { t: 'seatchair', w: 1 }), Infinity, '...a chair (IndustrialTextures art) is static');
  A.eq(drawAt(1000, { t: 'crate', w: 1 }), Infinity, '...so is a crate');
  A.eq(drawAt(1000, { t: 'bridge_consolebank', w: 9 }), Infinity, '...and the bridge furniture');
  A.eq(drawAt(1000, { t: 'lavalamp', w: 1 }), 1000, '...while a native draw that does not say is still motion');
  const itSrc = read('frontend/app/industrialtextures.js');
  A.ok(/const t = Math\.max\(0, Number\(state && state\.now\) \|\| 0\); wsChangeAt = t > 0 \? \(Math\.floor\(t \/ 175\) \+ 1\) \* 175 : Infinity;/.test(itSrc)
    && /function workstation\(ctx, x, y, w, h, facing = 's', state\) \{\s*wsChangeAt = Infinity;/.test(itSrc) && /workstationNext: \(\) => wsChangeAt/.test(itSrc),
    "IndustrialTextures.workstation reports its sweep's next 175 ms edge only while it draws the sweep (occupied, not still)");
}

// ---- 3. the overlay modules ----------------------------------------------------------------------------------------
{
  const fx = require('../frontend/app/projection-prop-effects.js');
  const ctx = recorder();
  const last = (id, state) => {
    const b = fx.classify(id, 's').binding;
    A.ok(fx.draw(ctx, id, 's', { x: 10, y: 20, width: 24, height: 30, sourceWidth: b.width, sourceHeight: b.height }, state), id + ' draws');
    return fx.lastChange();
  };
  A.eq(last('console', { now: 5000, occupied: true }), 5000, "projection: an occupied workstation's sweep line moves");
  A.eq(last('console', { now: 5000, occupied: false }), Infinity, '...a vacant one is a static dark slab');
  A.eq(last('console', { now: 5000, occupied: true, still: true }), Infinity, '...and frozen under reduced motion');
  A.eq(last('ticker', { now: 5000 }), 5000, "...a ticker's ambient screen sweeps all the time: motion");
  for (const id of ['fishtank', 'lavalamp', 'plasmaglobe', 'incubator', 'tank']) A.eq(last(id, { now: 5000 }), 5000, '...' + id + ' moves on its clock (motion)');
  A.eq(last('coffee', { now: 3400 * 2 + 1700 }), 3400 * 2 + 1700, '...steam rising is motion');
  const between = 3400 * 2 + 3400 * 0.9;
  A.ok(Math.abs(last('coffee', { now: between }) - 3400 * 3) < 1e-6, '...between puffs the next puff is due (+' + Math.round(3400 * 3 - between) + ' ms)');
  for (const id of ['treasury_pnl_holo', 'holopet', 'cryopod', 'arc_floorlight', 'desklamp']) A.eq(last(id, { now: 5000 }), Infinity, '...' + id + ' is alpha-only glow or a steady light: ambient');
  A.eq(last('intake', { now: 5000, work: true }), Infinity, "...a worked lamp's pulse is alpha-only glow (the work itself is the prop pass's motion)");
  A.eq(last('speaker', { now: 5000, work: true }), 5000, "...a worked speaker's cone throbs: motion");
  A.eq(last('trophycase', { now: 5000, trophies: 3 }), Infinity, '...earned trophies are static marks');
  for (const id of fx.ids) A.eq(last(id, { now: 98765, still: true, occupied: true, work: true, scanning: true, live: true }), Infinity, id + ' is frozen under reduced motion');
}
{
  const ase = require('../frontend/app/approved-sheet-effects.js');
  const ctx = recorder();
  const last = (id, state) => { A.ok(ase.draw(ctx, id, { x: 0, y: 0, width: 20, height: 20, sourceWidth: 64, sourceHeight: 64 }, state), id + ' draws'); return ase.lastChange(); };
  A.eq(last('fishtank', { now: 5000 }), 5000, 'approved sheet: the fish swim (motion)');
  A.eq(last('lavalamp', { now: 5000 }), 5000, '...the wax drifts');
  A.eq(last('plasmaglobe', { now: 1000 }), 1140, "...plasma lights its next branch every 190 ms: the next step is due");
  A.ok(Math.abs(last('steamvent', { now: 3400 * 0.9 }) - 3400) < 1e-6, '...between puffs the next puff is due');
  A.eq(last('steamvent', { now: 3400 * 0.5 }), 1700, '...a puff rising is motion');
  for (const id of ['cryopod', 'terrarium', 'etsy_kiln', 'research_samplecart']) A.eq(last(id, { now: 5000 }), Infinity, '...' + id + ' is alpha-only glow');
  A.eq(last('jukebox', { now: 5000, live: true }), Infinity, '...a live jukebox glows (alpha-only)');
  for (const id of ase.ids) A.eq(last(id, { now: 5000, still: true, work: true, live: true }), Infinity, id + ' is frozen under reduced motion');
}

// ---- 4. PropRemaster, the real renderer on real pixel buffers (the prop-remaster-recovery fixture's shape) -----------
(async () => {
  const Canvas = require('@napi-rs/canvas');
  const source = read('frontend/app/propremaster.js');
  const view = (image, extra) => Object.assign({ image, sourceWidth: 8, sourceHeight: 8, footprint: { w: 1, h: 1 }, bounds: { x: 0, y: 0, width: 12, height: 12 }, mode: 'static' }, extra);
  const views = {
    still_box: view('still_box.png'),
    crt_box: view('crt_box.png', { mode: 'screen', screenPower: 'occupied' }),
    scan_box: view('scan_box.png', { mode: 'scanner', motion: { region: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] } }),
  };
  const props = {}, geometry = {};
  for (const [id, spec] of Object.entries(views)) { props[id] = { views: { s: spec } }; geometry[id + ':s'] = { image: spec.image, width: 8, height: 8, crop: { x: 0, y: 0, width: 8, height: 8 } }; }
  class Image { constructor() { const c = Canvas.createCanvas(8, 8), g = c.getContext('2d'); g.fillStyle = 'rgb(30,200,210)'; g.fillRect(0, 0, 8, 8);
    Object.defineProperty(c, 'src', { set() { queueMicrotask(() => c.onload && c.onload()); } }); return c; } }
  const document = { documentElement: { dataset: {} }, createElement() { const c = Canvas.createCanvas(1, 1); c.addEventListener = noop; c.removeEventListener = noop; return c; } };
  const scope = { module: { exports: {} }, console, URLSearchParams, location: { search: '?propSet=approved' }, Image, ImageData: Canvas.ImageData,
    performance: { now: () => 1000 }, Date, setTimeout, clearTimeout, queueMicrotask, document, IndustrialTextures: { isRemaster: () => true },
    fetch: async url => ({ ok: true, json: async () => url.endsWith('runtime-geometry.json') ? { version: 1, views: geometry } : { version: 1, props } }) };
  vm.runInNewContext(source, scope);
  const PR = scope.module.exports; await PR.ready;
  A.eq(PR.status().failures.length, 0, 'remaster fixture artwork loaded');
  const g = Canvas.createCanvas(72, 72).getContext('2d');
  const last = (id, state) => { A.ok(PR.draw(g, id, 's', 0, 0, 12, 12, state, noop), id + ' draws through the real renderer'); return PR.lastChange(); };
  A.eq(last('still_box', { now: 1000, work: true }), Infinity, 'remaster: static authored art reports Infinity');
  A.eq(last('crt_box', { now: 1000, occupied: true }), 1050, "...an occupied screen's beam steps every 350 ms: its next phase edge is due");
  A.eq(last('crt_box', { now: 1000, occupied: false }), Infinity, '...a vacant screen is its dark plate');
  A.eq(last('crt_box', { now: 1000, occupied: true, still: true }), Infinity, '...and the beam is frozen under reduced motion');
  A.eq(last('scan_box', { now: 1000, scanning: true }), 1050, '...a scanning reader steps a frame every 75 ms (900 / 12): the next is due');
  A.eq(last('scan_box', { now: 1000, scanning: false }), Infinity, '...an idle reader is static');
  A.ok(/if\(ApprovedSheetEffects\.lastChange\)changeAt=Math\.min\(changeAt,ApprovedSheetEffects\.lastChange\(\)\);/.test(source)
    && /if\(ProjectionPropEffects\.lastChange\)changeAt=Math\.min\(changeAt,ProjectionPropEffects\.lastChange\(\)\);/.test(source),
    '...and folds in what its approved-sheet and projection overlays report');
  A.ok(/if\(ct>0&&\(v\.mode==='content'\|\|v\.mode==='machine'&&!e\.lost\|\|v\.mode==='service'&&!\(state&&state\.still\)\)\)changeAt=ct;/.test(source),
    '...an authored content / machine / service layer is motion (unknown motion is motion)');
  A.report('render still readouts (sky, props, overlays, remaster)');
})().catch(e => { console.error(e); process.exitCode = 1; });
