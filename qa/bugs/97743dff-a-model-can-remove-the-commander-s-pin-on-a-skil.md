---
fingerprint: 97743dff
slug: a-model-can-remove-the-commander-s-pin-on-a-skil
title: A model can remove the Commander's pin on a skill directly, without a staged proposal
surface: skills
severity: P2
status: open
found: 2026-10-20
lane: sweep/skills
fix:
origin: audit
---

# A model can remove the Commander's pin on a skill directly, without a staged proposal

## Symptom

A model can remove the Commander's pin from a skill with one `skill.manage` call (`action: "unpin"`). The pin is the Commander's explicit protection against model edits, yet unpinning is applied at once, not staged for approval — after which the model's next `patch`/`write` is no longer refused.

## Repro

1. Commander pins a skill (`[S6.pin] 200 pinned=true`).
2. A run calls `skill.manage {action:"unpin", id}`.
3. Read the skill: `pinned:false`. A later model `patch` now succeeds.

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- `[S6.model.patch] Could not manage the skill: "Pinned Proc" is pinned - unpin it first (pinned skills are protected from patch)`
- `[S6.model.unpin] Skill "Pinned Proc" unpin complete.` → `[S6.after.model.unpin] {"pinned":false}`

Anchor: `sidecar/skillstore.js:530` applies `pin`/`unpin` directly (`entry.pinned = …; persist(entry)`); `sidecar/tools/builtin/skills.js:74` classes pin/unpin as lifecycle, not content.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

