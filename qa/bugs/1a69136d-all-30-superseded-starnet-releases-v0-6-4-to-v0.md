---
fingerprint: 1a69136d
slug: all-30-superseded-starnet-releases-v0-6-4-to-v0
title: All 30 superseded StarNet releases (v0.6.4 to v0.13.3) remain publicly downloadable from the releases repo
surface: release
severity: P2
status: open
found: 2026-10-20
lane: sweep/release
fix:
origin: audit
---

# All 30 superseded StarNet releases (v0.6.4 to v0.13.3) remain publicly downloadable from the releases repo

## Symptom

Every StarNet version ever published, back to v0.6.4, can still be downloaded by anyone: the releases repo lists 31 published releases, each with its Windows installer and macOS DMGs attached and served HTTP 200. The website only links `/releases/latest` (v0.13.5), but a search result, an old forum link or the GitHub releases list hands a new user a months-old build. The lane law is that only the current version may be downloadable.

## Repro

1. `GET https://api.github.com/repos/androoAGI/starnet-releases/releases?per_page=100` (read-only).
2. Count published releases and their assets.
3. `curl -I -L https://github.com/androoAGI/starnet-releases/releases/download/v0.6.4/StarNet_0.6.4_x64-setup.exe`.

## Evidence

Captured 2026-10-20 (lane scratch `release/gh-releases.json`, `release/old-release-heads.txt`): 31 releases, none draft or prerelease, newest v0.13.5, oldest v0.6.4; every one carries `StarNet_<v>_x64-setup.exe` plus DMGs (9 assets each since v0.6.8). HEAD results: `200 .../v0.6.4/StarNet_0.6.4_x64-setup.exe`, `200 .../v0.13.3/StarNet_0.13.3_x64-setup.exe`, `200 .../v0.12.3/StarNet_0.12.3_aarch64.dmg`. No Linux asset exists on any release (platform law holds), and the live updater feed is correct: `node scripts/verify-update-host.mjs` ALL CHECKS PASSED for 0.13.5 (windows-x86_64, darwin-aarch64, darwin-x86_64 only). Anchor: `.github/workflows/release-train.yml` publishes each release and nothing retires the previous release's assets.

_Found by the `sweep/release` lane, 2026-10-20._

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
