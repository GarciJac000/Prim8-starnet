---
fingerprint: 10ecf010
slug: a-cron-advance-anchored-inside-a-fall-back-repea
title: A cron advance anchored inside a fall-back repeated hour fires that day's ambiguous time a second time
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 822503be5
origin: audit
---

# A cron advance anchored inside a fall-back repeated hour fires that day's ambiguous time a second time

## Symptom

On the night the clocks fall back, a daily routine scheduled inside the repeated hour (e.g. 01:30) can run twice: once as the late catch-up for 01:30 EDT and again at 01:30 EST twenty minutes later — a duplicate paid run the documented policy ("fires EXACTLY ONCE at the FIRST occurrence") forbids.

## Repro

1. `const s = cron.parseSchedule('30 1 * * *', Date.UTC(2026,9,30), { tz: 'America/New_York' })`.
2. A job due at 01:30 EDT (05:30Z) noticed late at 01:10 EST (06:10Z — a machine asleep through 01:30 EDT, or a transient-retry instant landing in the second pass): `cron.planTick([{ id:'j', enabled:true, schedule:s, nextRunAt:'2026-11-01T05:30:00Z', lastRunAt:'2026-10-31T05:30:00Z' }], Date.parse('2026-11-01T06:10:00Z'), {})`.
3. Persist its `next[0].nextAt` and tick again at 06:31Z.
Deterministic: `test/cron.dst.test.js` block 4b.

## Evidence

Before the fix (scratchpad dst1.js): `from 06:05Z (01:05 EST, second pass) -> 2026-11-01T06:30:00Z` (today's 01:30 EST); the late tick planned `fire:[05:30Z]` with `next: 06:30Z`, and the 06:31Z tick fired again: `{"fire":[{"jobId":"j","scheduledFor":1793514600000}]}`. Root cause: `nextCronFireAt` in `sidecar/cron.js` armed its fall-back repeat band only when the scan CROSSED the transition, so an anchor already in the second pass never suppressed the repeat. `test/cron.dst.test.js` 4b went RED (4 problems) before, GREEN after; Lord Howe (30-min shift) and Santiago (midnight-straddling) checked by hand; 2000-call timing unchanged (10.8s vs 11.7s).

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed: before the scan, if the UTC offset dropped within the last 2h, the transition minute is binary-searched and the same repeat band is pre-armed. A job created inside the second pass now waits for the next day (the day's first 01:30 already passed) — consistent with the first-occurrence policy.
