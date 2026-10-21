---
fingerprint: 56c6f962
slug: a-legacy-skill-record-s-unscanned-summary-still
title: A legacy skill record's unscanned summary still rides the prompt index
surface: skills
severity: P2
status: open
found: 2026-10-20
lane: sweep/skills
fix:
origin: audit
---

# A legacy skill record's unscanned summary still rides the prompt index

## Symptom

A legacy skill record saved before the guard existed has its BODY withheld, but its unscanned summary is still written into the skill index of every run, so text that never passed the scanner reaches the model on each turn.

## Repro

1. Write a skill record into the store without any guard verdict (the pre-guard legacy shape) whose summary carries a marker string.
2. Start a run and capture the composed system prompt at a mock provider.
3. The body is withheld (`withheldNotice:true`, body marker absent) but the summary marker is in the index.

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b) (same before and after bd449b81b):
- `[S1.legacy.preload] {"withheldNotice":true,"bodyNeedle":false,"indexSummaryNeedle":true}`

Anchor: the index builder in `sidecar/skills/runtime.js` (around line 145) prints a summary for rows not marked held; a legacy record is withheld at preload but not marked held in the index.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

