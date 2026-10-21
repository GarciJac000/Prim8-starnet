---
fingerprint: 90efe1f0
slug: a-grabbed-awakening-offer-becomes-the-commander
title: A grabbed awakening offer becomes the Commander's first task in the agent's own voice
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 22b3454a9
origin: audit
---

# A grabbed awakening offer becomes the Commander's first task in the agent's own voice

## Symptom

In the in-depth awakening the agent offers help ("i could draft your launch checklist tonight."). Picking one stores the goal "Wants the station to: i could draft your launch checklist tonight." and prefills YOUR FIRST TASK with the agent's sentence. Start sends it as the Commander's message, so the model's first real task reads as its own offer.

## Repro

1. Fresh station, deep path, answer the opening question.
2. At the offers pick option 1.
3. Read the goals dossier and the YOUR FIRST TASK textarea; press Start this task and read the user bubble.

## Evidence

Live (station NOVA, 2026-10-20): goal `Wants the station to: i could draft your launch checklist tonight.`; textarea `["i could draft your launch checklist tonight."]`; COMMS user bubble `COMMANDER 3:28 AM i could draft your launch checklist tonight.`.

The offer voice is mandated by `frontend/app/wakemind.js` buildMirror ("phrased as what YOU would do (\"i could …\")"); the consumer `frontend/app/onboarding.js` stored `'Wants the station to: ' + grabbedMove` and called `PitchStore.armFirstMove(grabbedMove)`.

After the fix (station GRAB): goal `synth:Accepted the station’s offer: i could draft your launch checklist tonight.`; textarea `Go ahead with your offer: “i could draft your launch checklist tonight.”`.

Regression: `test/onboarding-answer-hygiene.test.js` (deep path with a stubbed live mind); RED before the fix.

## Verdict

A grabbed offer is stored as 'Accepted the station’s offer: …' and armed as 'Go ahead with your offer: “…”'; the synthesis still reads the raw offer. Verified live (station GRAB).
