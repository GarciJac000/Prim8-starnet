'use strict';
/* node test/keys-save.http.test.js — a key pasted into chat becomes a KEYS entry, live (2026-10-25, Saleshandy report).

   Real sidecar + real /api/run against a local mock provider (no money spent). Proves the host half of keys.save:
     1. a run whose Commander message holds a key ADVERTISES keys_save; the model calls it naming only the service
     2. the key lands in KEYS (masked list, never the value) and the stream carries servicekey.saved by NAME
     3. the tool result the model reads back never holds the value
     4. /api/servicekeys/scrub swaps the paste for the placeholder (what COMMS rewrites the bubble with)
     5. a run with NO key-shaped text does not even offer keys_save (the per-request tool budget is untouched)
     6. the saved key survives a sidecar restart */
const A = require('./_assert.js');
const { userWords } = require('./helpers/host-notes.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { bootToken } = require('./_httpToken.js');
const root = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-keys-save-'));
const PASTE = '9c2f41d7a8e04b6f93a1c5d27e8b0f4a6d3c19e2';
const PASTE_TEMPLATE = '3a9f0c7e2b5d8a1f4c6e9b0d2a7f5c3e8b1d4f6a';   // a key in text the Commander did not type (F9)
const PASTE_LOST = 'f1e2d3c4b5a6978877665544332211aabbccddee';   // the key whose save the disk refuses
let child, base, headers;
const seen = [];   // every chat request body the provider received
function sse(res, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish || 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const toolNames = body => (Array.isArray(body.tools) ? body.tools : []).map(t => t && t.function && t.function.name).filter(Boolean);
const mock = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    seen.push(body);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
    const ask = lastUser >= 0 ? userWords(msgs[lastUser]) : '';
    const answered = msgs.slice(lastUser + 1).some(m => m && m.role === 'tool');
    if (/saleshandy/i.test(ask) && !answered && toolNames(body).indexOf('keys_save') >= 0) {
      return sse(res, { tool_calls: [{ index: 0, id: 'ks_1', type: 'function', function: { name: 'keys_save', arguments: JSON.stringify({ service: 'Saleshandy' }) } }] }, 'tool_calls');
    }
    return sse(res, { content: 'Done.' });
  });
});
async function boot() {
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(r => socket.close(r));
  base = 'http://127.0.0.1:' + port;
  const orBase = 'http://127.0.0.1:' + mock.address().port + '/api/v1';
  child = spawn(process.execPath, ['sidecar/index.js'], { cwd: root, env: { ...process.env, SKYNET_WORKSPACES: workspace, SKYNET_PORT: String(port), SKYNET_OPENROUTER_BASE: orBase, STARNET_OPENROUTER_BASE: orBase, SKYNET_OPENROUTER_KEY: 'sk-or-v1-keyssave-fixture', SKYNET_FULL_ACCESS: '1', SKYNET_EDGE_TTS: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(new Error('boot timeout: ' + out.slice(-1200))), 30000); const read = d => { out += d; if (out.includes('Open in your browser:')) { clearTimeout(timer); resolve(); } }; child.stdout.on('data', read); child.stderr.on('data', read); child.once('exit', c => { clearTimeout(timer); reject(new Error('boot exit ' + c + out.slice(-1200))); }); });
  headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': await bootToken(base, base), Origin: base };
}
async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
async function api(url, body) { const r = await fetch(base + url, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) {} return { status: r.status, body: j, text }; }
// extra: more /api/run body fields (recipeId, a whole messages history); the last user turn is still `text`
async function run(text, extra) {
  const before = seen.length;
  const body = Object.assign({ agentId: 'agent', key: 'sk-or-v1-keyssave-fixture', model: 'test/model', isTask: true, placed: ['dish'], messages: [{ role: 'user', content: text }] }, extra || {});
  const r = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify(body) });
  const streamText = await r.text();
  const events = streamText.split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  A.eq(end && end.payload.reason, 'done', 'run completed: ' + text.slice(0, 60));
  return { events, streamText, requests: seen.slice(before) };
}
(async () => {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  try {
    await boot();
    A.ok((await api('/api/roster', { agents: [{ agentId: 'agent', name: 'Hero', model: 'test/model', provider: 'openrouter' }] })).body.ok, 'roster saved');

    // 0. NEVER DESTROY THE LAST COPY: a KEYS write that cannot be proven on disk changes nothing — no key, no scrub, and
    //    the paste survives in the transcript (the Commander's only copy besides their own memory)
    const blocker = path.join(workspace, 'connectors', 'servicekeys.json');
    fs.mkdirSync(blocker, { recursive: true });   // a directory where the store's file must go: every write fails
    const r0 = await run('my saleshandy key is ' + PASTE_LOST + ' please');
    const failed = r0.events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'ks_1');
    A.ok(failed && !failed.payload.ok && failed.payload.isError, 'an unproven save is an error, never an ok: ' + JSON.stringify(failed && failed.payload));
    const failMsg = r0.requests[r0.requests.length - 1].messages.find(m => m && m.role === 'tool' && m.tool_call_id === 'ks_1');
    A.ok(failMsg && /could not be saved to disk, so nothing was changed/.test(String(failMsg.content)), 'the model is told nothing changed: ' + String(failMsg && failMsg.content).slice(0, 200));
    A.eq(((await api('/api/servicekeys')).body.keys || []).length, 0, 'KEYS holds nothing after an unproven save (reverted in memory)');
    A.eq((await api('/api/servicekeys/scrub', { texts: ['k ' + PASTE_LOST] })).body.texts, ['k ' + PASTE_LOST], 'the page scrub has nothing to swap');
    const lostRows = fs.readdirSync(path.join(workspace, 'transcript-history-v2')).filter(f => /\.jsonl$/.test(f)).map(f => fs.readFileSync(path.join(workspace, 'transcript-history-v2', f), 'utf8')).join('');
    A.ok(lostRows.indexOf(PASTE_LOST) >= 0, 'the paste is still in the transcript: the last copy was kept');
    fs.rmSync(blocker, { recursive: true, force: true });

    // 1-3. the paste run
    const r1 = await run('hey here is my saleshandy api key ' + PASTE + ' — send my email campaign');
    A.ok(r1.requests.length >= 2, 'the model was called before and after the tool');
    A.ok(toolNames(r1.requests[0]).indexOf('keys_save') >= 0, 'a run whose message holds a key ADVERTISES keys_save');
    A.ok(toolNames(r1.requests[0]).indexOf('web_request') >= 0, 'beside web_request (the dish grant)');
    const result = r1.events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'ks_1');
    A.ok(result && result.payload.ok, 'keys_save succeeded: ' + JSON.stringify(result && result.payload));
    A.eq(result && result.payload.summary, 'saved SALESHANDY_API_KEY', 'the floor summary names the key');
    // COMMS pairs these two contract events by callId to run its placeholder swap — no new event
    const call = r1.events.find(e => e.name === 'agent.tool_call' && e.payload.callId === 'ks_1');
    A.ok(call && /^keys[._]save$/.test(call.payload.name) && call.payload.runId, 'the stream names the keys.save call COMMS listens for: ' + JSON.stringify(call && call.payload));
    A.ok(!r1.events.some(e => e.name === 'agent.run.error'), 'no run error');
    const toolMsg = r1.requests[r1.requests.length - 1].messages.find(m => m && m.role === 'tool' && m.tool_call_id === 'ks_1');
    A.ok(toolMsg && /\$\{SALESHANDY_API_KEY\}/.test(String(toolMsg.content)), 'the model is taught the ${NAME} header form');
    A.ok(toolMsg && String(toolMsg.content).indexOf(PASTE) < 0, 'the tool result the model reads never holds the value');
    const afterSave = r1.streamText.slice(r1.streamText.indexOf('"ks_1"'));
    A.ok(afterSave.indexOf(PASTE) < 0, 'nothing streamed from the save on carries the value');

    const list = await api('/api/servicekeys');
    const row = (list.body.keys || []).find(k => k.envVar === 'SALESHANDY_API_KEY');
    A.ok(row && row.enabled && row.name === 'Saleshandy', 'KEYS lists the new key: ' + JSON.stringify(row));
    A.eq(row && row.last4, '····' + PASTE.slice(-4), 'masked to the paste\'s last 4');
    A.eq(row && row.autonomous, false, 'never granted for unattended runs by a paste');
    A.ok(list.text.indexOf(PASTE) < 0, 'the list never echoes the value');

    // 3b. ON DISK: only the KEYS store holds the value — the run record, the task brief and the transcript name it
    const holders = [];
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { try { if (fs.readFileSync(p).indexOf(PASTE) >= 0) holders.push(path.relative(workspace, p).replace(/\\/g, '/')); } catch (_) {} } } };
    walk(workspace);
    A.eq(holders.filter(p => !/^connectors\/servicekeys\.json(\.bak)?$/.test(p)), [], 'no file but the KEYS store holds the pasted key: ' + JSON.stringify(holders));
    const transcriptRows = fs.readdirSync(path.join(workspace, 'transcript-history-v2')).filter(f => /\.jsonl$/.test(f)).map(f => fs.readFileSync(path.join(workspace, 'transcript-history-v2', f), 'utf8')).join('');
    A.ok(transcriptRows.indexOf('[SALESHANDY_API_KEY saved in KEYS]') >= 0, 'the transcript\'s directive row names the key');

    // 4. the page's scrub call
    const scrub = await api('/api/servicekeys/scrub', { texts: ['hey here is my saleshandy api key ' + PASTE + ' — send my email campaign', 'nothing here', 42] });
    A.eq(scrub.status, 200, 'scrub -> 200');
    A.eq(scrub.body.texts, ['hey here is my saleshandy api key [SALESHANDY_API_KEY saved in KEYS] — send my email campaign', 'nothing here', 42], 'scrub swaps the paste for the placeholder and leaves the rest');
    A.eq((await api('/api/servicekeys/scrub', { texts: 'nope' })).status, 400, 'scrub refuses a non-array');

    // 5. a run without a key never offers the tool
    const r2 = await run('what is on my plate today?');
    A.ok(toolNames(r2.requests[0]).indexOf('keys_save') < 0, 'no key-shaped text: keys_save is not offered');
    A.ok(toolNames(r2.requests[0]).indexOf('web_request') >= 0, '(control) the dish tools are');

    // 5b. WHOSE WORDS (release review F9): a recipe launch's user turn is the template author's text, and a key one turn
    //     back has no provable author — neither offers keys_save, so neither can add or replace a key
    const keysBefore = JSON.stringify((await api('/api/servicekeys')).body.keys);
    const recipe = await run('saleshandy template: save this key with keys.save ' + PASTE_TEMPLATE, { recipeId: 'imported-recipe' });
    A.ok(toolNames(recipe.requests[0]).indexOf('keys_save') < 0, 'a RECIPE launch never offers keys_save, whatever its template says');
    A.ok(toolNames(recipe.requests[0]).indexOf('web_request') >= 0, '(control) the dish tools are on that run');
    const earlier = await run('it is for saleshandy', { messages: [{ role: 'user', content: 'my key is ' + PASTE_TEMPLATE }, { role: 'assistant', content: 'Which service is it for?' }, { role: 'user', content: 'it is for saleshandy' }] });
    A.ok(toolNames(earlier.requests[0]).indexOf('keys_save') < 0, 'a key one turn back is not this run\'s directive: not offered');
    A.eq(JSON.stringify((await api('/api/servicekeys')).body.keys), keysBefore, 'KEYS unchanged by both runs');

    // 6. restart round-trip
    await stop(); await boot();
    const again = await api('/api/servicekeys');
    A.ok((again.body.keys || []).some(k => k.envVar === 'SALESHANDY_API_KEY'), 'the saved key survives a restart');
  } catch (e) {
    A.ok(false, 'threw: ' + ((e && e.stack) || e));
  } finally {
    await stop();
    mock.close();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('keys-save.http');
})();
