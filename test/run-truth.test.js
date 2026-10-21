/* node test/run-truth.test.js — RUN-TRUTH contract locks (2026-07-16, crew-panel "working at the
   terminal" escape, twice user-visible).

   The escape, both rounds: the app asserted a per-agent WORKING state the harness could not prove.
   Round 1 — stationui's runningAgents was a bare event counter (no TTL, no reconcile): a lost
   agent.run.end stuck the crew manifest at "working at the terminal" while the sprite honestly idled.
   Round 2 — three residual holes: the TTL sweep was AGENT-keyed (one leaked runId on a busy agent
   never staled), the snapshot reconcile fired only on SSE reopen (a lost end inside a healthy link
   waited out the full 5m TTL), and a snapshot-restored run had no body driver (truthful WORKING label
   over a standing sprite after an app reload mid-run).

   THE LAW these asserts pin: any UI asserting per-agent run state must read World's truth-netted
   refcount (event-fed + per-run TTL swept + 30s snapshot reconciled), never a bare event counter.
   stationui/world are not headless-loadable, so these are source-level locks (same convention as
   test/consent-visibility.test.js / settings-p1-backend.test.js). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const F = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const sui = F('frontend/app/stationui.js');
const wld = F('frontend/app/world.js');

/* ---------- 1 · stationui: ONE predicate, deferring to World's truth-netted refcount ---------- */
{
  A.ok(/function agentLive\(id\)/.test(sui), 'stationui: the single agentLive(id) predicate exists');
  const body = (sui.split('function agentLive(id)')[1] || '').slice(0, 1200);
  A.ok(/World\.agentRunsLive/.test(body), 'agentLive: consults World.agentRunsLive (the truth-netted refcount)');
  A.ok(/return worldN > 0/.test(body), 'agentLive: an untracked agent lights when the WORLD proves a live run (reconnect-mid-run inverse lie)');
  A.ok(/runningAgents\.delete\(id\)/.test(body), 'agentLive: a world-refuted stale local count self-heals (deleted, not just hidden)');
  A.ok(/runSeenAt/.test(body), 'agentLive: the veto honors a start-grace (same-emit listener order must not flash idle)');
  // every consumer reads the predicate — a bare .has() outside agentLive is the round-1 bug reborn
  const bareHas = sui.split('runningAgents.has(').length - 1;
  A.eq(bareHas, 1, 'stationui: runningAgents.has() appears ONLY inside agentLive (found ' + bareHas + ' use(s)) — all consumers go through the predicate');
  A.ok(/const live = agentLive\(a\.id\)/.test(sui), 'crewTick: the crew manifest row reads agentLive');
  A.ok(/isAgentRunning:\s*\(id\)\s*=>\s*agentLive\(id\)/.test(sui), 'export: isAgentRunning (warroom dots) is agentLive');
}

/* ---------- 2 · world: per-RUN TTL — a leaked runId on a busy agent must stale on its own clock ---------- */
{
  A.ok(/agentId -> Map\(runId -> lastSeen/.test(wld), 'world: liveRunsByAgent tracks per-run lastSeen stamps (not a bare Set)');
  A.ok(/function stampRun\(aid, rid\)/.test(wld), 'world: stampRun takes the runId so reinforcement is per-run');
  A.ok(/per-RUN sweep/.test(wld), 'world: the per-run sweep exists (agent-level silence alone must not be required)');
  const sweep = (wld.split('per-RUN sweep')[1] || '').slice(0, 900);
  A.ok(/s\.delete\(rid\)/.test(sweep), 'per-run sweep: a run past RUN_TTL_MS is dropped individually');
  A.ok(/serverLit\.delete\(aid\); setActivityFor\(aid, 'idle'\)/.test(sweep), 'per-run sweep: emptying an agent releases its work pose');
  // the reinforcing events must stamp their OWN run's clock, not just the agent's
  A.ok(/stampRun\(p\.agentId, p\.runId\);\s*\/\/ E2: a tool fire/.test(wld), 'world: tool_call reinforces per-run');
  A.ok(/stampRun\(p && p\.agentId, p && p\.runId\)/.test(wld), 'world: token reinforces per-run');
}

/* ---------- 3 · world: the snapshot poll — truth converges inside a healthy link, not only on reopen ---------- */
{
  A.ok(/setInterval\(\(\) => \{ if \(!bridgePaused\) fetchSnapshot\(\); \}, 30000\)/.test(wld),
    'world: the authoritative snapshot is polled every 30s (paused bridge stays silent)');
  // idle CPU piece 3 (2026-10-20): in the app the same poll runs through PollGate (30 s on screen and away, a catch-up on return)
  A.ok(/PollGate\.every\(\(\) => \{ if \(!bridgePaused\) fetchSnapshot\(\); \}, \{ ms: 30000, immediate: false \}\)/.test(wld),
    'world: through PollGate the snapshot poll keeps its 30s cadence and its paused-bridge silence');
}

/* ---------- 4 · world: an orphan (snapshot-restored) run drives the body — no truthful-label-over-idle-sprite ---------- */
{
  A.ok(/ORPHAN RUN/.test(wld), 'world: reconcile handles the orphan-run case');
  const orphan = (wld.split('ORPHAN RUN')[1] || '').slice(0, 1400);
  A.ok(/serverLit\.add\(r\.agentId\); setActivityFor\(r\.agentId, 'task'\)/.test(orphan),
    'reconcile: an orphan run lights the agent through serverLit → work pose at its desk');
}

// report() LAST — it is what calls process.exit(fail?1:0). This file used to end in a bare
// console.log, so every assertion failure printed FAIL and STILL exited 0: the fast gate scored
// it green no matter what broke. Never end an _assert.js test any other way.
A.report('run-truth.test');
