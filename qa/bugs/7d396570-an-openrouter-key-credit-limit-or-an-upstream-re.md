---
fingerprint: 7d396570
slug: an-openrouter-key-credit-limit-or-an-upstream-re
title: An OpenRouter key credit limit or an upstream region refusal reads as a rejected API key
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 613beeac9
origin: audit
---

# An OpenRouter key credit limit or an upstream region refusal reads as a rejected API key

## Symptom

A Commander whose OpenRouter key has hit the credit limit set on that key, or whose request was refused by the upstream for their region, is told "The provider rejected the API key — check it, or paste a new one". The key is valid; pasting it again changes nothing.

## Repro

1. Make OpenRouter answer HTTP 403 `{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys","code":403}}`; send a message.
2. Make it answer 403 `{"error":{"message":"Provider returned error","code":403,"metadata":{"raw":"{\"error\":{\"code\":\"unsupported_country_region_territory\",\"message\":\"Country, region, or territory not supported\"}}"}}}`; send a message.
3. Read the COMMS row.

## Evidence

Live on the sweep rig (sidecar on :9711 from the sweep-providers worktree, mock OpenRouter on an ephemeral port, SKYNET_OPENROUTER_BASE pointed at it), before: `{"model":"mock/403-keylimit","mockHits":1,"userTold":{"kind":"auth","userMessage":"The provider rejected the API key — check it, or paste a new one under SETTINGS → AI & MODELS."}}`; `{"model":"mock/403-region","mockHits":1,"error":{"message":"openrouter http 403 — Provider returned error"},"userTold":{"kind":"auth","userMessage":"The provider rejected the API key — …"}}`.

Cause: `sidecar/providers/errorClass.js` `if (status === 401 || status === 403) return NO_CREDIT_RE.test(low) ? 'billing' : 'auth';` and the browser mirror — neither knew a per-key limit or a region refusal.

After (headless Chrome DOM on :9712): "⚠ This OpenRouter key reached the credit limit set on it — raise that key's limit in your OpenRouter key settings, or use a different key." Region → `model_not_found` ("That model isn't available — pick a different one"). Regression: `test/provider-403-truth.test.js`.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

`key limit exceeded` joins NO_CREDIT_RE (billing, with key-limit copy); a 403 naming `unsupported_country_region_territory` is `model_not_found` (fallback-eligible). Both classifiers changed in step.
