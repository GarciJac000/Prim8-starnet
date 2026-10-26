/* test/first-ship-receipt.test.js — FIRST SHIP rides the executor's terminal receipt and the SHIPMENT RECORD, never a crate
   animation and never this browser's memory alone (M8, 2026-10-12; repair pass 2026-10-12).

   The gold 'FIRST SHIP · LINE X' toast and the milestone sound used to fire from world.js onWorkitemDeliver — a crate sinking at
   a chute. A direct COMMS order to the agent crewing a line's last BAY rides a crate down that BAY's belt too, so a line that never
   ran a job "shipped" while its plate read SHIPPED 0. Then it rode the receipt but judged "first" by a per-browser flag against
   TODAY's count, defaulting to 0 whenever that count was unknown — so a line that had shipped before this page loaded, in another
   window, while this one slept, or under an older build (its `done` flag) got a second FIRST SHIP, even on a talk-only job. Now
   chain.js's terminal receipt workitem.delivered { box: 'line-output', lineId, outboxId } asks, and the line's SHIPPED over the
   whole kept record (?since=1) answers: a count read BEFORE the receipt is the baseline (unknown = no claim, never 0), a line
   already above 0 or already spent reads nothing, and FIRST SHIP is said only when the record goes 0 -> 1+ across the receipt.

   Runs the REAL world.js lineNameOf / readShipCounts / noteFirstShip and the REAL build.js finRead / lineShipSpent /
   markLineShipped / noteLineShipped (source slices in a vm) against a real WorldModel station. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), path = require('path'), vm = require('vm');
const WM = require('../frontend/app/worldmodel.js'), P = require('../frontend/app/pipeline.js'), LE = require('../frontend/app/lineedit.js');
const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');
const slice = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + 1); A.ok(a >= 0 && b > a, 'source slice ' + from.trim().slice(0, 40)); return src.slice(a, b); };
const settle = () => new Promise(r => setImmediate(r));

/* ---------- 1. the world: a receipt asks, the shipment record answers, and an unknown count claims nothing ---------- */
const section1 = (async () => {
  const notes = [], sounds = [], asked = [], shipped = [], quiet = [];
  const spent = new Set();
  let server = {}, down = false;
  const Build = {
    lineShipSpent: id => spent.has(id),
    markLineShipped: id => { if (spent.has(id)) return false; spent.add(id); quiet.push(id); return true; },
    noteLineShipped: (o, l) => { shipped.push([o, l]); if (spent.has(l)) return null; spent.add(l); return { first: true, name: 'LINE ' + l, tiles: { '1,1': 1 } }; }
  };
  let wakes = 0;   // STILL (world.js): the FIRST SHIP pulse lands between frames, so it wakes a still floor
  // fnow is the last frame's clock (stale between frames); performance.now() the wall clock the pulse must start on (STILL tier)
  const ctx = vm.createContext({ fnow: 123, performance: { now: () => 456 }, firstShipPulse: null, motionWake: () => { wakes++; }, Date, Promise, Object, isFinite, Set, Pipeline: P, station: null,
    routingPlan: { hash: 'h1', lines: [{ lineId: 'L1', intakes: ['i1'] }, { lineId: 'L2', intakes: ['i2'], name: 'Research' }] },
    apiUrl: p => p,
    fetch: async url => { asked.push(url); if (down) throw new Error('offline'); return { ok: true, json: async () => ({ ok: true, lines: Object.keys(server).map(k => ({ lineId: k, shipped: server[k] })) }) }; },
    Build, StationUI: { notify: (t, k) => notes.push([t, k]) }, SFX: { milestone: () => sounds.push(1) } });
  vm.runInContext(slice(world, '  /* A LINE\'S NAME off the floor', '  // the crate\'s MASS must be read NOW')
    + '; globalThis.note = noteFirstShip; globalThis.read = readShipCounts; globalThis.stale = shipBaseStale; globalThis.base = () => shipBase; globalThis.pulse = () => firstShipPulse;', ctx);
  const R = (workitemId, lineId, outboxId) => ({ workitemId, box: 'line-output', lineId, outboxId: outboxId || 'o_' + lineId, entryRunId: 'r_' + workitemId });

  // a direct COMMS order's delivery (chat.js: box '') and a crate animation's payload (box 'product') announce nothing
  await ctx.note({ workitemId: 'wi_direct', finalQueueId: 'outbox', agentId: 'nova', box: '' });
  await ctx.note({ workitemId: 'wi_crate', box: 'product', lineId: 'L1', outboxId: 'o1' });
  await ctx.note({ workitemId: 'wi_half', box: 'line-output', lineId: 'L1' });   // a receipt with no OUTBOX proves nothing
  A.eq(shipped.length + notes.length + sounds.length + asked.length, 0, 'no receipt, no FIRST SHIP and no read (direct order, crate payload, partial receipt)');

  // M8 / review: NO COUNT FROM BEFORE THE RECEIPT IS NO BASELINE. The record says L1 already shipped 3 times (before this page),
  // this window never read it and set no flag, and a TALK-ONLY job's receipt arrives: the old code took 0 and toasted.
  server = { L1: 3, L2: 0 };
  A.ok(ctx.stale(), 'a page that read no counts yet is stale');
  A.eq(ctx.note(R('wi_talk', 'L1')), null, 'an unknown count claims nothing — it only asks for the counts');
  await settle(); await settle();
  A.eq(asked, ['/api/routing/lines/stats?since=1'], 'the counts are read over the whole kept record (since=1), not today');
  A.eq([shipped.length, notes.length, sounds.length], [0, 0, 0], 'no FIRST SHIP for a line that shipped before this page');
  A.eq(quiet, ['L1'], '…and the record\'s shipment spends that line\'s FIRST SHIP quietly');
  A.ok(!ctx.stale(), 'every posted line has a count now');

  // a spent line reads NOTHING on its next receipt (review: every receipt used to fold the whole line stats again)
  asked.length = 0;
  A.eq(ctx.note(R('wi_L1b', 'L1')), null, 'a spent line\'s receipt returns at once');
  A.eq(asked.length, 0, '…without reading the stats');

  // a line at 0: a TALK-ONLY job reaches the OUTBOX but mints nothing — the record stays 0, so no toast, and FIRST SHIP stays unspent
  await ctx.note(R('wi_L2talk', 'L2'));
  A.eq(asked, ['/api/routing/lines/stats?since=1'], 'a line at 0 reads its count once after the receipt');
  A.eq([shipped.length, notes.length], [0, 0], 'SHIPPED did not grow: no FIRST SHIP');
  A.ok(!spent.has('L2'), '…and the line keeps its FIRST SHIP for the job that really ships');

  // the job that ships: 0 -> 1 across the receipt
  server.L2 = 1;
  await ctx.note(R('wi_L2', 'L2'));
  A.eq(shipped, [['o_L2', 'L2']], 'a receipt whose job minted the line\'s first shipment asks Build with its exact OUTBOX and line');
  A.eq(notes, [['FIRST SHIP · LINE RESEARCH', 'gold']], 'the first shipment shows the gold toast, the line named by the floor\'s rule (its named INBOX)');
  A.eq(sounds.length, 1, '…and plays the milestone once');
  A.ok(ctx.pulse() && ctx.pulse().at === 456, '…and pulses the line, from the wall clock (the answer lands between frames: a still floor\'s fnow is up to 33 ms old)');
  A.eq(wakes, 1, '…and wakes a still floor, so the pulse starts on the next vsync (STILL tier)');
  const n = asked.length;
  A.eq(ctx.note(R('wi_L2', 'L2')), null, 'the SSE echo of the same receipt is ignored');
  server.L2 = 2;
  A.eq(ctx.note(R('wi_L2b', 'L2')), null, 'a later shipment of the same line is not a first');
  A.eq([asked.length, notes.length, sounds.length], [n, 1, 1], '…and neither reads anything');

  // a read that fails proves nothing
  server.L3 = 0; ctx.routingPlan = { hash: 'h2', lines: ctx.routingPlan.lines.concat([{ lineId: 'L3', intakes: ['i3'] }]) };
  A.ok(ctx.stale(), 'a new line on the posted floor makes the counts stale');
  await ctx.read();
  A.eq(ctx.base().byLine.L3, 0, 'the new line\'s count is read');
  server.L3 = 1; down = true;
  await ctx.note(R('wi_L3', 'L3'));
  A.eq([notes.length, spent.has('L3')], [1, false], 'a failed read announces nothing (and spends nothing)');
  down = false;

  // a count the sidecar could not read (SHIPPED null — an unreadable record) is unknown, never 0
  server = { L1: 3, L2: 2, L3: null };
  await ctx.read();
  A.ok(!Object.prototype.hasOwnProperty.call(ctx.base().byLine, 'L3'), 'a null SHIPPED leaves the line without a count');
  A.eq(ctx.note(R('wi_L3b', 'L3')), null, '…so its receipt claims nothing');
  await settle(); await settle();
  A.eq(notes.length, 1, '…and no toast');

  // a line another window saw ship (the record is above 0, this browser's flag unset) reads nothing and stays quiet
  server = { L1: 3, L2: 2, L3: 0, L4: 2 };
  ctx.routingPlan = { hash: 'h3', lines: ctx.routingPlan.lines.concat([{ lineId: 'L4', intakes: ['i4'] }]) };
  spent.delete('L4');
  const base = ctx.read(); spent.delete('L4'); quiet.length = 0; await base;
  A.eq(quiet, ['L4'], 'the record\'s count spends a line another window saw ship');
  spent.delete('L4'); asked.length = 0;
  A.eq(ctx.note(R('wi_L4', 'L4')), null, 'a line counted above 0 before the receipt is no first (even with this browser\'s flag unset)');
  A.eq([asked.length, notes.length, spent.has('L4')], [0, 1, true], '…it reads nothing and spends the flag quietly');

  // an older read that answers late never overwrites a newer one
  const gates = [];
  ctx.fetch = url => new Promise(res => gates.push(v => res({ ok: true, json: async () => ({ lines: Object.keys(v).map(k => ({ lineId: k, shipped: v[k] })) }) })));
  const older = ctx.read(), newer = ctx.read();
  gates[1]({ L5: 1 }); await newer; gates[0]({ L5: 0 }); await older;
  A.eq(ctx.base().byLine.L5, 1, 'a late older read leaves the newer count in place');
})();

/* ---------- 2. source locks: the crate seam books nothing; the receipt is the only announcer; the counts stay fresh ---------- */
{
  const deliver = slice(world, '  function onWorkitemDeliver(bx) {', '\n  }\n');
  A.ok(!/'FIRST SHIP|SFX\.milestone|StationUI\.notify|firstShipPulse/.test(deliver), 'a crate sinking at a chute announces nothing');
  A.ok(!/Build\.(noteLine|markLine|lineShip)/.test(deliver), '…and books nothing: no FIRST SHIP flag, no finish-card retirement (a direct COMMS order rides a crate too)');
  A.ok(!/function noteLineDelivered|noteLineDelivered,/.test(build), 'Build has no crate-at-a-chute hook any more');
  A.eq((world.match(/'FIRST SHIP · '/g) || []).length, 1, 'FIRST SHIP is said in exactly one place');
  A.ok(/function noteFirstShip\(p\) \{\s*if \(!p \|\| p\.box !== 'line-output'/.test(world), '…and that place answers only box line-output');
  A.ok(/U\.bus\.on\('workitem\.delivered', p => \{ releaseJoinedProduct\(p\); noteFirstShip\(p\); \}\)/.test(world), 'the receipt listener calls it');
  A.ok(/if \(shipBaseStale\(\)\) refreshShipBase\(\);/.test(slice(world, '  function pollLineStats() {', '\n  }\n')), 'the line-stats cadence re-reads the counts when the posted floor has a line without one');
  A.ok(/name === 'workitem\.placed' \|\| name === 'agent\.run\.start'[\s\S]{0,200}if \(lid && !hasCount\(String\(lid\)\)\) refreshShipBase\(\);/.test(slice(world, '  function watchEvent(name, p) {', '\n  }\n')), 'a job starting on a line with no count reads the counts before it can ship');
  // (conveyor-final repair: the reset is FIRST SHIP's own forgetShipBase, called after the bridge's authoritative snapshot — inlined
  // ahead of it, inside the bridge's catch-all, a throw here skipped the reconciliation; test/channels.sse drives the order)
  A.ok(/function forgetShipBase\(\) \{\s*shipBase = \{ known: false, byLine: \{\} \}; shipApplied = shipSeq; shipBaseReading = false; refreshShipBase\(\);\s*\}/.test(world)
    && /m\.stream === 'ready'[\s\S]{0,400}fetchSnapshot\(\);[\s\S]{0,300}forgetShipBase\(\);/.test(world), 'a (re)connected stream drops the old counts and reads them again');
  A.ok(/shipBase = \{ known: false, byLine: \{\} \}; shipBaseHash = null; shipApplied = shipSeq; firstShipPending\.clear\(\);/.test(world), 'another station starts with no counts');
}

/* ---------- 3. Build: first per line, spent flags, the upgrade from an older build's `done` ---------- */
{
  const s = WM.create(); s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 90, y2: 40 } });
  const a = LE.placeBlueprint(s, 'research_line', { x: 40, y: 4 }), b = LE.placeBlueprint(s, 'research_line', { x: 40, y: 22 });
  A.ok(a.ok && b.ok, 'fixture: two lines');
  for (const p of s.props()) if (p.t === 'bay') s.assignPropAgent(p.id, 'ag_' + p.id);
  const of = (r, t) => r.ids.find(id => s.propById(id).t === t);
  s.setPropLabel(of(a, 'intake'), 'Research');
  const comps = P.lineComponents(s.projectGeometry()), ca = comps.find(c => c.outboxes.includes(of(a, 'outbox'))), cb = comps.find(c => c.outboxes.includes(of(b, 'outbox')));
  const mk = (store) => {
    const ctx = vm.createContext({ opts: { getStation: () => s }, station: null, running: false, renderFinCard: () => {}, Pipeline: P,
      stationKeyOf: () => 'test', localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } });
    vm.runInContext(slice(build, '  const FIN_KEY = st =>', '  /* SAMPLE-JOB seam detection') + slice(build, '  /* FIRST SHIP BOOKKEEPING', '  /* ---------- AIRLOCK door-state picker')
      + '; globalThis.shipped = noteLineShipped; globalThis.mark = markLineShipped; globalThis.spent = lineShipSpent; globalThis.reg = () => finRead(opts.getStation());', ctx);
    return ctx;
  };
  let store = {};
  let ctx = mk(store);
  A.eq(ctx.spent(ca.key), false, 'a line that never shipped has its FIRST SHIP to come');
  A.eq(ctx.shipped(of(a, 'outbox'), cb.key), null, 'a receipt whose OUTBOX is on another line announces nothing');
  A.eq(ctx.shipped('no-such-outbox', ca.key), null, 'a receipt for an OUTBOX no longer on the floor announces nothing');
  const r = ctx.shipped(of(a, 'outbox'), ca.key);
  A.ok(r && r.first === true && r.name === 'LINE RESEARCH' && JSON.stringify(Object.keys(r.tiles).sort()) === JSON.stringify(Object.keys(ca.tiles).sort()), 'the first receipt of a line is its FIRST SHIP, named as the floor names it: ' + JSON.stringify(r && { first: r.first, name: r.name }));
  A.eq([ctx.shipped(of(a, 'outbox'), ca.key), ctx.spent(ca.key)], [null, true], 'the second receipt of that line is not, and the line reads spent');
  A.eq([ctx.mark(cb.key), ctx.mark(cb.key), ctx.spent(cb.key)], [true, false, true], 'the record spends another line quietly, once');
  A.eq(ctx.shipped(of(b, 'outbox'), cb.key), null, '…so its next receipt is no first');
  A.ok(!ctx.reg()[ca.key].done && !ctx.reg()[cb.key].done, 'nothing writes the old crate flag `done` any more');

  // UPGRADE: a line an older build marked `done` (a product crate sank at its chute — the old FIRST SHIP / card retirement) has
  // had its moment: read once as shipped, so no second gold toast after the upgrade (review: noteLineShipped never read `done`)
  store = { 'starnet.refit.finline.test': JSON.stringify({ [ca.key]: { done: 1 }, [cb.key]: { dis: 1 } }) };
  ctx = mk(store);
  A.eq(ctx.spent(ca.key), true, 'an older build\'s `done` reads as a spent FIRST SHIP');
  A.eq(ctx.shipped(of(a, 'outbox'), ca.key), null, '…so its first shipment under this build is no FIRST SHIP');
  A.eq(store['starnet.refit.finline.v2.test'], '1', 'the upgrade is marked done for this station');
  A.eq(JSON.parse(store['starnet.refit.finline.test'])[cb.key], { dis: 1 }, 'a dismissed line is untouched by the upgrade');
  // …and runs ONCE: a `done` that appears after it is never honoured (nothing writes one now; a stray one proves no shipment)
  store['starnet.refit.finline.test'] = JSON.stringify({ [cb.key]: { done: 1 } });
  ctx = mk(store);
  A.eq(ctx.spent(cb.key), false, 'a `done` written after the upgrade does not spend FIRST SHIP');
  const rb = ctx.shipped(of(b, 'outbox'), cb.key);
  A.ok(rb && rb.first && /^LINE [A-Z]+$/.test(rb.name), 'another line ships its own first (an unnamed line by its letter): ' + (rb && rb.name));
}
section1.then(() => A.report('first-ship-receipt'), e => { console.error(e); process.exit(1); });
