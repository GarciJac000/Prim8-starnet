---
fingerprint: e862d9ff
slug: a-second-save-quarantine-after-a-restart-deletes
title: A second save quarantine after a restart deletes the first quarantined copy the recovery notice points to
surface: sessions
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: dd8662b5c
origin: audit
---

# A second save quarantine after a restart deletes the first quarantined copy the recovery notice points to

## Symptom

When the station save is torn and has no usable `.bak`, the store moves the bytes aside to
`agent.save.json.corrupt-<n>` and writes a recovery notice naming that file. That file is the only remaining copy of
the lost station. If a second unrecoverable incident happens after a restart, the second quarantine reuses the name
`.corrupt-1`, deletes the first copy and puts the new bytes in its place. The first incident's bytes are permanently
gone.

## Repro

1. Write a torn `agent.save.json` (unparseable, no `.bak`) and load it through `makeSaveStore`. It is quarantined to `.corrupt-1`.
2. Restart: create a new store instance on the same directory (the quarantine counter starts at 0 again).
3. Write another torn `agent.save.json` with no `.bak` and load it.
4. List `*.corrupt-*` and read their bytes.

## Evidence

Deterministic harness against the real `sidecar/savestore.js`, before the fix:

```
boot1 load -> corrupt notice {"kind":"quarantined",…"quarantinedTo":"…\\agent.save.json.corrupt-1"}
files after boot1: agent.save.json.corrupt-1 agent.save.recovery.json
boot2 load -> corrupt notice {"kind":"quarantined",…"quarantinedTo":"…\\agent.save.json.corrupt-1"}
files after boot2: agent.save.json.corrupt-1 agent.save.recovery.json
agent.save.json.corrupt-1 => [ 'SECOND-INCIDENT-BYTES' ]
```

Cause: `sidecar/savestore.js` quarantine named the copy `file + '.corrupt-' + (++tmpSeq)` (per-process counter) and
then ran `fs.unlinkSync(dead)` before `renameSync`. Regression: `test/save.test.js` block J2 (red before the fix,
green after).

After the fix: `agent.save.json.corrupt-1 => FIRST-INCIDENT-BYTES`, `agent.save.json.corrupt-2 => SECOND-INCIDENT-BYTES`,
and the notice names `.corrupt-2`.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._

## Verdict

Fixed. The quarantine steps to the first free `.corrupt-<n>` name and never unlinks an existing copy. The general
stores already avoided this (`index.js` quarantineCorrupt names copies `<file>.corrupt-<pid>-<seq>`); the save store
did not. The name keeps the `.corrupt-<digits>` shape existing readers match.
