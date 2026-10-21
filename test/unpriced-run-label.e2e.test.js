/* node test/unpriced-run-label.e2e.test.js — an UNPRICED run is labelled, never booked as a $0 metered run
   (sweep/providers 2026-10-20).

   A model with no provider-reported cost and no catalog price is "unpriced": the loop knows it (agent.cost
   unpriced:true, result.unpricedUsage) and its own token ceiling guards it. But the run host wrote both durable
   rows (ledger.jsonl + runs.jsonl) with usd 0 and NO unpriced mark, so /api/insights folded it as a METERED $0 run
   (meteredRuns 1, usd 0, spendLabel '') and the /insights readout printed the model at "$0.00" — a zero the harness
   cannot prove. Live on the sweep rig before the fix: ledger {usd:0, unmetered:false}, insights byModel
   {usd:0, meteredRuns:1, spendLabel:''}.

   Boots the real sidecar against a loopback OpenRouter wire (one priced model, one unpriced), drives /api/run,
   restarts the sidecar, and asserts the label survives in the ledger row, the run row and the insights fold, while
   the priced run is untouched. No external network, no spend. Part of test:http (owns a child + sockets). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function startProvider() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (/\/models(?:\?|$)/.test(req.url || '')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'mock/priced', context_length: 64000, pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['tools'] },
          { id: 'mock/unpriced', context_length: 64000, supported_parameters: ['tools'] }
        ] }));
      }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
        send({ choices: [{ index: 0, delta: { content: 'reply from ' + body.model } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });   // no usage.cost
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const provider = await startProvider();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-unpriced-label-',
    env: { OPENROUTER_KEY: '', OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: 'sk-or-v1-unpriced-e2e', SKYNET_OPENROUTER_BASE: provider.base,
      STARNET_OPENROUTER_BASE: provider.base, SKYNET_EDGE_TTS: '0', STARNET_EDGE_TTS: '0', SKYNET_AUX_BUDGET: '0' }
  });
  await sidecar.start();
  const runOnce = async (model, agentId) => {
    const r = await sidecar.json('POST', '/api/run', { provider: 'openrouter', model, agentId, isTask: false, messages: [{ role: 'user', content: 'hello' }] });
    const events = String(r.text || '').split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    return (events.find(e => e.name === 'agent.run.end') || {}).payload || {};
  };
  try {
    const pricedEnd = await runOnce('mock/priced', 'pricedagent');
    const unpricedEnd = await runOnce('mock/unpriced', 'freeagent');
    A.eq(pricedEnd.reason, 'done', 'priced run completed');
    A.eq(unpricedEnd.reason, 'done', 'unpriced run completed');

    const check = async (when) => {
      const rows = fs.readFileSync(path.join(sidecar.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const lu = rows.find(r => r.runId === unpricedEnd.runId) || {};
      const lp = rows.find(r => r.runId === pricedEnd.runId) || {};
      A.eq(lu.unpriced, true, when + ': the unpriced run\'s LEDGER row is labelled unpriced (' + JSON.stringify(lu) + ')');
      A.ok(!('unpriced' in lp), when + ': the priced run\'s ledger row is byte-identical to before (no unpriced key)');
      A.ok(lp.usd > 0, when + ': the priced run booked real dollars');
      const ru = ((await sidecar.json('GET', '/api/runs?agent=freeagent&runId=' + unpricedEnd.runId)).body.runs || [])[0] || {};
      A.eq(ru.unpriced, true, when + ': the unpriced run\'s RUN row is labelled unpriced');
      const ins = (await sidecar.json('GET', '/api/insights?agent=freeagent')).body || {};
      const m = (ins.byModel || []).find(x => x.model === 'mock/unpriced') || {};
      A.eq(m.meteredRuns, 0, when + ': insights does not count the unpriced run as a metered $0 run (' + JSON.stringify(m) + ')');
      A.eq(m.unpricedRuns, 1, when + ': insights names it as an unpriced run');
      A.ok(/price/i.test(String(m.spendLabel || '')), when + ': insights labels the model\'s spend instead of a bare $0 (' + m.spendLabel + ')');
      A.eq(ins.unpricedRuns, 1, when + ': the overview counts the unpriced run');
      const pi = (await sidecar.json('GET', '/api/insights?agent=pricedagent')).body || {};
      const pm = (pi.byModel || []).find(x => x.model === 'mock/priced') || {};
      A.eq(pm.meteredRuns, 1, when + ': the priced run is still a metered run');
      A.eq(pm.spendLabel, '', when + ': the priced model carries no label');
    };
    await check('live');
    await sidecar.restart();
    await check('after restart');
  } finally {
    await sidecar.dispose();
    await new Promise(resolve => provider.server.close(resolve));
  }
  A.report('unpriced-run-label.e2e');
})().catch(e => { console.log('FAIL: unpriced-run-label.e2e threw -- ' + (e && e.stack || e)); process.exit(1); });
