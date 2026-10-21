---
fingerprint: 5a215a68
slug: a-refused-update-download-shows-the-bare-minisig
title: A refused update download shows the bare minisign/reqwest error text and never says nothing was installed
surface: release
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/release
fix: eeb5cf20f
origin: audit
---

# A refused update download shows the bare minisign/reqwest error text and never says nothing was installed

## Symptom

When the native updater refuses a download, the Update Center toast and error card show only the library's Display text: "Update install failed - The signature verification failed", "The signature was created with a different key than the one provided", "Invalid symbol 45, offset 4.", or for a dropped connection "error decoding response body". Nothing tells a non-technical Commander that the refusal is the safety check working, that nothing was installed, or that their current StarNet is untouched.

## Repro

1. Desktop app with an update available; INSTALL UPDATE.
2. The download is corrupted, signed by another key, or the connection drops (Tauri rejects `starnet_update_install` with `e.to_string()`, see `src-tauri/src/main.rs` starnet_update_install).
3. Read the Update Center error card.

## Evidence

`frontend/app/updates.js` install(): `state.error = cleanError(e) + ...`, rendered as-is in `.up-error`.

Probe (lane scratch `release/probes/sig-refusal-ui.cjs`: the real updates.js in a vm, invoke rejecting with the exact Display strings of tauri-plugin-updater 2.10.1 / minisign-verify 0.2.5 / reqwest 0.13.4). Before: errorCard `The signature verification failed`, `error decoding response body`, `Download request failed with status: 404 Not Found`. Fail-closed itself was correct (`thawCalls: 1`, phase back to `available`).

After: `Update refused: the download did not match the signed StarNet release. Nothing was installed; your current StarNet is unchanged. (The signature verification failed)` and `The update download did not finish. Nothing was installed; your current StarNet is unchanged. Check the connection, then press INSTALL UPDATE again. (error decoding response body)`. Regression: `test/updates-install.test.js` (5 problems before the fix, `OK (43 assertions)` after; revert-and-watch red again).

_Found by the `sweep/release` lane, 2026-10-20._

## Verdict

The install failure is now described by what happened to the Commander's install, with the raw updater text kept as the trailing detail for support. Not changed: the card still offers DOWNLOAD LATEST MANUALLY after a signature refusal (the manual installer carries no updater signature and the NSIS installer is not Authenticode-signed yet, T1.2); that is an owner product call. Fix: `eeb5cf20f`.
