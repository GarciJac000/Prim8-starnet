/* node test/learning-pause-midflight.e2e.test.js — a learning pass must not write after the Commander paused (or
   forgot) learning while its model call was in flight.

   runReflection, runFailureReview and the hybrid-recall embedder (hybridVectors) checked the personalization PAUSE
   once, at entry, then awaited a provider for seconds and persisted whatever came back. A pause or a DELETE (forget)
   that landed during that await was ignored: a memory or lesson about the Commander was saved ("◈ remembered") after
   they turned learning off, and it steers later prompts. The fix copies scanDocumentSource's rule: re-check enabled +
   revision after the await (setEnabled and markForgotten both bump it). runScoutCycle's arm lives in scout.e2e BOOT 4.

   Real sidecar + a mock OpenRouter that HOLDS the chosen call until the test releases it. Every arm has a control
   that shows the same pass DOES write when nothing changes mid-flight, so each paused arm can fail:
     · reflection  — control writes; a POST {enabled:false} mid-call writes nothing (spend still booked); a DELETE
                     (forget, learning stays on) mid-call writes nothing;
     · failure review — control writes a lesson; a pause mid-call writes none;
     · hybrid recall  — control persists the memory vectors; a pause mid-embed persists none.
   Zero network, fake key, no real spend. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODEL = 'run/model';
const EMBED_MODEL = 'openai/text-embedding-3-small';
const FAIL_MARK = 'FAILRUN';
const LONG_REPLY = ('I rebuilt the staging rollback path end to end and wrote down the reasoning and tradeoffs. ').repeat(30);
const SENTINEL = 'rollback notes in every deploy summary';
const LESSON = 'LESSON: Registry pushes rate-limit after repeated attempts; batch retries with exponential backoff before the next push';
const REFLECT_USAGE = { prompt_tokens: 1000, completion_tokens: 777, total_tokens: 1777 };

function startMock() {
  // hold: which kind of call to keep in flight ('reflect' | 'fail' | 'embed' | null); held: the kind now waiting
  const state = { hold: null, held: null, release: null, count: { reflect: 0, fail: 0, embed: 0 } };
  const holdIf = async kind => {
    state.count[kind]++;
    if (state.hold !== kind) return;
    await new Promise(resolve => { state.release = () => { state.release = null; state.held = null; resolve(); }; state.held = kind; });
  };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] }] }));
      return;
    }
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', async () => {
      if (req.url.indexOf('/embeddings') >= 0) {
        const body = JSON.parse(raw);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        await holdIf('embed');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: [1, 0, 0] })), usage: { prompt_tokens: 5 * inputs.length, total_tokens: 5 * inputs.length } }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      const send = (delta, usage, finish) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish || 'stop' }], usage: usage || { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      };
      if (raw.indexOf('reflecting right after finishing a task') >= 0) {
        await holdIf('reflect');
        return send({ content: 'PREFERENCE: The Commander wants ' + SENTINEL + '.' }, REFLECT_USAGE);
      }
      if (raw.indexOf('reviewing a task run of yours that FAILED') >= 0) {
        await holdIf('fail');
        return send({ content: LESSON });
      }
      if (raw.indexOf('[RUNTIME]') >= 0 && raw.indexOf(FAIL_MARK) >= 0) {
        const body = JSON.parse(raw);
        if (!(body.messages || []).some(m => m && m.role === 'tool')) {
          // one real tool turn (the failure-review salience floor), then a fatal 400 -> the run ends 'error'
          return send({ tool_calls: [{ index: 0, id: 'inspect_once', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }, null, 'tool_calls');
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'main stream rejected (test fault injection)', code: 400 } }));
        return;
      }
      if (raw.indexOf('[RUNTIME]') >= 0) return send({ content: LONG_REPLY });
      send({ content: 'NONE' });
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

function startRun(fixture, agentId, text) {
  return fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-pause-midflight-fake', model: MODEL, agentId, isTask: true, messages: [{ role: 'user', content: text }] })
  }).then(async r => { const raw = await r.text(); const m = raw.match(/"runId":"([^"]+)"/); return { status: r.status, runId: m ? m[1] : '', raw }; });
}
async function waitHeld(state, kind, label) {
  const until = Date.now() + 15000;
  while (state.held !== kind && Date.now() < until) await sleep(25);
  A.eq(state.held, kind, label + ': the ' + kind + ' call is in flight (held by the mock)');
}
async function until(pred, ms) { const end = Date.now() + (ms || 8000); while (Date.now() < end) { if (await pred()) return true; await sleep(100); } return !!(await pred()); }
const notebook = async (fixture, agentId) => JSON.stringify((await fixture.json('GET', '/api/notebook?agent=' + agentId)).body || '');
const lessons = async (fixture, agentId) => (((await fixture.json('GET', '/api/memory/records?agent=' + agentId)).body || {}).records || []).filter(r => r && r.origin === 'failure-review');
const ledgerRows = ws => { try { return fs.readFileSync(path.join(ws, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const setLearning = async (fixture, enabled) => (await fixture.json('POST', '/api/personalization', { enabled })).body;

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({
    prefix: 'starnet-learning-pause-', timeoutMs: 30000,
    env: { SKYNET_OPENROUTER_BASE: mock.base, SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SCOUT: '0' }
  });
  const ws = fixture.workspace;
  try {
    await fixture.start();
    const TASK = 'rebuild the staging rollback path and write it up';

    // ================= REFLECTION =================
    mock.state.hold = 'reflect';
    // control: nothing changes mid-flight -> the memory IS written
    const c = await startRun(fixture, 'ctl', TASK);
    A.eq(c.status, 200, 'reflection control: the task run streamed');
    await waitHeld(mock.state, 'reflect', 'reflection control');
    mock.state.release();
    A.ok(await until(async () => (await notebook(fixture, 'ctl')).indexOf(SENTINEL) >= 0), 'reflection control: an undisturbed reflection writes the memory');

    // paused mid-call -> nothing is written, the spend is still booked
    const p = await startRun(fixture, 'paused', TASK);
    await waitHeld(mock.state, 'reflect', 'reflection paused');
    A.eq((await setLearning(fixture, false)).enabled, false, 'reflection paused: learning paused while the call is in flight');
    mock.state.release();
    A.ok(await until(() => ledgerRows(ws).some(r => r.runId === p.runId && r.tokens === 1777 && r.usd > 0), 5000), 'reflection paused: the call\'s spend is still booked to the ledger (truthful cost)');
    await sleep(300);
    A.ok((await notebook(fixture, 'paused')).indexOf(SENTINEL) < 0, 'reflection paused: NO memory is written after the Commander paused learning');

    // forgot mid-call (learning stays ON) -> nothing is written
    A.eq((await setLearning(fixture, true)).enabled, true, 'reflection forgot: learning is back on before the run');
    const f = await startRun(fixture, 'forgot', TASK);
    await waitHeld(mock.state, 'reflect', 'reflection forgot');
    A.eq((await fixture.json('DELETE', '/api/personalization')).status, 200, 'reflection forgot: the forget lands while the call is in flight');
    mock.state.release();
    await until(() => ledgerRows(ws).some(r => r.runId === f.runId && r.tokens === 1777), 5000);
    await sleep(300);
    A.ok((await notebook(fixture, 'forgot')).indexOf(SENTINEL) < 0, 'reflection forgot: NO memory is written from a pass that began before the forget');
    A.eq(mock.state.count.reflect, 3, 'exactly the three reflection passes ran');

    // ================= FAILURE REVIEW =================
    mock.state.hold = 'fail';
    const fc = await startRun(fixture, 'fctl', FAIL_MARK + ' inspect the station then push the registry update');
    A.ok(/"reason":"error"/.test(fc.raw), 'failure-review control: the driven run ended in error');
    await waitHeld(mock.state, 'fail', 'failure-review control');
    mock.state.release();
    A.ok(await until(async () => (await lessons(fixture, 'fctl')).length === 1), 'failure-review control: an undisturbed review writes its lesson');

    const fp = await startRun(fixture, 'fpaused', FAIL_MARK + ' inspect the station then push the registry update');
    A.ok(/"reason":"error"/.test(fp.raw), 'failure-review paused: the driven run ended in error');
    await waitHeld(mock.state, 'fail', 'failure-review paused');
    A.eq((await setLearning(fixture, false)).enabled, false, 'failure-review paused: learning paused while the call is in flight');
    mock.state.release();
    await sleep(800);
    A.eq((await lessons(fixture, 'fpaused')).length, 0, 'failure-review paused: NO lesson is written after the Commander paused learning');
    A.eq((await setLearning(fixture, true)).enabled, true, 'learning back on for the recall arm');

    // ================= HYBRID RECALL (embeddings) =================
    const cfg = await fixture.json('POST', '/api/memory/config', { embedModel: EMBED_MODEL });
    A.eq(cfg.body && cfg.body.embedEnabled, true, 'recall: the embedding lane is live');
    mock.state.hold = null;
    // control: 'fctl' holds a lesson -> its vectors persist when nothing changes mid-embed
    await startRun(fixture, 'fctl', FAIL_MARK + ' inspect the station; publishing artifacts to the package index returns HTTP 429');
    A.ok(mock.state.count.embed >= 1, 'recall control: the embedding lane made its call');
    A.ok(fs.existsSync(path.join(ws, 'fctl.embed.json')), 'recall control: the memory vectors persisted (embed:<agent> store)');

    // paused mid-embed: 'ctl' holds the reflection memory from the first arm -> no vectors may persist
    mock.state.hold = 'embed';
    const pending = startRun(fixture, 'ctl', 'publish the rollback write-up to the package index');
    await waitHeld(mock.state, 'embed', 'recall paused');
    A.eq((await setLearning(fixture, false)).enabled, false, 'recall paused: learning paused while the embedding call is in flight');
    mock.state.release();
    const pr = await pending;
    A.eq(pr.status, 200, 'recall paused: the run still completes (recall falls back to lexical)');
    await sleep(300);
    A.ok(!fs.existsSync(path.join(ws, 'ctl.embed.json')), 'recall paused: NO memory vectors are persisted after the Commander paused learning');
  } finally {
    try { mock.state.hold = null; if (mock.state.release) mock.state.release(); } catch (_) {}
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('learning-pause-midflight.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
