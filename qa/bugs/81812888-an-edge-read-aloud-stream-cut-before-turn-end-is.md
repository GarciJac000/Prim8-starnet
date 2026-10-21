---
fingerprint: 81812888
slug: an-edge-read-aloud-stream-cut-before-turn-end-is
title: An Edge read-aloud stream cut before turn.end is served as a whole clip and cached under the full sentence; a dropped connection hangs the full 15s per attempt
surface: voice
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/voice
fix: 0efc04afe
origin: audit
---

# An Edge read-aloud stream cut before turn.end is served as a whole clip and cached under the full sentence; a dropped connection hangs the full 15s per attempt

## Symptom

On a zero-key station (and on any station whose keyed voice falls through to the free floor) a sentence the Edge read-aloud service cut short — a websocket CLOSE frame before `Path:turn.end` — was played as if complete, and from then on that exact sentence ALWAYS played cut in half, even with Edge healthy again, because the half clip was written to the voice cache under the full sentence's key. Stock lines that repeat (prewarm ambient lines, "standing by") are the lines most likely to be poisoned for good. A service that simply dropped the TCP connection mid-stream was not handled at all: the sentence sat silent for the full 15 s wall clock, three times over with the desk's retries.

## Repro

1. Boot a keyless seeded sidecar with the Edge floor aimed at a loopback WS stub (`SKYNET_EDGE_TTS_HOST/PORT/INSECURE`).
2. Stub answers the SSML with `turn.start`, ONE binary audio frame carrying half the clip, then a websocket CLOSE frame (no `turn.end`).
3. `POST /api/tts {text:'Edge closed halfway through.'}`, then repeat the same request with the stub healthy.
4. Variant: half the clip, then end the TCP socket with no close frame.

## Evidence

Live, seeded sidecar :9771 (netguarded), loopback Edge stub — BEFORE the fix:
```
K4  half-audio then CLOSE       {"status":200,"ct":"audio/mpeg","vp":"edge:en-US-ChristopherNeural","cache":"miss","bytes":1486,"fullClip":false}
K4b same sentence, Edge healthy {"status":200,"ct":"audio/mpeg","cache":"hit","bytes":1486,"fullClip":false}
K4  cache delta [{"p":"voice-cache/d8bdb4ca669c80a06e2a3d3d4d1f793b31a56db2.mp3","size":1486}]   (full clip = 2973 bytes)
K5  half-audio then TCP end     {"status":200,"ct":"application/json","ms":15016,"json":{"fallback":true,"reason":"edge: edge timeout"}}
```
Mechanism: `sidecar/edgetts.js` passed `finish` (resolve with whatever audio arrived) as the frame parser's onClose, and never listened for the socket's `end`/`close`. AFTER the fix (same probe): K4 -> `{"fallback":true,"reason":"edge: edge socket closed before turn.end"}`, K4b -> `cache:"miss", bytes:2973, fullClip:true` (the WHOLE clip is what gets cached), K5 -> fallback in 40 ms. Regression: `test/edgetts-stream-end.test.js` (RED before: the close resolved 2000 of 4000 bytes; the drop rejected only at the 4000 ms ceiling with 'edge timeout'. GREEN after).

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

Fixed in `sidecar/edgetts.js`: only `Path:turn.end` completes a clip; a close frame, socket `end` or `close` before it rejects with 'edge socket closed before turn.end' (a transient-class reason, so the desk retries it). Not verified against the real Microsoft endpoint (lane rule: no real TTS traffic). Clips an existing install already poisoned in its voice-cache are not purged by this fix.
