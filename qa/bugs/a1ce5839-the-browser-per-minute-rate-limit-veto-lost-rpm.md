---
fingerprint: a1ce5839
slug: the-browser-per-minute-rate-limit-veto-lost-rpm
title: The browser per-minute rate-limit veto lost rpm and tpm to collapsed backspace bytes
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 163c2d772
origin: audit
---

# The browser per-minute rate-limit veto lost rpm and tpm to collapsed backspace bytes

## Symptom

Silent: the browser's per-minute rate-limit veto could never match "rpm" or "tpm", so a 429 that names a daily or weekly limit and says RPM/TPM (and nothing else short-window) would read as a spent allowance with no retry.

## Repro

1. `grep -c $'\x08' frontend/app/friendlyerror.js` on trunk → 1.
2. Inspect line 407: `|\x08rpm\x08|\x08tpm\x08|` — literal backspace bytes where `\b` was meant.

## Evidence

`xxd` of trunk `frontend/app/friendlyerror.js:407`: `637c 0872 706d 087c 0874 706d 087c` ("c|.rpm.|.tpm.|"). The same collapsed-escape writer left bytes in two other shipped files (see 46602571, 9515a903). Guard: `test/source-collapsed-escapes.test.js` — RED on trunk with 4 problems (friendlyerror.js:407 + its website mirror, sidecar/index.js:15561, website/docs/glossary.html:168), GREEN after.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Bytes restored to `\brpm\b|\btpm\b`; the guard test scans sidecar/frontend/shared/website/scripts for the bytes a collapsed \0 \a \b \v \f escape produces (0x01 sentinels and an 0x1B example stay legal).
