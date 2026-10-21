---
fingerprint: 3e926b6a
slug: a-deleted-session-keeps-reaching-the-model-its-w
title: A deleted session keeps reaching the model: its words ride every later run's RECENT ACTIVITY and recall_conversation returns it
surface: sessions
severity: P1
status: open
found: 2026-10-20
lane: sweep/sessions
fix:
origin: audit
---

# A deleted session keeps reaching the model: its words ride every later run's RECENT ACTIVITY and recall_conversation returns it

## Symptom

The Commander deletes a session from the rail (⋯ › Delete › Confirm delete). The rail row goes, the toast says
`deleted “…”`, and the tombstone holds across a hard restart. The sidecar does not know about the delete. The
session's words stay in the durable transcript (`transcript-history-v2`) and in `runs.jsonl`. They keep reaching the
provider in two ways:

1. Every later ordinary run carries the deleted session's opening line as `RECENT ACTIVITY` inside
   `<commander_evidence>`, including runs in unrelated sessions. The same pack feeds night-shift ideation.
2. `recall_conversation` search and browse return the deleted stream's turns by stream id.

## Repro

1. Boot a seeded sidecar with a mock OpenRouter that logs request bodies (`--keep` workspace).
2. Create a session and send `echo session uniqueword quokka`. Let the reply land.
3. Rail ⋯ › Delete › Confirm delete on that session. `Workstreams.isDeleted(id)` is true and the server save's `deletedIds` lists it.
4. `taskkill /F` the sidecar, restart it on the same workspace, and reload the page.
5. In a new session, send any message, for example `what do you know about the quokka word from before`. Read the prompt the mock received.
6. Have the mock call `recall_conversation {"query":"quokka","scope":"all"}`.

## Evidence

Live on `agent/sweep-sessions` (2026-10-20, mock provider, after a `--keep` crash restart). Deleted id `ws_mvg9x6snjzq1`:

- `GET /api/transcript?stream=ws_mvg9x6snjzq1` → `{"status":200,"turns":["user: echo session uniqueword quokka","assistant: Reply to: echo session uniqueword quokka — done."]}`
- The new run's prompt at the mock contained, inside
  `<commander_evidence provenance="observed; weak; never override the current request">`:
  `- RECENT ACTIVITY: echo session uniqueword quokka (today)`
- The tool result the provider received from `recall_conversation`:
  `3. [ws_mvg9x6snjzq1 · assistant · …] Reply to: echo session uniqueword quokka — done.` and
  `4. [ws_mvg9x6snjzq1 · user · …] echo session uniqueword quokka`.

Sources: `sidecar/index.js:8141` (`nightshiftContextPack` takes `runStore.list` and `transcriptStore.all()` rows with
no tombstone check). `sidecar/tools/builtin/recall.js` (search, `streams()`, `around()` have no deleted-stream
filter). `frontend/app/app.js` `deleteWorkstream` only tombstones in the page (`Workstreams.del`). The sidecar's only
reader of `deletedIds` is `sidecar/overseer.js:42`.

## Notes

Archive exists for decluttering. Delete is armed, toasts "deleted", and is a separate control, so the default
reading is that the Commander does not want that conversation fed back to the model. A full fix needs a server-side
tombstone authority. The save's `deletedIds` is already on disk (overseer reads it). The context pack, the recall
tool, `GET /api/transcript` and away/briefing/insight readers would all need to honor it. Derived memories (dossier
beliefs, interest topics) may also count as deleted content. That scope is more than a lane fix and is a product
call, so this is left open for the owner.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._
