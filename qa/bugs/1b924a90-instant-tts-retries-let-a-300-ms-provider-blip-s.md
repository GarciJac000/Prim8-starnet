---
fingerprint: 1b924a90
slug: instant-tts-retries-let-a-300-ms-provider-blip-s
title: Instant TTS retries let a 300 ms provider blip spend every in-flight chunk's budget, so MID_REPLY_GIVEUP silences the whole spoken reply
surface: voice
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/voice
fix: 468524e05
origin: audit
---

# Instant TTS retries let a 300 ms provider blip spend every in-flight chunk's budget, so MID_REPLY_GIVEUP silences the whole spoken reply

## Symptom

With the agent voice on, a provider hiccup of a fraction of a second could silence an entire spoken reply: the agent never says a word, or says its first sentence and stops dead, and the speaker tooltip reads "Voice unavailable for the rest of this reply" — although the provider was answering again a moment later. It reads as the voice feature being dead.

## Repro

1. Seeded station, speaker on, page `fetch` patched to answer `/api/tts` with `{fallback:true, reason:'edge: edge upgrade refused: HTTP 429'}` for 300 ms from the first request, real audio afterwards.
2. `Voice.speakChunk('... sentence number i ...')` for i = 1..5, then `Voice.endReply()`.
3. Count `/api/tts` requests and `HTMLMediaElement.prototype.play` calls.
4. Variant: the window opens on request 2 (after the first sentence played) and lasts 1500 ms.

## Evidence

Live, headless Chrome on the seeded station (CDP :9772), play()/fetch instrumented — BEFORE the fix:
```
opening blip 300ms : requests 9, injected 9, plays 0, note "Voice unavailable for the rest of this reply — full reply remains in chat."
mid-reply 1500ms   : requests 13, injected 12, plays 1
```
Mechanism (`frontend/app/voice.js` startSynth): the two transient retries were chained with no delay — `.then(res => (res.kind === 'fail' && retryableFallback(res.reason) && seq === speakSeq) ? synthOnce(job) : res)` twice — so all three attempts of every chunk in flight landed inside the same blip; prefetch (MAX_INFLIGHT=2) runs the opening chunks together, both were exhausted within milliseconds, `replyFails` reached MID_REPLY_GIVEUP and every later chunk resolved `{kind:'fail', reason:'cooldown'}` without a request. AFTER the fix (same probe): opening blip -> requests 7, plays 5; mid-reply 1500 ms -> requests 7, plays 5; a genuinely dead provider still costs exactly 6 requests (two sentences) and drains in 2.2 s; a barge-in during a retry gap fires no retry (1 request). Regression: `test/voice.button.test.js` "short blip: every sentence of the reply is still spoken" (RED before: 6 requests, 0 spoken).

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

Fixed in `frontend/app/voice.js`: retries wait RETRY_GAP_MS [400, 1200] ms (a blip must now outlive ~1.6 s to cost a sentence), and no NEW chunk is prefetched while a chunk of the reply waits on a retry, so a dead provider still costs two sentences of attempts, not three. Six existing fixed-tick waits in `test/voice.button.test.js` became outcome waits (assertions unchanged). Not verified by ear.
