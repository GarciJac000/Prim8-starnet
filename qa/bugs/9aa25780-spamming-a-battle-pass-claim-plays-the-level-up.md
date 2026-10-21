---
fingerprint: 9aa25780
slug: spamming-a-battle-pass-claim-plays-the-level-up
title: Spamming a battle-pass CLAIM plays the level-up sting once per click
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Spamming a battle-pass CLAIM plays the level-up sting once per click

## Symptom

Five fast clicks on one CLAIM played the level sting five times; only the first click advanced the claim, the rest landed on a detached button that still ran the sound and a re-render.

## Repro

1. Have at least one earned-but-unclaimed tier.
2. Click its CLAIM five times quickly (or call `.click()` five times on the same element).

## Evidence

Before (SFX.level counted): `{ stings: 5, stored: "{\"claimedTier\":2}" }`. `frontend/app/stationui.js` claim handler now returns unless `t > bpClaimed()`. After, live: `{ spamStings: 1, stored: "{\"claimedTier\":2}" }`.

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed: only a claim that advances plays the sting. Fix: `c1b4a6f59`.
