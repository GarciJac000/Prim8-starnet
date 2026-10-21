---
fingerprint: d3a76db3
slug: the-per-run-dollar-cap-does-not-bound-team-spawn
title: The PER RUN dollar cap does not bound team.spawn workers, so a 5-cent cap ran 24 cents
surface: providers
severity: P1
status: open
found: 2026-10-20
lane: sweep/providers
fix:
origin: audit
---

# The PER RUN dollar cap does not bound team.spawn workers, so a 5-cent cap ran 24 cents

## Symptom

SETTINGS › SPENDING LIMITS promises PER RUN is a "Hard ceiling for a single agent run. The run stops the moment it would exceed this." With PER RUN at $0.05, one Commander request that delegates to clones spent $0.24 (lead $0.08 + four workers at $0.04 each), plus $0.08 of post-run aux passes. Each spawned worker carries its own full PER RUN ceiling, and the lead itself finished at $0.08, past its $0.05 cap, reason "done".

## Repro

1. Boot with `SKYNET_BUDGET_PER_RUN=0.05` (or set PER RUN to 0.05).
2. Give the lead the orchestrator object and a model that answers its first turn with `team.spawn` of 4 tasks; every model call costs $0.04 (`usage.cost`).
3. Send one message; read every agent.run.end, the ledger and /api/budget/status.

## Evidence

Live on the sweep rig (sidecar on :9711 from the sweep-providers worktree, mock OpenRouter on an ephemeral port, SKYNET_OPENROUTER_BASE pointed at it) (mock/team-lead, cost 0.04 per call): `caps {"perRun":0.05,…}`; `lead end {"reason":"done","usd":0.08}`; `all ends [sub-…a834 done 0.04, sub-…dabc done 0.04, sub-…6cf4 done 0.04, sub-…055f done 0.04, agent done 0.08]`; ledger `TOTAL 0.3200` (incl. two $0.04 aux rows for `agent`); `budget day {"usd":0.3323}`; mock saw 8 POSTs `["L","W","W","W","W","L+","W","W"]`.

Mechanism: `sidecar/tools/builtin/orchestration.js:926` and `:1189` start each worker/clone with `maxCostUsd: perWorker`, and `perWorker` is `ORCH_PER_WORKER = num(ENV('BUDGET_PER_WORKER'), 0)` (`sidecar/index.js:871`) — 0 means each worker falls back to the full per-run cap (`sidecar/index.js:20382`). Nothing charges worker spend against the lead's run tally. The lead overshoot is the cap being checked between turns. The PER RUN hint is `frontend/app/stationui.js` "Hard ceiling for a single agent run. The run stops the moment it would exceed this."

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
