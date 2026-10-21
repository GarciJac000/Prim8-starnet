---
fingerprint: 3683ee51
slug: battle-pass-hides-its-points-count-and-reset-tim
title: Battle pass hides its points count and reset time in a narrow quest window
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Battle pass hides its points count and reset time in a narrow quest window

## Symptom

At phone width (390px) the 24-cell ASCII points bar pushed "0/100 PTS" off the edge of the hero and the WEEKLY CHALLENGES rule clipped to "RESETS IN 6D 0…"; the layout breakpoint was a viewport media query, so a narrow quest WINDOW on a wide screen got no compact layout at all.

## Repro

1. Open QUEST LOG on PASS.
2. Emulate a 390×844 viewport (or keep a wide viewport and make the quest window ~360px wide).
3. Read the hero: the count is clipped; read the challenges rule: the reset time is cut.

## Evidence

Screenshot at 390×844 before the fix showed `[........................] (` with the count cut. `frontend/css/quests.css` now makes `.bp` a container (`container-name: bpass`) and swaps to a 10-cell bar under 420px; the reset time moved under the rule. After, live at 390: `{ shortBar: true, xpText: "[#####.....] 50/100 PTS", bodyOverflow: 0 }`; at a 1280px viewport with a 366px window the compact layout also applies (`pass: 303, shortBar: true`).

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed with container queries (precedent: `.ext-workspace`, `delegated` in beat-cards.css). Fix: `c1b4a6f59`.
