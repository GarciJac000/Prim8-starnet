---
fingerprint: 8faefe89
slug: a-wall-of-text-onboarding-answer-rides-every-sys
title: A wall-of-text onboarding answer rides every system prompt uncapped
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 773e82859
origin: audit
---

# A wall-of-text onboarding answer rides every system prompt uncapped

## Symptom

A beginner who pastes a long text into the awakening's answer box ("say as much or as little as you like…") pays for it on every model call afterwards. The answer is written verbatim into the agent's context.md, which `composeSystemPrompt` folds into every system prompt, and it is quoted again into each meeting directive.

## Repro

1. Fresh station, mock provider that records request bodies, pick "Let's talk it through".
2. Paste a 5,000-word answer (42,001 chars) into the opening or follow-up question and send.
3. Read the next `/chat/completions` body: system prompt size and the context.md section.

## Evidence

Mock capture (station QUASAR, 2026-10-20): `req-2.txt system 49411 user 44257`, the system prompt's `ABOUT YOUR COMMANDER & THEIR WORLD (context.md):` section held the whole answer (336 repeats of the probe word). Code: `frontend/app/onboarding.js` askStep `const text = isSkip ? '' : String(res.value).trim();` then `commit({ context: conversation.map(...) })`; `frontend/app/app.js:387` appends context.md uncapped.

After the fix (station VERIFY, same 42,001-char answer): `system 9242`, `App.currentAgent().docs.context.length` = `1998`.

Regression: `test/onboarding-answer-hygiene.test.js` (a 42k answer is clipped before commit; an emoji-studded wall never leaves a lone surrogate); RED before the fix.

## Verdict

askStep clips each answer to ANSWER_CHARS (2000) before it is committed or quoted; fef9b5d37 makes the clip count code points. Verified live: the same 42,001-char answer now gives a 9,242-char system prompt and a 1,998-char context.md.
