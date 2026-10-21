---
fingerprint: 5c019483
slug: an-empty-station-file-never-re-seeds-from-the-br
title: An empty station file never re-seeds from the browser save and the banner blames another window
surface: sessions
severity: P1
status: open
found: 2026-10-20
lane: sweep/onboarding
fix:
origin: audit
---

# An empty station file never re-seeds from the browser save and the banner blames another window

## Symptom

When the station's workspace is empty but the browser still holds the station's save (workspace folder deleted, moved or reset; a fresh install over an old WebView profile), the app resumes the old station from the browser copy and then can never back it up. Every autosave is refused as a conflict, and a banner says "Another window saved newer station changes. Your work from this window was preserved separately on the station." No other window exists and the station file is still empty. Pressing the banner's "Reload current station" deletes the browser copy and drops the Commander into a brand-new first-run onboarding. That onboarding silently reuses the old station's API key and per-station browser state: WAKE succeeded with an EMPTY key field because `starnet.byok.key` survived.

## Repro

1. Onboard a station on `node dev/onboard-fresh.js` (port 9761) in a browser profile; do some work (save `_saveRevision` reaches 23).
2. Stop the sidecar; restart `node dev/onboard-fresh.js` (wipes the workspace) with no server key; reload the same browser tab.
3. The old station (NOVA, its sessions) is back on screen; `GET /api/save` → `{"save":null,...}`; the workspace gets `agent.save-conflict-<uuid>.json` and no `agent.save.json`.
4. `CloudSave.health()` → `conflict:{ok:false,stale:true,conflict:true,revision:0}`; `#save-conflict-notice` shows the "Another window…" text.
5. Click "Reload current station" → splash/first-run. Pick OpenRouter, leave the key EMPTY, WAKE → enters the game; the mock provider logs valid-key chat calls.

## Evidence

Live, 2026-10-20: `{"h":{"consecutiveFailures":2,"conflict":{"ok":false,"stale":true,"conflict":true,"revision":0,"recovery":"agent.save-conflict-b8992ed2-….json","updatedAt":0}},"rev":23,"pull":"empty","localRev":23,"dirty":true}`; `GET /api/save` `200 {"save":null,...}`; banner text as quoted. After Reload: `{"screen":"screen-splash","hasLocal":false}`, localStorage still held `starnet.byok.key` (30 chars), `starnet.pitch.v1`, `starnet.tutorial.v1`, `starnet.queststate.v1`, `starnet.trust.v1` and others; WAKE with an empty key field → `screen-game`, mock `kind:"chat"` with `keyShape:"valid-mock"`.

Root cause: `frontend/app/cloudsave.js` reconcile, empty-remote branch: `revision = num(local && local._saveRevision); if (isSave(local)) push(local);` ("seed the server") pushes with the local revision (23), and `sidecar/savestore.js` save with `compareRevision` reads the missing prior as revision 0, `expected !== revision` → conflict file, never a seed. `frontend/app/stationui.js` refreshSaveDurability prints the multi-window text for every conflict. `CloudSave.reloadCurrent` removes only `starnet.save`.

Not fixed here: the right seed rule (accept a first write when no prior exists, versus the Erase Everything resurrection guard) belongs to the sessions owner.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
