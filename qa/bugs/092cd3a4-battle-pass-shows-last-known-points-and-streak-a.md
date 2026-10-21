---
fingerprint: 092cd3a4
slug: battle-pass-shows-last-known-points-and-streak-a
title: Battle pass shows last-known points and streak as live while the sidecar is offline
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/battlepass
fix: c1b4a6f59
origin: audit
---

# Battle pass shows last-known points and streak as live while the sidecar is offline

## Symptom

With the station offline the topbar already reads "Lv 3 · saved" and PROGRESS shows "Journey snapshot is unconfirmed", but the PASS view kept presenting its tier, points and streak with no marker — as if live.

## Repro

1. Open QUEST LOG on PASS.
2. Stop the sidecar.
3. `JourneyStore.sync(true)` (or wait for the poll); `JourneyStore.state().stale === true`.
4. PASS has no stale/offline line.

## Evidence

Before: `{ stale: true, topbar: "Lv 1 · saved", passHasStale: false }`. `frontend/app/stationui.js` passHtml now reads `JourneyStore.state().stale` and renders `.bp-stale`. After, live: `{ stale: true, banner: "[ OFFLINE ] showing your last verified pass — points and streak refresh when the station reconnects.", topbar: "Lv 3 · saved" }`.

_Found by the `sweep/battlepass` lane (world surface), 2026-10-20._

## Verdict

Fixed: the pass carries the same stale honesty as PROGRESS and the topbar. Fix: `c1b4a6f59`.
