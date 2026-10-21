---
fingerprint: 72fef60f
slug: the-night-shift-panel-shows-a-next-job-clock-tha
title: The night-shift panel shows a next-job clock that a spent leash or a held gate will not honor
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: c6ebbb0ce
origin: audit
---

# The night-shift panel shows a next-job clock that a spent leash or a held gate will not honor

## Symptom

SETTINGS › AUTONOMY › NIGHT SHIFT shows "NEXT JOB EARLIEST 5:35 PM" when today's job limit is already used (no job can run before the leash refills at local midnight), and shows a clock — sometimes one already in the past — when the shift is held by an exhausted budget, a missing provider or the readiness gate.

## Repro

1. `NightReport.panelModel({ status:{ active:true, away:true, binding:'leash', beatsUsedToday:3, leashPerDay:3, lastBeatAt:now-10min, nextEligibleAt:now+35min, leashResetsAt:<local midnight> }, tzOffsetMin:-240 })`.
2. Same with `binding:'budget'` and `nextEligibleAt` 15 minutes in the past.
Regression: `test/nightreport.test.js` (leash / no-clock bindings block).

## Evidence

Before (node -e against `frontend/app/nightreport.js`): leash → `{ why:"today’s job limit was already used", leash:"3 of 3 jobs today", next:"5:35 PM" }`; budget → `{ why:"the spending budget is exhausted…", next:"4:45 PM" }` at 5:00 PM. Root cause: `panelModel` special-cased only `posture` and `halt`; every other binding printed `fmtLocalTime(s.nextEligibleAt)` (the cooldown clock). Test RED (8 problems) before, GREEN after (131 assertions).

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed: leash names the refill time from the status's own `leashResetsAt`; budget / spend-unknown / no-provider / readiness / precheck-error / persist-failed say "not scheduled — held until the reason above is fixed". Website mirror synced.
