'use strict';
// A STOP MID-ANSWER IS NOT A KNOWN FIGURE (bug 80de2a75), through a real sidecar and a priced mock model.
//  - a run that finishes keeps its priced rows, with no flag;
//  - a run stopped while its only call streams (nothing booked): spend unknown on the run row, a floor on the ledger row;
//  - a run that BOOKED a priced call, then is stopped while its next call streams: the booked dollars stay known and
//    counted (INSIGHTS, the ledger) as a floor (usageMissing), never zeroed as unknown and never called "unpriced";
//  - a run whose booked call's usage came in the SAME chunk as its last words (an openai-compatible profile yields the
//    usage before the text), stopped while the next call has sent no byte: nothing was cut, so its rows carry no flag;
//  - every flag survives a restart.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const PRICE_IN = 0.000003, PRICE_OUT = 0.000015;
const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
const toolCall = { index: 0, id: 'call_1', type: 'function', function: { name: 'recall_conversation', arguments: '{"query":"otter"}' } };
let plan = [];                       // one behaviour per provider call of the run under test, in order
let planFor = '';                    // that run's own words: the station's background calls (intake, …) never take a step
const held = [];
let onHeld = null;                   // resolves when a call is being held open
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: String(PRICE_IN), completion: String(PRICE_OUT) }, supported_parameters: ['tools'] }, { id: 'deepseek-chat', context_length: 128000 }] })); return; }
    // the run's own calls carry its tools and its words (inside the run context on a fresh stream)
    let mine = false;
    try {
      const j = JSON.parse(raw);
      mine = !!planFor && Array.isArray(j.tools) && j.tools.length > 0
        && (j.messages || []).some(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.indexOf(planFor) >= 0);
    } catch (_) {}
    const step = (mine && plan.shift()) || 'complete';
    if (step === 'silent') { held.push(res); if (onHeld) onHeld(); return; }   // the request is out; no byte ever comes back
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step === 'complete') { res.end(sse({ choices: [{ delta: { content: 'A complete answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }) + 'data: [DONE]\n\n'); return; }
    if (step === 'tool') {           // a priced tool-call turn whose usage arrives (booked: 100000*3e-6 + 1000*15e-6 = $0.315)
      res.end(sse({ choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100000, completion_tokens: 1000 } }) + 'data: [DONE]\n\n');
      return;
    }
    if (step === 'tool-text-usage') {   // the tool call, then its last words in the SAME chunk as the usage (usage first)
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] })
        + sse({ choices: [{ index: 0, delta: { content: 'Checking the otter notes.' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100000, completion_tokens: 1000 } })
        + 'data: [DONE]\n\n');
      return;
    }
    // 'stream': part of the answer, then hold — the usage chunk never comes
    res.write(sse({ choices: [{ delta: { content: 'Here is the first half of a long answer' } }] }));
    held.push(res);
    if (onHeld) onHeld();
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'cancel-spend-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_OPENROUTER_KEY: 'fixture', STARNET_OPENROUTER_KEY: 'fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    DEEPSEEK_BASE_URL: base, DEEPSEEK_API_KEY: 'fixture',   // the openai-compatible adapter (usage before text in one chunk)
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0'
  } });
  let seq = 0;
  const body = (text, sid, via) => JSON.stringify({ model: (via && via.model) || 'test/model', provider: (via && via.provider) || 'openrouter', key: 'fixture', agentId: 'agent', streamId: sid || 'cancel-spend', isTask: true, messages: [{ role: 'user', content: text }] });
  async function runRow(runId) { const r = await fixture.json('GET', '/api/runs?runId=' + encodeURIComponent(runId)); assert.equal(r.status, 200); return r.body.runs[0]; }
  function ledgerRow(runId) {
    const lines = fs.readFileSync(path.join(fixture.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } });
    return lines.filter(r => r && r.runId === runId).pop();
  }
  // start a run on `steps`, Stop it once the last step is being held open (mid-stream or before its first byte), and
  // read the run's stream to its end
  async function stoppedRun(text, steps, via) {
    plan = steps.slice(); planFor = text;
    const heldNow = new Promise(r => { onHeld = r; });
    const res = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(text, 'cancel-spend-' + (++seq), via) });
    assert.equal(res.status, 200);
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', runId = '', cancelled = false, stopping = null;
    const names = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line); names.push(ev.name);
        if (ev.name === 'agent.run.start' && !runId) {
          runId = ev.payload.runId;
          stopping = heldNow.then(async () => {
            await new Promise(r => setTimeout(r, 300));   // let what was written reach the loop
            cancelled = true;
            const c = await fixture.json('POST', '/api/cancel', { runId });
            assert.equal(c.body.stopped, true, 'the stop reached the live run');
          });
        }
      }
    }
    await stopping;
    onHeld = null;
    for (const r of held.splice(0)) { try { r.destroy(); } catch (_) {} }
    assert(runId && cancelled, 'the run was stopped: ' + names.join(','));
    return runId;
  }
  try {
    await fixture.start();
    // 1. a run that finishes with its usage keeps its priced rows, with no flag
    plan = ['complete'];
    const ok = await fixture.json('POST', '/api/run', JSON.parse(body('answer fully')));
    const okId = String(ok.text).split('\n').filter(Boolean).map(JSON.parse).find(e => e.name === 'agent.run.start').payload.runId;
    const okRow = await runRow(okId);
    assert.equal(okRow.reason, 'done');
    assert(okRow.usd > 0 && okRow.spendUnknown !== true && okRow.usageMissing !== true, 'a completed priced run keeps its known spend: ' + JSON.stringify(okRow));
    assert(ledgerRow(okId).unpriced !== true && ledgerRow(okId).usageMissing !== true, 'the completed run\'s ledger row carries no flag');

    // 2. stopped while its only call streams: nothing was booked, so the spend is unknown — never a known $0
    const bare = await stoppedRun('write a long answer', ['stream']);
    const bareRow = await runRow(bare);
    assert.equal(bareRow.reason, 'cancelled');
    assert.equal(bareRow.spendUnknown, true, 'nothing booked + a cut stream = spend unknown: ' + JSON.stringify({ usd: bareRow.usd, spendUnknown: bareRow.spendUnknown }));
    const bareLed = ledgerRow(bare);
    assert(bareLed && bareLed.usageMissing === true && bareLed.unpriced !== true, 'the ledger row is a floor, never "no published price": ' + JSON.stringify(bareLed));

    // 3. a booked priced call, then a Stop while the next call streams: the booked $0.315 stays known — a floor
    const booked = await stoppedRun('look up the otter notes then write a long answer', ['tool', 'stream']);
    const bookedRow = await runRow(booked);
    assert.equal(bookedRow.reason, 'cancelled');
    assert(Math.abs(bookedRow.usd - 0.315) < 1e-6, 'the booked call is on the run row: ' + bookedRow.usd);
    assert(bookedRow.spendUnknown !== true, 'booked spend is never re-labelled unknown (INSIGHTS would drop it): ' + JSON.stringify(bookedRow));
    assert.equal(bookedRow.usageMissing, true, 'the run row says its dollars are a floor');
    assert(bookedRow.unpriced !== true, 'a priced model is never called unpriced');
    const bookedLed = ledgerRow(booked);
    assert(bookedLed && Math.abs(bookedLed.usd - 0.315) < 1e-6 && bookedLed.usageMissing === true && bookedLed.unpriced !== true, 'the ledger row keeps the booked $ as a floor: ' + JSON.stringify(bookedLed));

    // 4. usage arrived first in the chunk that carried the call's last words; the Stop lands while the next call has
    //    sent nothing: no call was cut off, so the rows are exactly a known figure
    const clean = await stoppedRun('look up the otter notes', ['tool-text-usage', 'silent'], { provider: 'deepseek', model: 'deepseek-chat' });
    const cleanRow = await runRow(clean);
    assert.equal(cleanRow.reason, 'cancelled');
    assert(cleanRow.usd > 0, 'the booked call is on the run row: ' + cleanRow.usd);
    assert(cleanRow.spendUnknown !== true && cleanRow.usageMissing !== true, 'a Stop before the next call\'s first byte cut nothing: ' + JSON.stringify({ usd: cleanRow.usd, spendUnknown: cleanRow.spendUnknown, usageMissing: cleanRow.usageMissing, cancelledWhile: cleanRow.cancelledWhile }));
    const cleanLed = ledgerRow(clean);
    assert(cleanLed && cleanLed.usageMissing !== true && cleanLed.unpriced !== true, 'its ledger row carries no flag: ' + JSON.stringify(cleanLed));

    // INSIGHTS keeps every known dollar (the floor run included) and names the floor; spend unknown is only the bare run
    const expectUsd = okRow.usd + 0.315 + cleanRow.usd;
    const ins = (await fixture.json('GET', '/api/insights')).body;
    assert(Math.abs(ins.totalUsd - expectUsd) < 1e-6, 'INSIGHTS counts the booked $ of the stopped runs: ' + JSON.stringify({ totalUsd: ins.totalUsd, expectUsd }));
    assert.equal(ins.usageMissingRuns, 1, 'INSIGHTS names the floor run');
    assert.equal(ins.spendUnknownRuns, 1, 'INSIGHTS names the bare stopped run as spend unknown');
    assert.equal(ins.unpricedRuns, 0, 'INSIGHTS calls no run unpriced');
    // the /usage card: the same totals, the floor said in words, and never "no published price"
    const usage = (await fixture.json('POST', '/api/slash/dispatch', { input: '/usage', agentId: 'agent' })).body;
    const lines = (usage && usage.directive && usage.directive.lines) || [];
    assert(lines.some(l => /^2 runs stopped mid-answer/.test(l) && /at least/.test(l)), 'the /usage card names the floor runs: ' + JSON.stringify(lines));
    assert(!lines.some(l => /no published price/.test(l)), 'the /usage card never calls a stopped run unpriced: ' + JSON.stringify(lines));

    await fixture.restart();
    assert.equal((await runRow(bare)).spendUnknown, true, 'spend unknown survives a restart');
    const afterRow = await runRow(booked);
    assert(afterRow.usageMissing === true && afterRow.spendUnknown !== true, 'the floor survives a restart');
    const after = (await fixture.json('GET', '/api/insights')).body;
    assert(Math.abs(after.totalUsd - expectUsd) < 1e-6 && after.usageMissingRuns === 1, 'INSIGHTS reads the same after a restart: ' + JSON.stringify({ totalUsd: after.totalUsd, usageMissingRuns: after.usageMissingRuns }));
    console.log('cancel-spend-unknown: a stop mid-answer books its known spend as a floor (unknown only when nothing was booked), a stop that cut nothing and a completed run carry no flag, INSIGHTS and /usage keep every booked dollar, all survive restart PASS');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
