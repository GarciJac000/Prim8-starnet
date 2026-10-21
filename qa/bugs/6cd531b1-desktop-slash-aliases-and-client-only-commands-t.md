---
fingerprint: 6cd531b1
slug: desktop-slash-aliases-and-client-only-commands-t
title: Desktop slash aliases and client-only commands typed on Telegram (/routines, /reset, /version, /q) fall through to a paid model run
surface: channels
severity: P2
status: open
found: 2026-10-20
lane: sweep/channels
fix:
origin: audit
---

# Desktop slash aliases and client-only commands typed on Telegram (/routines, /reset, /version, /q) fall through to a paid model run

## Symptom

Desktop palette aliases and client-only commands typed on Telegram are not recognised and are sent to the model as ordinary text: "/routines" (alias of /routine), "/reset" (alias of /new), "/tasks", "/buildaway", "/version", "/q", "/retry". Each costs a paid model run whose answer is the model guessing what the command means, instead of the command's own answer (or "That command only works in the StarNet desktop app.").

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner DM 4242.
1. Send "/routines".
2. Send "/version".

## Evidence

- Mock capture: `=== /routines >> "ACK[/routines]" LLM-RUN "/routines"` and `=== /version >> "ACK[/version]" LLM-RUN "/version"` (the mock's default model reply), while "/routine" from the same chat answered "Routines (1)\n1. check the morning news …" with no model call.
- Drift: `sidecar/slash.js` declares `routine` with `aliases: ['routines']`, `away` with `['build-away','buildaway']`, `new` with `['reset']`, `agents` with `['tasks']`; the hub's own table (`COMMANDS` / `parseCommand` in sidecar/channels/hub.js) knows only canonical names, and `runSlashForChannel` (which already answers client-only commands with "That command only works in the StarNet desktop app.") is reached only for the four `slash:true` names.
- Fix sketch: map the registry aliases onto hub commands inside parseCommand (so the owner gate still applies), and answer any other registry-known head through runSlash's client refusal instead of a model run.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
