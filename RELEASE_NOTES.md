# StarNet v0.14.1

The stability update. It fixes the bugs you reported most since 0.14.0, starting with stations that stopped saving.

## Your station saves again

- **Stations stop disappearing.** If StarNet closed unexpectedly between two saves (a crash, a killed app, a Windows restart), the reopened window could have every later save refused, so the station file stopped updating while the app kept working, and a restart brought back an old station. The station now records which window wrote each save, so that window's newer work is accepted when it comes back.
- **Copies that can't be proven newer are merged, not refused.** Sessions from both sides are kept, and the station file is backed up first.
- **Lost work can come back.** If 0.14.0 already set some of your work aside, StarNet offers to restore that window's sessions when it starts.

## Agents

- **Workers aren't cut off mid-job.** A worker given a brief that mentioned reviewing or checking was capped at 3 tools and 45 seconds, even when the brief also asked it to write, fix or build. Now only a pure read gets that short budget.
- **Agents read your folders with the file tools.** When you name a project folder, agents read, list and search it directly instead of going through the terminal, so you don't get an approval card for every command.
- **A key you paste into chat is saved to KEYS.** The agent stores it and refers to it by name, and COMMS shows a placeholder instead of the key. Only a key in the message you just sent is saved, so another agent in a group chat or an imported recipe can never add or change your keys.
- **Scheduled routines keep their notepad** in ASK mode. A routine could lose routine.notepad and still report success.

## Local models (Ollama)

- **Small models stop timing out on long tasks.** Once a big request locked the memory window at 64k, it never came back down, so on a smaller GPU the model spilled onto the CPU and gave up after 5 minutes. A task now steps the window back down when the model is spilling. Set `SKYNET_OLLAMA_CONNECT_TIMEOUT_MS` if your machine needs longer than the 5-minute connect wait.
- **Reasoning OFF really is off.** qwen3 and other thinking models on Ollama no longer think on every turn when reasoning is off.

## Look

- **The + key no longer sits on PROJECTS** in a narrow window. The CREW column now scales with your TEXT SIZE like every other panel.
- **A round of small fixes from a pass over every window:** dossier tabs fit on one row, manual chapters line up, the ABILITIES list keeps each label on one line, the dock hint steps back while a window is open, trophy cards have more room, the bell has a proper empty state, and doubled settings headings are gone.

## COMMS

- **A reply stands apart from its run again.** The RUN COMPLETE footer, the step rows and the run record go back to 0.13.5's dim phosphor with lowercase tool names, so they no longer compete with the agent's answer.

## Startup and the CLI

- **"Could not start its local engine" now says why.** If the engine fails at startup, its last lines of output appear in the error window and in startup.log, with keys removed, so you (and we) can see what went wrong.
- **`starnet` works with the app closed.** It starts StarNet in the background (no window) and attaches to your station, instead of asking you to open the app first. `status`, `ls`, `approve`, `watch` and `flow run` work the same way. When the last `starnet` session ends, StarNet closes again. On macOS, open the window from the menu-bar icon.
