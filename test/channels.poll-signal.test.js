/* node test/channels.poll-signal.test.js — a channel's long-poll never leaks a signal per poll.

   Before: every poll built `AbortSignal.any([ac.signal, AbortSignal.timeout(deadline)])`, where ac.signal lives
   for the whole connection. On Node 22 the long-lived parent keeps every composite it ever fed reachable
   (~1.8 KB retained per poll after GC): a Discord/Slack poll at ~1.25/s grew the heap ~225 MB/day, freed only
   on reconnect. Now each poll gets ONE short-lived controller whose deadline timer and parent listener are
   released the moment the poll settles.

   Laws under test:
     • 20k polls on one connection retain (almost) nothing after GC;
     • each poll gets its own signal, and disconnect still aborts the in-flight poll (the loop exits);
     • a stalled poll is still cut by the deadline with a TimeoutError — a deadline is NOT a disconnect, so the
       loop re-polls instead of exiting. */
'use strict';
const A = require('./_assert.js');
const v8 = require('v8');
const vm = require('vm');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const normalize = (ru) => ({ offset: ru.id, message: null });
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 4; i++) { gc(); await tick(); } };
const parked = (signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

(async () => {
  // ---- 1. 20k polls retain ~nothing; each poll has its own signal; disconnect aborts the parked poll ----
  {
    const N = 20000;
    let polls = 0, lastSignal = null, distinct = 0, release = null;
    const transport = {
      getUpdates({ signal }) {
        polls++;
        if (signal !== lastSignal) distinct++;
        lastSignal = signal;
        if (polls < N) return new Promise(r => setImmediate(() => r([])));   // an empty long-poll answer
        return new Promise((resolve, reject) => { release = () => resolve([]); parked(signal).catch(reject); });
      },
      send: async () => ({ ok: true })
    };
    const a = makeChannelAdapter({ transport, normalize, name: 'discord', dropPendingOnConnect: false, pollTimeoutSec: 30,
      onInbound: () => {}, clock: { now: () => 1 }, sleep: () => Promise.resolve() });
    await settle();
    const before = process.memoryUsage().heapUsed;
    await a.connect();
    while (polls < N) await tick();
    await settle();
    const retainedMb = (process.memoryUsage().heapUsed - before) / 1e6;
    A.ok(retainedMb < 5, '20k polls on one connection retain < 5 MB after GC (retained ' + retainedMb.toFixed(1) + ' MB; the leak was ~35 MB)');
    A.eq(distinct, N, 'every poll gets its own short-lived signal');
    const inFlight = lastSignal;
    await a.disconnect();
    A.ok(inFlight.aborted, 'disconnect still aborts the in-flight poll');
    A.ok(typeof release === 'function', 'the last poll was parked when disconnect arrived');
  }

  // ---- 2. a stalled poll is cut by the deadline (TimeoutError) and the loop RE-POLLS ----
  {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms) { const a = Array.prototype.slice.call(arguments, 2); return realSetTimeout.apply(null, [fn, ms >= 15000 ? 20 : ms].concat(a)); };
    try {
      const reasons = [];
      let polls = 0;
      const transport = {
        getUpdates({ signal }) {
          polls++;
          return parked(signal).catch(e => { reasons.push(e && e.name); throw e; });
        },
        send: async () => ({ ok: true })
      };
      const a = makeChannelAdapter({ transport, normalize, name: 'telegram', dropPendingOnConnect: false, pollTimeoutSec: 0,
        onInbound: () => {}, clock: { now: () => 1 }, sleep: () => Promise.resolve() });
      await a.connect();
      const t0 = Date.now();
      while (polls < 3 && Date.now() - t0 < 5000) await new Promise(r => realSetTimeout(r, 10));
      A.ok(polls >= 3, 'a deadline-cut poll is retried, not treated as a disconnect (' + polls + ' polls)');
      A.eq(reasons[0], 'TimeoutError', 'the deadline aborts with a TimeoutError, like AbortSignal.timeout did');
      await a.disconnect();
    } finally { global.setTimeout = realSetTimeout; }
  }

  A.report('channels.poll-signal.test');
})().catch(e => { console.error(e); process.exit(1); });
