---
fingerprint: 1186e4e7
slug: a-force-killed-holder-s-cron-lock-with-a-recycle
title: A force-killed holder's cron.lock with a recycled PID mutes the scheduler for up to 8 minutes
surface: autonomy
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/autonomy
fix: 283face2e
origin: audit
---

# A force-killed holder's cron.lock with a recycled PID mutes the scheduler for up to 8 minutes

## Symptom

After StarNet is force-killed while it holds the scheduler lock (any routine save or tick), and Windows hands the dead process's PID to some other program, the next launch's routines do not run for up to 8 minutes; the log claims "cron.lock held by another live process" although the workspace-owner check already proved no other StarNet runs.

## Repro

1. Spawn any process now; write `WORKSPACES/cron.lock` = `<its pid>:<nonce>` with an mtime 3 minutes in the past (the crashed holder's stamp, inside the 8-minute age break).
2. Seed a due routine; boot with `SKYNET_CRON_ENABLED=1`.
3. Read `GET /api/cron` health and the boot log after 20s.
Regression: `test/cron-lock-recycled-pid.http.test.js`.

## Evidence

Live (scratchpad probeF `reused`, before): `health: { lastSuccessAt:null, healthy:false }`, `providerCalls: 0`, lock still `47480:deadbeefdeadbeef`, boot log `[cron] boot reconcile skipped — cron.lock held by another live process (no catch-up tick this boot)`. The `dead-pid` variant reclaimed and fired at once. Root cause: `const cronLock = makeCronLock({ fs, path, lockfile: CRON_LOCK_FILE, now, maxRunMs: CRON_MAX_RUN_MS })` in `sidecar/index.js` was built without the `processIdentity` / `bootedAt` proofs `sidecar/cron-lock.js` supports and the workspace-owner lock already uses. Test RED (4 problems) before, GREEN after; `test/cron.lock.test.js` still 56/56.

_Found by the `sweep/autonomy` lane, 2026-10-20._

## Verdict

Fixed by wiring both proofs. A stamp naming a PID whose process is OLDER than the stamp (genuinely unprovable) is still respected until the age break, by design.
