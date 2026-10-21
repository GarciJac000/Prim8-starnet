---
fingerprint: 67ba42c6
slug: usage-on-an-unsettled-ledger-answers-see-setting
title: /usage on an unsettled ledger answers '…See SETTINGS › SPENDING LIMITS..' with a doubled period, on Telegram and in COMMS
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: cc57c42b6
origin: audit
---

# /usage on an unsettled ledger answers '…See SETTINGS › SPENDING LIMITS..' with a doubled period, on Telegram and in COMMS

## Symptom

After a crash left an interrupted run's spend unsettled, /usage on Telegram (and the same command in COMMS) answered "Could not read the spend ledger: Spend history is unavailable or not durably saved. See SETTINGS › SPENDING LIMITS.." — a doubled period on the one line that tells the Commander where to look. Cosmetic; the refusal itself is honest.

## Repro

Booted sidecar :9721 after hard-killing it mid-run (ledger health complete:false, UNSETTLED_SPEND), owner DM 4242.
1. Send /usage on Telegram, or POST /api/slash/dispatch {input:"/usage"}.

## Evidence

- Telegram (mock capture) and /api/slash/dispatch both: `"Could not read the spend ledger: Spend history is unavailable or not durably saved. See SETTINGS › SPENDING LIMITS.."`.
- `sidecar/slash-actions.js:336` appended `'.'` to a host error that already ends in one (sidecar/index.js budget.snapshot: `'… See SETTINGS › SPENDING LIMITS.'`).
- Regression: `test/slash-actions.test.js` ("a refusal that ends in a period is not doubled") — RED before, GREEN after.

## Verdict

Fixed: trailing punctuation of the host's error is trimmed before the sentence's own period. Fix: `cc57c42b6`.
