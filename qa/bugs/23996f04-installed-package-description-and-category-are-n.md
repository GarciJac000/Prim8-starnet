---
fingerprint: 23996f04
slug: installed-package-description-and-category-are-n
title: Installed package description and category are never scanned yet ride every run's skill index
surface: skills
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: bd449b81b
origin: audit
---

# Installed package description and category are never scanned yet ride every run's skill index

## Symptom

An installed community package carrying an instruction-style phrase only in its `description` (body clean) installed with guard action `allow`, and that description text was then placed in the skill index of every run. The scanner never looked at the fields the index actually shows.

## Repro

1. Import a package envelope whose SKILL.md body is clean but whose frontmatter `description` contains a phrase the guard's existing rules flag.
2. Preview and install it.
3. Start any run and capture the composed system prompt at a mock provider.
4. Before the fix: preview `allow`, install 200, the phrase is in the prompt index. After: preview `block`, install 400. Locked by `test/skills.package-hardening.test.js` (D).

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- before: `[S1.desc.install] {"preview":"allow","install":200,"guardAction":"allow"}`, `[S1.desc.index] {"injectionInPrompt":true}`
- after: `[S1.desc.install] {"preview":"block","install":400}`, `[S1.desc.index] {"injectionInPrompt":false}`

Cause: `sidecar/skills/guard.js` `scanSkillRecord` scanned only `body`, `setup` and support files (the market path already scanned descriptions). Revert-and-watch: guard.js reverted → D fails.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed in `bd449b81b`: `scanSkillRecord` also scans name, summary, description and category (findings reported at line 0).
