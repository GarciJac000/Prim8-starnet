---
fingerprint: bbf17048
slug: with-mention-off-a-group-command-addressed-to-an
title: With /mention off, a group command @-addressed to another bot (/new@otherbot, /stop@otherbot) runs on this bot
surface: channels
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/channels
fix: debe64ba4
origin: audit
---

# With /mention off, a group command @-addressed to another bot (/new@otherbot, /stop@otherbot) runs on this bot

## Symptom

In a Telegram group where the owner turned /mention off (answer every message), a command explicitly addressed to a different bot — "/new@otherbot" — wiped THIS bot's chat history ("Cleared 2 messages — this chat starts fresh"), and "/stop@otherbot" would stop this bot's run. With two StarNet bots in one room (station bot + an agent-bound bot), both obey a command meant for one.

## Repro

Booted sidecar :9721, mock Telegram, owner 99 paired.
1. In supergroup -1001 the owner sends /allow, then /mention off.
2. Send "hello group, remember the codeword PINEAPPLE" (history: 2 messages).
3. Send "/new@otherbot".

## Evidence

- Before the fix (mock capture): `>> chat -1001: "Cleared 2 messages — this chat starts fresh. I no longer remember what we discussed."`, then /status "History: 0 messages remembered."
- Mechanism: `sidecar/channels/adapter.js` admission returns 'run' for every group message once `requireMentionFor(chatId)` is false — before any addressing check — and the hub's `parseCommand` strips any @suffix (`'/talk@mybot' -> 'talk'`) without checking whose name it is. With the mention gate ON, addressesUs already refused it.
- Regression: `test/channels.telegram.groups.test.js` case B2 — RED before, GREEN after.

## Verdict

Fixed: admission refuses a command whose @suffix names a different bot before the mention gate (observed if the chat observes, else dropped); a bare command and one addressed to us still run. Live re-check: "/new@otherbot" and "/stop@otherbot" got no reply and /status still showed "History: 2 messages remembered."; "/status@bot123456" still answered. Fix: `debe64ba4`.
