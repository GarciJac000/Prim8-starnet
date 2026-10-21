---
fingerprint: df610df1
slug: a-keyed-voice-provider-slower-than-the-desk-s-30
title: A keyed voice provider slower than the desk's 30s synth ceiling is paid twice for one sentence, which then plays after a minute of silence
surface: voice
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/voice
fix: 22c36eed6
origin: audit
---

# A keyed voice provider slower than the desk's 30s synth ceiling is paid twice for one sentence, which then plays after a minute of silence

## Symptom

When the keyed voice provider is slow (any synthesis taking longer than 30 seconds), one spoken sentence was paid for twice and the agent stayed silent for over a minute before saying it. The desk gives up on a `/api/tts` request after 30 s and retries; the sidecar keeps the abandoned provider call running (its own ceiling is 60 s), and the retry, finding nothing cached yet, started a SECOND paid synthesis of the same sentence. The sentence finally played only on the third attempt, from the first call's cache.

## Repro

1. Seeded sidecar (netguarded) with the keyed OpenRouter leg rewritten to the lane mock; the mock answers speech requests after 32 s.
2. Speaker on; `Voice.speakChunk('One slow sentence from a slow keyed provider.')`, `Voice.endReply()`.
3. Count the speech requests the mock received for that sentence and the time until the reply drains.

## Evidence

Live BEFORE the fix: `{"drainedMs":62407,"plays":1,"keyedCallsForTheSentence":[{"atMs":19},{"atMs":30432}]}`; desk attempts `[(1,'signal is aborted'), (30415,'signal is aborted'), (61620,'cache hit')]` — two paid syntheses, 61.6 s of silence. Mechanism: the desk's `TTS_TIMEOUT_MS = 30000` (`frontend/app/voice.js`) is shorter than the keyed call's `voiceFetchOpts(..., 60000)` in `sidecar/media-service.js` ttsSynthKeyed, and handleTts neither observes the client abort nor knows a synthesis of the same clip is already running. AFTER the fix (same probe): `{"drainedMs":32958,"plays":1,"keyedCallsForTheSentence":[{"atMs":11}]}`, attempts `[(1,'aborted'), (30411,'miss')]` — the retry joined the running call and played at ~33 s. Regression: `test/media-service.test.js` "a retry for a clip already being synthesized does not pay for it again" (RED before: calls=2).

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

Fixed in `sidecar/media-service.js`: a keyed synthesis is single-flight per voice-cache key — a concurrent request for the same clip awaits the running call (which writes the cache once) instead of starting another. The abandoned first request's provider call still runs to completion (it is what the retry receives); a provider that never answers still costs the desk its 30 s ceiling per attempt.
