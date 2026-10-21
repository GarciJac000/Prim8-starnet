/* node test/overseer-pollgate.test.js — the overseer ledger beat moved onto PollGate and NOTHING ELSE moved
   (idle CPU piece 3, 2026-10-20).

   THE RULE. Only the scheduling changed: the same 2.5 s beat while the station can be seen, the 30 s floor while the
   Commander is away, and a catch-up read the moment they are back. What fresh() and unreachable() say — the rail's crew
   lamp and the DELEGATED rows read them — is trunk's, byte for byte. After a long away the catch-up ask is out against a
   ledger older than three beats, and trunk's label says so until that read lands: that is the truth (nobody has
   checked the station for that long), so nothing here vouches for old data.

   GENUINE (executed):
     1 · the label lines in frontend/app/overseer.js are trunk's verbatim, and no other line writes their state;
     2 · the REAL overseer.js, on a fake clock with its fetch held and released by the test, gives exactly trunk's
         fresh()/unreachable() for a grid of (okAt, askedAt, busy, failing) states and read times — the oracle below is
         trunk's formula, copied, evaluated over the state the test drove the module into;
     3 · the REAL overseer.js booted through the REAL pollgate.js: 2.5 s on screen, the 30 s floor away, and a wake runs
         the catch-up read at once. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../frontend/app/overseer.js'), 'utf8');

/* ---- 1 · the label logic is trunk's, byte for byte ---- */
const TRUNK_LINES = [
  "  let busy = false, lastDeliveries = '', last = null;",
  '  const BEAT = 2500;',
  '  let okAt = 0, failing = false, askedAt = 0;',
  '  const fresh = () => !!last && !failing && !(busy && Date.now() - okAt > 3 * BEAT);',
  '  const unreachable = () => failing || (busy && Date.now() - (okAt || askedAt) > 3 * BEAT);',
  "    if (busy || typeof Workstreams === 'undefined' || !Workstreams.generalId()) return;",
  '    busy = true; askedAt = Date.now();',
  '    const timeout = setTimeout(() => controller.abort(), 8000);',
  '      last = data; okAt = Date.now(); failing = false;',
  '      failing = true;',
  '    } finally { clearTimeout(timeout); busy = false; }',
  '  return { refresh, snapshot: () => last, fresh, unreachable };'
];
const lines = SRC.split('\n');
for (const want of TRUNK_LINES) A.ok(lines.some(l => l === want || l.startsWith(want + ' ')), 'trunk line kept verbatim: ' + want.trim());
// every write to the label's state is one of the lines above (a write elsewhere would change what the labels say)
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // comments say "last = …" too
const writes = name => (CODE.match(new RegExp('\\b' + name + '\\s*=(?!=)', 'g')) || []).length;
A.eq(writes('okAt'), 2, 'okAt: declared, and set only when an answer lands');
A.eq(writes('askedAt'), 2, 'askedAt: declared, and set only when an ask starts');
A.eq(writes('failing'), 3, 'failing: declared, cleared by an answer, set by a failed read');
A.eq(writes('busy'), 3, 'busy: declared, set by an ask, cleared when it settles');
A.eq(writes('last'), 2, 'last: declared, and set only by an answer');
A.ok(!/awayCover|lastAwayAt|performance\.now|okCadence|LATE_GRACE/.test(SRC), 'no formula that vouches for an answer across an away stretch, and no second clock');
A.ok(/PollGate\.every\(refresh, \{ ms: BEAT \}\)/.test(SRC), 'the beat runs through PollGate at the same 2.5 s');
A.ok(/else \{ refresh\(\); setInterval\(refresh, BEAT\); \}/.test(SRC), 'without PollGate it is trunk\'s interval');

/* trunk's formula, copied: the oracle every read below is held to */
const BEAT = 2500;
const oracle = (s, now) => ({
  fresh: !!s.last && !s.failing && !(s.busy && now - s.okAt > 3 * BEAT),
  unreachable: s.failing || (s.busy && now - (s.okAt || s.askedAt) > 3 * BEAT)
});

// one fake clock + timer queue for the overseer (and, in 3, the gate)
let T = 1e6, tid = 0;
const timers = new Map();
const setT = (fn, ms) => { const id = ++tid; timers.set(id, { fn, ms: ms || 0, at: T + Math.max(0, ms || 0) }); return id; };
const clearT = id => { timers.delete(id); };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const advance = async ms => {
  const end = T + ms;
  for (;;) {
    let nx = null; for (const [id, t] of timers) if (t.at <= end && (!nx || t.at < nx[1].at || (t.at === nx[1].at && id < nx[0]))) nx = [id, t];
    if (!nx) break; timers.delete(nx[0]); T = Math.max(T, nx[1].at); nx[1].fn(); await settle();
  }
  T = Math.max(T, end); await settle();
};
const LEDGER = { threads: [], reviews: [], workers: [{ runId: 'w1', status: 'running', parentStreamId: 'b' }] };
const overseerIn = extra => {
  const ctx = vm.createContext(Object.assign({
    module: { exports: {} }, console: { debug() {} }, AbortController, Date: { now: () => T },
    setTimeout: setT, clearTimeout: clearT, setInterval: () => { throw new Error('no bare interval when PollGate is present'); },
    Workstreams: { generalId: () => 'general', get: () => null, adopt: r => r }, App: { persist() {}, refreshRail() {} }
  }, extra));
  vm.runInContext(SRC, ctx, { filename: 'overseer.js' });
  return ctx.module.exports;
};

(async () => {
  /* ---- 2 · the REAL module across (okAt, askedAt, busy, failing) states equals trunk's formula ---- */
  {
    const held = [];   // each /api/overseer ask, answered or refused by the test
    const O = overseerIn({
      fetch: (_u, o) => new Promise((res, rej) => {
        held.push({ ok: () => res({ ok: true, json: async () => LEDGER }), refuse: () => res({ ok: false }) });
        o.signal.addEventListener('abort', () => rej(new Error('aborted')));
      })
    });
    const s = { last: null, okAt: 0, askedAt: 0, busy: false, failing: false };   // the state the test drives it into
    const READS = [0, 1, 2499, 2500, 7499, 7500, 7501, 8000, 30000, 3600000];
    let checked = 0;
    const holdsTo = (label, from) => {
      const t0 = T;
      for (const dt of READS) {
        T = from + dt;
        const want = oracle(s, T), got = { fresh: O.fresh(), unreachable: O.unreachable() };
        A.eq(JSON.stringify(got), JSON.stringify(want), label + ' — read ' + dt + ' ms in: trunk\'s labels');
        checked++;
      }
      T = t0;
    };
    const ask = () => { const p = O.refresh(); s.busy = true; s.askedAt = T; return p; };
    const answer = async p => { held.shift().ok(); await settle(); await p; s.busy = false; s.last = LEDGER; s.okAt = T; s.failing = false; };

    holdsTo('nothing asked yet', T);
    let p = ask();
    holdsTo('the first ask out, no answer yet', s.askedAt);
    T += 1200; await answer(p);
    holdsTo('answered', s.okAt);
    T += 3600000;   // an hour away with nothing asked: trunk only ages a ledger while an ask is out
    holdsTo('an hour later, nothing out', T);
    p = ask();
    A.eq(O.fresh(), false, 'the catch-up ask out against an hour-old ledger is not current (trunk)');
    A.eq(O.unreachable(), true, '…and trunk calls it unreachable until it answers (nobody has checked the station for an hour)');
    holdsTo('the catch-up ask out against an hour-old ledger', s.askedAt);
    T += 40; await answer(p);
    holdsTo('the catch-up answer lands', s.okAt);
    T += 2500; p = ask();
    holdsTo('the next beat out against a ledger one beat old', s.askedAt);
    // that ask runs into its 8 s deadline: the page's own timer aborts it
    T += 8000; const deadline = [...timers.values()].find(t => t.ms === 8000);
    A.ok(deadline, 'fixture: the ask armed its 8 s deadline');
    deadline.fn(); await settle(); await p; held.shift();
    s.busy = false; s.failing = true;
    holdsTo('the read failed at its deadline', T);
    p = ask();
    holdsTo('an ask out while failing', s.askedAt);
    T += 40; await answer(p);
    holdsTo('recovered', s.okAt);
    T += 2500; p = ask();
    held.shift().refuse(); await settle(); await p;
    s.busy = false; s.failing = true;
    holdsTo('a refused read', T);
    A.ok(checked >= 100, 'fixture: ' + checked + ' (state, read time) pairs held to trunk\'s formula');
    timers.clear();
  }

  /* ---- 3 · the REAL overseer on the REAL gate: same beat on screen, the away floor, a catch-up read on wake ---- */
  {
    const G = require('../frontend/app/pollgate.js');
    const listeners = {};
    const doc = {
      hidden: false,
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }, removeEventListener() {},
      fire(ev) { for (const fn of listeners[ev] || []) fn(); }
    };
    G._resetForTest(); G._setClockForTest(() => T); G._setTimersForTest(setT, clearT); G._setFrameForTest(null);
    G._setDocForTest(doc, null);
    let asks = 0, boot = null, askedAt = 0, answeredAt = 0;
    const O = overseerIn({
      PollGate: G,
      document: { addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') boot = fn; } },
      fetch: (_u, o) => { asks++; askedAt = T; return new Promise((res, rej) => {
        setT(() => { answeredAt = T; res({ ok: true, json: async () => LEDGER }); }, 40);
        o.signal.addEventListener('abort', () => rej(new Error('aborted')));
      }); }
    });
    A.ok(typeof boot === 'function', 'fixture: the overseer arms its beat on DOMContentLoaded');
    boot();
    A.eq(asks, 1, 'boot: the first ledger read goes out at once, as before');
    await advance(41);
    A.eq(O.fresh(), true, 'fixture: answered');
    await advance(4 * 2500);
    A.eq(asks, 5, 'on screen: one read every 2.5 s, trunk\'s beat');

    doc.hidden = true;   // minimized: hidden, no focus, no input, no frames
    const atAway = asks;
    await advance(120000);
    const awayReads = asks - atAway;
    A.ok(awayReads >= 3 && awayReads <= 5, 'away: the 30 s floor (' + awayReads + ' reads in 2 min; it was 48)');
    A.ok(O.snapshot() === LEDGER && !O.unreachable(), 'away: each floor read answers and the ledger stays the station\'s');

    // back 20 s after the last away read: the catch-up read goes out in the wake itself, before any timer runs
    if (T - askedAt < 20000) await advance(20000 - (T - askedAt));
    const before = asks, okAt = answeredAt;
    doc.hidden = false; doc.fire('visibilitychange');
    A.eq(asks, before + 1, 'WAKE: the catch-up read is out at once, not on the next beat');
    const want = oracle({ last: LEDGER, okAt, askedAt: T, busy: true, failing: false }, T);
    A.eq(JSON.stringify({ fresh: O.fresh(), unreachable: O.unreachable() }), JSON.stringify(want), 'WAKE: while that read is out against a ledger ' + Math.round((T - okAt) / 1000) + ' s old, the labels are trunk\'s');
    A.eq(O.fresh(), false, '…which do not vouch for it (nobody checked the station for 20 s) until the read lands');
    await advance(41);
    A.eq(O.fresh(), true, 'WAKE: the catch-up answer makes it current again');
    A.eq(O.unreachable(), false, '…and reachable');
    const back = asks;
    await advance(2500);
    A.eq(asks, back + 1, 'back on screen: the 2.5 s beat resumes');
    G._resetForTest();
  }

  A.report('overseer-pollgate.test');
})().catch(e => { console.error(e); process.exit(1); });
