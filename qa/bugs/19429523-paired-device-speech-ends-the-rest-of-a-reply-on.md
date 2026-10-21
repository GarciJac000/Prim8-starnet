---
fingerprint: 19429523
slug: paired-device-speech-ends-the-rest-of-a-reply-on
title: Paired-device speech ends the rest of a reply on one failed later sentence, with no retry
surface: voice
severity: P2
status: open
found: 2026-10-20
lane: sweep/voice
fix:
origin: audit
---

# Paired-device speech ends the rest of a reply on one failed later sentence, with no retry

## Symptom

On a paired device (the companion's spoken reply), one transient synthesis failure on any sentence after the first ends the whole reply there: the device hears the opening and then silence, although the engine answered normally on the very next call. This is the same "starts, then stops dead" shape the desk queue guards against (there one failed sentence is retried, then skipped, never the rest of the reply).

## Repro

1. `makeRemoteVoice({ now: () => 1, newId: () => 'r1', synthesize })` where synthesize fails ONLY its 2nd call with `edge: edge upgrade refused: HTTP 429`.
2. `speak('dev', { text: <a 3-part reply> })`, let the background loop settle, then `speech('dev', { id, offset: 0 })`.

## Evidence

Module probe (no paired phone available to this lane): `{"sentencesInReply":3,"synthCalls":2,"bytesDelivered":4,"done":true,"error":"edge: edge upgrade refused: HTTP 429"}` — the third part was never asked for. Code: `sidecar/remote/voice.js` speak loop `if (!r.ok) { rec.error = r.reason.slice(0, 160); break; }`, no retry. `test/remote-voice.test.js` locks this as intended ("a failed later sentence ends the reply and reports it"), so changing it is a contract change for the device client (which reads `error` on the speech chunk); left open rather than fixed in this lane. A bounded retry of the pinned leg before ending would rescue a blip without touching the error contract.

_Found by the `sweep/voice` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
