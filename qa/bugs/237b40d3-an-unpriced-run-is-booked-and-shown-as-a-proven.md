---
fingerprint: 237b40d3
slug: an-unpriced-run-is-booked-and-shown-as-a-proven
title: An unpriced run is booked and shown as a proven zero-dollar metered run
surface: providers
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 3c53fa524
origin: audit
---

# An unpriced run is booked and shown as a proven zero-dollar metered run

## Symptom

After a run on a model StarNet has no price for (no provider-reported cost, no catalog rate), every durable surface treats it as a run that provably cost $0: Insights counts it as a metered run at $0 and `/insights` prints the model at "$0.00". The loop itself knew the run was unpriced.

## Repro

1. Serve an OpenRouter model with no `pricing` in /models and no `usage.cost` in the stream.
2. Run one message on it.
3. Read `ledger.jsonl`, `GET /api/runs?runId=`, `GET /api/insights`, and `/insights` in COMMS.

## Evidence

Live on the sweep rig (sidecar on :9711 from the sweep-providers worktree, mock OpenRouter on an ephemeral port, SKYNET_OPENROUTER_BASE pointed at it), before: agent.cost `{"usd":0,"model":"mock/ok-unpriced","unpriced":true}` but ledger row `{"usd":0,"tokens":990,"model":"mock/ok-unpriced","unmetered":false}` (no mark), run row `{"usd":0,"unmetered":false}`, insights byModel `{"model":"mock/ok-unpriced","usd":0,"meteredRuns":1,"spendUnknownRuns":0,"spendLabel":""}`. `test/unpriced-run-label.e2e.test.js` RED: 12 problems (live + after restart).

Cause: `sidecar/index.js` run end — `ledger.record({… usd: finalUsd …, unmetered })` and `runStore.record` carried no unpriced flag; `effectiveRunUsd` used `result.unpricedUsage` only for a catalog backfill.

After: ledger `{"usd":0,"model":"mock/ok-unpriced","unpriced":true}`, insights `{"usd":0,"meteredRuns":0,"unpricedRuns":1,"spendLabel":"no published price"}`; COMMS DOM `/insights`: "Insights (lifetime run history for agent): 5 runs, $0.0123 (+ 1 run with no published price), … Top models: mock/ok-provider-cost ($0.0123), mock/ok-unpriced (no published price) …"; `/usage`: "1 run on models with no published price — their cost is not in these dollars." e2e GREEN 22 assertions through a sidecar restart.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Both rows carry an additive `unpriced:true` (absent on priced rows); the insights fold counts `unpricedRuns`, keeps a $0 unpriced run out of the metered count and labels it; `/insights` and `/usage` print the label. Fix: 3c53fa524 (rows + fold + /insights) and e760d444a (/usage). Not changed: the SPENDING LIMITS "spent today" readout still sums dollars only (unpriced runs are bounded by the separate unpriced-token ceiling).
