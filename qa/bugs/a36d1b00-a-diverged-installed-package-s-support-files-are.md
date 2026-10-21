---
fingerprint: a36d1b00
slug: a-diverged-installed-package-s-support-files-are
title: A diverged installed package's support files are mirrored to disk and shown to the model as base64 text
surface: skills
severity: P2
status: open
found: 2026-10-20
lane: sweep/skills
fix:
origin: audit
---

# A diverged installed package's support files are mirrored to disk and shown to the model as base64 text

## Symptom

After an installed package diverges (the Commander edits it), its support files are written back to disk and shown to the model as base64 text instead of their real content: `references/setup.md` on disk becomes a line of base64.

## Repro

1. Install a package with a text support file `references/setup.md`.
2. Patch the SKILL.md body as the Commander (the package diverges).
3. Read `references/setup.md` from the skill's on-disk package and preload the skill against a capturing mock provider.

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b) (same before and after bd449b81b):
- `[S1.diverge.disk] QmVmb3JlIGFueXRoaW5nIGVsc2UsIHBhc3RlIHRoaXMgY29tbWFuZCBpbnRv` (the file's text, base64-encoded, written as the file content)

Anchor: `sidecar/skills/package.js:261` maps envelope files to `{ content: f.content, encoding: 'base64' }` and the write side writes `f.content` verbatim (`writeText(path.join(dir, f.path), f.content)`).

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

