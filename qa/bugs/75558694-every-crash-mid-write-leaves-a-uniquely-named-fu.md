---
fingerprint: 75558694
slug: every-crash-mid-write-leaves-a-uniquely-named-fu
title: Every crash mid-write leaves a uniquely named full-copy tmp file that nothing ever sweeps
surface: sessions
severity: P2
status: open
found: 2026-10-20
lane: sweep/sessions
fix:
origin: audit
---

# Every crash mid-write leaves a uniquely named full-copy tmp file that nothing ever sweeps

## Symptom

The durable writers do keep their promise: a crash at any point leaves the last good or the new state, never a torn
one. But a crash between the temp write and the rename leaves the temp file behind. `durable-write.js` names temps
`<file>.<pid>.<random>.tmp`, so every crash adds a new orphan holding a full (or partial) copy of that store,
including credential stores such as channel secrets and connector keys (mode 0600). Nothing removes them. The save
store reuses `<file>.<seq>.tmp` names, so it leaves at most a few.

## Repro

1. Run a write through `makeDurableJsonStore(...).update()` in a child process whose fs facade kills the process (SIGKILL) on the first `writeSync` or `fsyncSync` of the main temp.
2. Restart, read the store, and list the directory.

## Evidence

Kill harness (111 kill points over the real `savestore.js`, `durable-store.js` and `logbound.js appendJsonlDurable`):
`TOTAL 111 BAD 0`. Every restart read the last good or the new state, and the next write succeeded. The directories
afterwards:

```
durablestore write:2:100  died ok:OLD2 | rec.json rec.json.33312.2551f26fda0f.tmp rec.json.bak
durablestore fsync:3      died ok:OLD2 | rec.json rec.json.45092.6064ad1469cd.tmp rec.json.bak
durablestore rename:1     died ok:OLD2 | rec.json rec.json.bak rec.json.bak.46180.a105bf91f91c.tmp
savestore    write:2:100  died ok:OLD2 | agent.save.json agent.save.json.2.tmp agent.save.json.bak
```

Anchor: `sidecar/durable-write.js:48` (`const tmp = file + '.' + process.pid + '.' + nonce + '.tmp';`). No sidecar
code removes stale `*.tmp` siblings at boot. This is disk growth and stray copies, not lost state.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._
