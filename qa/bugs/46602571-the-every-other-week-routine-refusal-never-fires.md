---
fingerprint: 46602571
slug: the-every-other-week-routine-refusal-never-fires
title: The every-other-week routine refusal never fires because its regex carries backspace bytes
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 163c2d772
origin: audit
---

# The every-other-week routine refusal never fires because its regex carries backspace bytes

## Symptom

Asking for a routine "every other monday at 10am" (or "fortnightly", "biweekly", "every 2 weeks", "twice a month") returns the generic "couldn't read that schedule — try \"every day at 9am\"…" instead of the shipped explanation that every-other-week cannot be scheduled and what to use instead.

## Repro

1. POST /api/cron/preview `{ "schedule": "every other monday at 10am" }` (or POST /api/cron).
2. Read the 400 error.

## Evidence

Live on :9711 with trunk's `sidecar/index.js`: `cron preview "every other monday at 10am" 400 {"ok":false,"error":"couldn't read that schedule — try \"every day at 9am\", …"}`. With the fix: `400 {"ok":false,"error":"every other week cannot be scheduled — use one weekday (\"mondays at 10am\") or two dates a month (\"the 1st and 15th of every month at 10am\"), and tell the Commander which you chose"}` (also for "fortnightly"; "mondays at 10am" still 200).

Cause: `sidecar/index.js:15561` parseCronScheduleOr400 — the regex carried nine literal 0x08 bytes where `\b` was meant, so it matched nothing. Guard: `test/source-collapsed-escapes.test.js`.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Found by the providers lane while hunting the same byte in friendlyerror.js (a1ce5839). Bytes restored to `\b`; the refusal now fires. Filed under autonomy (routines) since that is the surface the user meets.
