/* node test/comms-presence.test.js — REGRESSION LOCK for the COMMS run-status honesty fixes
   (branch comms-ui-reliability, 2026-07-11).

   The escape this guards against: the live working-presence card (#comms-presence) only ever
   worked for a stream's FIRST run. resolvePresence() rewrote the card into a "■ RUN COMPLETE"
   summary (destroying its .cp-verb/.cp-tool/.cp-time children) but KEPT the id, so every later
   run's presenceCard() resurrected the dead card — no THINKING/WORKING indicator ever rendered
   again, and the stale summary was re-pinned under the new turn. The user-visible symptom:
   "I give a task and nothing shows it's working until text streams."

   chat.js is browser-flow (DOM + streaming), not node-loadable, so — like chat-runmeta.test.js —
   the DOM-layer invariants are locked by reading the source; the state-model behavior
   (connecting→confirmed upgrade, start re-stamp, pause-aware elapsed) is asserted live against
   channels.js, which IS node-loadable. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const C = require('../frontend/app/channels.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');

/* ---------- 1. a resolved card is history, never the next run's live card ---------- */
// presenceCard() must check for the resolved class and shed the id instead of reusing the card.
const pc = /function\s+presenceCard\s*\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
A.ok(pc, 'presenceCard() exists');
A.ok(/classList\.contains\(\s*'resolved'\s*\)/.test(pc[1]), 'presenceCard refuses to resurrect a resolved card (checks .resolved)');
A.ok(/removeAttribute\(\s*'id'\s*\)/.test(pc[1]), 'presenceCard demotes the resolved card to history (sheds the id) and builds a fresh live card');
// clearPresence (stream switch) must also keep resolved summaries as history, not delete them.
const cp = /function\s+clearPresence\s*\(\)\s*\{(.*)\}/.exec(src);
A.ok(cp, 'clearPresence() exists');
A.ok(/classList\.contains\(\s*'resolved'\s*\)/.test(cp[1]), 'clearPresence keeps a resolved summary (only live cards are torn down)');

/* ---------- 2. displayed durations come from the honest clock, never raw wall-arithmetic ---------- */
A.ok(/function\s+renderElapsed[\s\S]{0,700}Channels\.elapsedOf\(/.test(src), 'header timer reads Channels.elapsedOf (re-stamped start, pauses excluded)');
A.ok(/function\s+renderPresence[\s\S]{0,2200}Channels\.elapsedOf\(/.test(src), 'presence card time reads Channels.elapsedOf');
A.ok(/function\s+resolvePresence[\s\S]{0,600}Channels\.elapsedOf\(/.test(src), 'RUN COMPLETE duration reads Channels.elapsedOf');

/* ---------- 3. no state claim before server confirmation ---------- */
A.ok(/CONNECTING/.test(src), 'presence verb has the CONNECTING state (pre-confirmation honesty)');
A.ok(/setRunId\(\s*ws\.id\s*,\s*id\s*,\s*Date\.now\(\)\s*\)/.test(src), 'onRunId re-stamps the run start with the confirmation instant');
// walkToDesk may fire pre-confirmation (eager task walk) but must not claim working… until the run is confirmed.
const wtd = /function\s+walkToDesk\s*\(\)\s*\{([\s\S]*?)\n    \}/.exec(src);
A.ok(wtd, 'walkToDesk() exists');
A.ok(/runIdOf\(\s*ws\.id\s*\)/.test(wtd[1]), 'walkToDesk gates the working… claim on a confirmed runId');
// approval pauses feed the pause ledger (both directions).
A.ok(/setPending\(\s*ws\.id\s*,\s*\{[\s\S]{0,200}\}\s*,\s*Date\.now\(\)\s*\)/.test(src), 'onPermission opens the pause span (setPending with a timestamp)');
A.ok(/clearPending\(\s*(ws\.id|id)\s*,\s*Date\.now\(\)\s*\)/.test(src), 'consent resolution closes the pause span (clearPending with a timestamp)');

/* ---------- 4. the state model itself (real behavior, not source shape) ---------- */
C.reset();
C.begin('w', 1000);
A.eq(C.statusOf('w'), 'connecting…', 'begin claims only connecting… — a click proves nothing');
C.setRunId('w', 'r1', 1800);
A.eq(C.statusOf('w'), 'thinking…', 'server confirmation upgrades to thinking…');
A.eq(C.startedAtOf('w'), 1800, 'confirmation re-stamps the start (connect latency excluded)');
C.setPending('w', { promptId: 'p', tool: 't', argsSummary: '', runId: 'r1' }, 3800);
C.clearPending('w', 6800);
A.eq(C.elapsedOf('w', 7800), 3000, 'elapsed excludes the 3s approval pause (6s wall − 3s paused)');
C.end('w');
A.eq(C.elapsedOf('w', 9000), 0, 'end zeroes the honest elapsed');

/* ---------- 5. concurrent sessions: a peer run is a SOFT indicator, never a send gate ----------
   (concurrent-sessions lane, 2026-07-18: the sidecar admits concurrent same-agent runs — the workspace
   is guarded by a run-scoped lease backend-side. COMMS must SHOW the peer run truthfully but must not
   re-become the old hard gate: no disabled composer, no preflight refusal.) */
A.ok(/function\s+busyPeerFor\s*\(ws\)[\s\S]{0,700}Workstreams\.list[\s\S]{0,1200}Channels\.isBusy/.test(src),
  'COMMS still resolves a same-agent peer run (the soft indicator\'s source of truth)');
// org P25 (2026-10-14): the row reads '<NAME> IS BUSY IN <SESSION>' (who and where) — was 'ALSO RUNNING IN <SESSION>'
A.ok(/' IS BUSY IN ' \+ shownName\(peer\)\.toUpperCase\(\)/.test(src) && /VIEW ACTIVE RUN/.test(src),
  'a session with a busy peer names who is busy and where, and offers a route to the active run');
A.ok(/function\s+maybeEmptyState[\s\S]{0,300}busyPeerFor\(activeWs\)/.test(src),
  'an empty busy-peer session shows the peer row, not competing starter chips');
// the OLD hard gate must stay dead: nothing may disable the composer off a peer run…
const uc = /function\s+updateControls\s*\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
A.ok(uc, 'updateControls() exists');
A.ok(!/disabled\s*=\s*!!peer/.test(uc[1]), 'the composer is never disabled because a peer session is running');
A.ok(/input\.disabled\s*=\s*false/.test(uc[1]), 'the input is explicitly kept live under a peer run');
// …and send() must not refuse a turn because of one (the per-STREAM one-run gate stays).
A.ok(!/preflightPeer/.test(src), 'send has no agent-global preflight refusal (the old blocked-return is gone)');
A.ok(/Channels\.isBusy\(ws\.id\)\)\s*return/.test(src), 'the per-stream one-run-per-session gate still holds');

/* ---------- 6. a disconnect durably keeps real partial output before its marker ---------- */
A.ok(/function\s+persistPartial[\s\S]{0,700}role:\s*'assistant'[\s\S]{0,220}content:/.test(src),
  'chat owns one helper that persists accumulated partial assistant text');
A.ok(/if\s*\(error\)[\s\S]{0,2200}persistPartial\(ws,\s*acc\)[\s\S]{0,900}error:\s*true/.test(src),
  'a 200/error-envelope stores partial text before its durable failure marker');
A.ok(/catch\s*\(e\)[\s\S]{0,1500}persistPartial\(ws,\s*acc\)[\s\S]{0,900}error:\s*true/.test(src),
  'a thrown stream disconnect stores partial text before its durable failure marker');

/* ---------- 7. persisted hierarchy replaces the lead-only tool illusion ---------- */
A.ok(/card\.dataset\.runId\s*=\s*presenceRunId/.test(src), 'resolved presence is joined to its durable run row by runId');
A.ok(/function\s+hydrateRunTelemetry[\s\S]{0,2200}entry\.children/.test(src), 'run completion hydrates lead + worker hierarchy from persisted rows');
A.ok(/workerCalls[\s\S]{0,800}reasoningEffort/.test(src), 'summary exposes worker call count plus actual model/effort');
// read inside telemetryRun's own body (it ends on its two-space closing brace): a fixed character window broke when two
// lanes each grew the function's head line (10-21: 1,155 → 1,384 characters before the tool line)
const telemetryRunBody = (/function\s+telemetryRun\([\s\S]*?\n  \}\n/.exec(src) || [''])[0];
A.ok(/\bt\.ms\b/.test(telemetryRunBody), 'expanded hierarchy renders each persisted per-tool duration');
A.ok(/hydrateRunTelemetry\(ws,\s*entry,\s*runId\)[\s\S]{0,300}if\s*\(!arts\.length/.test(src), 'clean artifact-less runs still hydrate telemetry before the quiet recap return');

// ONE run, ONE duration (live walkthrough 2026-10-13): the telemetry hydration rewrote the resolved card with the
// sidecar's WALL time (approval waits included) under a receipt showing machine time. The card keeps the honest ms and
// names any approval wait apart.
{
  const hyd = src.slice(src.indexOf('  function hydrateRunTelemetry('), src.indexOf('  function hydrateRunTelemetry(') + 2500);
  A.ok(/if \(started\) card\.dataset\.ms = String\(Math\.max\(0, Math\.round\(Channels\.elapsedOf\(ws\.id, Date\.now\(\)\)/.test(src), 'the resolved card carries the honest (pause-excluded) run time');
  A.ok(hyd.indexOf('const honest = Number(card.dataset.ms) || 0') >= 0 && hyd.indexOf("bits.push(fmtMs(wall - honest) + ' waiting on you')") >= 0,
    'hydration shows that honest time and names the approval wait apart — never the wall time as the run time');
}

// THE FOLD TELLS THE FOOTER'S TIME, BY NAME (Andrew 10-18, the step-rows pass): under "RUN COMPLETE · 907ms · 3.1s waiting
// on you" the opened fold's lead line read the record's WALL time ("lead · agent · 4.0s") — and the hero's raw id for NOVA.
{
  A.ok(/const leadRow = honest > 0 \? Object\.assign\(\{\}, entry, \{ durationMs: honest, waitedMs: wall - honest > 1500 \? wall - honest : 0 \}\) : entry;\s*detail\.appendChild\(telemetryRun\(leadRow, 'lead', hasChips\)\);/.test(src),
    'the fold\'s lead line tells the footer\'s machine time and names the wait on you apart');
  A.ok(/const runWho = id => \(id && typeof App !== 'undefined' && App\.agentName && App\.agentName\(id\)\) \|\| id \|\| '';/.test(src) && /head\.textContent = \[role, runWho\(entry\.agentId\),/.test(src)
    && /Number\(entry\.waitedMs\) > 0 \? fmtMs\(Number\(entry\.waitedMs\)\) \+ ' waiting on you' : ''/.test(src), 'and says who ran it by name, never the raw id');
  // the glass layer's register for the steps and the footer (pipglass.css)
  const pip = fs.readFileSync(path.join(__dirname, '../frontend/css/pipglass.css'), 'utf8');
  const steps = pip.slice(pip.indexOf('PIP-BOY COMMS STEPS'));
  // QUIET AGAIN (Andrew 10-25): the machinery sits below the 18px speech — dim phosphor, lowercase, never the bright caps opcode
  A.ok(pip.indexOf('PIP-BOY COMMS STEPS') > 0 && /\.tool-chip \.tc-head \{[^}]*font-size: 14px;[^}]*color: var\(--ph-dim\);/.test(steps), 'a step row is quiet: 14px dim phosphor (16px bright caps read as loud as the reply)');
  A.ok(/\.tool-chip \.tc-name \{[^}]*text-transform: none;/.test(steps) && !/\.tool-chip \.tc-name \{[^}]*--ph-bright/.test(steps), 'the tool name is plain lowercase phosphor, not a bright caps opcode');
  A.ok(/\.tool-chip \.tc-glyph \{[^}]*animation: none;/.test(steps), 'a running step\'s glyph is steady (the working line\'s meter says the run is live)');
  A.ok(/\.tool-chip\.held :is\(\.tc-glyph, \.tc-stat\) \{ color: var\(--ph-dim\); \}/.test(steps), 'a held step stays plain dim phosphor over the brighter step text');
  A.ok(/\.tool-chip \.tc-exp \{[^}]*font-size: 0;[^}]*border-right: 2px solid/.test(steps) && /\.comms-presence\.resolved \.cp-chev \{[^}]*font-size: 0;[^}]*border-right: 2px solid currentColor;/.test(steps),
    '"open me" is a drawn caret on the step and on the footer, never the ▸ a running step starts with');
  A.ok(/\.comms-presence\.resolved \{\s*font-size: 14px;[^}]*opacity: \.5;/.test(steps), 'RUN COMPLETE is the quiet footer again: 14px at half strength (0.13.5), bright only on hover or open');
}

A.report('comms-presence.test');
