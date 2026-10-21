---
fingerprint: 4e057f0f
slug: fifth-quest-tab-pass-overflows-a-narrow-quest-wi
title: Fifth quest tab (PASS) overflows a narrow quest window on a wide screen
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Fifth quest tab (PASS) overflows a narrow quest window on a wide screen

## Symptom

Adding PASS made five quest tabs; in a ~366px quest window on a wide screen the HISTORY tab hung 37px past the window edge and the window body scrolled sideways. The only compact-tab rule was a viewport media query.

## Repro

1. Wide viewport (1280×800).
2. Size the QUEST LOG window to ~366px wide.
3. `body.scrollWidth - body.clientWidth` is 40; the overflowing element is `button[data-quest-view="completed"]` (HISTORY).

## Evidence

Before: `{ hits: [{ el: "BUTTON.", r: 414 }], bodyRight: 377 }`, text "HISTORY", parent `.q-view-tabs`. `frontend/css/quests.css` makes `.q-view-tabs` a container (`qtabs`), lets tabs shrink (`flex: 1 1 0; min-width: 0`) and compacts them under 460px. After, live with a 350px body: `{ overflow: 0, tabs: "PASS:63 NOW:63 GOALS:63 PROGRESS:63 HISTORY:63" }`, none clipped.

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed; the regression was introduced by the battle pass merge itself (a9c55553a). Fix: `c1b4a6f59`.
