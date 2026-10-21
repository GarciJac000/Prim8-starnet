---
fingerprint: 446602ab
slug: every-channel-run-without-a-configured-system-pr
title: Every channel run without a configured system prompt reaches the provider with the persona replaced by the literal text '() => p'
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 9e15c999e
origin: audit
---

# Every channel run without a configured system prompt reaches the provider with the persona replaced by the literal text '() => p'

## Symptom

A Telegram message to the station bot on a station whose channel config carries no synced system prompt (env-token / headless boot, or before the desktop page has pushed /api/channels/telegram/sync) runs with a system prompt that begins with the literal characters "() => p" instead of the channel persona ("You are the Commander's AI agent aboard the STARNET station, reachable over Telegram. Address the user as "Commander"…"). The agent loses its channel identity and the "keep replies concise and chat-friendly / you have REAL tools" guidance on every such run, while the sidecar log says the run "proceeds on the station persona".

## Repro

Booted sidecar :9721 (SKYNET_TELEGRAM_TOKEN + SKYNET_TELEGRAM_API_BASE -> mock Bot API, scripted mock OpenRouter), owner paired in DM 4242, no /sync from a browser.
1. Send any message ("hello there, what can you do").
2. Read the system message of the captured provider request.

## Evidence

- Captured provider requests (wire): req-3, req-201, req-215, req-232, req-245, req-265, req-269 all start `"() => p The Commander has just messaged you a task — carry i…"`; the voice-note run req-268 starts `"() => p\n<capabilities_ground_truth>…"`. The agent-bound bot (system synced from the roster) was correct: req-233 starts `"scout system SCOUT_PERSONA The Commander…"`.
- Defect: `sidecar/channels/hub.js` `const personaFor = typeof o.persona === 'function' ? o.persona : (() => { const p = (typeof o.persona === 'string' && o.persona) || DEFAULT_PERSONA; return () => p; });` — the factory is never invoked, so `personaFor(agentId, rec)` returns the inner arrow and `dockSystem(persona, …)` string-concatenates its source. Present since 7be3c6e12 (2026-06-14). Every string-persona hub is affected whenever `sec.system` is empty: TELEGRAM_PERSONA, DISCORD_PERSONA, DEV_PERSONA, channelPersona(label) (Slack/Matrix/Signal), SAMPLE_PERSONA, TRIGGER_PERSONA, HANDOFF_PERSONA, and the DEFAULT_PERSONA fallback.
- Exposure scoping: the desktop page's sync (frontend/app/app.js `system: agent.systemPrompt`) normally supplies a composed system prompt, so a synced station's main chat is not affected; trigger/handoff/sample hubs fall back only when the roster agent has no system.
- Regression: `test/channels.hub.test.js` case B3 — RED before ("a string persona opens the system prompt: \"() => p\""), GREEN after.

## Verdict

Fixed: the fallback factory is invoked, so a string (or absent) persona is the run's persona. Live re-check on the wire: the next station-bot request (req-270) opened "You are the Commander's AI agent aboard the STARNET station, reachable over Telegram. Address the user as \"Commander\"…". Fix: `9e15c999e`.
