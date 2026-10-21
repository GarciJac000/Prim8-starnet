---
fingerprint: c9c58539
slug: the-fast-gate-s-save-quota-writethrough-q3-preco
title: The fast gate's save-quota-writethrough Q3 precondition flakes when two saves land in one millisecond
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: 0151a2b74
origin: audit
---

# The fast gate's save-quota-writethrough Q3 precondition flakes when two saves land in one millisecond

## Symptom

`npm run test:fast` stopped at step 192/1273 on two consecutive full runs with
`FAIL: Q3 precondition: the queued crimson save is in the cache with the same stamp as the verdant save in transit`.
Run alone, the same file failed 2/20 times on this branch and 3/20 times with trunk's `sidecar/savestore.js` and
`frontend/app/stationui.js`, so the flake is pre-existing.

## Repro

`for i in $(seq 1 20); do node test/save-quota-writethrough.test.js >/dev/null 2>&1 || echo FAIL; done` prints a few FAILs.

## Evidence

The flake was confirmed with an instrumented copy that printed the Q3 inputs on each failing run:

```
Q3DBG {"priorQ3":1792479863670,"stamp":1792479863670,"stored":1792479863671,"cached":1792479863670,"floor":"crimson"} FAIL: Q3 precondition …
Q3DBG {"priorQ3":1792479866207,"stamp":1792479866207,"stored":1792479866208,"cached":1792479866207,"floor":"crimson"} FAIL: Q3 precondition …
```

Every failure has the frozen stamp equal to the confirmed amber save's `updatedAt`. In that case the station store's
anti-clobber rule (`incomingUpdated = Math.max(incomingUpdated, prevUpdated + 1)` in `sidecar/savestore.js`
compareRevision) stores verdant at stamp+1. The product is right; the test's
`store3.load('agent').updatedAt === stamp` assumption is not. Anchor: `test/save-quota-writethrough.test.js` (Q3 block).

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20, while running its own gate._

## Verdict

Fixed in the test: before freezing the page clock, it waits until the wall clock passes the confirmed amber save's
millisecond. 40/40 green after the change, against 2/20 and 3/20 before. No product code changed.
