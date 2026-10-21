---
fingerprint: f6744691
slug: model-catalog-lookups-resolve-a-bare-model-id-ag
title: Model catalog lookups resolve a bare model id against another provider's catalog
surface: providers
severity: P2
status: open
found: 2026-10-20
lane: sweep/providers
fix:
origin: audit
---

# Model catalog lookups resolve a bare model id against another provider's catalog

## Symptom

With the active provider switched to one whose catalog does not list a model id, StarNet still reports a context window and a price for that id — borrowed from another provider's catalog that happens to use the same bare id. The model picker hint, the history fitter and the context gauge then act on a window and price this provider never published.

## Repro

1. Warm the OpenRouter catalog (it lists `mock/ok-catalog` with context 64000 and $3/$15 per M).
2. `Harness.setProv('custom')` (or `'ollama'`), whose catalog never listed that id.
3. `Harness.contextLimitOf('mock/ok-catalog')`, `Harness.priceOf('mock/ok-catalog')`.

## Evidence

Live DOM round-trip (headless Chrome :9712 on :9711): `{"prov0":"openrouter","or":64000,"orPrice":{"in":3,"out":15},"prov1":"custom","custom":64000,"customPrice":{"in":3,"out":15},"prov2":"ollama","ollama":64000}`.

Cause: `frontend/app/harness.js` catalogModel(id) prefers the ACTIVE provider (`getProv()`) and then `for (const k in modelsByProv) { const m = modelsByProv[k] && modelsByProv[k][id]; if (m) return m; }` — a lookup keyed by bare model id across providers (the CTX-gauge bug class). Callers pass no provider: `frontend/app/app.js` modelMetaStr/updateHint use `Harness.contextLimitOf(id)` / `Harness.priceOf(id)` while the user is picking `pickedProvider` (not the active one), and `frontend/app/chat.js` modelFitHistory/composerContextIssue size the history window from it. Real collisions: a custom endpoint (LM Studio, a proxy) serving an id OpenRouter also lists, ChatGPT-plan vs OpenAI-API ids.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
