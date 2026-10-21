---
fingerprint: 77350944
slug: intake-interview-asks-scene-register-questions-a
title: Intake interview asks scene-register questions and glues each lead-in to its question
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 8130d66ee
origin: audit
---

# Intake interview asks scene-register questions and glues each lead-in to its question

## Symptom

COMMANDER › Start a guided interview asks questions that need decoding — "what's open on your screen right now? that's the honest answer.", "say i work for you for a year, free and tireless — what exists at the end that doesn't right now?", "what's the rule you catch yourself repeating to anyone who works with you?", "when work lands on your desk — the one-liner or the walkthrough?". Read literally, the first one gets the answer "StarNet", which was saved as the Commander's stated stack. Every question is also rendered with its lead-in glued on: "instead of guessing —what's open…", "from a silhouette.what does a typical day…".

## Repro

1. Fresh station, finish the awakening, open COMMANDER, press "Start a guided interview".
2. Read the COMMS line for question 2 and answer it literally: `just this StarNet window`.
3. `DossierStore.beliefs('stack')` → `stated:just this StarNet window`.

## Evidence

Live COMMS text (station ORBIT, 2026-10-20): `[1/7] so i reach for the right tools instead of guessing —what’s open on your screen right now? that’s the honest answer.` then `{"stack":["stated:just this StarNet window"]}`.

These asks are the scene-register rewrite `docs/ONBOARDING_V3_PLAN.md` proposed; its §1 PLAIN-QUESTION LAW (Andrew, 2026-07-20) supersedes that register: "Personality lives in ACK/reaction lines, NEVER in questions". Code: `frontend/app/interview.js` QUESTIONS asks, and `frontend/app/intake.js` `if (q.pre) segs.push({ text: q.pre, cps: 47, holdAfter: 300 })` (no separator before the ask).

Regression: `test/intake-plain-questions.test.js` runs the real intake.js in a vm and asserts the rendered line plus a banned-shapes scan over every ask; RED before the fix (10 problems).

## Verdict

Asks rewritten as plain questions (lead-ins keep the voice); intake.js types a space after the lead-in. Live after: '[2/8] so i reach for the right tools instead of guessing — which apps and tools do you use most for your work?'
