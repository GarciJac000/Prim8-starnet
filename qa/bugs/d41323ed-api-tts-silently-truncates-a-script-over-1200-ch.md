---
fingerprint: d41323ed
slug: api-tts-silently-truncates-a-script-over-1200-ch
title: /api/tts silently truncates a script over 1200 characters and answers 200 audio as if the whole text was spoken
surface: voice
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/voice
fix: 35f80804c
origin: audit
---

# /api/tts silently truncates a script over 1200 characters and answers 200 audio as if the whole text was spoken

## Symptom

A caller that sent `/api/tts` a script longer than 1200 characters got 200 audio back with only the first ~1200 characters spoken (cut at the last sentence end), and nothing in the response said so — the caller had every reason to believe the whole text was spoken. The voice rule is that an over-cap script is REFUSED, never truncated (`voice_generate` refuses over 4000; the paired-device speak verb refuses over 1200); this sibling truncated instead.

## Repro

1. Seeded sidecar (netguarded; keyed leg stubbed to 500 so the Edge stub serves).
2. `POST /api/tts {text: <1539 characters of sentences>}`.
3. Read the response and the SSML the Edge stub received.

## Evidence

Live BEFORE the fix: `{"sent":1539,"res":{"status":200,"ct":"audio/mpeg","vp":"edge:en-US-ChristopherNeural","cache":"miss"},"edgeSsmlChars":1189}` — 350 characters silently dropped. Defective code: `sidecar/media-service.js` handleTts `if (text.length > 1200) { const head = text.slice(0, 1200); ... text = (sentence && sentence[0].length > 600 ? sentence[0] : head).trim(); }`. AFTER: `{"status":200,"ct":"application/json","json":{"fallback":true,"reason":"text is 1539 characters; the per-request cap is 1200 — split it into sentences"}}` and the Edge stub received no request. The desk client never sends more than 1000 characters per request (splitForTts), so the shipped desk UI was not affected; direct API callers were. Regression: `test/media-service.test.js` (RED before: audio served; GREEN after, and a 1200-character script is still spoken whole). Sibling still holding a silent `.slice(0, 1200)`: `sidecar/local-voice.js` renderSpeech — every caller is already bounded to 1200, so it is latent and not changed here.

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

Fixed: handleTts refuses an over-cap script with a 200 fallback naming the cap (the 200-always contract holds).
