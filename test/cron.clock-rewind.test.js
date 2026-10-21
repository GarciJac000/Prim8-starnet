/* node test/cron.clock-rewind.test.js — a wall clock that jumped FORWARD and was then corrected back must not strand
   every recurring routine at the bad clock's future (sweep/autonomy 2026-10-20). Pure planTick + store reducers.

   THE HOLE: a boot with a wrong RTC (or a VM resumed with a skewed clock) ticks at "next week": each recurring routine
   fires its one catch-up and advance-before-run persists nextRunAt a period past THAT time. Minutes later NTP puts the
   clock back. planTick only ever asks "is nextRunAt due?", so an hourly routine and a daily 9am routine both went
   silent for the whole week (0 fires in 2 real days, "next in 7d"). A recurring routine whose lastRunAt is in the
   FUTURE is the unambiguous trace of a rewound clock; planTick now re-anchors its next fire from the real now
   (without firing) instead of sleeping until the bad clock catches up. A normal schedule is untouched. */
'use strict';
const A = require('./_assert.js');
const cron = require('../sidecar/cron.js');
const store = require('../sidecar/cron-store.js');

const H = 3600000, D = 24 * H;
const T = Date.UTC(2026, 9, 20, 12, 0);
const iso = ms => new Date(ms).toISOString();

function simulate(spec) {
  let jobs = store.createJob([], { name: spec, prompt: 'p', schedule: cron.parseSchedule(spec, T), agentId: 'agent' }, { id: 'j', now: T, defaultTz: 'UTC' });
  const jumped = T + 7 * D;                                  // the clock reads a week ahead
  const p = cron.planTick(jobs, jumped, { defaultTz: 'UTC' });
  jobs = jobs.map(j => Object.assign({}, j, { nextRunAt: iso(p.next[0].nextAt) }));
  jobs = store.markRun(jobs, 'j', { runId: 'r1', status: 'ok', reason: 'done' }, { now: jumped + 60000, defaultTz: 'UTC' });
  const fires = [];
  for (let t = T + 5 * 60000; t < T + 2 * D; t += 60000) {   // NTP corrected it: two REAL days of 1-minute ticks
    const q = cron.planTick(jobs, t, { defaultTz: 'UTC' });
    for (const nx of q.next) jobs = jobs.map(j => (j.id === nx.jobId ? Object.assign({}, j, { nextRunAt: iso(nx.nextAt) }) : j));
    if (q.fire.length) { fires.push(t); jobs = store.markRun(jobs, 'j', { runId: 'r' + t, status: 'ok', reason: 'done' }, { now: t, defaultTz: 'UTC' }); }
  }
  return { fires, job: store.getJob(jobs, 'j') };
}

{
  const r = simulate('every 1h');
  A.ok(r.fires.length >= 40, 'an hourly routine keeps firing after the clock is corrected back (fired ' + r.fires.length + 'x in 2 real days)');
  A.ok(r.fires[0] - (T + 5 * 60000) <= H + 60000, 'its first fire after the correction is within one period of the real now');
}
{
  const r = simulate('0 9 * * *');
  A.eq(r.fires.map(t => iso(t).slice(11, 16)), ['09:00', '09:00'], 'a daily 9am routine fires each real 9:00 after the correction (not a week later)');
  A.eq(r.fires.length ? iso(r.fires[0]).slice(0, 10) : null, '2026-10-21', 'the first one is the very next real 9:00');
}
// an ordinary routine (lastRunAt in the past) is untouched: a not-due job yields no fire and no rewrite
{
  const jobs = [Object.assign(store.makeJob({ name: 'n', prompt: 'p', schedule: cron.parseSchedule('every 1h', T), agentId: 'agent' }, { id: 'n', now: T }), { lastRunAt: iso(T - 10 * 60000), nextRunAt: iso(T + 50 * 60000) })];
  const q = cron.planTick(jobs, T, {});
  A.eq([q.fire.length, q.next.length], [0, 0], 'a healthy not-yet-due routine is left exactly as it is');
}
// a lastRunAt only slightly ahead (clock skew between settlement and tick) is not treated as a rewind
{
  const jobs = [Object.assign(store.makeJob({ name: 'n', prompt: 'p', schedule: cron.parseSchedule('every 1h', T), agentId: 'agent' }, { id: 'n', now: T }), { lastRunAt: iso(T + 30000), nextRunAt: iso(T + H) })];
  A.eq(cron.planTick(jobs, T, {}).next.length, 0, 'a few seconds of skew is not a rewound clock');
}

A.report('cron.clock-rewind');
