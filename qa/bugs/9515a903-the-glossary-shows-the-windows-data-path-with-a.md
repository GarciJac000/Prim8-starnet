---
fingerprint: 9515a903
slug: the-glossary-shows-the-windows-data-path-with-a
title: The glossary shows the Windows data path with a BEL byte instead of a backslash
surface: release
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 163c2d772
origin: audit
---

# The glossary shows the Windows data path with a BEL byte instead of a backslash

## Symptom

The website glossary entry WORKSPACE shows the Windows station data path as "%APPDATA%" followed by an invisible control character and "i.skynet.harness" — the backslash and the leading "a" are gone, so the path a reader copies does not exist.

## Repro

1. Open website/docs/glossary.html, WORKSPACE.
2. `grep -c $'\x07' website/docs/glossary.html` on trunk → 1.

## Evidence

Trunk `website/docs/glossary.html:168`: `<code>%APPDATA%<0x07>i.skynet.harness</code>` (a collapsed `\a`). Guard: `test/source-collapsed-escapes.test.js`.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Restored to `%APPDATA%\ai.skynet.harness`. Found by the providers lane's collapsed-escape scan; filed under release (public docs).
