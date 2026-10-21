---
fingerprint: a8f9ad8b
slug: the-away-workshop-card-counts-down-to-its-next-s
title: The away-workshop card counts down to its next shift while scheduling is OFF or E-STOPped
surface: autonomy
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: c6b725e8f
origin: audit
---

# The away-workshop card counts down to its next shift while scheduling is OFF or E-STOPped

## Symptom

With the away workshop granted, turn scheduling OFF (or press the E-STOP): ROUTINES, the apps list and GET /api/cron all say routines are off, but the agent's workshop card keeps counting down "next shift in 6h" to a shift that will never fire.

## Repro

1. Boot a seeded station; `POST /api/workshop/grant { agentId:'agent', on:true }` (arms scheduling, creates the 6-hour shift routine).
2. `POST /api/cron/arm { enabled:false }`, then read `GET /api/workshop/backlog?agent=agent`.
3. `POST /api/cron/arm { enabled:true }` + `POST /api/halt`, read it again.
Regression: `test/workshop-next-shift-truth.http.test.js`.

## Evidence

Live (scratchpad probeB, before): disarmed → `cron: { enabled:false }`, `apps: { routinesOn:false }`, but `workshopCard: { granted:true, nextShiftAt:"2026-10-20T13:08:05.820Z" }`; halted → `cron: { halted:true }`, same `nextShiftAt`. The consumer `renderWsLive` in `frontend/app/stationui.js` turns any `nextShiftAt` into `'next shift in ' + rel(due)`. Root cause: `handleWorkshopBacklog` in `sidecar/index.js` returned `routine.enabled && routine.nextRunAt` without consulting `cronArmed`/`cronHalted`. After: `nextShiftAt:null` with `shiftsPaused:'scheduler-off'|'halted'`; the card says "shifts paused — …". Test RED (5 problems) before, GREEN after.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed in the route and its one consumer (website mirror synced).
