/* node dev/notepad-think-live-proof.js — LIVE proof for two 0.14.1 fixes, driven through a REAL sidecar (hermetic
   SidecarFixture: temp workspace + temp profile, never the Commander's station) against a mock Ollama that records
   every /api/chat body it is sent.

   #116  Reasoning OFF (Ollama's own default effort) reaches a thinking model as think:false on a Commander greeting
         and on a task; a real effort ('high') still sends think:true.
   #155  A routine in the default ASK posture, fired with Run Now (the scheduled fire's exact posture), is OFFERED
         routine.notepad, reads and writes it, and after a sidecar restart a second fire reads the first fire's note
         back. (That an unknown tool of the same capability, or a connector re-registering the name, stays filtered is
         locked in test/inputpolicy.test.js through the real registry, authority and dispatch.)

   PROOF_BASELINE=1 prints the same receipts without asserting (the A/B against v0.14.0 sources); PROOF_DUMP=1 prints
   the routine's and the watched task's tool wires. No keys needed. */
'use strict';
const http = require('node:http');
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');

const BASELINE = process.env.PROOF_BASELINE === '1';
const MODEL = 'qwen3:8b';
const problems = [];
function check(cond, label, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
  if (!cond) problems.push(label);
}

// ---- mock Ollama: /api/show says the model thinks; /api/chat is recorded and scripted by the user turn's marker ----
function startOllama() {
  const chats = [];
  let fire = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/api/show')) return res.end(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools', 'thinking'] }));
    if (req.url.endsWith('/api/ps')) return res.end('{"models":[]}');
    if (req.url.endsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL }] }));
    if (!req.url.endsWith('/api/chat')) return res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    const body = JSON.parse(raw || '{}');
    const users = (body.messages || []).filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
    const toolNames = (body.tools || []).map(t => t && t.function && t.function.name).filter(Boolean);
    const results = (body.messages || []).filter(m => m.role === 'tool');
    // the LAST marker: a turn's <run_context> quotes this agent's earlier runs (their markers) ahead of the real request
    const marker = (users.match(/THINK116_[A-Z]+|NOTEPAD155/g) || ['other']).pop();
    chats.push({ marker, think: body.think, hasThink: 'think' in body, toolNames, results: results.map(r => String(r.content)) });
    res.setHeader('Content-Type', 'application/x-ndjson');
    const reply = (message) => res.end(JSON.stringify({ message: Object.assign({ role: 'assistant', content: '' }, message), done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 }) + '\n');
    if (marker !== 'NOTEPAD155') return reply({ content: 'Ready.' });
    const notepad = toolNames.find(n => /^routine[._]notepad$/.test(n));
    if (!notepad) return reply({ content: 'NO_NOTEPAD_TOOL on my wire.' });
    if (results.length === 0) { fire++; return reply({ tool_calls: [{ id: 'np-read-' + fire, function: { name: notepad, arguments: { action: 'read' } } }] }); }
    if (results.length === 1) return reply({ tool_calls: [{ id: 'np-write-' + fire, function: { name: notepad, arguments: { action: 'write', text: 'LEDGER fire ' + fire + ' | previous: ' + String(results[0].content).slice(0, 120) } } }] });
    return reply({ content: 'Ledger updated.' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    chats, base: 'http://127.0.0.1:' + server.address().port + '/v1',
    close: () => new Promise(r => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); })
  })));
}

const parse = (text) => String(text || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
const endOf = (events) => { const e = events.filter(x => x.name === 'agent.run.end').pop(); return e ? e.payload.reason : null; };

(async () => {
  const ollama = await startOllama();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-notepad-think-', timeoutMs: 45000,
    env: {
      OLLAMA_BASE_URL: ollama.base, SKYNET_DEFAULT_MODEL: MODEL, SKYNET_AUX_BUDGET: '0', SKYNET_QUEST_REFRESH: '0',
      SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '',
      SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
    }
  });
  try {
    await sidecar.start();
    const perms = await sidecar.json('GET', '/api/permissions');
    check(perms.body && perms.body.masterBypass === false && perms.body.envFullAccess === false, 'station is in the default ASK posture (no Full Access, no bypass)');

    /* ---------------- #116: think on the native Ollama wire ---------------- */
    console.log('\n#116 — Reasoning OFF on native Ollama (' + (BASELINE ? 'BASELINE' : 'fix') + ')');
    async function run(marker, isTask, extra) {
      const r = await sidecar.json('POST', '/api/run', Object.assign({
        provider: 'ollama', baseUrl: ollama.base, model: MODEL, agentId: 'agent', isTask,
        messages: [{ role: 'user', content: marker + (isTask ? ' list what you can do, then stop' : ' hello') }]
      }, extra || {}));
      const events = parse(r.text);
      const sent = ollama.chats.filter(c => c.marker === marker);
      return { reason: endOf(events), sent };
    }
    const greet = await run('THINK116_GREETING', false);
    check(greet.reason === 'done', 'OFF greeting run completed', greet.reason);
    check(greet.sent.length > 0 && greet.sent.every(c => c.think === false), 'OFF greeting: every /api/chat body carried think:false', greet.sent.map(c => c.hasThink ? c.think : '(absent)'));
    const task = await run('THINK116_TASK', true);
    check(task.reason === 'done', 'OFF task run completed', task.reason);
    check(task.sent.length > 0 && task.sent.every(c => c.toolNames.length > 0), 'OFF task: the request carried tools (a real task turn)', task.sent.map(c => c.toolNames.length));
    check(task.sent.length > 0 && task.sent.every(c => c.think === false), 'OFF task: every /api/chat body carried think:false', task.sent.map(c => c.hasThink ? c.think : '(absent)'));
    const high = await run('THINK116_HIGH', true, { reasoningEffort: 'high' });
    check(high.reason === 'done', 'HIGH task run completed', high.reason);
    check(high.sent.length > 0 && high.sent.every(c => c.think === true), 'HIGH task: a real effort still sends think:true', high.sent.map(c => c.hasThink ? c.think : '(absent)'));

    /* ---------------- #155: routine.notepad in an unattended ASK routine ---------------- */
    console.log('\n#155 — routine.notepad under unattended ASK (' + (BASELINE ? 'BASELINE' : 'fix') + ')');
    const created = await sidecar.json('POST', '/api/cron', { name: 'Dedup ledger', prompt: 'NOTEPAD155 keep a dedup ledger of what you already reported in your routine notepad', schedule: 'every 1h', agentId: 'agent', model: MODEL, provider: 'ollama' });
    check(created.status === 200 && created.body && created.body.job, 'routine created', created.body && (created.body.error || created.body.job && created.body.job.id));
    const job = created.body && created.body.job;
    check(job && (job.approvalMode || 'ask') !== 'full' && (!job.unattendedGrants || job.unattendedGrants.length === 0), 'routine holds no unattended grants', job && { approvalMode: job.approvalMode, grants: job.unattendedGrants });
    async function fire(n) {
      const before = ollama.chats.length;
      const res = await sidecar.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id }) });
      const events = parse(await res.text());
      const sent = ollama.chats.slice(before).filter(c => c.marker === 'NOTEPAD155');
      const calls = events.filter(e => e.name === 'agent.tool_call').map(e => e.payload && e.payload.name);
      const toolResults = events.filter(e => e.name === 'agent.tool_result').map(e => ({ name: e.payload && e.payload.name, ok: e.payload && e.payload.ok, summary: e.payload && e.payload.summary }));
      const wire = sent[0] ? sent[0].toolNames : [];
      console.log('  fire ' + n + ': reason=' + endOf(events) + ' wire tools=' + wire.length + ' calls=' + JSON.stringify(calls) + ' results=' + JSON.stringify(toolResults));
      return { reason: endOf(events), sent, wire, calls, toolResults };
    }
    const f1 = await fire(1);
    if (process.env.PROOF_DUMP === '1') console.log('  routine wire: ' + f1.wire.join(' ') + '\n  watched task wire: ' + (task.sent[0] ? task.sent[0].toolNames.join(' ') : ''));
    check(f1.reason === 'done', 'fire 1 completed', f1.reason);
    check(f1.wire.some(n => /^routine[._]notepad$/.test(n)), 'fire 1: routine.notepad is on the unattended ASK wire', f1.wire.filter(n => /routine/.test(n)));
    const f1Results = (f1.sent[f1.sent.length - 1] || { results: [] }).results;
    check(f1Results.length === 2 && /"ok":true/.test(f1Results[1] || ''), 'fire 1: the notepad write succeeded (tool result the model got back)', f1Results);
    const listed = await sidecar.json('GET', '/api/cron');
    const stored = ((listed.body && listed.body.jobs) || []).find(j => j.id === job.id) || {};
    console.log('  stored job notepad field: ' + JSON.stringify(stored.notepad));

    await sidecar.restart();
    console.log('  (sidecar restarted)');
    const f2 = await fire(2);
    check(f2.reason === 'done', 'fire 2 (after restart) completed', f2.reason);
    const readBack = ((f2.sent[1] || f2.sent[f2.sent.length - 1] || { results: [] }).results[0]) || '';
    check(/LEDGER fire 1/.test(readBack), 'fire 2: the notepad read returned fire 1\'s note across the restart', readBack.slice(0, 160));

    const tail = sidecar.output();
    check(!/unhandledRejection|uncaughtException/.test(tail), 'no process-level failure in the sidecar log');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('\nsidecar output (tail):\n' + sidecar.output().slice(-4000));
    problems.push('threw');
  } finally {
    await sidecar.dispose();
    await ollama.close();
  }
  console.log('\n' + (problems.length ? problems.length + ' problem(s): ' + problems.join(' | ') : 'ALL CHECKS PASSED') + (BASELINE ? '  [BASELINE: not asserted]' : ''));
  process.exitCode = (problems.length && !BASELINE) ? 1 : 0;
})();
