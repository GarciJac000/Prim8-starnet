/* node test/outbox-crate-memo.test.js — the OUTBOX crate read stays O(1) per frame (perf, 2026-10-20).

   world.js asks outboxCrateMap() on every drawn frame. Its memo key read ReturnStore.pendingCount(), which ran
   Returns.hydrate(state) — a filter of the pending ledger, a Set, and a filter of up to 10k digested ids — 60 times a
   second, ~0.3 ms and up to 78 KB of garbage per frame on a long-lived ledger. The store's state is ALWAYS hydrated
   (every assignment goes through Returns.*), so the count is just state.pending.length, and the store now carries a
   revision() that moves on every state change. Keying the memo on that revision also fixes a stale map: keyed on the
   COUNT, a crate resolved and another folded between two frames left each chute showing the old line's crates. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Returns = require('../frontend/app/returns.js');

/* ---- returnstore.js: pendingCount is free, revision() moves on every state change ---- */
{
  const code = fs.readFileSync(path.join(__dirname, '../frontend/app/returnstore.js'), 'utf8') + '\nthis.store = ReturnStore;';
  let hydrates = 0, saved = JSON.stringify({ lastSeenAt: 1000, pending: [{ runId: 'r0', ts: 900, streamId: 's0' }] }), heartbeat = null;
  const counted = Object.assign({}, Returns, { hydrate: raw => { hydrates++; return Returns.hydrate(raw); } });
  const ctx = vm.createContext({ Returns: counted, Date,
    localStorage: { getItem: () => saved, setItem: (_, v) => { saved = v; }, removeItem: () => { saved = null; } },
    window: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: fn => { heartbeat = fn; return 1; }, clearInterval() {} });
  vm.runInContext(code, ctx);
  const st = ctx.store;
  A.ok(typeof st.revision === 'function', 'ReturnStore exports revision()');
  const r0 = st.revision();
  st.init({ enabled: false });
  const r1 = st.revision();
  A.ok(r1 > r0, 'init (hydrate + first heartbeat) moves the revision');
  // the read the frame loop makes: no hydrate, ever
  hydrates = 0;
  let n = 0; for (let i = 0; i < 100; i++) n = st.pendingCount();
  A.eq(hydrates, 0, '100 pendingCount() reads run Returns.hydrate 0 times (it ran once per read before)');
  A.eq(n, 1, '…and still answer the true count');
  A.eq(st.revision(), r1, 'reads never move the revision');
  st.pendingRows();
  A.eq(st.revision(), r1, 'pendingRows() is a read too');
  // every state change moves it — and the cheap count always agrees with the engine's own count of the persisted ledger
  const agrees = () => st.pendingCount() === Returns.pendingCount(JSON.parse(saved));
  let rev = st.revision();
  A.ok(st.foldRow({ runId: 'r1', agentId: 'nova', ts: 2000, streamId: 's1' }), 'foldRow lands a crate');
  A.ok(st.revision() > rev && agrees() && st.pendingCount() === 2, 'foldRow moves the revision (count 2)'); rev = st.revision();
  heartbeat();
  A.ok(st.revision() > rev && agrees(), 'a heartbeat moves the revision'); rev = st.revision();
  st.resolve('r0');
  A.ok(st.revision() > rev && agrees() && st.pendingCount() === 1, 'resolve moves the revision (count 1)'); rev = st.revision();
  st.foldRow({ runId: 'r2', agentId: 'nova', ts: 2100, streamId: 's2' }); st.foldRow({ runId: 'r3', agentId: 'nova', ts: 2200 });
  rev = st.revision();
  st.resolveAll(['r1', 'r2']);
  A.ok(st.revision() > rev && agrees() && st.pendingCount() === 1, 'resolveAll moves the revision (count 1)'); rev = st.revision();
  st.reset();
  A.ok(st.revision() > rev && st.pendingCount() === 0, 'reset moves the revision and empties the count');
  // the six state writes all go through one setter (a missed site would leave the revision stale)
  const src = fs.readFileSync(path.join(__dirname, '../frontend/app/returnstore.js'), 'utf8');
  A.eq((src.match(/(?<!let )\bstate = /g) || []).length, 1, 'returnstore.js assigns `state` in exactly one place (setState)');
}

/* ---- world.js outboxCrateMap: memoized on the store revision, never on the count ---- */
{
  const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
  const from = world.indexOf('  function returnCrates() {'), to = world.indexOf('  function pollLineJobStreams() {');
  A.ok(from > 0 && to > from && to - from < 4000, 'world.js carries returnCrates + outboxCrateMap together');
  let rev = 1, rows = [], rowReads = 0, countReads = 0;
  const ReturnStore = {
    revision: () => rev,
    pendingCount: () => { countReads++; return rows.length; },
    pendingRows: () => { rowReads++; return rows.map(r => Object.assign({}, r)); }
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('ReturnStore', 'geo', 'routingPlan', world.slice(from, to) +
    '\nreturn { map: outboxCrateMap, setJoin(j) { lineJobStream = j; } };')(ReturnStore,
    { props: [{ id: 'ob1', t: 'outbox' }, { id: 'ob2', t: 'outbox' }] },
    { lineOfProp: { ob1: 'L1', ob2: 'L2' } });
  api.setJoin({ s1: 'L1', s2: 'L2' });
  rows = [{ runId: 'a', streamId: 's1' }];
  A.eq(api.map(), { ob1: 1 }, 'one crate proven on line L1 sits on its chute');
  rowReads = 0;
  for (let i = 0; i < 100; i++) api.map();
  A.eq(rowReads, 0, '100 frames at one revision re-read the ledger 0 times');
  // the same COUNT, different crates: resolve L1's run, fold an L2 run, one revision later
  rows = [{ runId: 'b', streamId: 's2' }]; rev++;
  A.eq(api.map(), { ob2: 1 }, 'a resolve + fold at the same count moves the crate to the right chute (the count key left it on ob1)');
  rows = []; rev++;
  A.eq(api.map(), {}, 'an empty ledger empties every chute');
  // an old store without revision() still works on the count
  delete ReturnStore.revision; rows = [{ runId: 'c', streamId: 's1' }];
  A.eq(api.map(), { ob1: 1 }, 'a store without revision() falls back to the count key');
}

A.report('outbox-crate-memo');
