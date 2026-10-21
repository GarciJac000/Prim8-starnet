---
fingerprint: 6c707133
slug: t5-stamps-publicdistributionready-on-an-updater
title: T5 stamps publicDistributionReady on an updater .sig that signs different bytes, because T5.2 only text-compares it to latest.json
surface: release
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/release
fix: d2960405c
origin: audit
---

# T5 stamps publicDistributionReady on an updater .sig that signs different bytes, because T5.2 only text-compares it to latest.json

## Symptom

The last gate before publishing (`npm run t5:public-distribution`) reported T5.2 "Signed updater artifacts and manifest are valid" and `publicDistributionReady=true` for an installer whose `.sig` signs DIFFERENT bytes, as long as `latest.json` carried the same signature text. Every installed app would refuse that update (Tauri verifies minisign against the baked pubkey); the gate said it was fine. This is the remainder of 26af4a9a: that fix made `release-cut.mjs` verify its own signature, but T5 kept the text-only compare.

## Repro

1. Make a fixture installer `StarNet_<ver>_x64-setup.exe` and sign DIFFERENT bytes with a test minisign key (`test/minisign-test-signer.js`).
2. Write that signature to `<installer>.sig` and into `latest.json` `platforms.windows-x86_64.signature` (text-identical).
3. Give T5 green, installer-bound T0-T4 statuses and a good distribution proof; run `node scripts/t5-public-distribution.mjs --distribution-evidence <proof>`.

## Evidence

`scripts/t5-public-distribution.mjs` validateManifest only did `if (sigText && String(platform.signature || '').trim() !== sigText) errors.push(...)` and no cryptographic check.

Before the fix the new regression block in `test/t5-public-distribution.test.js` went RED: `AssertionError: a .sig that does not sign the installer must turn T5 red: ... PASS t5.2-signed-updater-artifacts` (exit 0, expected 1). The existing fixture even reached green on the literal string `fake-updater-signature`.

After the fix: `t5-public-distribution.test: OK (39 assertions)`; reverting only the script turns it red again (revert-and-watch, exit 1). Against a REAL production-key-signed build (the `_build-cli-1019` 0.13.5 installer, read-only) T5.2 now reports `pass Installer .sig verifies against the updater public key and matches latest.json.` with `pubkeySource: src-tauri/tauri.conf.json` (lane scratch `release/t5-fixcheck/t5-public-distribution-status.json`).

_Found by the `sweep/release` lane, 2026-10-20._

## Verdict

T5.2 now runs the installed updater's own check (`verifySignature` from `scripts/minisign-verify.mjs`) over the installer bytes against the pubkey baked in `src-tauri/tauri.conf.json`; `STARNET_T5_PUBKEY` is a test-only override and the step records which key it trusted. Fix: `d2960405c`.
