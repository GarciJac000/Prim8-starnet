---
fingerprint: 5d19823c
slug: wake-key-check-failure-claims-a-previous-key-on
title: WAKE key-check failure claims a previous key on a fresh install and shows raw outage jargon
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 2ad0d1c9a
origin: audit
---

# WAKE key-check failure claims a previous key on a fresh install and shows raw outage jargon

## Symptom

On a brand-new install (no key anywhere), CREATE YOUR OVERSEER › WAKE with a bad key says "your previous key is unchanged". There is no previous key. When the provider is unreachable or overloaded the same screen shows plumbing a beginner can't act on: "fetch failed (ECONNREFUSED)" and "credential probe HTTP 503". The same failures inside a run already read in plain words.

## Repro

1. `node dev/onboard-fresh.js` with an empty key and a clean browser profile; mock OpenRouter.
2. Splash › CONNECT A BRAIN › All providers › OpenRouter, model `test/model`, type a wrong key, WAKE.
3. Type the right key, take the provider down (connection refused), WAKE; then make it answer 503, WAKE.

## Evidence

Live `#connect-msg` text, 2026-10-20, fresh no-key station:
- `could not start — provider rejected this key (HTTP 401) — your previous key is unchanged`
- `could not start — fetch failed (ECONNREFUSED) — your previous key is unchanged`
- `could not start — credential probe HTTP 503 — your previous key is unchanged`

Defect: `frontend/app/harness.js` `validateAndSetKey` unconditionally threw `keyCheckFailure(r.status, j, text) + ' — your previous key is unchanged'`.

After the fix, same station: `could not start — provider rejected this key (HTTP 401) — nothing was saved`; `could not start — couldn’t reach the AI provider — check your internet connection, VPN or proxy, then try again (fetch failed (ECONNREFUSED)) — nothing was saved`; `could not start — the AI provider’s servers are having trouble right now — wait a moment and try again (credential probe HTTP 503) — nothing was saved`.

Regression: `test/wake-key-check-copy.test.js` (vm-runs the real validateAndSetKey); RED before the fix (6 problems).

## Verdict

validateAndSetKey keeps the preserved-key line only when a credential is stored ('nothing was saved' otherwise); keyCheckLine routes unreachable/5xx through Friendly with the raw cause in brackets. Verified live on a fresh no-key station for 401, ECONNREFUSED and 503.
