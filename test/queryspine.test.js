/* node test/queryspine.test.js — pure contract for the shared frontend JSON query spine. */
'use strict';
const A = require('./_assert.js');
const { QuerySpine: Q } = require('../frontend/app/queryspine.js');

async function rejects(p, label) {
  let failed = false;
  try { await p; } catch (_) { failed = true; }
  A.ok(failed, label);
}

(async () => {
  let clock = 1000;
  Q._setClockForTest(() => clock);
  Q._resetForTest();

  // One key, one wire request: concurrent readers adopt the exact same in-flight promise.
  Q.define('dedupe', { path: '/dedupe', ttlMs: 100 });
  let calls = 0, release;
  Q._setGetForTest(path => {
    calls++;
    A.eq(path, '/dedupe', 'the configured path reaches the JSON getter');
    return new Promise(resolve => { release = resolve; });
  });
  const d1 = Q.refresh('dedupe');
  const d2 = Q.refresh('dedupe');
  A.ok(d1 === d2, 'concurrent reads share one in-flight promise');
  await Promise.resolve();
  A.eq(calls, 1, 'concurrent readers make one request');
  release({ value: 7 });
  const ds = await d1;
  A.eq(ds.data.value, 7, 'the shared request publishes its real payload');

  // TTL serves the last-good value only while it is actually fresh.
  Q.define('ttl', { path: '/ttl', ttlMs: 50 });
  calls = 0;
  Q._setGetForTest(() => Promise.resolve({ value: ++calls }));
  A.eq((await Q.get('ttl')).data.value, 1, 'the first TTL read reaches the wire');
  clock += 49;
  A.eq((await Q.get('ttl')).data.value, 1, 'a fresh TTL read reuses last-good state');
  A.eq(calls, 1, 'the fresh read does not duplicate the request');
  clock += 1;
  A.eq((await Q.get('ttl')).data.value, 2, 'the TTL boundary refreshes from the wire');

  // A failed refresh is not an empty success: reject, retain last-good, expose error metadata.
  Q.define('honesty', { path: '/honesty', ttlMs: 100 });
  Q._setGetForTest(() => Promise.resolve({ rows: ['real'] }));
  await Q.refresh('honesty');
  clock += 1;
  Q._setGetForTest(() => Promise.reject(new Error('offline now')));
  await rejects(Q.refresh('honesty'), 'a failed refresh rejects instead of synthesizing success');
  const honest = Q.state('honesty');
  A.eq(honest.data.rows.join(','), 'real', 'failure retains the last-good payload');
  A.ok(honest.stale && honest.error && honest.error.message === 'offline now' && honest.errorAt === clock,
    'failure publishes explicit stale/error metadata');

  // A successful mutation response can write through canonical server truth without a redundant GET.
  Q.define('write-through', { path: '/write-through', validate: data => !!(data && data.ok) });
  const written = Q.update('write-through', { ok: true, revision: 9 });
  A.ok(written.hasData && !written.stale && written.data.revision === 9,
    'update publishes a validated mutation response as fresh shared truth');
  A.throws(() => Q.update('write-through', { ok: false }), 'update refuses a payload that fails the resource validator');

  // A mutation invalidation outranks an older GET already on the wire. Its response must not become fresh
  // after the write, and a reader arriving after invalidation waits for a new-generation request.
  Q.define('mutation-race', { path: '/mutation-race', ttlMs: 1000 });
  let releaseOld;
  calls = 0;
  Q._setGetForTest(() => {
    calls++;
    if (calls === 1) return new Promise(resolve => { releaseOld = resolve; });
    return Promise.resolve({ revision: 'after-mutation' });
  });
  const published = [];
  const offRace = Q.subscribe('mutation-race', s => published.push(s), { refresh: false });
  const oldRead = Q.refresh('mutation-race');
  await Promise.resolve();
  Q.invalidate('mutation-race');
  const postMutationRead = Q.get('mutation-race');
  A.ok(postMutationRead !== oldRead, 'a post-invalidation reader does not adopt the older in-flight request');
  releaseOld({ revision: 'before-mutation' });
  await oldRead;
  const afterMutation = await postMutationRead;
  offRace();
  A.eq(calls, 2, 'invalidation queues one new-generation wire request');
  A.eq(afterMutation.data.revision, 'after-mutation', 'the post-mutation reader receives the new-generation payload');
  A.ok(!afterMutation.stale, 'the new-generation response becomes fresh');
  A.ok(!published.some(s => s.hasData && s.data && s.data.revision === 'before-mutation'),
    'the obsolete response is never published as shared resource truth');

  // Invalidation keeps last-good for display but forces the next ordinary read to the wire.
  Q.define('invalidate', { path: '/invalidate', ttlMs: 1000 });
  calls = 0;
  Q._setGetForTest(() => Promise.resolve({ revision: ++calls }));
  await Q.get('invalidate');
  await Q.get('invalidate');
  A.eq(calls, 1, 'a long-TTL resource is cached before invalidation');
  const invalid = Q.invalidate('invalidate');
  A.ok(invalid.stale && invalid.data.revision === 1, 'invalidate marks state stale without erasing last-good');
  A.eq((await Q.get('invalidate')).data.revision, 2, 'the next read after invalidate refreshes');

  // Subscribers jointly own exactly one poll timer; the final unsubscribe tears it down.
  Q.define('poll', { path: '/poll', pollMs: 60, ttlMs: 5 });
  let timerSeq = 0;
  const timers = new Map(), cleared = [];
  Q._setTimersForTest((fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; }, id => { cleared.push(id); timers.delete(id); });
  Q._setGetForTest(() => Promise.resolve({ tick: true }));
  const seen = [];
  const offA = Q.subscribe('poll', s => seen.push(['a', s]), { refresh: false });
  const offB = Q.subscribe('poll', s => seen.push(['b', s]), { refresh: false });
  A.eq(timers.size, 1, 'two subscribers share one poll timer');
  A.eq(Array.from(timers.values())[0].ms, 60, 'the resource owns its configured cadence');
  offA();
  A.eq(timers.size, 1, 'one remaining subscriber keeps the shared timer alive');
  offB();
  A.eq(timers.size, 0, 'the final unsubscribe stops polling');
  A.eq(cleared.length, 1, 'the shared timer is cleared exactly once');
  A.eq(Q._debug('poll').listeners, 0, 'no subscriber ownership leaks after teardown');
  A.ok(seen.length >= 2, 'subscribers receive an immediate state snapshot');

  Q.define('hung', { path: '/hung', timeoutMs: 25 });
  calls = 0;
  Q._setGetForTest(() => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({ recovered: true }));
  const hung = Q.refresh('hung');
  const hungFailure = rejects(hung, 'a hung read reaches a bounded deadline');
  await Promise.resolve();
  Q.invalidate('hung');
  A.ok((await Q.refresh('hung')).data.recovered, 'a new generation recovers without awaiting its hung predecessor');
  await hungFailure;
  A.ok(!Q.state('hung').pending && !Q.state('hung').error, 'obsolete timeout cannot poison recovered state');

  /* IDLE CPU PIECE 3 (2026-10-20): while the Commander is away (PollGate) a polled resource reads at most once per 30 s,
     never zero times, and the wake on return re-reads whatever is older than its own cadence. */
  const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
  Q.define('away-poll', { path: '/away-poll', pollMs: 4000, ttlMs: 1 });
  let awayNow = false, awayReads = 0, awayTick = null;
  Q._setAwayForTest(() => awayNow);
  Q._setTimersForTest((fn, ms) => { awayTick = fn; return 99; }, () => { awayTick = null; });
  Q._setGetForTest(() => { awayReads++; return Promise.resolve({ n: awayReads }); });
  const offAway = Q.subscribe('away-poll', () => {}, { refresh: false });
  await Q.refresh('away-poll');
  A.eq(awayReads, 1, 'fixture: one read lands');
  awayTick(); await drain();
  A.eq(awayReads, 2, 'on screen, every beat reads (the visible cadence is unchanged)');
  awayNow = true;
  for (let i = 0; i < 6; i++) { clock += 4000; awayTick(); await drain(); }
  A.eq(awayReads, 2, 'away: beats inside 30 s of the last read skip the wire (was one read per 4 s)');
  clock += 7000; awayTick(); await drain();
  A.eq(awayReads, 3, 'away: once the value is 30 s old the beat reads again — slower, never stopped');
  clock += 9000;
  awayNow = false; Q._wakeForTest(); await drain();
  A.eq(awayReads, 4, 'back on screen: a value older than its own 4 s cadence is re-read at once');
  Q._wakeForTest(); await drain();
  A.eq(awayReads, 4, 'a fresh value is not re-read on wake');
  offAway(); clock += 60000; Q._wakeForTest(); await drain();
  A.eq(awayReads, 4, 'a resource nobody watches is never re-read on wake');
  /* fix round (2026-10-20): a backward wall-clock step never parks an away poll or skips a wake. The age of a value read
     before the step is negative — unknown, never "fresh" — so the beat reads (it skipped until the clock caught up). */
  clock = 1760000000000;   // a real wall-clock reading (the fixture clock started at 1000)
  const offStep = Q.subscribe('away-poll', () => {}, { refresh: false });
  await Q.refresh('away-poll');
  const stepAt = awayReads;
  awayNow = true; clock -= 300000; awayTick(); await drain();
  A.eq(awayReads, stepAt + 1, 'away, the wall clock stepped back 5 min: the next beat reads (a negative age is unknown)');
  clock += 4000; awayTick(); await drain();
  A.eq(awayReads, stepAt + 1, '…and the 30 s away floor holds again from that read');
  clock -= 300000; awayNow = false; Q._wakeForTest(); await drain();
  A.eq(awayReads, stepAt + 2, 'a wake after a backward step re-reads too');
  offStep();

  /* fix round 6 (2026-10-20): AN AWAY STRETCH DOES NOT VOUCH FOR OLD DATA (the overseer ruling). GENUINE (executed): the
     REAL pollgate.js, queryspine.js, journeystore.js and topbar.js in one page (vm), on one fake monotonic + wall clock and
     timer queue, with an /api/journey that answers after 40 ms. Away, journey (12 s TTL, 4 s poll) is read only once its
     value is 30 s old, so for part of the stretch the value is past its TTL. The snapshot says so by trunk's own formula
     (age >= TTL), and the topbar's COMMANDER label reads "Lv N · saved" whenever the value it shows is that old: in its own
     repaint while away, and from the catch-up read's pending snapshot on return, until that answer lands ("Lv N"). No
     formula stretches the TTL across the away stretch: the station may have levelled up while the page did not ask. */
  async function topbarAcrossAway({ awayMs, frozenMs = 0, failAway = false }) {
    const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
    let mono = 5e6, wall = 1760000000000, seq = 0, reads = 0, failing = false;
    const timers = new Map();
    const arm = (fn, ms, every) => { const id = ++seq; timers.set(id, { fn, at: mono + Math.max(0, ms || 0), every: every ? Math.max(1, ms) : 0 }); return id; };
    const labels = [];
    const label = { set textContent(v) { labels.push(String(v)); this._t = String(v); }, get textContent() { return this._t; } };
    const listeners = {};
    const doc = { readyState: 'loading', hidden: false, visibilityState: 'visible', hasFocus: () => !doc.hidden,
      addEventListener(k, fn) { (listeners[k] = listeners[k] || []).push(fn); }, removeEventListener() {},
      getElementById: id => (id === 'gt-station' ? label : null), querySelector: () => null, body: { dataset: {} } };
    const journey = { progression: { level: 3, points: 330, levelStartsAt: 300, nextLevelAt: 400, pointsToNextLevel: 70 }, evolution: { stage: 1 } };
    const ctx = vm.createContext({ console, Promise, AbortController,
      performance: { now: () => mono }, Date: { now: () => wall },
      setTimeout: (fn, ms) => arm(fn, ms, false), clearTimeout: id => timers.delete(id),
      setInterval: (fn, ms) => arm(fn, ms, true), clearInterval: id => timers.delete(id),
      document: doc,
      Harness: { api: { get: () => new Promise((res, rej) => { reads++; const f = failing; arm(() => (f ? rej(new Error('offline')) : res({ ok: true, journey })), 40, false); }) } } });
    for (const f of ['pollgate.js', 'queryspine.js', 'journeystore.js', 'topbar.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app', f), 'utf8'), ctx);
    const win = { addEventListener() {}, removeEventListener() {} };
    vm.runInContext('PollGate', ctx)._setDocForTest(doc, win);
    const advance = async ms => {
      const until = mono + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        wall += t.at - mono; mono = Math.max(mono, t.at);
        if (t.every) { t.at += t.every; while (t.at <= mono) t.at += t.every; } else timers.delete(id);   // an interval a freeze held up fires once
        t.fn();
        for (let n = 0; n < 20; n++) await Promise.resolve();
      }
      wall += until - mono; mono = until;
    };
    const Topbar = vm.runInContext('Topbar', ctx), JourneyStore = vm.runInContext('JourneyStore', ctx);
    JourneyStore.init();
    await advance(8000);
    const before = label.textContent;
    // the Commander leaves: hidden, unfocused, no input (no rAF in this page: the frame proof is skipped)
    doc.hidden = true; doc.visibilityState = 'hidden';
    for (const fn of listeners.visibilitychange || []) fn();
    failing = failAway;
    const readsAtLeave = reads;
    const away = [];
    for (let t = 0; t < awayMs; t += 10000) {   // the topbar's own 30 s repaint, while away
      await advance(Math.min(10000, awayMs - t)); Topbar._paintXp();
      const s = JourneyStore.state(); away.push({ label: label.textContent, ageMs: s.ageMs, error: !!s.error });
    }
    const readsAway = reads - readsAtLeave;
    mono += frozenMs; wall += frozenMs;   // a sleep / a frozen page: the clocks move, nothing runs
    failing = false;
    const atWake = labels.length;
    doc.hidden = false; doc.visibilityState = 'visible';
    for (const fn of listeners.visibilitychange || []) fn();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    const atReturn = labels.slice(atWake);
    const returnSnap = JourneyStore.state();
    await advance(100);
    return { before, away, readsAway, atReturn, ageAtReturn: returnSnap.ageMs, pendingAtReturn: returnSnap.pending,
      catchUp: reads > readsAtLeave + readsAway, after: label.textContent };
  }
  const QS_SRC = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/app/queryspine.js'), 'utf8');
  A.ok(!/awayCover|ttlOf/.test(QS_SRC) && /\(r\.ttlMs > 0 && ageMs >= r\.ttlMs\)/.test(QS_SRC), 'stale is trunk\'s age >= ttlMs: no formula vouches for a value across an away stretch');
  const JOURNEY_TTL = 12000;
  const truthOf = ageMs => (ageMs >= JOURNEY_TTL ? 'Lv 3 · saved' : 'Lv 3');
  const across = {};
  for (const awayMs of [20000, 60000, 240000]) {
    const r = across[awayMs] = await topbarAcrossAway({ awayMs });
    A.eq(r.before, 'Lv 3', 'fixture: on screen, the COMMANDER label reads the live level');
    A.ok(r.readsAway <= Math.ceil(awayMs / 30000) + 1, 'fixture: away, journey is read on the 30 s floor (' + r.readsAway + ' reads in ' + awayMs / 1000 + ' s)');
    A.ok(r.away.every(p => !p.error && p.label === truthOf(p.ageMs)), 'AWAY ' + awayMs / 1000 + ' s: each repaint reads "· saved" exactly when the value is past its 12 s TTL: ' + JSON.stringify(r.away));
    A.ok(r.atReturn.length >= 1 && r.atReturn.every(t => t === truthOf(r.ageAtReturn)), 'BACK after ' + awayMs / 1000 + ' s: the catch-up read\'s pending snapshot paints the value\'s real age (' + r.ageAtReturn + ' ms): ' + JSON.stringify(r.atReturn));
    A.ok(r.catchUp, '…the catch-up read went out on return');
    A.eq(r.after, 'Lv 3', '…and after the answer lands the label reads the live level');
  }
  {
    // the defect this pins: a value the page chose not to re-read while away is NOT vouched for. Back after 60 s, journey's
    // value is past its TTL, so the pending catch-up paints "· saved" (a stretched away TTL painted "Lv 3") until it lands
    const r = across[60000];
    A.ok(r.ageAtReturn >= JOURNEY_TTL && r.pendingAtReturn, 'fixture: back after 60 s, the value is ' + r.ageAtReturn + ' ms old and the catch-up read is out');
    A.ok(r.atReturn.length >= 1 && r.atReturn.every(t => t === 'Lv 3 · saved'), 'BACK after 60 s: "· saved" while the catch-up read is out (no away formula vouches for it): ' + JSON.stringify(r.atReturn));
    A.eq(r.after, 'Lv 3', '…then "Lv 3" once it lands');
    A.ok(Object.values(across).some(x => x.away.some(p => p.label === 'Lv 3 · saved')), 'away, a repaint over a value past its TTL reads "· saved" (no stretched TTL)');
  }
  {
    // a value a sleep left an hour old is stale until the catch-up answer lands
    const r = await topbarAcrossAway({ awayMs: 20000, frozenMs: 3600000 });
    A.ok(r.atReturn.length >= 1 && r.atReturn.every(t => t === 'Lv 3 · saved'), 'an hour-old value after a sleep reads "· saved" while the catch-up read is out: ' + JSON.stringify(r.atReturn));
    A.eq(r.after, 'Lv 3', '…until it answers');
  }
  {
    // an away read the station failed is stale (an error, not an age)
    const r = await topbarAcrossAway({ awayMs: 40000, failAway: true });
    A.ok(r.away.some(p => p.error && p.label === 'Lv 3 · saved'), 'an away read that failed reads "· saved": ' + JSON.stringify(r.away));
    A.eq(r.after, 'Lv 3', '…and the catch-up answer on return makes it live again');
  }
  A.report('queryspine.test');
})().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
