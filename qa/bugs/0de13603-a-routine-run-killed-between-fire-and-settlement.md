---
fingerprint: 0de13603
slug: a-routine-run-killed-between-fire-and-settlement
title: A routine run killed between fire and settlement leaves the routine reporting the previous run's ok and absent from its own history
surface: autonomy
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 124feb5b0
origin: audit
---

# A routine run killed between fire and settlement leaves the routine reporting the previous run's ok and absent from its own history

## Symptom

Kill StarNet while a recurring routine is mid-run (a Windows force-kill, an update, a crash) and start it again: the ROUTINES row still reads "last ✓ ok 1h ago · next in 1h" and the routine's run history is empty. The occurrence that fired, spent money and died is invisible on the routine itself; only the separate run-recovery page knows it happened.

## Repro

1. Seed a workspace with a recurring routine `every 1h` whose previous run settled ok and whose nextRunAt is due in a few seconds; boot with `SKYNET_CRON_ENABLED=1 SKYNET_CRON_TICK_MS=2000` against a mock provider that streams one token and then hangs.
2. Wait for the fire to reach the provider, then hard-kill the sidecar (`child.kill('SIGKILL')`).
3. Boot again on the same workspace; read `GET /api/cron`, `GET /api/cron/history?id=<job>`, `GET /api/run-recoveries`.
Deterministic replay: `test/cron.interrupted-settlement.http.test.js` (seeds the job record + an interrupted run journal carrying `cronJobId`, two boots).

## Evidence

Live (scratchpad probeA, port 9741, before the fix) after the reboot:
`afterReboot: { state: "scheduled", lastStatus: "ok", lastRunId: "prev-run-ok", lastRunAt: "2026-10-20T05:55:03Z" }`, `history: { ok: true, runs: [] }`, while `run-recoveries` listed `{ cronJobId: "probeinterval", status: "resumable" }` and `runs.jsonl` held `{ reason: "interrupted", streamId: "cron-635032f7…" }` with NO `cronJobId`.
Root cause: `syncInterruptedRunHistory` in `sidecar/index.js` wrote the interrupted row without the journal's `meta.cronJobId`, so `handleCronHistory` (which matches `r.cronJobId === id || r.runId === job.lastRunId`) could not see it, and nothing ever told the routine record its newest occurrence died (advance-before-run had already moved nextRunAt; `markRun` never ran).
After the fix the same probe reads `{ state: "error", lastStatus: "error", lastError: "interrupted: StarNet stopped before this run finished; it can continue from its last durable step", lastRunId: <the run> }` and the history lists the run with `reason: "interrupted"`. Regression `test/cron.interrupted-settlement.http.test.js` went RED (8 problems) before the fix and GREEN after; it also proves a routine that settled a LATER occurrence is never rewritten and a second boot changes nothing.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed. The interrupted history row now carries the journal's `cronJobId`, and `cronStore.markInterrupted` names the interrupted run on a RECURRING routine's record (lastRunId/lastRunAt/lastStatus 'error'/lastReason 'interrupted') without re-arming it, finalizing it or counting it toward auto-pause. One-shots keep their G4.5 fire-claim reclaim. The routine history also serves `spendUnknown` so the panel prints "spend unknown" instead of "$0" for such a run (`frontend/app/windows/routines.js`). Not done: the interrupted occurrence is not re-delivered to its chat destination, and a continuation started from run recovery still does not write back to the routine record.
