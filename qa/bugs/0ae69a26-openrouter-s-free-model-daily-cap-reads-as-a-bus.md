---
fingerprint: 0ae69a26
slug: openrouter-s-free-model-daily-cap-reads-as-a-bus
title: OpenRouter's free-model daily cap reads as a busy provider and is retried for about 100 seconds
surface: providers
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 7436e401e
origin: audit
---

# OpenRouter's free-model daily cap reads as a busy provider and is retried for about 100 seconds

## Symptom

A Commander on an OpenRouter `:free` model who has used up the free-model daily allowance watches the run sit for about 100 seconds, then reads "The model provider is busy (too many requests) — wait a few seconds and try again." with a ↻ retry. The allowance resets the next UTC day, so every retry is doomed.

## Repro

1. Point a station at an OpenRouter endpoint that answers HTTP 429 `{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"<next UTC midnight ms>"}}}}` (the shape OpenRouter returns for the free daily cap).
2. Send any message on that model.
3. Count the chat POSTs that reach the provider and read the COMMS error row.

## Evidence

Live on the sweep rig (sidecar on :9711 from the sweep-providers worktree, mock OpenRouter on an ephemeral port, SKYNET_OPENROUTER_BASE pointed at it), before the fix: `{"model":"mock/429-day","ms":102004,"mockHits":7,"error":{"message":"openrouter http 429 — Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","transient":true},"retries":["3/6:rate_limit:4579","4/6:rate_limit:11369","5/6:rate_limit:34097","6/6:rate_limit:49678"],"userTold":{"kind":"rate_limit","retryable":true,"userMessage":"The model provider is busy (too many requests) — wait a few seconds and try again."}}`.

Cause: the provider text says "requests per day", and `SHORT_WINDOW_RE` in `sidecar/providers/errorClass.js` (and its mirror in `frontend/app/friendlyerror.js`) vetoes anything containing `requests per`, so the 429 stayed `rate_limit` (retryable) on both classifiers.

After the fix (same rig): `{"ms":906,"mockHits":1,"transient":false,"userTold":{"kind":"quota_exhausted","retryable":false}}`; COMMS DOM row (headless Chrome on :9712): "⚠ OpenRouter's daily limit for free models is used up — it resets tomorrow (UTC), not in seconds. To keep working now, pick a paid model in the COMMS model dock, or add credits on OpenRouter to raise the free limit." Regression: `test/openrouter-free-daily-cap.test.js` (RED 12 problems before, GREEN 23 assertions after).

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

`free-models-per-day` is now named ahead of the short-window veto in both classifiers (quota_exhausted: one POST, no ladder; a configured fallback is still taken). `free-models-per-min` stays a retryable rate limit. The reset time in `metadata.headers` is still not shown (the copy says "tomorrow (UTC)").
