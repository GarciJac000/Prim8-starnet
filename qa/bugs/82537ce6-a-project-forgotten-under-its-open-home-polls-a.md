---
fingerprint: 82537ce6
slug: a-project-forgotten-under-its-open-home-polls-a
title: A project forgotten under its open home polls a 404 forever while saying reconnecting
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: 121374d64
origin: audit
---

# A project forgotten under its open home polls a 404 forever while saying reconnecting

## Symptom

With a project's COMMS home open, the Commander revokes it and then uses PROJECTS ⋯ › Forget (already revoked) ›
Confirm. The project row goes and the toast says `forgot “proj-a”`. The open home keeps the COMMS title `proj-a`
with its CREW/ACTIVITY buttons, and shows "Activity could not refresh. Showing the last confirmed state;
reconnecting…" indefinitely. Nothing is disconnected: the station answered that the project no longer exists.

## Repro

1. PROJECTS › + ADD a folder, then click the row (its COMMS home opens).
2. ⋯ › Remove (revoke trust) › Confirm remove.
3. ⋯ › Forget (already revoked) › Confirm remove.
4. Wait at least 6 s and read the project home notice.

## Evidence

Live on the seeded sidecar (2026-10-20), 6 s after the Forget:

```
GET /api/projects/workspace?root=… -> 404 {"error":"Project not found."}
{"notice":"Activity could not refresh. Showing the last confirmed state; reconnecting…","inline":"Activity could not refresh. Showing the last confirmed state; reconnecting…","actionsHidden":false,"comms":"proj-a","owns":true}
```

Cause: `frontend/app/project-home.js` `poll()` caught every failure with `catch (_)` and re-armed the 2.5 s poll, so a
definitive 404 read as an outage. Regression: `test/project-home-ui.test.js` (forgotten-under-open-home block: red
before, green after).

After the fix, live: `{"owns":false,"inline":false,"comms":"COMMS · proj-a","actionsHidden":true}`. The home hands
COMMS back to the session, which stays in SESSIONS, and polling stops.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._

## Verdict

Fixed. `request()` now carries the HTTP status on its error, and the poll closes the project home on a 404 instead of
re-arming. Transient failures keep the existing "reconnecting…" notice and keep retrying.
