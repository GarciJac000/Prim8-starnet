---
fingerprint: e5ecd6b8
slug: a-sidecar-crash-mid-run-replays-the-whole-telegr
title: A sidecar crash mid-run replays the whole Telegram message as a second identical user turn, so side effects run twice and the reply undercounts them
surface: channels
severity: P1
status: open
found: 2026-10-20
lane: sweep/channels
fix:
origin: audit
---

# A sidecar crash mid-run replays the whole Telegram message as a second identical user turn, so side effects run twice and the reply undercounts them

## Symptom

The station crashes (or is killed) while a Telegram task is working. When it comes back it quietly runs the same message again from scratch: anything the first attempt already did is done a second time, and the phone gets one ordinary reply that only describes the second attempt. In the live walk an "append one line" task appended TWO lines and the chat was told "Appended one line to audit.log." Nothing on the phone says the station restarted or that the request was re-run.

## Repro

Booted sidecar on :9721 with a mock Telegram Bot API (SKYNET_TELEGRAM_API_BASE) and a scripted mock OpenRouter; owner paired in DM chat 4242; `/approvals off`.
1. Send "append audit line now". The model calls `brief_proceed`, then `fs_append {path:"audit.log", content:"AUDIT-LINE
"}`; its final text turn is held open (the tool has already run).
2. Hard-kill the sidecar while the reply is held; boot it again on the same workspace.
3. On the first poll-up the hub's durable inbox replays message 7046; the scripted model runs the same task again.

## Evidence

- `ws/tg_4242/audit.log` after the reboot: `AUDIT-LINE
AUDIT-LINE
` (11 -> 22 bytes; the second tool receipt reads "Appended to audit.log (+11 bytes, now 22)").
- Phone (mock sendMessage 7047): `Appended one line to audit.log.` — the only message after the restart.
- Canonical transcript `channel_telegram_4242`: the user turn "append audit line now" appears TWICE, the first followed by the interrupted attempt's tool rows. The replayed provider request (captured req-34) carries msg[29] user "append audit line now", the old rows as `[recovered tool result — its originating call is not in this transcript] Appended to audit.log (+11 bytes, now 11)…`, and msg[34] the same user words again — so the model reads it as the Commander asking twice.
- `sidecar/channels/hub.js:1508` `try { await onInbound(it.message, { recovered: true }); }` — the `recovered` intake flag has ZERO consumers (grep), so nothing tells the run or the chat that this is a re-delivery after an interrupted attempt; processInbound appends the user turn again unconditionally (`store.appendTurn(agentId, 'user', turnText …)`).
- Station side is honest: `/api/runs?agent=tg_4242` shows the first run `interrupted`, the replay `done`.

Not fixed in the lane (a prompt/semantics change, >30 lines): the replay should not append a second copy of the user turn, should carry a host note that an earlier attempt was interrupted after running tools (so completed side effects are not repeated), and the chat should be told the station restarted mid-task.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
