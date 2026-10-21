/* node test/cron.dst.test.js — TIMEZONE / DST correctness of the pure cron-math (G4.1).
   Proves a tz-aware cron schedule fires on LOCAL wall-clock and shifts across DST, with the two
   hard cases pinned to an explicit, documented policy:
     · SPRING/FALL: `0 9 * * *` America/New_York fires 09:00 LOCAL on both sides of a transition
       (−05:00 EST before / −04:00 EDT after spring), and the spanning day is 23h / 25h long.
     · NONEXISTENT (spring-forward skipped hour): `30 2 * * *` on 2026-03-08 — 02:30 local never
       exists — fires EXACTLY ONCE at the post-transition instant (03:30 local = 07:30Z), never
       silently skipped, never doubled.
     · AMBIGUOUS (fall-back doubled hour): `30 1 * * *` on 2026-11-01 — 01:30 local occurs twice —
       fires EXACTLY ONCE (the FIRST occurrence), never twice.
     · A tz TYPO fails parse (must NOT silently fall back to UTC and re-introduce the lie).
     · DEFAULT tz = UTC preserves the pre-tz behavior byte-for-byte (no signature break).
   Everything is injected-clock + pure (no wall-clock read), exactly like cron.test.js. */
'use strict';
const A = require('./_assert.js');
const cron = require('../sidecar/cron.js');

const NY = 'America/New_York';
const U = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi);       // a UTC instant, ms epoch
// the local wall-clock "HH:MM" an instant shows in a tz (the ground truth we assert fires LAND on).
function localHM(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(ms);
}

// ---- 1. SPRING-FORWARD: `0 9 * * *` NY fires 09:00 local on both sides; the spanning day is 23h ----
{
  // anchor just before 2026-03-07 09:00 EST. Both the 03-07 and 03-08 fire must read 09:00 local.
  const anchor = U(2026, 3, 7, 13, 58);                            // 08:58 EST on 03-07
  const sched = cron.parseSchedule('0 9 * * *', anchor, { tz: NY });
  A.eq(sched && sched.kind, 'cron', 'tz cron parses');
  A.eq(sched.tz, NY, 'schedule carries its IANA tz');

  const fire1 = cron.nextFireAt(sched, null, anchor);
  A.eq(fire1, U(2026, 3, 7, 14, 0), 'pre-spring daily fire = 09:00 EST (−05:00) = 14:00Z');
  A.eq(localHM(fire1, NY), '09:00', 'pre-spring fire reads 09:00 local');

  const fire2 = cron.nextFireAt(sched, cron._internals.iso(fire1), fire1);
  A.eq(fire2, U(2026, 3, 8, 13, 0), 'post-spring daily fire = 09:00 EDT (−04:00) = 13:00Z');
  A.eq(localHM(fire2, NY), '09:00', 'post-spring fire still reads 09:00 local (offset shifted, wall-time fixed)');

  A.eq(fire2 - fire1, 23 * 3600000, 'the spring-forward day spans exactly 23h between consecutive 09:00 fires');
}

// ---- 2. FALL-BACK: `0 9 * * *` NY fires 09:00 local on both sides; the spanning day is 25h ----
{
  const anchor = U(2026, 10, 31, 12, 58);                          // 08:58 EDT on 10-31
  const sched = cron.parseSchedule('0 9 * * *', anchor, { tz: NY });

  const fire1 = cron.nextFireAt(sched, null, anchor);
  A.eq(fire1, U(2026, 10, 31, 13, 0), 'pre-fall daily fire = 09:00 EDT (−04:00) = 13:00Z');
  A.eq(localHM(fire1, NY), '09:00', 'pre-fall fire reads 09:00 local');

  const fire2 = cron.nextFireAt(sched, cron._internals.iso(fire1), fire1);
  A.eq(fire2, U(2026, 11, 1, 14, 0), 'post-fall daily fire = 09:00 EST (−05:00) = 14:00Z');
  A.eq(localHM(fire2, NY), '09:00', 'post-fall fire still reads 09:00 local');

  A.eq(fire2 - fire1, 25 * 3600000, 'the fall-back day spans exactly 25h between consecutive 09:00 fires');
}

// ---- 3. NONEXISTENT local time (the hardest case): `30 2 * * *` on a spring-forward day ----
{
  // 2026-03-08 NY: the local clock jumps 01:59 -> 03:00, so 02:30 local NEVER exists.
  // POLICY: fire EXACTLY ONCE at the post-transition instant (03:30 local = 07:30Z) — never skipped, never doubled.
  const anchor = U(2026, 3, 8, 6, 0);                              // 01:00 EST on 03-08, before the gap
  const sched = cron.parseSchedule('30 2 * * *', anchor, { tz: NY });
  A.eq(sched && sched.kind, 'cron', 'nonexistent-time schedule parses');

  const fire = cron.nextFireAt(sched, null, anchor);
  A.eq(fire, U(2026, 3, 8, 7, 30), 'nonexistent 02:30 fires at the post-transition instant 03:30 local = 07:30Z');

  // EXACTLY ONCE: advancing strictly past that fire jumps to the NEXT day, not a second fire that day.
  const after = cron.nextFireAt(sched, cron._internals.iso(fire), fire);
  A.eq(after, U(2026, 3, 9, 6, 30), 'the very next fire is 02:30 EDT the FOLLOWING day (07:30 - 1h offset back to normal 02:30=06:30Z), not a double-fire on 03-08');
  A.ok(after > fire, 'next fire is strictly later (never doubled)');
}

// ---- 3b. NONEXISTENT time in a gap that STRADDLES LOCAL MIDNIGHT (Havana: transition at 00:00) ----
// Cuba springs forward AT midnight: 23:59 Mar 7 -> 01:00 Mar 8, so minute-of-day reads 1439 -> 60 and the
// plain `>` gap test saw nothing — a `30 0 * * *` routine's fire was silently SKIPPED that day, violating
// the never-skipped policy the function documents. The rollover-adjusted axis (-1 -> 60) sees the gap.
{
  const HV = 'America/Havana';
  const anchor = U(2026, 3, 7, 5, 28);                             // 00:28 local Mar 7 (-05:00)
  const sched = cron.parseSchedule('30 0 * * *', anchor, { tz: HV });
  const fire1 = cron.nextFireAt(sched, null, anchor);
  A.eq(fire1, U(2026, 3, 7, 5, 30), 'pre-transition daily fire = 00:30 CST (-05:00) = 05:30Z');
  A.eq(localHM(fire1, HV), '00:30', 'pre-transition fire reads 00:30 local');
  const fire2 = cron.nextFireAt(sched, cron._internals.iso(fire1), fire1);
  A.eq(fire2, U(2026, 3, 8, 5, 30), 'the skipped 00:30 fires at its post-transition equivalent (01:30 CDT = 05:30Z), not skipped');
  A.eq(localHM(fire2, HV), '01:30', 'post-transition fire reads 01:30 local (00:30 shifted across the 1h gap)');
  const fire3 = cron.nextFireAt(sched, cron._internals.iso(fire2), fire2);
  A.eq(fire3, U(2026, 3, 9, 4, 30), 'exactly once: the next fire is Mar 9 00:30 CDT (-04:00) = 04:30Z');
  A.eq(localHM(fire3, HV), '00:30', 'and the schedule is back on its wall time');
}

// ---- 4. AMBIGUOUS local time: `30 1 * * *` on a fall-back day fires once (the FIRST occurrence) ----
{
  // 2026-11-01 NY: 01:30 local occurs TWICE — first at 05:30Z (EDT) then at 06:30Z (EST).
  // POLICY: fire EXACTLY ONCE at the FIRST occurrence (05:30Z), never twice.
  const anchor = U(2026, 11, 1, 4, 0);                             // 00:00 EDT on 11-01, before both occurrences
  const sched = cron.parseSchedule('30 1 * * *', anchor, { tz: NY });

  const fire = cron.nextFireAt(sched, null, anchor);
  A.eq(fire, U(2026, 11, 1, 5, 30), 'ambiguous 01:30 fires at the FIRST occurrence (05:30Z, EDT)');
  A.eq(localHM(fire, NY), '01:30', 'the first occurrence reads 01:30 local');

  // advancing strictly past the first occurrence must NOT fire again that same local hour — next is the following day.
  const after = cron.nextFireAt(sched, cron._internals.iso(fire), fire);
  A.eq(after, U(2026, 11, 2, 6, 30), 'after the first 01:30 the next fire is 01:30 EST the FOLLOWING day, not the 06:30Z repeat');
  A.ok(after > U(2026, 11, 1, 6, 30), 'the doubled 06:30Z occurrence is NOT a second fire');
}

// ---- 4b. AMBIGUOUS, anchor INSIDE the repeated hour (sweep/autonomy 2026-10-20) ----
// The fall-back watermark was only armed when the SCAN crossed the transition. An advance computed from an anchor
// already in the second pass (01:00–01:59 EST) saw no transition, matched 01:30 EST and fired the day's 01:30 a
// SECOND time: a machine asleep through 01:30 EDT and woken at 01:10 EST ran the late catch-up AND the repeat.
{
  const sched = cron.parseSchedule('30 1 * * *', U(2026, 10, 30, 0, 0), { tz: NY });
  const inRepeat = U(2026, 11, 1, 6, 10);                          // 01:10 EST — the SECOND pass of 01:xx
  A.eq(cron._internals.nextCronFireAt(sched, inRepeat, NY), U(2026, 11, 2, 6, 30), 'an anchor inside the repeated hour never re-matches that day\'s 01:30 (next is 11-02)');
  // the whole scheduler path: 01:30 EDT due, noticed late at 01:10 EST (within grace) -> one catch-up, then tomorrow
  const job = { id: 'j', enabled: true, schedule: sched, nextRunAt: new Date(U(2026, 11, 1, 5, 30)).toISOString(), lastRunAt: new Date(U(2026, 10, 31, 5, 30)).toISOString() };
  const late = cron.planTick([job], inRepeat, {});
  A.eq(late.fire.length, 1, 'the late wake still runs the missed 01:30 once (fire_once inside grace)');
  A.eq(late.next[0] && late.next[0].nextAt, U(2026, 11, 2, 6, 30), 'and advances to TOMORROW, not to the 01:30 EST repeat 20 minutes later');
  // a transient-retry instant that lands in the second pass (markRun backoff) is the same anchor shape
  A.eq(cron._internals.nextCronFireAt(sched, U(2026, 11, 1, 6, 3), NY), U(2026, 11, 2, 6, 30), 'a retry at 01:03 EST does not schedule the 01:30 repeat either');
  // outside the repeat the ordinary answers are unchanged
  A.eq(cron._internals.nextCronFireAt(sched, U(2026, 11, 1, 7, 10), NY), U(2026, 11, 2, 6, 30), '02:10 EST (past the repeat) -> tomorrow');
  A.eq(cron._internals.nextCronFireAt(sched, U(2026, 11, 1, 5, 10), NY), U(2026, 11, 1, 5, 30), '01:10 EDT (first pass) -> the first occurrence today');
  // an every-15-min cron follows the same policy: nothing inside the repeat, next at 02:00 EST
  const q = cron.parseSchedule('*/15 * * * *', U(2026, 10, 30, 0, 0), { tz: NY });
  A.eq(cron._internals.nextCronFireAt(q, U(2026, 11, 1, 6, 10), NY), U(2026, 11, 1, 7, 0), '*/15 anchored in the repeat resumes at 02:00 EST, like a scan that crossed the transition');
}

// ---- 5. a tz TYPO fails parse — never a silent UTC fall-back ----
{
  A.eq(cron.parseSchedule('0 9 * * *', 0, { tz: 'America/New_Yrok' }), null, 'an IANA typo -> null (no silent UTC fallback)');
  A.eq(cron.parseSchedule('0 9 * * *', 0, { tz: 'Mars/Phobos' }), null, 'a bogus zone -> null');
  A.eq(cron.parseSchedule('0 9 * * *', 0, { tz: 'not a zone' }), null, 'garbage tz -> null');
}

// ---- 6. DEFAULT tz = UTC preserves the pre-tz behavior (no signature break for tz-less schedules) ----
{
  const base = U(2026, 6, 19, 8, 58);
  const tzless = cron.parseSchedule('0 9 * * *', base);            // no opts at all -> UTC, as before
  A.ok(tzless == null || tzless.tz == null || tzless.tz === 'UTC', 'a tz-less schedule has no IANA tz (default UTC)');
  A.eq(cron.nextFireAt(tzless, null, base), U(2026, 6, 19, 9, 0), 'tz-less daily cron still matches on UTC (09:00Z), unchanged');

  // an explicit tz:'UTC' is equivalent to tz-less.
  const utc = cron.parseSchedule('0 9 * * *', base, { tz: 'UTC' });
  A.eq(cron.nextFireAt(utc, null, base), U(2026, 6, 19, 9, 0), 'explicit tz:UTC matches the same 09:00Z instant');
}

// ---- 7. an injected defaultTz is honored when a schedule omits its own tz (host-tz injection, not ambient) ----
{
  const anchor = U(2026, 3, 7, 13, 58);
  // parse with NO tz, then resolve the next fire under an injected default tz — the host-tz constant path.
  const tzless = cron.parseSchedule('0 9 * * *', anchor);
  const fire = cron.nextFireAt(tzless, null, anchor, { defaultTz: NY });
  A.eq(fire, U(2026, 3, 7, 14, 0), 'an injected defaultTz makes a tz-less schedule fire on local wall-clock (09:00 EST = 14:00Z)');
  A.eq(localHM(fire, NY), '09:00', 'injected-default-tz fire reads 09:00 local');
  // a schedule's OWN tz wins over the injected default. The anchor (13:58Z on 03-07) is already past
  // 09:00Z that day, so the next UTC fire is 09:00Z on 03-08 — and crucially NOT a tz-shifted instant.
  const owned = cron.parseSchedule('0 9 * * *', anchor, { tz: 'UTC' });
  A.eq(cron.nextFireAt(owned, null, anchor, { defaultTz: NY }), U(2026, 3, 8, 9, 0), "a schedule's own tz:UTC overrides the injected defaultTz (matches on UTC, not NY)");
}

A.report('cron.dst');
