---
fingerprint: a40510a0
slug: battle-pass-days-challenge-can-be-impossible-lat
title: Battle pass days challenge can be impossible late in the week
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Battle pass days challenge can be impossible late in the week

## Symptom

"Earn points on 3 different days" stayed at 3 on a Saturday or Sunday with fewer active days than could still be reached — a weekly challenge that cannot be completed.

## Repro

1. Sunday, no point-earning days yet this week.
2. Open PASS: the challenge asked for 3 days with 1 day left.

## Evidence

`frontend/app/battlepass.js` challengesOf now caps the need at active days + days remaining (today counted once). Regressions in `test/battlepass.test.js`: Sunday with 0 days asks for 1; Saturday with Mon+Sat counted still asks for 3 (Sunday remains).

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed: the need never exceeds what the week allows. Fix: `c1b4a6f59`.
