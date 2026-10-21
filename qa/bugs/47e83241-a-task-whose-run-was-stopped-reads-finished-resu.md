---
fingerprint: 47e83241
slug: a-task-whose-run-was-stopped-reads-finished-resu
title: A task whose run was stopped reads FINISHED - RESULT READY on the board
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: 898cdd327
origin: audit
---

# A task whose run was stopped reads FINISHED - RESULT READY on the board

## Symptom

The Commander STARTs a TASKS card, then presses ■ Stop while the run is working. The card in IN PROGRESS reads
"FINISHED — RESULT READY", and the column header counts it as "1 READY TO OPEN". The run never finished: the
sidecar recorded it as `cancelled`, and the reply is a cut-off fragment marked "stopped by you". The same happens for
an in-band stop (budget or step limit), where the envelope first settled the run as completed. The false chip
persists across a restart.

## Repro

1. TASKS › ADD TASK `Task four halted SLOW:40` (the mock streams one token a second), then START.
2. After ~5 s press ■ Stop in COMMS.
3. Reopen TASKS and read the card's chip and the IN PROGRESS header.

## Evidence

Live, before the fix:

```
{"ok":null,"reason":"","chip":"IN PROGRESS 11 READY TO OPEN:FINISHED — RESULT READY",
 "hist":["user: Task four halted SLOW:40","assistant[stopped]: tick0 tick1 tick2 tick3 "],"runReason":["cancelled"]}
```

Cause: the deliberate-Stop branch of `chat.js`'s run catch recorded no outcome. `appendRun` had reset `lastRunOk` to
null, and `stateChip` in `frontend/app/stationui.js` renders a null outcome with runs as
`<div class="kb-state done">FINISHED — RESULT READY</div>`. The in-band stop path called
`Workstreams.noteRunEnd(ws.id, thisRunId, true)` first. MY WORK (`frontend/app/workview.js`) already rendered the
same record as "Run outcome is unconfirmed", so the board disagreed with the app's other view of the same task.

Regression: `test/board-stopped-run.test.js` (10 failures before, 16 ok after; it runs the real `stateChip`,
`activeAggregate`, `noteStopReason` and Workstreams store).

After the fix, live and across a `taskkill` restart:
`{"ok":null,"reason":"stopped","chip":"IN PROGRESS 21 STOPPED · 1 READY TO OPEN:■ STOPPED — REVIEW"}`. The second
card in that column was stopped before the fix and has no recorded reason.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._

## Verdict

Fixed. `noteStopReason` now also settles the stream's outcome: `noteRunEnd(id, runId, null, 'stopped' | reason)`.
`noteRunEnd` accepts `null` meaning no verdict. The board chip and the column count read a recorded reason with a
null verdict as STOPPED. The rail is unchanged, so a stop is not shown with the failure lamp. Runs that were stopped
before this fix keep their old unrecorded state.
