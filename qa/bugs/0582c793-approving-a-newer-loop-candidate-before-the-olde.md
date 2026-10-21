---
fingerprint: 0582c793
slug: approving-a-newer-loop-candidate-before-the-olde
title: Approving a newer loop candidate before the older one it was built on breaks the rejection cascade
surface: autonomy
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: d0003aa49
origin: audit
---

# Approving a newer loop candidate before the older one it was built on breaks the rejection cascade

## Symptom

In a goal loop's review queue, APPROVE is offered on every pending pass. Approve pass #2, then reject pass #1 it was built on: if the passes touched different files, #1 is reverted but #2 stays "approved" and kept — work built on a rejected pass survives, which the stacking law says the app must never assert. If #2 built on #1's code, the rejection is refused with raw git conflict hints and #1 can never be rejected again.

## Repro

1. Bless a throwaway git repo; `POST /api/loops { workdir, queueCap:3, exitOn:'never' }` with a mock agent that writes one file per pass; wait for two committed candidates; pause the loop.
2. `POST /api/loops/verdict { n:2, verdict:'approved' }` → 200.
3. `POST /api/loops/verdict { n:1, verdict:'rejected' }`.
Variant: make each pass append a function that calls the previous one (dependent edits).
Regression: `test/loops-fifo-verdict.e2e.test.js`.

## Evidence

Live (scratchpad probeD, before): independent → approve #2 200; reject #1 200 `undone:[1]`, `cascaded:[]`; rows `#1 rejected, #2 approved`; tree `feature1:false, feature2:true`. Dependent → reject #1 409 `"could not undo iteration #1 — error: could not revert a95032e… hint: after resolving the conflicts…"`; #1 stays pending with #2 approved. Approve-twice was already a correct 409. Root cause: `handleLoopsVerdict` / `modelVerdictLoop` in `sidecar/index.js` and `recordVerdict` in `sidecar/loopjob-store.js` accepted an approval of any pending candidate, while the cascade (`loopjob.stackedAbove`) only reaches UN-approved ones. Test RED (7 problems) before, GREEN after (revert-and-watch done).

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed: an approval of #N while an older candidate is unreviewed is refused (409, names the one to review first) on the HTTP and model seams, and the pure store no-ops it; the panel greys APPROVE on all but the oldest pending pass (website mirror synced). Rejecting the oldest now cascades over everything above it.
