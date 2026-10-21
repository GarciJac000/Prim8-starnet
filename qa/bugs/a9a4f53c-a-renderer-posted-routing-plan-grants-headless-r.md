---
fingerprint: a9a4f53c
slug: a-renderer-posted-routing-plan-grants-headless-r
title: A renderer-posted routing plan grants headless runs any tools it names — no cross-check against the saved station, and it persists across restart
surface: world
severity: P1
status: open
found: 2026-10-20
lane: sweep/world
fix:
origin: audit
---

# A renderer-posted routing plan grants headless runs any tools it names — no cross-check against the saved station, and it persists across restart

## Symptom

The sidecar takes the capability grant for every headless run (channel DMs, cron, routines, loops, line hand-offs, step tests) from whatever routing plan the page last POSTed — the bay's `objects` list is the grant — and never checks it against the station the Commander actually built. A plan naming a bay that does not exist on the floor, for an agent that has no bay, turned an untrusted channel chat that gets **0 tools** into a run with **58 tools** (web, file write, browser, team dispatch/summon, routine_create, loop_create). The forged plan is written to `routing.plan.json` and re-armed at boot, so it outlives a restart until the page happens to post a new one. The floor never shows that bay, so the world also asserts a restriction the harness is not applying.

## Repro

Seeded dev sidecar WITHOUT `SKYNET_FULL_ACCESS`, mock OpenRouter that logs the `tools` array of each `/chat/completions` request (sweep/world rig).

1. `POST /api/dev/inbound {"chatId":"auth1","text":"please run a task: list the files in the workspace"}` → the mock records the run's tools.
2. `POST /api/routing` with a hand-written plan: `{"errors":[],"bays":[{"agentId":"dev_auth1","propId":"forged_bay","objects":["computer","workbench","dish","cabinet","orchestrator",{"objectType":"connector","connectorId":"ghost-connector"}]}],"dockBays":[{"agentId":"dev_auth1","propId":"forged_bay"}],"sources":[],"belts":[],"hash":"forged"}` (no such prop exists in the saved station).
3. Repeat step 1.
4. Restart the sidecar on the same workspace; repeat step 1 before any page re-posts a plan.
5. `POST /api/routing` with an empty body (clear); repeat step 1.

## Evidence

Live, 2026-10-20 (sweep/world rig, sidecar :9781, mock tool log):

- step 1: `0 []` — the dev chat run carries no tools.
- step 2: `{"ok":true,"hash":"forged","bays":1}` — accepted.
- step 3: `58 ["brief_ask",…,"web_search","web_fetch","web_request",…,"browser_navigate",…,"fs_write","fs_read",…,"team_dispatch","team_spawn","team_summon",…,"routine_create","routine_manage","loop_create","loop_manage"]`.
- step 4: `routing.plan.json` still holds `[{"agentId":"dev_auth1","propId":"forged_bay","objects":[…]}]`; after restart the same run again carried `58` tools.
- step 5: `{"ok":true,"cleared":true}` → back to `0` tools.

Code: `sidecar/routing/router.js:204` — `const authoritative = stationStore.hasStation() ? stationStore.bayObjects(agentId, bay.propId) : null;` falls back to the posted `bay.objects`, and nothing in `sidecar/index.js` ever installs a station into the router (`router.setStation` has no caller), so `hasStation()` is always false in the running sidecar. `sidecar/index.js:12628` (`handleRouting`) stores and persists any plan with an `errors` array (`router.setPlan` → `capsPlan = p`). The validated server-side derivation already exists and is unit-tested (`sidecar/station-store.js` `setSaveDoc`/`bayObjects`, `test/station-authority.test.js`; `sidecar/capability/saved-placement.js` for the cron path) but is not consulted here.

Not fixed in this lane: the fix (derive each bay's grant from the saved, validated station — or wire `router.setStation` from the save path — and refuse a bay whose prop is not on that floor) changes the authority model every routing e2e test posts plans through, and needs the plan-before-save timing decided (a freshly placed bay posts before the debounced save lands). Same root cause as an interactive `/api/run` trusting `body.placed` (`sidecar/index.js:19479`), not separately exercised here.

_Found by the `sweep/world` lane (renderer-authority failure state), 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog._
