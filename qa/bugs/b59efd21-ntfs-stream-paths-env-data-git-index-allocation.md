---
fingerprint: b59efd21
slug: ntfs-stream-paths-env-data-git-index-allocation
title: NTFS stream paths (.env::$DATA, .git::$INDEX_ALLOCATION) write through the protected-file floor
surface: safecell
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/safecell
fix: 876643da3
origin: audit
---

# NTFS stream paths (.env::$DATA, .git::$INDEX_ALLOCATION) write through the protected-file floor

## Symptom

The protected-file floor promises `.env` and `.git` are never written by an agent, under any grant. On Windows, `fs.write` of `.env::$DATA` writes `.env`, and `repo/.git::$INDEX_ALLOCATION/hooks/pre-commit` writes a git hook — each needing only an ordinary "Approve once" for a file write (or no prompt at all under a standing `cabinet:write` grant or a workshop grant on an unattended run). Inside a blessed project that has no `.env` yet, `<project>\.env::$DATA` creates one.

## Repro

1. Boot a sidecar with Full Access OFF; start a watched run with the cabinet placed.
2. Have the model call `fs.write { path: ".env::$DATA", content: "ADS=1" }`; answer the card "Approve once".
3. Have it call `fs.write { path: "repo/.git::$INDEX_ALLOCATION/hooks/pre-commit", content: "…" }`; approve once.
4. Bless a folder with no `.env` (answer a path.trust card "Always"), then `fs.write { path: "<that folder>\\.env::$DATA" }`.
5. Look at the disk.

## Evidence

Live against our own sidecar (probe `walk6.js`, sweep scratchpad). Control: `fs.write .env` → `consent denied for fs.write: writing .env is blocked by the protected-file floor`. Stream forms, before the fix:

```
jail_env_ads        prompts ["fs.write:once"]  ok:true  "Wrote .env::$DATA (5 bytes). [mutation receipt: read-back-verified …]"
jail_env_on_disk    "ADS=1"                     (workspaces/agent/.env)
jail_git_ads        prompts ["fs.write:once"]  ok:true  "Wrote repo/.git::$INDEX_ALLOCATION/hooks/pre-commit (20 bytes)."
jail_git_on_disk    true                        (workspaces/agent/repo/.git/hooks/pre-commit)
blessed_env_ads_new prompts ["fs.write:once"]  ok:true  "Wrote …\fuzz-proj\.env::$DATA (9 bytes)."
blessed_env_on_disk "PLANTED=1"                 (fuzz-proj/.env)
```

Cause: both floors matched only `.env` before `.`/end and `.git` before a separator/end — `sidecar/index.js` hardlineFloor `/(^|[\\/])\.env(\.|$)/i` and `/(^|[\\/])\.git([\\/]|$)/i`, and the same two patterns in `sidecar/pathtrust.js` hardlineReason. pathtrust's realpath re-proof already catches an EXISTING `.env`/`.git` reached this way (realpath canonicalizes the stream name), so the hole is a new target, and every in-workspace write (the jail branch has no realpath floor). Regression: `test/protected-floor-ntfs.test.js`.

Not covered by the fix (noted, not filed separately): 8.3 short names (`ENV~1`, `GIT~1`) inside an agent's own workspace still reach an EXISTING `.env`/`.git` there, because the jail branch of `fs.js` resolveInside does not re-prove the floor on the realpath; outside the workspace the pathtrust re-proof already refuses them.

_Found by the `sweep/safecell` lane (safecell surface), 2026-10-20._

## Verdict

Confirmed live and fixed in 876643da3: both floors now also stop at ':' after .env/.git. Re-walked live: .env::$DATA, repo/.git::$INDEX_ALLOCATION/hooks/pre-commit and <blessed proj>\.env::$DATA are refused at the broker hardline and nothing is written. Residual (not fixed): 8.3 short names inside an agent's own workspace (see Evidence). Regression: test/protected-floor-ntfs.test.js.
