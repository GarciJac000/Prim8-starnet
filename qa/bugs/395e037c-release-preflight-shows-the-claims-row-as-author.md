---
fingerprint: 395e037c
slug: release-preflight-shows-the-claims-row-as-author
title: release:preflight shows the claims row as 'authority Â· 37 claims Â· 380 locked surface files' because claims.mjs carries double-encoded UTF-8 literals
surface: release
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/release
fix: a0aa90243
origin: audit
---

# release:preflight shows the claims row as 'authority Â· 37 claims Â· 380 locked surface files' because claims.mjs carries double-encoded UTF-8 literals

## Symptom

The release cut checklist (`npm run release:preflight`) shows its claims row as `BLOCKED claims planning authority Â· 37 claims Â· 380 locked surface files`, and a long reason list ends in `â€¦ +N more`. The operator reads garbage characters in the one checklist meant to be read at cut time.

## Repro

1. `node scripts/release-preflight.mjs --next patch` (read-only), or `node scripts/qa/product-perfect/claims.mjs` directly.
2. Read the claims row.

## Evidence

`scripts/qa/product-perfect/claims.mjs:726` built the line with the literal `' authority Â· '` (U+00C2 U+00B7, a UTF-8 middle dot saved through a cp1252 round trip) and `:729` with `'  - â€¦ +'`. Captured preflight row (lane scratch `release/release-preflight.log`): `[FAIL] claims lock current for HEAD — BLOCKED claims planning authority Â· 37 claims Â· 380 locked surface files`. The fixtures in `test/release-preflight.test.js:30` and `test/release-ritual.test.js:68` assume the real `·`, so no test saw the real output. After the fix claims.mjs prints `BLOCKED claims planning authority · 37 claims · 380 locked surface files`. Regression: `test/release-gate-text-encoding.test.js` (scans scripts/ for the double-encoding signature; 2 problems before, OK after, red again on revert).

_Found by the `sweep/release` lane, 2026-10-20._

## Verdict

Both literals restored to the real characters; the new fast-gate test keeps every script under scripts/ free of the signature. One more instance exists only in a comment in `sidecar/channels/telegram.transport.js:245` (channels surface, harmless, not changed). Fix: `a0aa90243`.
