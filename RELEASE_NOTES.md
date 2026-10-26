# StarNet v0.14.0

**Before you update:** save a station backup first (SETTINGS › APP & BACKUP › STATION BACKUP keeps your agents, settings and connectors; your conversations stay in your station folder, which the installer keeps). If agents are working when you install, choose WAIT FOR AGENTS.

- If the save notice says "Another window saved newer station changes", the in-app update will keep saying "try again in a moment". Press **Download this window's save** (not Reload current station), close StarNet, install 0.14.0 with the installer from starnetos.com over the app (your station folder is kept), then reopen. When the window's unsaved work reaches the new version, the save notice offers **Restore this window's sessions**.
- On a large station (roughly 400 MB or more of agent files), if INSTALL UPDATE stops at "no verified recovery point was created", install 0.14.0 with the installer from starnetos.com over the app. Your station folder is kept.

The lighter, sharper update. StarNet does far less work you never see: the background work that ran every few seconds is nearly gone, pulsing lights no longer redraw the whole window at full speed, and a station where nothing moves draws half as often. Agents got a round of fixes for the things that made them look worse than the model behind them. The station takes on a terminal look, the QUEST LOG becomes a battle pass, StarNet comes to the terminal with its own CLI, and there is a long list of fixes.

## Lighter on your PC

- **A still station draws 30 times a second instead of 60.** The moment anything moves (an agent walking or typing, a crate on a belt, the camera, your mouse) it goes straight back to 60, and up to 144 while you pan. Minimized or in the tray it still draws nothing.
- **The idle camera settles.** When the camera has finished a move it stops instead of creeping, so the floor's shadows and belts stop redrawing every frame.
- **Pulsing lights no longer redraw the whole window.** A blinking cursor, a failed session's dot or the dock's glow used to make the entire window, frosted glass and all, redraw at your screen's full refresh rate, all day long. They now pulse in small steps, and the window only redraws when a step changes.
- **Background work is almost gone.** An idle station used to re-read and re-parse your whole station file dozens of times a minute. It now reads from memory: on a large station the background process went from about 10–30% of a CPU core to under 1%, and the short freezes that came with it are gone.
- **Quieter while minimized.** When StarNet is minimized or in the tray, its background checks on the station slow to once every 30 seconds (from as often as every second) and catch up the moment you're back.
- **Less waste per frame:** lighting, the starfield, walking paths and the review crates no longer rebuild work they already did.
- **Fewer memory leaks:** a slow leak in the chat-app connections is fixed, the local voice cache is cleaned up, and old run records and browser handles are released.
- **Less disk used by updates.** StarNet keeps the three newest pre-update recovery points instead of a full copy of your station for every update attempt, and the recovery point it makes before an update now fits large stations.
- **One huge command output can no longer crash StarNet.** A command that prints gigabytes keeps its first and last parts, and the agent is told the middle was cut.

## A new look

- **The station's panels take the terminal look:** the CREW rail, the dock, NEEDS YOU, COMMS cards and the top bar, with bigger minimum text everywhere.
- **NEEDS YOU is now an inbox.** Click a row to open its card and approve or answer there. Deny, Retry and Dismiss stay one tap on the row.

## Agents

- **Agents use their model's real memory window.** Gemini, Claude, Ollama, vLLM and other providers that report a context window now get that window instead of a 131k guess, and a small local model no longer overflows. One exception, for cost: on a direct provider key or StarNet credits, a model that bills a higher rate for very long prompts works within the window where that rate starts (100K tokens for Claude Haiku 5.5; 200K for Gemini 2.5 / 3 / 3.1 Pro and xAI grok), and older turns are folded into a summary once a prompt passes about 65% of it. An OpenRouter key keeps the whole window, because OpenRouter bills each call's real long-context cost and StarNet counts it. /compress shows the window a run works in, and why.
- **Edits don't overwrite changes they never saw.** If a file changed since the agent last read it (another agent, a command, or you), its edit is refused and it is told to read the file again, instead of writing over the change and reporting success.
- **File contents arrive exactly as written.** A repair step for slightly broken tool calls could remove commas inside the text an agent was writing (`[1, 2, 3,]`, regex character classes, shell patterns). It now only touches the call's own structure.
- **Pictures only go to models that can see them.** On StarNet credits and OpenRouter, a model the catalog lists as text-only gets a short note in place of each image (naming the file, for an attached photo), and image analysis switches to a vision model. If a provider still refuses an image, COMMS says "This model can't see images — pick a vision model from the model dock" instead of "That model isn't available".
- **Spreadsheets read correctly.** A sheet with blank cells keeps every value in its own column.
- **Clarifying answers aren't lost.** If the run that should use your answer fails before it starts, the agent still has your original task when you retry.
- **Signing out of ChatGPT, Grok or Kimi stays signed out,** even if a sign-in refresh was in flight.
- **An agent without the right gear says exactly what's missing** and which room it needs to be placed in, instead of guessing.
- **A terse "Looks good." at a review step hands on the work it approved,** not just those two words.
- **The per-run spending cap now covers the workers an agent spins up:** a 5¢ cap no longer runs to 24¢ (it can still pass by up to one call). Workers on a $0 model call in parallel; workers on a model StarNet can't price, or close to the cap, take turns one call at a time.
- **When you delete a conversation, your agents stop seeing it:** it is gone from history and recall, and from memory for deletes made from now on. An answer that arrives after the delete no longer brings its words back.
- **Agents don't recall the station's own background calls as your words** (session titles, the goal check), including ones an earlier version saved.
- **Faster streaming.** Long tool calls and long replies are no longer re-scanned from the start on every token.
- **Skills are never lost** when the skills log grows large, and only you can take the pin off a skill.
- **A slow local model isn't asked the same thing over and over.** When an Ollama model is loaded but still working through a long prompt past the wait limit, the turn ends and says where the model is running, instead of re-sending the prompt for about half an hour.

## New

- **The QUEST LOG is a battle pass:** an ASCII tier track, rank titles, a daily streak, a season and weekly challenges aimed at your real goal.
- **StarNet in the terminal.** `starnet` opens a dashboard of your station: your crew, live runs, approvals with an always-allow key, slash commands and your skills, and it works in the folder you launched it from (asking first if that folder isn't trusted). `starnet -p "…"` runs one task headlessly, now with tools (files, terminal, web, memory) when you give it a task. It works alongside the app: with StarNet closed, `starnet` asks you to open it first, because your keys live in the app (pass `--workspace <dir>` for a separate terminal-only station; a script that ran `starnet -p` with the app closed needs that flag now).
- **The CLI works with your mouse:** click an agent to open its chat, and move between STAT, CREW, COMMS, WORK and SKILLS from the tab line.
- **Type "/" in the CLI for a command menu:** your station's commands plus the terminal's own. Twenty of the app's commands now work there too, including /goal, /queue, /loop, /steer, /personality, /reasoning and /insights, and a message you type while a conversation is still running waits its turn.
- **The CLI has the station's terminal look:** a tab line under the logo that shows where you are, your crew grouped as NEEDS YOU, WORKING and STANDING BY, and a stat bar along the bottom with your station's level and XP, the crew, spend and the clock.
- **Getting `starnet` on your PATH:** on Windows the installer adds it to your user PATH. On macOS the app links it into ~/.local/bin the first time it opens, and adds a PATH line to ~/.zprofile if none of your shell profiles has one. Open a new terminal to use it.
- **Agents can show you pictures in COMMS.** An image an agent made or found appears as the picture, not a link.
- **Scheduled routines can make images** when you turn on ▣ ALLOW IMAGES, and a chat-bound routine's reply carries its images and files to Telegram. Only a routine with ALLOW IMAGES posts the pictures it generated.
- **Your own /commands work in group chats** as /command@yourbot and appear in Telegram's "/" menu, and also on Discord, Slack, Matrix and Signal. On Telegram, the descriptions you write for them stay out of the menu strangers can see.
- **Group chats on Telegram, Discord and Slack:** the paired owner sends /allow in a group to let StarNet answer there, and /deny to close it (on Telegram also /allow @yourbot). On Telegram, a group that removes the bot needs a fresh /allow if it adds it back.
- **KEYS can hold a 1Password reference** (op://…), read with the 1Password CLI and kept in memory only.
- **SHARED BUILDS:** EXPORT THIS STATION and IMPORT A BUILD in build mode's Presets.
- **A window's set-aside work can come back.** When a save is refused as a conflict, the save notice offers **Restore this window's sessions**: missing sessions and turns are added to the station, nothing in the station is removed or renamed, and the station file is copied aside first.
- **Dossier and tagline fields show their character counts.**
- **EXPORT STATION** saves to Downloads and says exactly where.

## Good to know

- **Routines after the update:** if a routine has results that 0.13 couldn't deliver (for example long digests Telegram refused), its chat gets only the newest one, ending with a line saying how many earlier results were not delivered and will not be resent. The same holds from now on whenever a chat can't be reached for a while: when it comes back, a routine delivers only its newest result, with a count of the ones skipped. A routine you paused keeps its result until you resume it, and no longer keeps the app running in the background.
- **A chosen away posture now starts sooner:** "Quietly do small jobs" or "Run free" begins after one task or one stated aim, instead of waiting for several runs first.
- **Long sessions can cost more per turn.** Models that bill one rate at any length (such as Claude Opus and Sonnet 4.6+, or Gemini Flash on your own key) now use their whole window, up to 1M tokens, so a long session sends far more context per turn than on 0.13.

## Fixes

- A large station whose save was acknowledged late no longer reads "Another window saved newer station changes" with only one window open, and its autosave keeps working.
- With many conversations waiting on approvals at once, Approve/Deny, new runs and NEEDS YOU no longer stall.
- BUILD only lights up for a station gap you haven't seen yet, and SESSIONS and PROJECTS switch cleanly (no phantom + key, readable paths).
- On WebKit (Safari, and the Mac app) at a TEXT SIZE above 100%, clicks on the station and in BUILD land under the cursor instead of below and to the right of it. If a click still misses on your Mac, tell us.
- On the desktop app, a CUSTOM endpoint (or an Ollama on another machine) is kept by the station once the app has opened on 0.14.0, so routines, Run Now, line hops and chat-app runs keep working after a restart. A routine that comes due during the update restart itself can stop once.
- Image generation works on a run of any provider when your only image route is an OpenRouter key saved in Settings.
- When the provider behind a model (for example xAI on StarNet credits or OpenRouter) refuses one request, StarNet says so and offers another model, instead of saying your API key was rejected, and it no longer sends the refused conversation back for a failure review.
- Batch-only models (OpenRouter's ":batch" ids) are no longer offered for chat, and an agent or routine that saved one runs on the standard version of that model.
- A line in a routine's reply that starts with "Media:" or "Attach:" stays in the message unless it names a file the station read and attached.
- Two routines delivering to the same chat no longer mix their messages, and a short Telegram rate limit is waited out instead of re-sending parts that already arrived.
- On Telegram, /steer, /q and /btw add to the running task, a steering note no longer glues two answers together, the desktop's slash names answer instead of costing a paid run, and /routine add delivers its results back to that chat.
- In a group with /mention observe, the agent now reads what the room said, as the setting promises.
- A new phone chat's first message (Telegram, Discord, Slack, Matrix, Signal) runs in that chat and survives a restart.
- If StarNet crashes while answering a phone message, it doesn't repeat what the agent already did; it tells you the run was interrupted.
- If YOUR FIRST TASK fails at the provider, press ↑ in the composer to get it back.
- A run you stop mid-answer (including while a reasoning model is still thinking) is no longer booked as a known $0: what it had booked counts as a floor, and a stopped run that booked nothing reads spend unknown. A Claude Code subscription Stop stays $0.
- Away autonomy you chose at setup acts on what you told it, instead of waiting for runs first.
- If the station file on disk goes missing while the app still has your station, StarNet writes it back from the app's copy instead of refusing every save and blaming another window.
- A fresh install opened and closed before setup no longer lands in Recovery Mode.
- A CUSTOM provider keeps your exact vendor and model id.
- A slow local Ollama turn says where the model is, and a cancel records what it interrupted.
- Denied calls read "denied", not "failed", and a denied run proposes no memories.
- Unpriced runs are labelled as unpriced instead of booked as $0, a 403 is no longer called "key rejected", and a retry against a server that isn't running says it's unreachable instead of "timeout".
- A model with no price now stops at a token ceiling you can set: UNPRICED MODEL TOKEN CEILING in SETTINGS › APP & BACKUP › Runtime limits.
- On Linux and macOS, the terminal tool names the shell that actually runs your commands.
- A routine killed mid-run reads interrupted, the away workshop and the night shift no longer show a countdown while scheduling is off or E-STOPped, and the autumn clock change no longer fires a routine twice.
- A cut voice stream is a failure, never a half clip saved forever.
- The workflow reader loads on older Mac Safari (before 16.4).
- A refused or interrupted update now says nothing was installed, and an update refused because of a save conflict says so instead of "try again in a moment".
- Runs started from the CLI use the agent's reasoning setting instead of the provider default. `starnet --version` names the installed build, `starnet` reaches your PATH even when your Windows profile folder has an apostrophe, and the dashboard gives your terminal back when it is closed.
- Many smaller wording and layout fixes across COMMS, SESSIONS, onboarding and the dossier.
