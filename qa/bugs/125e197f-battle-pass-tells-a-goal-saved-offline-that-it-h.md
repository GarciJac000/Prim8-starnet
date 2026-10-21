---
fingerprint: 125e197f
slug: battle-pass-tells-a-goal-saved-offline-that-it-h
title: Battle pass tells a goal saved offline that it has no success condition
surface: world
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Battle pass tells a goal saved offline that it has no success condition

## Symptom

A goal created while the journey service was unreachable is saved on the device WITH its success condition, but the PASS view's only challenge read "Give “Run a half marathon” a success condition" — telling the Commander something false about a goal they had just fully described.

## Repro

1. Boot a dev seed and open QUEST LOG.
2. Make `JourneyStore.registerGoal` fail (stub it to resolve `{ ok:false }`, or stop the sidecar) and create a goal with a success condition through `GoalStore.createGoal`.
3. The goal is saved with `pendingRegistration: true` and its `successCondition` set; open PASS.

## Evidence

`frontend/app/battlepass.js` challengesOf: the unregistered branch only knew `goalRegistered`, never whether a condition existed. Live DOM round-trip before the fix: `{ pending: true, hasCondition: true, chal: ["[ ] Give “Run a half marathon” a success condition … GO"] }`. After: `"Finish saving “Run a half marathon” to your journey — retry its success condition"`; GO lands on GOALS with the condition prefilled, SAVE SUCCESS CONDITION re-registers (`pendingAfter: false`) and the pass switches to the real challenges. Regression: `test/battlepass.test.js` ("a goal saved offline is not told it lacks a success condition").

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed: the pass is told `goalSaved` and names what is actually pending, with GO on the existing retry path. Fix: `c1b4a6f59`.
