---
fingerprint: 297e2db4
slug: base64-stored-support-files-are-scanned-as-their
title: Base64-stored support files are scanned as their encoding, so a body edit releases a withheld installed package
surface: skills
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: bd449b81b
origin: audit
---

# Base64-stored support files are scanned as their encoding, so a body edit releases a withheld installed package

## Symptom

An installed package held back for review (a caution finding in `references/setup.md`) was released by an unrelated one-word edit to its body: after the edit the guard re-scanned the support files as their base64 encoding, found nothing, flipped the skill to `allow`/`safe`, and the unreviewed support file was delivered to the model (as base64).

## Repro

1. Install a package whose support file `references/setup.md` trips a caution finding; confirm it is withheld (`guardAction: ask`).
2. Patch one word of the SKILL.md body as the Commander.
3. Read the skill's guard verdict and preload it with `/skill <name>` against a capturing mock provider.
4. Before the fix: verdict `safe`, not withheld, the support file reaches the provider base64-encoded. After: still `caution`/withheld. Locked by `test/skills.package-hardening.test.js` (E).

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- before: `[S1.diverge.after.patch] {"patch":200,"withheld":false,"guardAction":"allow","verdict":"safe"}`, `[S1.diverge.preload] {"withheldNotice":false,"setupBase64AtProvider":true}`
- after: `[S1.diverge.after.patch] {"patch":200,"withheld":true,"guardAction":"ask","verdict":"caution"}`, `[S1.diverge.preload] {"withheldNotice":true,"setupBase64AtProvider":false}`

Cause: once a package diverges, `sidecar/skills/package.js` hydrates its files with `encoding: 'base64'` and `sidecar/skills/guard.js` `scanSkillRecord` called `scanText(path, f.content)` on the encoded text. Revert-and-watch: guard.js reverted → E fails.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed in `bd449b81b`: a base64-stored support file is scanned as its decoded text (binary that does not round-trip as UTF-8 is not text-scanned). The base64-on-disk side effect is filed separately (a36d1b00).
