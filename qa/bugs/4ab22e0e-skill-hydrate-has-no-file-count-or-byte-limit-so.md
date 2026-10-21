---
fingerprint: 4ab22e0e
slug: skill-hydrate-has-no-file-count-or-byte-limit-so
title: Skill hydrate has no file-count or byte limit, so 10k files on disk reach the provider in one request
surface: skills
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: bd449b81b
origin: audit
---

# Skill hydrate has no file-count or byte limit, so 10k files on disk reach the provider in one request

## Symptom

A skill package with 10,000 support files on disk was hydrated whole: `/skill <name>` took ~1.9 s and sent a 2.4 MB request upstream. The store itself never holds more than 64 support files, so the disk copy was read past every limit the store enforces.

## Repro

1. Create a user skill, then write 10,000 small files under its on-disk `references/`.
2. `/skill <name>` against a capturing mock provider and measure the largest request.
3. Before the fix: 2,399,930 bytes. After: the over-limit disk copy is ignored and the stored record is delivered (52,138 bytes). Locked by `test/skills.package-hardening.test.js` (C, 65 files).

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- before: `[S7.10k.preload] {"ms":1858,"largestRequestBytes":2399930}`
- after: `[S7.10k.preload] {"ms":494,"largestRequestBytes":52138}`

Anchor: `sidecar/skills/package.js` `readSupportFiles` (no count/byte cap before the fix). Revert-and-watch: package.js reverted → C fails ("expected 0, got 65").

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed in `bd449b81b`: disk limits mirror the store (64 files, 1 MiB per file, 4 MiB total); over them `readSupportFiles` returns null and `hydrate()` keeps the stored record.
