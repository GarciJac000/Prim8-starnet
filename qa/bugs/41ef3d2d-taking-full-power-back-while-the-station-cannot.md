---
fingerprint: 41ef3d2d
slug: taking-full-power-back-while-the-station-cannot
title: Taking Full Power back while the station cannot record it shows the agent as asking first while every run still goes ahead unasked
surface: safecell
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/safecell
fix: b038a688e
origin: audit
---

# Taking Full Power back while the station cannot record it shows the agent as asking first while every run still goes ahead unasked

## Symptom

An agent has Full Power. The Commander takes it back in SETTINGS › PERMISSIONS (or the dossier) at a moment the station cannot record the change (sidecar unreachable, or its durable roster write failing — the disk-full / locked-file class). The row immediately reads "CHECK WITH ME — Before it writes a file, runs a command, or reaches outside, it stops and waits for your yes." No warning appears. The station still holds `approvalMode: "full"`, so the next watched file write and the next unattended write both run with no prompt. The only surface that says the agent is protected is wrong, and it is wrong in the dangerous direction.

## Repro

1. Boot a seeded sidecar with Full Access OFF (`SEED_FULL_ACCESS=0`), open the app.
2. Give the hero agent Full Power (`App.setApproval('agent','full')`, or the two-press FULL POWER chip). `agent.roster.json` now holds `"approvalMode": "full"`.
3. Make the roster write fail: `attrib +r <workspaces>\agent.roster.json` (any EPERM/ENOSPC on that file; a sidecar that is down for the click behaves the same on the page).
4. SETTINGS › PERMISSIONS › the agent's row › click the "ask" chip (taking power back applies on the first click).
5. Read the row; read `agent.roster.json`; start a watched run that does `fs.write after-ask.txt`, and POST `/api/autonomy/write`.

## Evidence

Live, headless Chrome on CDP 9702 against our own sidecar on 9701 (probe `walk2.mjs`, sweep scratchpad):

- after step 2: `serverAfterFull: "full"`, pane `{ badge: "FULL POWER" }`.
- sidecar log after step 4: `[roster] persist failed: EPERM: operation not permitted, rename '…agent.roster.json.45852….tmp' -> '…agent.roster.json'`.
- pane after step 4: `{ "badge": "CHECK WITH ME", "authority": "Before it writes a file, runs a command, or reaches outside, it stops and waits for your yes." }`, notifications `[]`, page-local posture `"ask"`.
- `agent.roster.json` after step 4: `"full"`.
- enforcement seam: the watched run raised **no** `permission.prompt` and returned `wrote after-ask.txt (1 B)` (file on disk); `/api/autonomy/write` returned `{"ok":true,"summary":"wrote auto-after-ask.txt (1 B)"}`.

Cause: `frontend/app/app.js` `setAgentApproval` — `a.approvalMode = mode === 'full' ? 'full' : 'ask'; pushRoster(); persist(); return true;` — it never reads the push's answer. Its neighbours already do (`setAgentExecutionProfile` reverts on a refused push, `setAgentWorkshop` reverts on a refused grant). Every caller (dossier approval chips, PERMISSIONS crew rows, the access cards, `/yolo`-style station commands) then repaints from that local value. Regression: `test/approval-posture-recorded.test.js`.

_Found by the `sweep/safecell` lane (safecell surface), 2026-10-20._

## Verdict

Confirmed live and fixed in b038a688e. setAgentApproval now reads the roster push's answer: a refused push restores the posture the station still enforces, repaints every roster readout (StationUI.setRoster) and raises a 'did not record' warning; the permission card's FULL ACCESS (persisted by the sidecar before it answers) is marked { recorded: true } and never reverted. Re-walked live with the roster write failing: the row reads FULL POWER, the warning names it, and the roster file agrees; online, the same click lands (roster 'ask', the next write prompts, /api/autonomy/write refused). Residual: the dossier/crew callers still paint the optimistic choice for the one round trip before the correction. Regression: test/approval-posture-recorded.test.js.
