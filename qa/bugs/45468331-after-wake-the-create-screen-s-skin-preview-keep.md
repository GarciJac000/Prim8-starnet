---
fingerprint: 45468331
slug: after-wake-the-create-screen-s-skin-preview-keep
title: After WAKE the create screen's skin preview keeps a 60fps animation loop running behind the station all session
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/world
fix: 589f871c0
origin: audit
---

# After WAKE the create screen's skin preview keeps a 60fps animation loop running behind the station all session

## Symptom

A first-run Commander who creates an Overseer and presses WAKE carries a second animation loop for the rest of the session: the create screen's walking skin preview keeps requesting a frame on every display refresh behind the station, although that screen is gone. Opening any other skin picker (Recruitment Bay, the dossier's SKIN card) starts the same never-ending loop. It costs a frame callback (and an `offsetParent` layout read per stage) at the world renderer's own rate until the page reloads.

## Repro

1. Empty workspace + cleared site storage; load the app → splash → any key → CREATE YOUR OVERSEER.
2. Pick OpenRouter, name the overseer, model `test/model` (mock provider), press WAKE; wait until `#screen-game` is active.
3. Count `requestAnimationFrame` callbacks by source over the next 8 s (lane instrumentation wraps rAF and attributes each callback to its caller).

## Evidence

Live, sweep/world rig (sidecar :9781, headless Chrome :9782, instrumentation injected with `Page.addScriptToEvaluateOnNewDocument`), 8 s window after WAKE:
before `{"skinstage.js:62":434,"world.js:1814":434,"crewcards.js:182":7,"crewcards.js:181":5}` — the hidden create screen's preview ran at the same rate as the world renderer. A resumed (seeded) session that never showed a picker had no `skinstage` callbacks at all.

Cause: `frontend/app/skinstage.js` `tick()` ended with an unconditional `requestAnimationFrame(tick)`; the create screen's `#skin-stage-img` stays connected (hidden), so the stage was never pruned and `looping` never cleared — despite the header's "a closed panel/modal costs nothing".

After the fix (`tick` re-arms rAF only while a stage is visible, polls hidden stages every 250 ms, and stops when no stage is mounted): same WAKE walk → `{"crewcards.js:182":8,"world.js:1814":438,"crewcards.js:181":3}` plus a 4 Hz `skinstage.js` visibility poll; the Recruitment Bay preview still animates on rAF while open (`skinstage.js:68`: 81 in 2 s) and goes quiet after close. Regression: `test/skinstage-idle-loop.test.js` (red before: 60 rAF callbacks in 60 hidden steps, a pending callback with no stage; green after).

_Found by the `sweep/world` lane (lifecycle residue across WAKE), 2026-10-20._

## Verdict

The loop now lives only while it has something on screen to animate; a re-shown stage resumes from the slow poll without a re-mount. Remaining by design: while the create screen's `<img>` stays in the DOM the 250 ms visibility poll continues (no rAF). Fix: `589f871c0`.
