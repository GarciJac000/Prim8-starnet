---
fingerprint: 243de8bd
slug: api-tts-asks-only-the-first-credentialed-keyed-p
title: /api/tts asks only the first credentialed keyed provider: a station holding OpenRouter and Gemini keys drops to Edge's different voice when OpenRouter fails
surface: voice
severity: P2
status: open
found: 2026-10-20
lane: sweep/voice
fix:
origin: audit
---

# /api/tts asks only the first credentialed keyed provider: a station holding OpenRouter and Gemini keys drops to Edge's different voice when OpenRouter fails

## Symptom

A station that holds two voice-capable keys (say OpenRouter and Gemini) and whose OpenRouter account runs dry stops speaking in its locked station voice: every sentence falls to the free Edge floor's different voice (en-US-ChristopherNeural) instead of trying the Gemini key it already holds — which would have kept the Algenib voice (OpenRouter's TTS model is Gemini TTS). The agent's `voice_generate` tool on the same station walks every keyed provider before the floor, so the two voice surfaces disagree about the ladder.

## Repro

1. Seeded sidecar with `SKYNET_OPENROUTER_KEY` (placeholder, netguard-rewritten to a local mock) and `GEMINI_API_KEY` + `GEMINI_BASE_URL` pointing at the lane mock.
2. Mock: OpenRouter speech answers 402 "Insufficient credits"; Gemini generateContent answers audio; Edge stub healthy.
3. `POST /api/tts {text:'Two keys on one station.'}`; count the requests each leg received.

## Evidence

Live: `G1 openrouter 402 with a Gemini key on the station {"status":200,"vp":"edge:en-US-ChristopherNeural"}` and `G1 legs actually asked {"openrouter":1,"gemini":0,"edge":1}`. Code: `sidecar/media-service.js` handleTts picks ONE provider (`if (key) { ttsProvider = provider; ttsKey = key; break; }`) and goes straight to `serveEdge` when it fails, while synthesizeForAgent loops every provider in `TTS_KEY_PROVIDERS`. Not fixed: walking a second keyed provider spends on a second account for every failed sentence — that is a product decision (voice identity against spend), not a small fix.

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
