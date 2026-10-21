---
fingerprint: 41b2d015
slug: chosen-away-autonomy-waits-for-runs-or-dossier-a
title: Chosen away autonomy waits for runs or dossier areas before acting (usage unlock on the onboarding path)
surface: autonomy
severity: P1
status: open
found: 2026-10-20
lane: sweep/onboarding
fix:
origin: audit
---

# Chosen away autonomy waits for runs or dossier areas before acting (usage unlock on the onboarding path)

## Symptom

At the awakening's "while you're away, how much should i run on my own?" a new Commander picks "Quietly do small jobs" (or "Run free"). The station answers: "While you're away I'll do up to 3 small jobs a day… I'll start once I've seen a few of your runs or learned a little more about you." The setting they chose stays off until the station has 4 recent runs or 4 known dossier areas. There is no setting that lifts the hold. The onboarding lane brief (state 5) says any grind, unlock or usage requirement found on this path is filed as P1 even when it looks deliberate.

## Repro

1. Fresh station, WAKE, deep or short conversation; answer briefly.
2. At "while you're away…" pick "Quietly do small jobs — each one a new session".
3. Read the next line, then `GET /api/nightshift/status` (readiness tier cold).

## Evidence

Live (station ORBIT, 2026-10-20): `While you’re away I’ll do up to 3 small jobs a day; each arrives as a new session in your rail. I’ll start once I’ve seen a few of your runs or learned a little more about you.`

Source: `frontend/app/nightreport.js:286` readinessPlain; the bar is `frontend/app/autopilot.js:44` `const HOT_MIN = 4` and `frontend/app/autopilot.js:71` `const ACTIVITY_HOT_MIN = 4`, surfaced by `sidecar/index.js:8297`.

This is a deliberate design: `docs/AUTONOMY_DRIVER_PLAN.md` §2 "Earn context, then act" (locked with Andrew). `docs/DECISIONS.md` also locks "full power from minute one, and no grind/unlock/usage walls". The two locked decisions conflict here, so this needs the owner's ruling (keep the hold as a safety floor with an override, or `wontfix`). The copy is truthful; the question is only whether the hold is allowed.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
