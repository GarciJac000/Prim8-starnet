---
fingerprint: 6e32cb6c
slug: a-run-s-ledger-row-cannot-be-matched-to-the-prov
title: A run's ledger row cannot be matched to the provider's charge because no generation id is kept
surface: providers
severity: P2
status: open
found: 2026-10-20
lane: sweep/providers
fix:
origin: audit
---

# A run's ledger row cannot be matched to the provider's charge because no generation id is kept

## Symptom

One paid OpenRouter run cannot be proven against what OpenRouter charged: StarNet's books agree with themselves, but the key's usage moved by a slightly different amount and there is no generation id to look the charge up by.

## Repro

1. Read the key's usage (`GET https://openrouter.ai/api/v1/key`).
2. Run one message on a paid model through COMMS.
3. Compare the ledger row to the key-usage delta once it settles.

## Evidence

The sweep's one paid smoke (mistralai/mistral-nemo, 2026-10-20 05:44 UTC): ledger `{"usd":0.0004234896,"tokens":25578,"cachedTokens":16,"model":"mistralai/mistral-nemo"}` = /api/runs row = /api/insights byModel ($0.000423) = /api/budget/status spentToday/lifetime = page `Harness.totals()` `{"tokens":25578,"cost":0.0004234896,"calls":1}`. OpenRouter key usage 218.206740941 → 218.207180402 (delta $0.000439461, stable over 45 s). Gap: $0.0000160 (3.6%). The key is shared (usage_daily $2.29 that day) and no StarNet run journal or pending-spend receipt was left behind, so the gap is most likely another consumer of the key, but it cannot be proven either way: `sidecar/providers/openrouter.js` never keeps the stream's `id` (the generation id OpenRouter's `/api/v1/generation?id=` would price exactly), and the ledger row has no field for it.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
