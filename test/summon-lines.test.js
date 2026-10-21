/* node test/summon-lines.test.js — SUMMON LINES + ACTIVITY PLATES (2026-10-19/21).
     · a delegated worker's tool steps reach the floor: orchestration FORWARDs agent.tool_call/tool_result onto the
       lead's stream (before, every worker read "thinking" for its whole run);
     · the lead's COMMS stays clean: harness hands a tool event to the chat callbacks only when its runId is the
       lead's own (a worker's tool_call used to be able to wipe the lead's answer);
     · a worker's tool use is never a ROOM gap: its kit is the sidecar's autonomous office, so the station-quest
       generator skips runs the harness saw arrive as delegated workers;
     · the plate tells the truth: cost only once the sidecar reports one (per-call agent.cost SUMMED), and it hangs
       beside a seated worker's desk instead of over its screen. */
'use strict';
const fs = require('fs'), path = require('path'), A = require('./_assert');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const orch = rd('sidecar/tools/builtin/orchestration.js');
const harness = rd('frontend/app/harness.js');
const quests = rd('frontend/app/stationqueststore.js');
const world = rd('frontend/app/world.js');

// 1. forward list carries tool steps, never tokens
const fwd = /const FORWARD = \{([^}]*)\}/.exec(orch);
A.ok(fwd, 'orchestration has a FORWARD list');
A.ok(/'agent\.tool_call': 1/.test(fwd[1]) && /'agent\.tool_result': 1/.test(fwd[1]), 'worker tool steps are forwarded to the lead stream');
A.ok(!/'agent\.token'/.test(fwd[1]), 'worker tokens are still never forwarded');

// 2. harness gate — exercised, not just grepped: a worker tool_call must not reach onToolCall / reset the answer
const gateCall = /case 'agent\.tool_call': if \(runId && payload\.runId && payload\.runId !== runId\) break;/.test(harness);
const gateResult = /case 'agent\.tool_result': if \(runId && payload\.runId && payload\.runId !== runId\) break;/.test(harness);
A.ok(gateCall && gateResult, 'harness skips the lead callbacks for a tool event from another run');
(function simulate() {
  let runId = null, full = 'lead answer so far', calls = [];
  const onToolCall = p => calls.push(p.runId);
  const step = (name, payload) => {
    switch (name) {
      case 'agent.run.start': if (!runId) runId = payload.runId; break;
      case 'agent.tool_call': if (runId && payload.runId && payload.runId !== runId) break; full = ''; onToolCall(payload); break;
    }
  };
  step('agent.run.start', { runId: 'lead' });
  step('agent.run.start', { runId: 'w1' });
  step('agent.tool_call', { runId: 'w1', name: 'web_search' });
  A.eq(full, 'lead answer so far', "a worker's tool_call leaves the lead's answer intact");
  A.eq(calls.length, 0, "a worker's tool_call never renders as the lead's tool row");
  step('agent.tool_call', { runId: 'lead', name: 'team_dispatch' });
  A.eq(calls.join(','), 'lead', "the lead's own tool_call still renders");
})();
A.ok(/else if \(payload\.runId && payload\.runId !== runId\) \{ delegatedRuns\.add\(payload\.runId\)/.test(harness), 'harness records delegated worker runIds');
A.ok(/isDelegatedRun: \(id\) => delegatedRuns\.has/.test(harness), 'Harness.isDelegatedRun is exported');

// 3. quest generator skips delegated runs, before any cap lookup
const onTool = A.fnBody(quests, 'function onToolCall(');
A.ok(onTool.indexOf('isDelegatedRun(p.runId)) return') >= 0 && onTool.indexOf('isDelegatedRun') < onTool.indexOf('capForTool'), "a worker's tool use never mints a room-gap quest");

// 4. the plate: reported cost only, summed per call; beside the desk when seated
A.ok(/U\.bus\.on\('agent\.cost', p => \{[^\n]*k\.usd = \(k\.est === false \? k\.usd : 0\) \+ \(\+p\.usd\)/.test(world), 'plate cost sums the per-call agent.cost reports');
A.ok(/usd: null, est: null/.test(world), 'a plate starts with NO cost (unknown, never $0)');
const plates = A.fnBody(world, 'function drawActivityPlates(');
A.ok(plates.indexOf('deskPropFor(aid)') >= 0 && /atDesk/.test(plates), 'a seated worker\'s plate anchors to its desk');
A.ok(plates.indexOf('crewIsAwaiting(b)') >= 0, 'a plate stands down while its agent waits on the Commander');
A.ok(/PLATES_ON && plateByAgent\.has\(aid\)\) continue;   \/\/ its ACTIVITY PLATE carries this clock/.test(world), 'one clock per run: the RUN tag stands down for a plated agent');

A.report('summon-lines');
