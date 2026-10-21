---
fingerprint: 7ae7e435
slug: a-clock-that-jumped-ahead-and-was-corrected-back
title: A clock that jumped ahead and was corrected back strands recurring routines for the length of the jump
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 6102a1612
origin: audit
---

# A clock that jumped ahead and was corrected back strands recurring routines for the length of the jump

## Symptom

If the PC boots with its clock wrong in the future (dead CMOS battery, a VM resumed with a skewed clock) and the clock is corrected minutes later, every recurring routine goes silent for the length of the jump — an hourly check and a daily 9am brief showed "next in 7d" and fired nothing for a week.

## Repro

1. Create `every 1h` (and `0 9 * * *`) at T.
2. Tick once at T+7d (the clock jumped): the routine fires its catch-up and markRun settles at T+7d.
3. Tick every minute from T+5min for two real days (the clock was corrected).
Deterministic: `test/cron.clock-rewind.test.js` (scratchpad clockjump.js is the same replay).

## Evidence

Before: `every 1h | after the correction: fires in the next 2 real days = 0 | stored nextRunAt 2026-10-27T13:00:00Z` and `0 9 * * * | … = 0 | stored nextRunAt 2026-10-28T09:00:00Z`. Root cause: `planTick` in `sidecar/cron.js` only asks whether the persisted nextRunAt is due; nothing recognises a nextRunAt advanced by a clock that later went backwards. Test RED (4 problems) before, GREEN after; the 13 existing cron unit suites unchanged.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed: a recurring job whose `lastRunAt` is more than 5 minutes in the FUTURE (the trace of a rewound clock) is re-anchored from the real now (no fire). A forward jump still collapses the missed backlog to one catch-up per routine, as designed.
