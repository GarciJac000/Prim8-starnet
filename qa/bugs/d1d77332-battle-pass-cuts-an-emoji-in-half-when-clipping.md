---
fingerprint: d1d77332
slug: battle-pass-cuts-an-emoji-in-half-when-clipping
title: Battle pass cuts an emoji in half when clipping a long goal title
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Battle pass cuts an emoji in half when clipping a long goal title

## Symptom

A long goal whose 47th character is an emoji rendered its challenge as "Finish 2 planned steps on “aaaa…a�”" — a broken replacement glyph.

## Repro

1. `BattlePass.build({ progression:{level:1,points:0,activity:[]}, goal:{ id:"gx", text:"a".repeat(46)+"🚀 tail", done:0, total:3 }, goalRegistered:true, now:Date.now() })`.
2. Read `challenges[0].title`.

## Evidence

`frontend/app/battlepass.js` clip used `s.slice(0, n - 1)` (UTF-16 units). Live before: `{ lone: true, t: "Finish 2 planned steps on “aaaa…�”" }`. Now clips by code point (`Array.from`). Regression: `test/battlepass.test.js` ("a clipped goal title never ends in a lone surrogate").

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed in the pass engine. The same `slice` clip pattern exists in older quest/goal code (`frontend/app/goals.js` clip) and is not changed here. Fix: `c1b4a6f59`.
