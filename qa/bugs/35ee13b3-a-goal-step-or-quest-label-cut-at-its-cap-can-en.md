---
fingerprint: 35ee13b3
slug: a-goal-step-or-quest-label-cut-at-its-cap-can-en
title: A goal, step or quest label cut at its cap can end on half an emoji, drawn broken and saved into the station's goal and journey files
surface: world
severity: P2
status: fixed
found: 2026-10-21
lane: quest-fixes
fix: a8f2cf422
origin: audit
---

# A goal, step or quest label cut at its cap can end on half an emoji, drawn broken and saved into the station's goal and journey files

## Symptom

A long goal or step with an emoji right where its length cap falls was saved with half of the emoji. The QUEST LOG drew it as a broken glyph, and the same broken text was written into the station's own goal and journey files, so it came back on every load.

## Repro

1. Boot a seeded station (`node dev/seed.js`) against a mock provider.
2. In the page: `await GoalStore.createGoal(<279 chars of words> + '🎯 done', 'the members can open it', [<139 chars> + '🚀 then post', 'Write the second step'], {})`, then `GoalStore.addStep(id, <139 chars> + '🎬 and share it')`.
3. Read `localStorage['starnet.goals.v1']`, the QUEST LOG text (`StationUI.openTerm('quests','goals')`), and the workspace's `_commander.goals.json` / `_station.journey.json`.
4. Before the fix each ends on a lone surrogate (`\ud83c` / `\ud83d`). Locked by `test/quest-clip-surrogates.test.js`.

## Evidence

Live probe on a seeded sidecar (:9801) + headless Chrome (:9802), mock provider, $0 — before (trunk `ea48ed9aa`):

- `goalTextTail "g \ud83c"`, `goalTextLone: true`; milestone tails `"go\ud83d"`, `"nch"`, `" a\ud83c"` → `milestoneLone [true, false, true]`
- rendered: `anyLoneInBody: true` (the QUEST LOG text)
- station files with a lone surrogate: `_commander.goals.json`, `_commander.goals.json.bak`, `_station.journey.json`

After `a8f2cf422`: every tail clean (`"ng "`, `" go"`, `"nch"`, `"g a"`), `anyLoneInBody: false`, `stationFilesWithLoneSurrogate: []`, no console errors.

Cause: every cap on the quest surface was a bare UTF-16 slice — `const clip = (s, n) => { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; };` in `frontend/app/goals.js`, the same shape in `goalloop.js`, `workquests.js`, ~15 inline `String(x).slice(0, n)` caps in `goalstore.js`, label caps in `stationquests.js` / `maintquests.js`, `questledgerstore.js`'s evidence clip, and on the sidecar `sidecar/quest-store.js:45`, `sidecar/journey-store.js:28` and `commanderGoals.set` in `sidecar/index.js`. Sibling of qa/bugs/d1d77332 (the battle-pass clip), whose verdict named `goals.js` as unfixed.

Regression: `test/quest-clip-surrogates.test.js` — 50 assertions; with the fix reverted 22 fail.

_Found by the quest-fixes pass (follow-up to the 2026-10-20 sweep), 2026-10-21._

## Verdict

Fixed in `a8f2cf422`. Each cap keeps its UTF-16 bound and drops a dangling high surrogate, and `GoalStore` hydrate runs every stored string through the same cut, so a save written before the rule heals on load. A cut can still separate a multi-code-point emoji sequence (a ZWJ family) into whole code points, but it never produces a broken glyph.
