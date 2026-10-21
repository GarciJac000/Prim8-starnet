---
fingerprint: c723d5f4
slug: skill-hydrate-reads-files-through-a-support-fold
title: Skill hydrate reads files through a support folder that is itself a junction, and through hardlinked files
surface: skills
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: bd449b81b
origin: audit
---

# Skill hydrate reads files through a support folder that is itself a junction, and through hardlinked files

## Symptom

A skill package whose `references/` folder is itself a link (a Windows junction) to a folder outside the package root had that outside folder's files read into the skill by `hydrate()` and delivered to the model, both through `/skill` preload and through `skill.view`. A support file that is a hardlink to a file elsewhere on disk was read the same way.

## Repro

1. Seed a station and create a clean user skill.
2. In its on-disk package, replace `references/` with a junction (`mklink /J references <a scratch folder outside the package root>`) holding a fixture text file.
3. Preload the skill with `/skill <name>` (or call `skill.view`) and capture the upstream request at a mock provider.
4. Before the fix the fixture text is in the request; after it the folder is skipped. Same for a hardlinked file inside `references/`. Locked by `test/skills.package-hardening.test.js` (A, B).

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- before: `[S7.junction.preload] {"keyAtProvider":true}`, `[S7.junction.skill_view] {"keyAtProvider":true}`, `[S7.hardlink.preload] {"keyAtProvider":true}`
- after: all three `{"keyAtProvider":false}`

Cause: `sidecar/skills/package.js` `readSupportFiles` skipped links found INSIDE a support folder but never checked the support folder itself, and read hardlinked files. Revert-and-watch: with package.js reverted, `test/skills.package-hardening.test.js` reports 5 problems (A, B, C).

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed in `bd449b81b`: `readSupportFiles` skips a support folder that is a link or resolves outside the root, and skips files with `nlink > 1` (this module never writes one).
