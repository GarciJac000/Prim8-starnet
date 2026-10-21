---
fingerprint: 4dea1814
slug: the-tts-failure-classifier-reads-the-whole-ladde
title: The TTS failure classifier reads the whole ladder string: OpenAI insufficient_quota (HTTP 429) is retried on a 4s cold-off, and Gemini's per-minute 429 text pin
surface: voice
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/voice
fix: 4aa163337
origin: audit
---

# The TTS failure classifier reads the whole ladder string: OpenAI insufficient_quota (HTTP 429) is retried on a 4s cold-off, and Gemini's per-minute 429 text pin

## Symptom

Two lies from one classifier. (a) A station whose OpenAI account is out of money (OpenAI sends `insufficient_quota` with HTTP 429) re-asked the dead wallet three times per sentence and again on every reply after a 4 s pause, instead of backing off for a minute. (b) A Gemini per-minute rate limit — Gemini's standard 429 text says "please check your plan and billing details ... Please retry in 23s" — pinned "real voice offline — voice provider out of credits" on the speaker tooltip, telling the user their wallet is empty when they only need to wait seconds.

## Repro

1. Seeded station, speaker on; page `fetch` answers `/api/tts` with `{fallback:true, reason:R}` three times.
2. `Voice.speakChunk(...)` + `Voice.endReply()`; count requests and read the `#voice-toggle` title.
3. R = `openai 429 — {"error":{"message":"You exceeded your current quota, please check your plan and billing details. ...","type":"insufficient_quota",...}}`
4. R = `gemini 429 — {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. ... Quota exceeded for metric: ...free_tier_requests, limit: 10 Please retry in 23s.","status":"RESOURCE_EXHAUSTED"}}; edge: edge timeout`

## Evidence

Live, seeded station — BEFORE the fix:
```
openai insufficient_quota (HTTP 429)  requests 3 | diag category 'credits' — retried twice (TRANSIENT_LEG matched the 429 first)
gemini per-minute 429                 requests 3 | tip "real voice offline — voice provider out of credits" (TERMINAL_BILLING matched the bare word 'billing')
```
Mechanism: `frontend/app/voice.js` classifyFallback / retryableFallback ran `TERMINAL_BILLING` and `TRANSIENT_LEG` against the WHOLE semicolon-joined ladder string, each in one fixed order. AFTER the fix (same probe): insufficient_quota -> requests 1, tip 'out of credits'; Gemini per-minute 429 -> requests 3, tip without 'out of credits'; no key -> 1; openrouter 402 -> 1; network -> 3; 503 -> 3. Regression: `test/voice.button.test.js` (three new blocks; RED before on "insufficient_quota at HTTP 429 is NOT retried" (got 3), "arms the long cold-off" (got 4), and "a rate-limit body that merely MENTIONS billing is not out of credits"; the billing-hard-limit guard was green before and after).

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

Fixed in `frontend/app/voice.js`: each ';'-joined leg is judged alone — a named empty wallet (402 / insufficient credit|quota|funds / payment required / out of credit) is terminal whatever its status code; the bare word 'billing' is terminal only on a leg with no rate-limit signal. The provider bodies were reproduced from their documented shapes, not captured from the live services (lane rule: no real TTS traffic).
