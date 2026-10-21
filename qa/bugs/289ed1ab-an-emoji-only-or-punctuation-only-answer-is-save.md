---
fingerprint: 289ed1ab
slug: an-emoji-only-or-punctuation-only-answer-is-save
title: An emoji-only or punctuation-only answer is saved as the Commander's stated belief
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 8130d66ee
origin: audit
---

# An emoji-only or punctuation-only answer is saved as the Commander's stated belief

## Symptom

A beginner who answers an onboarding question with only emoji has that reply saved as their own words at weight `stated`, the strongest belief the station holds. In the awakening it became the Commander's goal and the prefilled FIRST TASK ("here's the first task we can begin with" over `🚀🔥💯🙏`). In the COMMANDER › guided interview it became their stated pain point. This is the same class as the typed-"skip" P0 (e62959ca): a non-answer stored as a belief that feeds every prompt and the readiness gate.

## Repro

1. Fresh station (`node dev/onboard-fresh.js`, empty browser profile), WAKE against a provider (mock fine), pick "Let's talk it through".
2. At the offers, pick "none of these — i'll say it" and send `🚀🔥💯🙏`.
3. Finish the awakening. `DossierStore.beliefs('goals')` holds `stated:🚀🔥💯🙏`; the YOUR FIRST TASK box is prefilled with `🚀🔥💯🙏`.
4. COMMANDER › Start a guided interview; answer the second question with `😤😤😤` → `DossierStore.beliefs('pain')` = `stated:😤😤😤`.

## Evidence

Live DOM round-trips (station QUASAR, 2026-10-20): `{"goals":["stated:🚀🔥💯🙏"]}` and first-task textarea `["🚀🔥💯🙏"]`; station ORBIT intake: `{"pain":["stated:😤😤😤"]}`.

Root cause: `frontend/app/interview.js` `isSkipAnswer` only matched a fixed word list after stripping `.,!?/-–—'’"` (so even `?!…` passed), and the mirror's redirect box in `frontend/app/onboarding.js` bypassed `askStep` with `const t = (!f.skip && f.value != null) ? String(f.value).trim() : ''`.

Regression: `test/interview.test.js` (no-word answers are non-answers) and `test/onboarding-answer-hygiene.test.js` (emoji redirect stores no goal and arms no task). Both seen RED before the fix.

## Verdict

Interview.isSkipAnswer treats a reply with no letter or digit in any script as a non-answer (8130d66ee); the mirror's redirect box, which bypassed askStep, got the same guard in 22b3454a9. Live after: an emoji-only reply to the required purpose question re-asks 'i need a direction here' and no goal is stored.
