/* node dev/shell-refusal-hint-proof.js — host-wiring proof for the FILES BEFORE THE SHELL refusal hint (2026-10-25).

   A real model will not reliably type a C:\ path into shell_exec on demand, so a scripted mock provider does, in a REAL
   hermetic sidecar (SidecarFixture: temp workspace + profile). The script clicks "allow once" on the approval card, the
   way the v0.14.0 reporter did, and reads back the exact tool result the "model" got.
     with an INTEL CAB  (placed: cabinet + workbench) -> the refusal names fs_read / fs_list / fs_search and the cwd route
     without one        (placed: workbench only)      -> the refusal is the old text: no tool the run lacks is named
   Prints one JSON line; PASS = both. Free: no real model is called. PROOF_ENTRY=<a trunk sidecar/index.js> runs the baseline. */
'use strict';
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');

const ENTRY = process.env.PROOF_ENTRY ? path.resolve(process.env.PROOF_ENTRY) : undefined;
const CMD = 'type C:\\Users\\Public\\orbit-planner\\docs\\RELEASE_NOTES.md';

function sse(res, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) + '\n\n');
  res.write('data: [DONE]\n\n'); res.end();
}

function startMock() {
  const seen = { shellResult: null, wire: [] };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
        let body = {}; try { body = JSON.parse(b); } catch (_) {}
        const toolNames = (body.tools || []).map(t => t && t.function && t.function.name);
        if (toolNames.indexOf('shell_exec') < 0) return sse(res, { content: 'ok' }, 'stop');   // aux/internal calls
        seen.wire = toolNames;
        const msgs = body.messages || [];
        const toolMsg = msgs.filter(m => m && m.role === 'tool').pop();
        const call = (name, args) => sse(res, { tool_calls: [{ index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
        // the Task Brief gate holds consequential tools until the brief settles: settle it the way real models do first
        if (!toolMsg) return call('brief_proceed', { objective: 'Read the release notes and report the codename.' });
        if (toolMsg.tool_call_id === 'call_brief_proceed') return call('shell_exec', { cmd: CMD });
        seen.shellResult = typeof toolMsg.content === 'string' ? toolMsg.content : (toolMsg.content || []).map(p => p && p.text || '').join('');
        return sse(res, { content: 'Done.' }, 'stop');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ base: 'http://127.0.0.1:' + server.address().port + '/api/v1', seen, close: () => server.close() }));
  });
}

async function oneRun(placed) {
  const mock = await startMock();
  const fixture = SidecarFixture.create({ prefix: 'shell-hint-proof-', timeoutMs: 30000, entry: ENTRY,
    env: { SKYNET_OPENROUTER_BASE: mock.base, SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_QUEST_REFRESH: '0', SKYNET_AUX_BUDGET: '0' } });
  await fixture.start();
  const cards = [];
  let runId = '', end = null;
  try {
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-or-v1-mock', model: 'test/model', agentId: 'proof-hint', streamId: 'proof-hint', isTask: true, placed,
        messages: [{ role: 'user', content: 'Read C:\\Users\\Public\\orbit-planner\\docs\\RELEASE_NOTES.md and tell me the codename.' }] }) });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
        if (!runId && ev.payload && ev.payload.runId) runId = ev.payload.runId;
        if (ev.name === 'agent.run.end') end = ev.payload;
        if (ev.name === 'permission.prompt') {
          cards.push(ev.payload.tool);
          fixture.request('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision: 'once' }) }).catch(() => {});
        }
      }
    }
  } finally { await fixture.dispose(); mock.close(); }
  return { placed: placed.join('+'), fsReadOnWire: mock.seen.wire.indexOf('fs_read') >= 0, cards, reason: end && end.reason, shellResult: mock.seen.shellResult };
}

(async () => {
  const withCab = await oneRun(['cabinet', 'workbench']);
  const without = await oneRun(['workbench']);
  const out = { sidecar: ENTRY || 'this tree', withCab, without };
  out.PASS = !!(withCab.fsReadOnWire && /^ERROR|refused: drive-absolute/.test(withCab.shellResult || '') && /call fs_read \/ fs_list \/ fs_search with the full path instead/.test(withCab.shellResult || '')
    && /pass that folder as cwd/.test(withCab.shellResult || '')
    && !without.fsReadOnWire && /refused: drive-absolute/.test(without.shellResult || '') && !/fs_read/.test(without.shellResult || ''));
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.PASS ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
