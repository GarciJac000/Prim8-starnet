---
fingerprint: b09282dd
slug: a-session-answer-on-a-folder-trust-card-is-told
title: A session answer on a folder-trust card is told it was applied while the folder access is denied
surface: safecell
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/safecell
fix: f4827da6e
origin: audit
---

# A session answer on a folder-trust card is told it was applied while the folder access is denied

## Symptom

An agent reads a file outside its workspace and the station asks "work in <folder>?". Answering "Allow for the rest of this session" — the option ACP clients (Zed etc.) show, and the "for this session" key a paired phone shows — is acknowledged as applied (`ok:true, decision:"session"`; the desk card would settle "✓ approved for this session from your phone"), but the read fails with "access to … was denied", and the next file in the same folder asks again and is denied again. A legal consent word silently became a refusal: it reads as a broken tool, and the answering surface says the opposite of what happened.

## Repro

1. Boot a sidecar with Full Access OFF. Create a folder outside the workspaces with two files.
2. Start a watched run (`POST /api/run`) whose model calls `fs.read` on the first file, then the second.
3. Answer each `permission.prompt` (tool `path.trust`) with `POST /api/consent { runId, promptId, decision: "session" }` — exactly what `sidecar/acp/serve.js` sends for ACP's `session` option.

## Evidence

Live against our own sidecar (probe `walk4.js`, sweep scratchpad):

```
prompts  ["path.trust:session","true/session","path.trust:session","true/session"]
results  [{"tool":"fs_read","ok":false,"summary":"error"},{"tool":"fs_read","ok":false,"summary":"error"}]
model saw: ERROR: tool fs.read failed: access to …\outside-proj\second.txt was denied
```

Cause: `sidecar/pathtrust.js` guard — after the prompt it handled only `if (decision === 'always' || decision === 'full')` and `if (decision === 'once')`, then `throw new Error('access to ' + norm + ' was denied')`. Producers of `session` into that prompt: `sidecar/remote/approvals.js` (`REMOTE_DECISIONS = once|session|deny`, routed through askHuman's `viaRemote`, which also announces `session` to the desk card) and `sidecar/acp/core.js` `permissionOptions()` (`optionId: 'session'`). `handleConsent` passes `session` through because it is in the vocabulary. Regression: `test/pathtrust.test.js` block 4a.

_Found by the `sweep/safecell` lane (safecell surface), 2026-10-20._

## Verdict

Confirmed live and fixed in f4827da6e. pathtrust.guard now treats 'session' as approve-this-access plus a per-run session root (o.sessionRoots, a Set runOnce owns, so it ends with the run and is never a standing grant); the protected-file floor and the workspace jail still apply first. Re-walked live: one 'session' answer, both reads in the folder succeed, no path: grant and no project row recorded. Regression: test/pathtrust.test.js block 4a.
