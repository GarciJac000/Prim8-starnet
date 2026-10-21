---
fingerprint: 38da5ee4
slug: a-provider-403-that-says-forbidden-tells-the-com
title: A provider 403 that says Forbidden tells the Commander the station restarted
surface: providers
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 613beeac9
origin: audit
---

# A provider 403 that says Forbidden tells the Commander the station restarted

## Symptom

When a provider (or a proxy in front of a custom endpoint) refuses a request with HTTP 403 "Forbidden", COMMS tells the Commander "The station restarted — reload this page to reconnect." with a RELOAD door. The station did not restart; the provider refused. The node classifier calls the same text `auth`, so the two paths disagree.

## Repro

1. In the browser build (friendlyerror.js loaded without `require`, the path real users take), classify the run error `openai-compatible http 403 - Forbidden` (also `openrouter http 403 — Forbidden`, `Anthropic http 403 - forbidden: Request not allowed`).
2. Read kind + userMessage.

## Evidence

Before (vm-loaded browser friendlyerror): `"openai-compatible http 403 - Forbidden" | browser: stale_session | The station restarted — reload this page to reconnect. | node: auth` (same for the openrouter and Anthropic variants).

Cause: `frontend/app/friendlyerror.js` kindFromRaw `if (s === 403 && (/sidecar http/.test(low) || /\bforbidden\b/.test(low))) return 'stale_session';` — any 403 text containing "forbidden" was taken for StarNet's own stale page token. The sidecar's own token gate always reads "sidecar HTTP 403".

After: provider-labelled 403s ("<adapter> http 403") are never stale_session; "sidecar HTTP 403 — forbidden" still is. Regression: `test/provider-403-truth.test.js` (RED 18 problems across this and 7d396570, GREEN 30).

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Fixed in the browser ladder: `stale_session` needs the sidecar's own prefix or a 403 with no provider adapter label (`PROVIDER_HTTP_RE`).
