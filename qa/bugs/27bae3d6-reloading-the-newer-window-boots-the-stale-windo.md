---
fingerprint: 27bae3d6
slug: reloading-the-newer-window-boots-the-stale-windo
title: Reloading the newer window boots the stale window's cached station and calls it this window's work
surface: sessions
severity: P2
status: open
found: 2026-10-20
lane: sweep/sessions
fix:
origin: audit
---

# Reloading the newer window boots the stale window's cached station and calls it this window's work

## Symptom

Two windows are open on one station (same origin, so one shared `localStorage` cache). Window B renames session X
and deletes session C, and those changes are confirmed in the station file (revision 50). Window A, still on
revision 46, then renames C. Its save is correctly refused as a conflict and preserved as
`agent.save-conflict-<client>.json`, and A shows the conflict banner. But A wrote its stale snapshot into the shared
cache first. When B reloads, it boots that stale, dirty cache instead of the station file it had just confirmed:
- session C, which B deleted, is back in the rail as "Charlie From Stale Tab";
- B's rename of X is reverted;
- B's banner says "Your work from this window was preserved separately", although the work on screen came from the other window.

The station file stays correct (rev 50) until the Commander clicks "Reload current station".

## Repro

1. Load the station in tab A, then open tab B (both on the same revision).
2. In B: rename session X, delete session C, and wait for the save to confirm.
3. In A (no reload): rename session C, and wait for the save attempt. A shows the conflict banner.
4. Reload B.

## Evidence

Live on 2026-10-20 (two CDP tabs on one headless Chrome profile):

```
shared cache after A's attempt: {"rev":46,"dirty":true,"C":true,"B":"Bravo Renamed"}
B after reload: {"rev":46,"C":true,"Ctitle":"Charlie From Stale Tab","B":"Bravo Renamed","conflict":true,"banner":true,
                 "server":{"rev":50,"C":false}}
```

Cause: `frontend/app/cloudsave.js:346`, the reconcile branch `if (isSave(local) && local._saveDirty)`, boots any dirty
local snapshot as this window's offline edits. The cache key `starnet.save` is shared by every window, so another
live window's stale snapshot can't be told apart from this window's own offline work. `_saveClient` is per page load
and is not compared.

## Notes

Not fixed: this is a product fork (offline edits across an app restart versus a concurrent stale window). Nothing
is silently lost, because the station file and the conflict file both survive. The defect is that the newer window
shows, and attributes to itself, a state it never made.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._
