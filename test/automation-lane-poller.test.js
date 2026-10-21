/* node test/automation-lane-poller.test.js — the GOAL LOOPS lane keeps ONE /api/loops poller per AUTOMATION window body
   (idle CPU piece 3, 2026-10-20).

   THE LEAK. StationUI re-renders a window by running its builder again on the SAME connected body (AWAY WORK's openAway =
   openTerm + rerender, a roster change, "AUTOMATION › section" while the window is open). windows/loops.js armed a NEW
   4 s setInterval(refresh) in every wire() and the old one only died once the body left the DOM, so each re-render added
   a permanent /api/loops poller (and kept the previous render's closures alive) for as long as the window stayed open.

   GENUINE (executed): the REAL windows/loops.js runs in a vm with a permissive stub DOM; the lane registered with the
   AutomationWindow stub is built and wired six times on one body, the way re-renders do. Exactly one 4 s poller may be
   live; the body leaving the DOM ends it. A minimized window keeps polling, as on trunk. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/windows/loops.js'), 'utf8');

// any element: unknown methods return another element, lists are empty, nothing is ever a thenable
function el(extra) {
  const o = Object.assign({ isConnected: true, dataset: {}, style: {}, value: '', hidden: false, disabled: false, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, extra || {});
  return new Proxy(o, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol' || k === 'then' || k === 'toJSON') return undefined;
      if (k === 'querySelectorAll') return () => [];
      if (k === 'getClientRects') return () => [{}];
      return () => el();
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

const live = new Map();   // interval id -> { fn, ms }
let seq = 0, getCalls = 0;
const lanes = [];
const ctx = vm.createContext({
  window: {}, console,
  localStorage: { getItem: () => null, setItem() {} },
  document: { querySelector: () => null, createElement: () => el(), activeElement: null },
  StationUI: { h: { present: [{ id: 'agent', name: 'Agent' }], sel: 0, esc: s => String(s), sfx() {}, notify() {}, fmtRel: () => '', consoleSection: {} } },
  AutomationWindow: { registerLane: fn => lanes.push(fn) },
  Harness: { api: { get: async () => { getCalls++; return { loops: [] }; } } },
  fetch: async () => ({ ok: true, json: async () => ({ loops: [] }) }),
  setInterval: (fn, ms) => { const id = ++seq; live.set(id, { fn, ms }); return id; },
  clearInterval: id => { live.delete(id); },
  setTimeout: () => 0, clearTimeout() {},
  JSON, Math, Number, Object, Array, Set, Map, String, Promise, Error, isFinite, AbortController
});
vm.runInContext(src, ctx, { filename: 'windows/loops.js' });
A.eq(lanes.length, 1, 'the GOAL LOOPS lane registers with the AUTOMATION window');

const lanePollers = () => [...live.entries()].filter(([, t]) => t.ms === 4000);
const settle = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };
(async () => {
const body = el();
const RENDERS = 6;
for (let i = 0; i < RENDERS; i++) {
  const lane = lanes[0](body);
  A.ok(lane && typeof lane.wire === 'function', 'render ' + (i + 1) + ': the lane builds');
  lane.wire();
  A.eq(lanePollers().length, 1, 'after render ' + (i + 1) + ' of one AUTOMATION body: exactly ONE 4 s /api/loops poller (it was one per render)');
}
A.eq(live.size, 1, RENDERS + ' renders leave no other interval behind');

// the live poller is this render's: it reads the station
await settle();
const before = getCalls;
lanePollers()[0][1].fn();
await settle();
A.ok(getCalls > before, 'the surviving poller still refreshes the window');

// a second, separate window body has its own poller
const other = el();
lanes[0](other).wire();
A.eq(lanePollers().length, 2, 'a different window body owns its own poller');

// the window closes: its body leaves the DOM and the next beat clears the poller
body.isConnected = false;
const mine = lanePollers().find(([id]) => id === body.__lpPoll) || lanePollers()[0];
mine[1].fn();
A.eq(lanePollers().length, 1, 'a body that left the DOM ends its poller on the next beat');
A.ok(!body.__lpPoll, 'and forgets it');

/* a window minimized to the strip keeps polling, as on trunk: StationUI keeps its body connected (display:none), and only
   the body leaving the DOM ends the poller */
const mBody = el({ getClientRects: () => [] });
lanes[0](mBody).wire();
await settle();
const mPoll = lanePollers().find(([id]) => id === mBody.__lpPoll);
A.ok(mPoll, 'a minimized window keeps its 4 s poller');
const atMin = getCalls;
mPoll[1].fn(); await settle();
A.ok(getCalls > atMin, 'a minimized window still reads /api/loops on its beat, as on trunk');

A.report('automation-lane-poller.test');
})().catch(e => { console.error(e); process.exit(1); });
