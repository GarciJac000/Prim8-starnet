/* skinstage-idle-loop.test.js — the skin preview's animation loop must not outlive what it animates.
   sweep/world 2026-10-20, live after a fresh WAKE: the create screen's skin stage kept a 60fps
   requestAnimationFrame loop running behind the station for the whole session (~54 callbacks/s from
   skinstage.js, the same rate as the world renderer), because tick() re-armed rAF unconditionally and the
   create screen's <img> stays in the DOM (hidden, never disconnected). The module promised "a closed
   panel/modal costs nothing". Locks: while no stage is on screen the loop stops spending animation frames
   (a slow visibility poll may remain so a re-shown stage resumes without a re-mount), once every stage has
   left the DOM the loop ends outright, and a visible stage still animates on rAF. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'skinstage.js'), 'utf8');

function harness() {
  const raf = [], timers = [];
  let now = 0;
  const ctx = {
    console,
    performance: { now: () => now },
    requestAnimationFrame: fn => { raf.push(fn); return raf.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Image: function () { this.complete = true; this.src = ''; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sprites: { 'x.walk.south': ['x/a.png', 'x/b.png', 'x/c.png'] } }) }),
    DATA: { SKINS: { s1: { set: 'x', name: 'S1' } } },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.SkinStage = SkinStage;', ctx);
  // drive whichever callback is pending (rAF first, then timers); returns what fired
  const step = (dt) => {
    now += dt || 16;
    if (raf.length) { const fn = raf.shift(); fn(now); return 'raf'; }
    if (timers.length) { const t = timers.shift(); t.fn(); return 'timer'; }
    return null;
  };
  return { ctx, raf, timers, step, pending: () => raf.length + timers.length };
}

(async () => {
  // 1. a visible stage animates on rAF
  {
    const h = harness();
    const img = { isConnected: true, offsetParent: {}, src: '' }, name = { textContent: '' };
    h.ctx.SkinStage.mount(img, name, 's1');
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    const seen = new Set();
    for (let i = 0; i < 40; i++) { A.eq(h.step(16), 'raf', 'a visible stage is driven by animation frames (step ' + i + ')'); seen.add(img.src); }
    A.ok(seen.size > 1, 'a visible stage actually walks through its frames');
  }
  // 2. a hidden-but-connected stage (the create screen after WAKE) must not burn animation frames
  {
    const h = harness();
    const img = { isConnected: true, offsetParent: {}, src: '' };
    h.ctx.SkinStage.mount(img, null, 's1');
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    h.step(16);
    img.offsetParent = null;                       // the screen hides; the <img> stays in the DOM
    let rafs = 0;
    for (let i = 0; i < 60; i++) { if (h.step(16) === 'raf') rafs++; }
    A.ok(rafs <= 2, 'a hidden stage stops re-arming requestAnimationFrame (' + rafs + ' rAF callbacks in 60 steps)');
    A.ok(h.timers.every(t => t.ms >= 200), 'any idle visibility poll is slow (>=200ms), not a frame loop');
    img.offsetParent = {};                         // shown again WITHOUT a re-mount (a restored window)
    let back = 0;
    for (let i = 0; i < 6; i++) { if (h.step(250) === 'raf') back++; }
    A.ok(back > 0, 'a re-shown stage resumes animating without a re-mount');
  }
  // 3. once every stage has left the DOM, the loop ends outright
  {
    const h = harness();
    const img = { isConnected: true, offsetParent: {}, src: '' };
    h.ctx.SkinStage.mount(img, null, 's1');
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    h.step(16);
    img.isConnected = false;
    for (let i = 0; i < 5; i++) h.step(16);
    A.eq(h.pending(), 0, 'no rAF or timer remains once no stage is mounted');
    // and a later mount starts it again
    const img2 = { isConnected: true, offsetParent: {}, src: '' };
    h.ctx.SkinStage.mount(img2, null, 's1');
    await new Promise(r => setImmediate(r));
    A.ok(h.pending() > 0, 'a new mount restarts the loop after it ended');
  }
  A.report('skinstage-idle-loop.test');
})();
