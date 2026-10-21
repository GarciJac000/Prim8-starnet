---
fingerprint: 29043870
slug: rolling-back-an-installed-skill-overrides-its-pi
title: Rolling back an installed skill overrides its pin without an explicit force
surface: skills
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/skills
fix: bd449b81b
origin: audit
---

# Rolling back an installed skill overrides its pin without an explicit force

## Symptom

Rolling back an exchange-installed skill the Commander had pinned replaced its content anyway: the rollback answered 200 and the pinned body changed from version 2 back to version 1.

## Repro

1. Install a skill from the exchange (v1), update it (v2), pin it.
2. `POST /api/skill-exchange/rollback` to the v1 digest without `force`.
3. Before the fix: 200, body is v1. After: 400 "is pinned - unpin it first (pinned skills are protected from rollback)", body stays v2; an explicit `force:true` still rolls back. Locked by `test/skills.package-hardening.test.js` (F).

## Evidence

probe log `[S…]` lines from the lane's live run against a seeded sidecar on :9751 with a capturing mock provider (before = trunk f2c4a1424, after = bd449b81b):
- before: `[S6.rollback.pinned] {"status":200,"error":"","bodyNow":"1. ROLL-V1","pinned":true}`
- after: `[S6.rollback.pinned] {"status":400,"error":"\"notes-tool\" is pinned - unpin it first (pinned skills are protected from rollback)","bodyNow":"1. ROLL-V2","pinned":true}`

Anchor: `sidecar/skills/exchange.js` `rollback` (no pin check) and its route in `sidecar/index.js` `handleSkillExchangeRollback`. Revert-and-watch: exchange.js reverted → F fails.

_Found by the `sweep/skills` lane (skills surface), 2026-10-20._

## Verdict

Fixed in `bd449b81b`: rollback refuses a pinned skill unless the request carries `force: true`; the route passes `body.force` through.
