---
fingerprint: 50551f59
slug: lowering-the-autonomy-dial-to-wait-does-not-stop
title: Lowering the autonomy dial to WAIT does not stop the night-shift beat already in flight
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: ac17d27be
origin: audit
---

# Lowering the autonomy dial to WAIT does not stop the night-shift beat already in flight

## Symptom

The Commander comes back mid-night and turns ON ITS OWN down to WAIT while a night-shift beat is running: the panel flips to "not scheduled", but the beat already in flight keeps its provider stream and goes on to buy its remaining calls (or its whole build run). Only the E-STOP reached it.

## Repro

1. Boot with `SKYNET_NIGHTSHIFT_AWAY_MS=1 SKYNET_NIGHTSHIFT_TICK_MS=300` and a mock provider that hangs after one token.
2. `POST /api/autonomy/posture { posture:{ initiative:'leash', reach:'observe', leashPerDay:5 }, beliefs:<hot> }`; wait for the driver beat to reach the provider.
3. `POST /api/autonomy/posture { posture:{ initiative:'wait', … } }`; watch the hung request.
Regression: `test/nightshift-revoke-midbeat.e2e.test.js`.

## Evidence

Live (scratchpad probeH, before): `revoke: { initiative:"wait", actsUnattended:false }` but `hungRequestClosed: "still open 6028ms after the revoke"`. Root cause: `handleAutonomyPosture` in `sidecar/index.js` only changes the next tick's gate ("we LEAVE the timer armed — its own gate returns binding:'posture'"); nothing aborts `nightshiftDriver`'s in-flight beat. After: the stream closes right after the write, `inFlight:false`, no further calls, ledger `outcome delivered:false` + `posture-revoked`. Test RED (4 problems) before, GREEN after.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed: a posture write that no longer permits acting unattended calls `nightshiftDriver.abortBeat()` and ledgers why. A reach-only downgrade mid-build (initiative still >= leash) does not abort; the workshop write grant is re-read per tool call, so revoking it mid-beat already denies the next write.
