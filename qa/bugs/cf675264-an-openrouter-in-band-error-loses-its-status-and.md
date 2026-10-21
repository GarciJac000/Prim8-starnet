---
fingerprint: cf675264
slug: an-openrouter-in-band-error-loses-its-status-and
title: An OpenRouter in-band error loses its status and the upstream's words, so an in-band 401 is retried for about 100 seconds
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: c486a4f0a
origin: audit
---

# An OpenRouter in-band error loses its status and the upstream's words, so an in-band 401 is retried for about 100 seconds

## Symptom

When OpenRouter reports an upstream failure inside an already-open stream, the run either retries a hopeless error for about 100 seconds and ends with "Something went wrong on that turn — try again", or shows only "Provider returned error" with the upstream's actual reason thrown away.

## Repro

1. Make OpenRouter answer 200 and then send an in-band error chunk: `data: {"error":{"code":401,"message":"User not found."},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}` (OpenRouter opens the stream with keep-alives before the upstream answers, so upstream failures arrive this way).
2. Send a message; count chat POSTs; read the COMMS row.
3. Also: a pre-stream 403 `{"error":{"message":"Provider returned error","code":403,"metadata":{"raw":"…unsupported_country_region_territory…"}}}` — read the message the classifier sees.

## Evidence

Live on the sweep rig (sidecar on :9711 from the sweep-providers worktree, mock OpenRouter on an ephemeral port, SKYNET_OPENROUTER_BASE pointed at it), before: in-band 401 → `{"ms":105764,"mockHits":7,"error":{"message":"User not found.","transient":true},"retries":["1/6:unknown:325",…,"6/6:unknown:60000"],"userTold":{"kind":"unknown","userMessage":"Something went wrong on that turn — try again."}}`; in-band 429 wrapper → message "Provider returned error", 7 POSTs, 99 s, `unknown`; pre-stream 403 region → message "openrouter http 403 — Provider returned error" (metadata.raw dropped).

Cause: `sidecar/providers/openrouter.js` emitFrom threw `new Error(j.error.message)` with `ownMessage` — a numeric `error.code` was never a status and `error.metadata.raw` was dropped (the pre-stream path built `detail` from `error.message` only).

After (same rig + headless Chrome DOM): in-band 401 → 1 POST, "⚠ The provider rejected the API key — check it, or paste a new one under SETTINGS → AI & MODELS. ⧉ openrouter http 401 (in-stream) — User not found." Regression: `test/openrouter-inband-error.test.js` (RED 7 problems, GREEN 13).

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

An in-band numeric code now becomes `err.status` and the adapter sentence `openrouter http <code> (in-stream) — …`; `metadata.raw` rides in the message (bounded to 400 chars) on both paths. A string code (`server_error`) invents no status.
