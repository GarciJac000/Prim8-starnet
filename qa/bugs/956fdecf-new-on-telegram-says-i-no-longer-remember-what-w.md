---
fingerprint: 956fdecf
slug: new-on-telegram-says-i-no-longer-remember-what-w
title: /new on Telegram says 'I no longer remember what we discussed' while the next run replays up to 100 turns of the old chat, taint included
surface: channels
severity: P1
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: 5b934e4e2
origin: audit
---

# /new on Telegram says 'I no longer remember what we discussed' while the next run replays up to 100 turns of the old chat, taint included

## Symptom

The Commander sends /new on Telegram and is told "Cleared 100 messages — this chat starts fresh. I no longer remember what we discussed." The next message's run still receives the entire old conversation (101 messages on the wire, plus a conversation summary). Anything the old chat contained is still in the agent's context — including taint: after /new, channel.send stayed "BLOCKED … via replayed history (tainted by channel attachment)" for attachments the Commander believed were forgotten. /status meanwhile says "History: 0 messages remembered."

## Repro

Booted sidecar :9721, mock Telegram + scripted mock OpenRouter, owner paired in DM 4242, a chat with prior history including a document attachment.
1. Send /new -> "Cleared N messages — this chat starts fresh…".
2. Send "send me the files now" (scripted brief_proceed -> channel_send with files).
3. Inspect the captured provider request and the tool result.

## Evidence

- Captured provider request req-205 (the first run after /new): 102 messages, starting `user :: …whoami extra`, ending with the previous run's `[recovered tool result …] ERROR: BLOCKED: "channel.send" …` rows; tool result: `ERROR: BLOCKED: "channel.send" is no longer available on this run. This run started with outside content already in its context (via replayed history (tainted by channel attachment))`.
- Mechanism: runs read history from the canonical stream — `history = canonicalStreamId && historyFor ? historyFor(canonicalStreamId, agentId) : store.loadHistory(agentId)` (sidecar/channels/hub.js), wired as `historyFor: (streamId) => transcriptStore.reconstruct(streamId, { limit: 100 })` (sidecar/index.js) — while /new only did `store.clearHistory(boundId)` on the legacy store file.
- The /new cases in test/channels.parity.test.js never pass historyFor, so they passed vacuously. New case "/new must forget what the RUN replays" — RED before (3 failures), GREEN after.

## Verdict

Fixed: /new also moves the chat onto a fresh canonical stream (chat record streamId — as /new starts a fresh workstream in COMMS) and counts the turns a run would have replayed; the old transcript stays in the station history but is never replayed. Live re-check: /new -> "Cleared 100 messages"; the next run's request had 2 messages and channel.send delivered report.txt and the unicode-named file. Fix: `5b934e4e2`.
