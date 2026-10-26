# StarNet v0.14.1

The stability update. It fixes the bugs you reported most since 0.14.0, starting with stations that stopped saving, and it makes StarNet quicker to open and easier to find your way around.

## Your station saves again

- **Stations stop disappearing.** If StarNet closed unexpectedly between two saves (a crash, a killed app, a Windows restart), the reopened window could have every later save refused, so the station file stopped updating while the app kept working, and a restart brought back an old station. The station now records which window wrote each save, so that window's newer work is accepted when it comes back.
- **Copies that can't be proven newer are merged, not refused.** Sessions from both sides are kept, and the station file is backed up first.
- **Lost work can come back.** If 0.14.0 already set some of your work aside, StarNet offers to restore that window's sessions when it starts.

## Easier to find your way

- **CONNECT is one list you can read at a glance.** APPS, CONNECTED (with your API keys), SKILL MARKET, SKILLS, TOOLS and EXTENSIONS all show at once, like SETTINGS, instead of three switches that swapped the sections under them. Old links and saved places still open where they belong.
- **AI & MODELS asks one question.** Its AI services are grouped by what you have: StarNet credits, a subscription you already pay for, an API key, or your own models. TOOLS, API keys, computer control and the model settings now say what they do in plain words.
- **Long windows are easier to read.** CONNECT, SETTINGS and the dossier open taller, and the app catalog and skill market fold by category; search opens whatever it finds.

## Faster windows

- **Windows open faster.** The median wait from click to window is down about 40%, and opening ABILITIES no longer freezes the station for seconds.
- **The window comes first.** The station pauses its own drawing for a moment while a window opens, so the window appears before the next frame.
- **SETTINGS no longer rebuilds itself** when a background check comes back unchanged.

## See your crew work

- **Every working agent shows what it's doing.** A small tag right above each agent reads its name and the task it was given. The agent you're talking to, or the one under your pointer, gets the full card: the task, the tool it's using right now, how long it has been running and what it has cost. Tags take your theme's colour and zoom with the station.
- **Hand-offs are visible.** When an agent splits work across its crew, a line runs across the floor from the lead to each worker for as long as that worker runs, and the result rides back when it finishes.
- **Workers' steps reach the station.** A worker's own tool steps now show on its CREW card instead of it reading "thinking" for the whole job.

## Agents

- **Workers aren't cut off mid-job.** A worker given a brief that mentioned reviewing or checking was capped at 3 tools and 45 seconds, even when the brief also asked it to write, fix or build. Now only a pure read gets that short budget.
- **Agents read your folders with the file tools.** When you name a project folder, agents read, list and search it directly instead of going through the terminal, so you don't get an approval card for every command.
- **A key you paste into chat is saved to your API keys.** The agent stores it and refers to it by name, and COMMS shows a placeholder instead of the key. Only a key in the message you just sent is saved, so another agent in a group chat or an imported recipe can never add or change your keys.
- **Scheduled routines keep their notepad** in ASK mode. A routine could lose routine.notepad and still report success.

## Local models (Ollama)

- **Small models stop timing out on long tasks.** Once a big request locked the memory window at 64k, it never came back down, so on a smaller GPU the model spilled onto the CPU and gave up after 5 minutes. A task now steps the window back down when the model is spilling. Set `SKYNET_OLLAMA_CONNECT_TIMEOUT_MS` if your machine needs longer than the 5-minute connect wait.
- **Reasoning OFF really is off.** qwen3 and other thinking models on Ollama no longer think on every turn when reasoning is off.

## Look

- **The dashboard matches its windows.** Rounded cards and keys, and the same glass the windows use; the old mesh pattern is gone, so nothing shimmers when you zoom out.
- **The crew rail and COMMS are easier to read.** Names stand out, status lines are quieter, a waiting session isn't announced twice, and "awaiting your answer" sits as a single line under the question.
- **A reply stands apart from its run again.** The RUN COMPLETE footer, the step rows and the run record go back to 0.13.5's dim phosphor with lowercase tool names, so they no longer compete with the agent's answer.
- **The + key no longer sits on PROJECTS** in a narrow window. The CREW column now scales with your TEXT SIZE like every other panel.
- **A round of small fixes from a pass over every window:** dossier tabs fit on one row, manual chapters line up, the ABILITIES list keeps each label on one line, the dock hint steps back while a window is open, trophy cards have more room, the bell has a proper empty state, and doubled settings headings are gone.

## Startup and the CLI

- **"Could not start its local engine" now says why.** If the engine fails at startup, its last lines of output appear in the error window and in startup.log, with keys removed, so you (and we) can see what went wrong.
- **`starnet` works with the app closed.** `starnet`, `starnet -p` and `starnet flow run` start StarNet in the background (no window) and attach to your station, instead of asking you to open the app first. Quick questions like `status`, `ls`, `approve` and `watch` don't start it; they tell you to run `starnet` first. When the last `starnet` session ends, StarNet closes again. On macOS, open the window from the menu-bar icon.
- **`/theme` in the terminal.** Pick the StarNet app's own colors (classic amber, Pip-Boy green, blue, purple, white) or keep the neon red. The whole dashboard recolors at once (logo, labels, camera feed), and your pick sticks for the next `starnet`. `STARNET_THEME=<name>` overrides it.
