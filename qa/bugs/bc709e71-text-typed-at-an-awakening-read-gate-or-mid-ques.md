---
fingerprint: bc709e71
slug: text-typed-at-an-awakening-read-gate-or-mid-ques
title: Text typed at an awakening read gate or mid-question is silently discarded
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: 773e82859
origin: audit
---

# Text typed at an awakening read gate or mid-question is silently discarded

## Symptom

During the awakening the COMMS box always says "answer to wake your agent…". When the panel is on a read gate ("i need a direction here — even a rough one. / Continue →"), on patter, or on an option-only choice, typing an answer and pressing Enter clears the box, echoes nothing and throws the words away. After Continue the same question returns with an empty answer box. The guided interview does the same while a question is still typing out.

## Repro

1. Fresh station, WAKE, Quick setup.
2. At "what made you want to set up an agent?" type `skip` in COMMS + Enter → the read gate "i need a direction here…" appears.
3. Type `teaching chemistry` in COMMS + Enter.
4. Composer is empty, nothing echoed; press Continue → the question again, empty.

## Evidence

Live (station VANTA, 2026-10-20): after step 3 `{"composer":"","echoed":[]}`; after Continue `{"dlg":"… what made you want to set up an agent? / Send → / Need a starting point?","box":[""]}`.

Defect: `frontend/app/onboarding.js` `Chat.beginInterview(text => { if (typeof Dialogue !== 'undefined' && Dialogue.answer) Dialogue.answer(text); })` ignored `Dialogue.answer`'s `false` (no question pending); `frontend/app/intake.js` `answer()` returns early when `!accepting`.

After the fix (station VERIFY): step 3 leaves `{"composer":"teaching chemistry"}`; Continue + Enter commits purpose `teaching chemistry`.

Regression: `test/onboarding-answer-hygiene.test.js` (read gate and mid-question cases); RED before the fix.

## Verdict

Both composer handlers hand unaccepted text back via Chat.prefill. Verified live: text typed at the read gate stays in the composer; Continue + Enter commits it as the purpose.
