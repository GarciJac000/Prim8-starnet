/* node test/pollgate.test.js — the pure contract of frontend/app/pollgate.js (idle CPU piece 3, 2026-10-20).

   PollGate is the one owner of "is anyone looking?" for the browser's background polls: a poll keeps its own cadence while
   the page can be seen, slows to a 30 s floor while the Commander is away (hidden AND no input for 10 s), never stops, and
   catches up the moment the Commander is back. Fake document, window, clock and timers; nothing real is scheduled. */
'use strict';
const A = require('./_assert.js');
const G = require('../frontend/app/pollgate.js');

let clock = 1000000;
const timers = new Map();
let seq = 0;
G._setClockForTest(() => clock);
G._setTimersForTest((fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + Math.max(0, ms) }); return id; }, id => { timers.delete(id); });
function listeners() { const m = {}; return { m, addEventListener(k, fn) { (m[k] = m[k] || []).push(fn); }, removeEventListener(k, fn) { m[k] = (m[k] || []).filter(f => f !== fn); }, fire(k) { for (const f of (m[k] || []).slice()) f({ type: k }); } }; }
const doc = Object.assign(listeners(), { hidden: false });
const win = listeners();
G._setDocForTest(doc, win);
// run every timer due by `until`, in time order (timers a run schedules are honoured in the same pass)
async function advance(ms) {
  const until = clock + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    timers.delete(next[0]); clock = Math.max(clock, next[1].at); next[1].fn();
    for (let n = 0; n < 10; n++) await Promise.resolve();
  }
  clock = until;
}

(async () => {
  // ---- away(): hidden AND no input for 10 s ----
  G._resetForTest();
  A.eq(G.away(), false, 'a visible page is never away');
  doc.hidden = true;
  A.eq(G.away(), true, 'hidden with no recent input is away');
  win.fire('pointermove');
  A.eq(G.away(), false, 'input proves the page is on screen, whatever document.hidden says (a webview that misreports hidden)');
  clock += 9999; A.eq(G.away(), false, 'the input grace lasts 10 s');
  clock += 1; A.eq(G.away(), true, '…and then the hidden page is away again');
  doc.hidden = false;

  // ---- every(): the visible cadence, then the away floor, never a stop ----
  G._resetForTest();
  let runs = [];
  const loop = G.every(() => { runs.push(clock); }, { ms: 5000 });
  A.eq(runs.length, 1, 'immediate (the default) runs once on arm, like fn(); setInterval(fn, ms)');
  await advance(20000);
  A.eq(runs.length, 5, 'visible: one run every 5 s (0, 5, 10, 15, 20)');
  A.ok(runs.every((t, i) => i === 0 || t - runs[i - 1] === 5000), 'the visible spacing is exactly the configured cadence');
  A.eq(loop.cadence(), 5000, 'cadence() is the interval in force when the last run started');
  doc.hidden = true; clock += 0;
  runs = [];
  await advance(60000);
  A.ok(runs.length >= 1 && runs.length <= 2, 'away: the loop slows to the 30 s floor (' + runs.length + ' runs in 60 s, was 12)');
  A.ok(runs.length > 0, 'away polls slow down; they never stop');
  A.eq(loop.cadence(), 30000, 'a run that started while away records the 30 s cadence');
  A.eq(loop.interval(), 30000, 'interval() is the cadence in force now');

  // ---- wake: visible again runs the overdue loop at once ----
  runs = [];
  clock += 7000;   // more than the visible 5 s since the last away run
  doc.hidden = false; doc.fire('visibilitychange');
  A.eq(runs.length, 1, 'back on screen: an overdue loop runs at once, not on its next away beat');
  await advance(5000);
  A.eq(runs.length, 2, '…and keeps its visible cadence again');
  loop.stop();
  await advance(60000);
  A.eq(runs.length, 2, 'stop() ends the chain');

  // ---- wake callbacks fire only after the gate was away; the first input counts as a return ----
  G._resetForTest();
  let woke = 0;
  const off = G.onWake(() => { woke++; });
  win.fire('focus');
  A.eq(woke, 0, 'a focus while the gate was never away is not a wake');
  doc.hidden = true; clock += 11000;
  A.eq(G.away(), true, 'fixture: away');
  win.fire('keydown');
  A.eq(woke, 1, 'the first input after being away wakes (a webview still saying hidden)');
  win.fire('keydown');
  A.eq(woke, 1, 'later input is not another wake');
  off();
  doc.hidden = false;

  // ---- immediate:false: first run after one cadence ----
  G._resetForTest();
  runs = [];
  G.every(() => { runs.push(clock); }, { ms: 1000, immediate: false });
  A.eq(runs.length, 0, 'immediate:false does not run on arm');
  await advance(1000);
  A.eq(runs.length, 1, '…it runs after one cadence');

  // ---- a pending run blocks overlap; a throw or rejection still reschedules ----
  G._resetForTest();
  let release, started = 0;
  G.every(() => { started++; return new Promise(r => { release = r; }); }, { ms: 1000 });
  await advance(5000);
  A.eq(started, 1, 'a run still in flight is never overlapped by the next beat');
  release(); for (let n = 0; n < 10; n++) await Promise.resolve();
  await advance(1000);
  A.eq(started, 2, 'once it settles the chain carries on');
  G._resetForTest();
  const raised = [];
  G._setRaiseForTest(e => raised.push('throw:' + e.message), e => raised.push('reject:' + e.message));
  let throws = 0, rejects = 0;
  G.every(() => { throws++; throw new Error('boom'); }, { ms: 1000 });
  G.every(() => { rejects++; return Promise.reject(new Error('offline')); }, { ms: 1000 });
  await advance(3000);
  A.eq(throws, 4, 'a throwing poll still reschedules');
  A.eq(rejects, 4, 'a rejecting poll still reschedules');
  A.eq(raised.filter(x => x === 'throw:boom').length, 4, 'each throw is re-raised outside the chain (as loud as under setInterval)');
  A.eq(raised.filter(x => x === 'reject:offline').length, 4, 'each rejection is re-raised as an unhandled rejection (as loud as an unawaited poll)');

  // ---- a live cadence function is read at every schedule ----
  G._resetForTest();
  let fast = true; runs = [];
  G.every(() => { runs.push(clock); }, { ms: () => (fast ? 1000 : 5000), immediate: false });
  await advance(3000);
  A.eq(runs.length, 3, 'ms() = 1 s: three runs in 3 s');
  fast = false;
  await advance(10000);
  A.ok(runs.length === 5 || runs.length === 6, 'ms() = 5 s: the cadence follows the function (' + (runs.length - 3) + ' runs in 10 s)');

  /* ---- A BEAT THAT NEVER SETTLES NEVER ENDS THE LOOP (fix round, 2026-10-20) ----
     world.js pollFeedState and the loops watcher returned fetches with no deadline: one read the sidecar accepted and never
     answered left the chain waiting on it for good (2 runs in 10 min where setInterval made 10). Each beat now has a
     deadline of max(2 x its cadence, 15 s); past it the chain moves on, and the abandoned promise's late answer changes
     nothing. */
  G._resetForTest();
  let calls = 0;
  G.every(() => { calls++; return calls === 2 ? new Promise(() => {}) : undefined; }, { ms: 60000 });
  await advance(10 * 60000);
  A.ok(calls >= 9, 'a 60 s loop whose 2nd read hangs forever still runs in 10 min (' + calls + ' runs; 2 before the deadline)');
  A.ok(timers.size > 0, '…and is still scheduled');

  G._resetForTest();
  let lateFirst = null, beats = 0;
  G.every(() => { beats++; if (beats === 1) return new Promise(r => { lateFirst = r; }); return undefined; }, { ms: 1000 });
  await advance(14999);
  A.eq(beats, 1, 'a 1 s beat in flight is waited on up to its 15 s deadline (no overlap before it)');
  await advance(1);
  A.eq(beats, 2, 'at the deadline the chain moves on and runs the overdue beat');
  lateFirst(); for (let n = 0; n < 10; n++) await Promise.resolve();
  const atLate = beats;
  await advance(10000);
  A.eq(beats - atLate, 10, 'the abandoned beat answering late starts no second chain (10 runs in 10 s, not 20)');

  /* the Commander comes back while a beat started away is hung: the catch-up is not blocked by it */
  G._resetForTest();
  let k = 0;
  G.every(() => { k++; if (k === 2) return new Promise(() => {}); return undefined; }, { ms: 1000 });
  doc.hidden = true;
  await advance(30000);
  A.eq(k, 2, 'fixture: away, the 30 s beat ran and hangs');
  await advance(20000);   // 20 s into the hung away beat: past a 1 s loop's 15 s deadline, short of the 60 s away one
  doc.hidden = false; doc.fire('visibilitychange');
  A.eq(k, 3, 'back on screen: a beat hung past the live deadline is abandoned and the overdue loop runs at once');
  G._resetForTest();
  k = 0;
  G.every(() => { k++; if (k === 2) return new Promise(() => {}); return undefined; }, { ms: 1000 });
  doc.hidden = true;
  await advance(30000);
  await advance(5000);    // 5 s into the hung away beat
  doc.hidden = false; doc.fire('visibilitychange');
  A.eq(k, 2, 'a beat only 5 s out on return is still awaited (its answer is on its way)');
  await advance(9999);
  A.eq(k, 2, '…until the live 15 s deadline');
  await advance(1);
  A.eq(k, 3, '…which is pulled in from the 60 s away deadline: the loop runs at 15 s, not 60 s');
  G._resetForTest();
  k = 0;
  const hungLoop = G.every(() => { k++; return k === 1 ? new Promise(() => {}) : undefined; }, { ms: 1000, immediate: true });
  clock += 16000;   // timers frozen (a frozen page): the guard has not fired yet
  hungLoop.runNow();
  A.eq(k, 2, 'runNow() is not blocked by a beat hung past its deadline either');
  doc.hidden = false;

  /* ---- AWAY IS NEVER CLAIMED AGAINST THE PAGE'S OWN EVIDENCE OF BEING ON SCREEN ----
     world.js cinecamTick: embedded webviews (the preview harness, some Tauri states) report document.hidden while still
     rendering, and a hands-off viewer gives no input. Away now needs every signal the page has to agree. */
  G._resetForTest();
  const frames = [];
  G._setFrameForTest(cb => { frames.push(cb); return frames.length; });
  doc.hidden = true; doc.visibilityState = 'visible';
  A.eq(G.away(), false, 'hidden but visibilityState "visible": the signals disagree, so not away');
  doc.visibilityState = 'hidden'; doc.hasFocus = () => true;
  A.eq(G.away(), false, 'hidden but the document holds focus: on screen, not away');
  doc.hasFocus = () => false;
  frames.length = 0;
  A.eq(G.away(), false, 'hidden, unfocused, idle: not away until a frame probe has had its chance');
  A.eq(frames.length, 1, 'one rAF probe is out');
  G.away(); A.eq(frames.length, 1, '…only one, however often away() is asked');
  clock += 1999; A.eq(G.away(), false, 'no frame for 1.999 s: not proven yet');
  clock += 1; A.eq(G.away(), true, 'no frame for 2 s (a really hidden page never runs rAF): away');
  frames.shift()(0);   // the page draws again with no visibilitychange (a webview that never says it is back)
  A.eq(G.away(), false, 'a drawn frame proves the page is on screen again');

  /* a webview that says hidden but keeps drawing keeps the visible cadence (it slowed to 30 s before) */
  G._resetForTest();
  frames.length = 0;
  G._setFrameForTest(cb => { const id = ++seq; timers.set(id, { fn: () => cb(clock), at: clock + 16 }); return id; });
  let drawn = 0;
  G.every(() => { drawn++; }, { ms: 1000, immediate: false });
  await advance(60000);
  A.eq(drawn, 60, 'hidden + idle + unfocused but drawing frames: a 1 s loop keeps its 1 s cadence (' + drawn + ' runs in 60 s, was 2)');
  /* …and a page that really is hidden still slows */
  G._resetForTest();
  G._setFrameForTest(cb => { frames.push(cb); return frames.length; });
  frames.length = 0;
  drawn = 0;
  G.every(() => { drawn++; }, { ms: 1000, immediate: false });
  await advance(60000);
  A.ok(drawn >= 2 && drawn <= 4, 'hidden + idle + no frames: the 1 s loop slows to the 30 s floor (' + drawn + ' runs in 60 s)');
  /* a frame after being away is a return: the overdue loop runs at once */
  clock += 5000;
  const before = drawn;
  frames.splice(0).forEach(f => f(0));
  A.eq(drawn, before + 1, 'the first frame drawn after being away wakes the gate: the overdue loop runs at once');
  G._setFrameForTest(null);
  doc.hidden = false; delete doc.visibilityState; delete doc.hasFocus;

  G._resetForTest();

  /* ---- THE DEFAULT CLOCK IS MONOTONIC (a backward wall-clock step never stalls a loop) ----
     A fresh PollGate in a vm with its OWN defaults: performance.now advances steadily while Date.now steps back 5 min
     (a w32time correction after resume). The next 1 s beat must come 1 s later, not 5 min later. */
  {
    const vm = require('vm');
    let mono = 50000, wall = 1760000000000;
    const q = new Map(); let qs = 0;
    const box = { module: { exports: {} }, Promise,
      performance: { now: () => mono }, Date: { now: () => wall },
      setTimeout: (fn, ms) => { const id = ++qs; q.set(id, { fn, at: mono + Math.max(0, ms) }); return id; },
      clearTimeout: id => { q.delete(id); } };
    vm.runInNewContext(require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/pollgate.js'), 'utf8'), box);
    const P = box.module.exports;
    const step = ms => { const until = mono + ms; for (;;) { let nx = null; for (const [id, t] of q) if (t.at <= until && (!nx || t.at < nx[1].at)) nx = [id, t]; if (!nx) break; q.delete(nx[0]); wall += nx[1].at - mono; mono = nx[1].at; nx[1].fn(); } wall += until - mono; mono = until; };
    let r = 0;
    P.every(() => { r++; }, { ms: 1000 });
    A.eq(r, 1, 'fixture: the loop ran on arm');
    wall -= 5 * 60000;
    step(1000);
    A.eq(r, 2, 'the wall clock stepped back 5 min: the next 1 s beat still comes 1 s later (it waited 5 min on Date.now)');
    step(3000);
    A.eq(r, 5, '…and the cadence carries on');
  }

  /* ---- THE VISIBLE CADENCE NEVER DRIFTS (fix round 4, 2026-10-20) ----
     Every real timer fires a little late (setTimeout leeway, 1-8 ms). Each beat was timed from when it RAN, so that
     lateness added up beat after beat, and the 1 s rail ticker and station tick (which run the live elapsed clocks) slid
     through the second boundaries of a run's clock: '41s' then '43s' every few minutes. The setInterval they replaced
     never drifted (Blink's repeating timer counts from when it was DUE). Timers here fire LATE ms late on purpose. */
  const exactTimers = () => G._setTimersForTest((fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + Math.max(0, ms) }); return id; }, id => { timers.delete(id); });
  G._setFrameForTest(null); doc.hidden = false;
  for (const LATE of [1, 4, 8]) {
    G._resetForTest(); timers.clear();
    G._setTimersForTest((fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + Math.max(0, ms) + LATE }); return id; }, id => { timers.delete(id); });
    const armedAt = clock, starts = [];
    G.every(() => { starts.push(clock); }, { ms: 1000, immediate: false });
    await advance(30 * 60000 + LATE);
    A.eq(starts.length, 1800, 'timers ' + LATE + ' ms late: 1800 beats in 30 min, as setInterval (it lost ' + (1800 - starts.length) + ')');
    A.eq(starts.filter((t, i) => t !== armedAt + (i + 1) * 1000 + LATE).length, 0, 'timers ' + LATE + ' ms late: every beat starts on the loop\'s own 1 s grid (the lateness never adds up)');
    const runStart = armedAt + 300;   // a run that started 300 ms into the loop's phase, its clock drawn on each beat
    let skipped = 0;
    for (let i = 1; i < starts.length; i++) if (Math.floor((starts[i] - runStart) / 1000) - Math.floor((starts[i - 1] - runStart) / 1000) !== 1) skipped++;
    A.eq(skipped, 0, 'timers ' + LATE + ' ms late: a live elapsed clock drawn on the beat never jumps two seconds in one tick');
  }
  exactTimers();
  /* a stall (a long task) runs the overdue beat once when it ends; the next keeps the grid, as setInterval did */
  G._resetForTest(); timers.clear();
  {
    const armedAt = clock, starts = [];
    G.every(() => { starts.push(clock - armedAt); }, { ms: 1000, immediate: false });
    await advance(3000);
    clock += 2300;   // the page's event loop busy: no timer runs
    await advance(2000);
    A.eq(starts, [1000, 2000, 3000, 5300, 6000, 7000], 'a 2.3 s stall: the overdue beat runs once at its end, and the next is back on the 1 s grid');
  }
  /* an awaited beat that runs long is never overlapped, and the chain stays on its grid after it */
  G._resetForTest(); timers.clear();
  {
    const armedAt = clock, starts = [];
    let hold = null;
    G.every(() => { starts.push(clock - armedAt); if (starts.length === 2) return new Promise(r => { hold = r; }); return undefined; }, { ms: 2500, immediate: false });
    await advance(5000);
    await advance(3000);   // the 5 s beat is still out at 8 s
    hold(); for (let n = 0; n < 10; n++) await Promise.resolve();
    await advance(5000);
    A.eq(starts, [2500, 5000, 10000, 12500], 'a beat that ran 3 s: never overlapped, the 7.5 s slot it covered is skipped (as setInterval\'s busy-guarded tick), and the chain keeps its 2.5 s grid');
  }

  /* ---- A SLOW ANSWER IS NEVER ASKED AGAIN AT ONCE (fix round 5, 2026-10-20) ----
     An awaited beat that outlasted its interval was re-run the moment it settled: a /api/overseer that answers in 3 s on
     the 2.5 s beat was asked at 0, 3, 6, 9 s… with no rest between an answer and the next ask. Trunk's
     setInterval(refresh, 2500) with its `if (busy) return` guard asked at 0, 5, 10 s… (~2 s idle between). */
  G._resetForTest(); timers.clear();
  {
    const armedAt = clock, starts = [], ends = [];
    G.every(() => { starts.push(clock - armedAt); return new Promise(r => { const id = ++seq; timers.set(id, { fn: () => { ends.push(clock - armedAt); r(); }, at: clock + 3000 }); }); }, { ms: 2500 });
    await advance(20000);
    A.eq(starts, [0, 5000, 10000, 15000, 20000], 'a 3 s read on the 2.5 s beat is asked on the grid points after each answer, as setInterval\'s busy guard did (it was 0, 3000, 6000…)');
    const rests = starts.slice(1).map((s, i) => s - ends[i]);
    A.ok(rests.every(r => r >= 2000), 'every answer is followed by rest before the next ask: ' + JSON.stringify(rests) + ' ms (it was 0 each time)');
  }
  /* …while a timer a stall held up still runs once at once (only an awaited beat's own overrun skips slots) */
  G._resetForTest(); timers.clear();
  {
    const armedAt = clock, starts = [];
    G.every(() => { starts.push(clock - armedAt); return Promise.resolve(); }, { ms: 1000, immediate: false });
    await advance(2000);
    clock += 2300;   // the page's event loop busy: no timer runs
    await advance(1000);
    A.eq(starts, [1000, 2000, 4300, 5000], 'a quick awaited beat after a 2.3 s stall: the overdue one runs once at its end, then back on the grid');
  }
  /* { gap: true }: a loop that was a setTimeout chain keeps a whole interval of rest after each beat (group-chat.js's
     station-wide list watch re-armed setTimeout(tick, 4000) after its read) */
  G._resetForTest(); timers.clear();
  {
    const armedAt = clock, starts = [], ends = [];
    G.every(() => { starts.push(clock - armedAt); return new Promise(r => { const id = ++seq; timers.set(id, { fn: () => { ends.push(clock - armedAt); r(); }, at: clock + 5000 }); }); }, { ms: 4000, immediate: false, gap: true });
    await advance(40000);
    A.eq(starts, [4000, 13000, 22000, 31000, 40000], 'gap: a 5 s read on a 4 s chain is asked every 9 s, as the chain did');
    A.ok(starts.slice(1).every((s, i) => s - ends[i] === 4000), 'gap: each answer is followed by the chain\'s full 4 s rest');
    G._resetForTest(); timers.clear();
    const quick = [];
    const t0 = clock;
    G.every(() => { quick.push(clock - t0); return new Promise(r => { const id = ++seq; timers.set(id, { fn: r, at: clock + 40 }); }); }, { ms: 4000, immediate: false, gap: true });
    await advance(12200);
    A.eq(quick, [4000, 8040, 12080], 'gap: a 40 ms read comes every 4.04 s, as setTimeout(tick, 4000) after the await did');
  }

  G._resetForTest();
  A.report('pollgate.test');
})().catch(e => { console.error(e); process.exit(1); });
