---
fingerprint: 94e4036f
slug: a-one-shot-routine-whose-time-already-passed-is
title: A one-shot routine whose time already passed is stored and fires on the next tick
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 17e0d3965
origin: audit
---

# A one-shot routine whose time already passed is stored and fires on the next tick

## Symptom

Schedule a one-shot for a date that already passed (a model a day or a year off on today's date, a typo): the routine is accepted, the preview lists the past instant as its next fire, and it runs immediately on the next tick — while the reply said "scheduled for <that date>". The slash preview even says "(this schedule has already passed — it will never fire)" about the same input.

## Repro

1. `POST /api/cron/preview { schedule: <yesterday ISO> }`.
2. `POST /api/cron { name, prompt, schedule: <yesterday ISO>, arm:true }` with scheduling on and a mock provider.
3. Wait one tick; count provider calls and read the job.
Regression: `test/cron.api.test.js` (past one-shot block).

## Evidence

Live (scratchpad probeE, before): preview `{ ok:true, kind:"once", next:["2026-10-19T11:31:00.000Z"] }`; create `status 200`; within 8s the provider received the routine run and the job read `{ state:"completed", lastStatus:"ok" }`. Root cause: `parseCronScheduleOr400` in `sidecar/index.js` accepted any parsed `once` regardless of `runAt` (English parsing refuses a past "today at 5pm", ISO did not). After: create and preview both 400 "that time already passed (…) — give a future time"; zero provider calls. `test/cron.api.test.js` RED (7 problems, the stored routine cascading into later counts) before, GREEN after; `test/cron.arm.test.js` seeded its due-now routine with a past ISO and now uses `in 1s`.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed at the one parse seam create/update/preview/routine.create share (60s tolerance for "now").
