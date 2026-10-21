---
fingerprint: c856c4f7
slug: t0-2-reports-a-clean-windows-surface-is-availabl
title: T0.2 reports a clean Windows surface is available when only a QEMU binary exists and no Windows guest is configured
surface: release
severity: P2
status: open
found: 2026-10-20
lane: sweep/release
fix:
origin: audit
---

# T0.2 reports a clean Windows surface is available when only a QEMU binary exists and no Windows guest is configured

## Symptom

`npm run t0:clean-install` prints `PASS t0.2-clean-windows-surface` ("A clean Windows surface is available") on this Windows 11 Home host, which has no Windows Sandbox, no Hyper-V and no Windows guest image. The pass comes from the mere presence of `C:\Program Files\qemu\qemu-system-x86_64.exe`. The overall T0 verdict stays blocked (T0.3/T0.4 need imported evidence), but the step asserts a capability the host does not have.

## Repro

1. On a Windows host with QEMU installed and no Windows guest image, run `node scripts/t0-clean-install.mjs`.
2. Read `clean-surface.json` and the T0.2 line.

## Evidence

`scripts/t0-clean-install.mjs` detectCleanSurface: `cleanSurfaceAvailable: windowsSandboxPaths.length > 0 || vmToolPaths.length > 0`. Captured (lane scratch `release/ladder-worktree/t0/clean-surface.json`): `"windowsSandboxAvailable": false`, `"vmToolsAvailable": true`, vmToolPaths = the qemu binary, `"cleanSurfaceAvailable": true`, and the log line `PASS t0.2-clean-windows-surface`. `Win32_OperatingSystem.Caption` = `Microsoft Windows 11 Home`. The header of `.github/workflows/t0-clean-install-proof.yml` itself states the operator machine has no Windows Sandbox / Hyper-V and that GitHub-hosted runners are the clean surface.

_Found by the `sweep/release` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
