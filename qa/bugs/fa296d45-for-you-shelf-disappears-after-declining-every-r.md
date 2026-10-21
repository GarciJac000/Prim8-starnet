---
fingerprint: fa296d45
slug: for-you-shelf-disappears-after-declining-every-r
title: FOR YOU shelf disappears after declining every recipe
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: ce7698b0d
origin: audit
---

# FOR YOU shelf disappears after declining every recipe

## Symptom

A Commander who presses ✕ ("not interested — stop recommending this") on every FOR YOU card watches the row shrink to two cards, then one, then vanish completely. The lane law is that hostile recommender input (reject everything) must still return something.

## Repro

1. Fresh station, finish onboarding, open the recipe library (`Marketplace.open({ mode: 'deploy', tab: 'recipes' })`).
2. Press the `.mkt-rec-decline` ✕ on the first FOR YOU card 45 times (the catalog has 45 recipes).
3. After the 45th, `.mkt-foryou-sect` no longer exists.

## Evidence

Live DOM log (station NOVA, 2026-10-20): `"40:3 ◈ STARTING POINTS…", "42:2 …", "43:1 …", "44:0 GONE", "45:NO-SHELF"`, `declinedN: 45`.

The ranker itself is robust (prefs negative on everything, every recipe rated miss, negative affinity, emoji/huge goal text all return 3 items: scratchpad `shelf-probe.log`). The hole is the input pool in `frontend/app/marketplace.js` `forYouShelfHTML`: `Recipes.list().filter(r => !shelfDeclined(r && r.name))` → empty → `if (!items || !items.length) return ''`.

After the fix, same walk: `"45:3 ◈ STARTING POINTS — you passed on every recipe, so here is t…"`.

Regression: `test/foryou-shelf-floor.test.js` (runs the real forYouShelfHTML over the real catalog); RED before the fix (0 cards).

## Verdict

When the declined filter leaves nothing, forYouShelfHTML ranks the whole library again under 'STARTING POINTS — you passed on every recipe, so here is the library again'. Verified live: 45 declines → 3 cards with that header. The row still thins to 2 then 1 card on the last declines before the floor; not empty.
