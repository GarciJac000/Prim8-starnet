/* node test/failreview-provider-refusal.e2e.test.js — a run the PROVIDER refused gets no failure review (xai-403-1023).

   Live (StarNet Cloud proxy logs 2026-10-23): every managed 403 {"provider":"xAI","message":"Provider returned error"}
   came in a pair 1-2 s apart. The second request was the failure review: after a failed task it sends the end of that
   conversation to the SAME provider and model, which refused it again — and since its cooldown arms only on a saved
   lesson, it repeated after every failed run. Against the REAL sidecar + a mock OpenRouter that records every call:

     ARM 1 — a task that made a real tool turn, then got the upstream's 403 (provider xAI named, no reason), ends
             'error' after exactly ONE refused request (no resend), and NO failure-review request follows.
     ARM 2 — CONTROL, same station: a task that failed on a 400 the provider gave on its request shape still gets its
             one failure review (the gate is selective, not off).
     ARM 3 — CONTROL: a tool turn, then a 404 "No endpoints found that support image input" (the model cannot read the
             screenshot the loop sent it — 14 of these in the same cloud log). model_not_found, but about a PART of the
             request: the review is a plain text request the same model answers, so it still gets its one review.

   No aux model is configured, so the review would ride the run's own model — the case in the logs. Zero network. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN_MODEL = 'x-ai/grok-fixture';
const REFUSE_MARK = 'REFUSEDRUN';
const SHAPE_MARK = 'SHAPERUN';
const IMAGE_MARK = 'IMAGEPARTRUN';

function sse(res, deltas, usage, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function startMock() {
  const state = { calls: [] };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: RUN_MODEL, context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        const body = JSON.parse(raw);
        const messages = body.messages || [];
        const sysMsg = messages.find(m => m && m.role === 'system');
        const sys = sysMsg ? (typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content)) : '';
        const rec = {
          main: raw.indexOf('[RUNTIME]') >= 0,
          failReview: sys.indexOf('reviewing a task run of yours that FAILED') >= 0,
          refused: raw.indexOf(REFUSE_MARK) >= 0, toolTurnDone: messages.some(m => m && m.role === 'tool'), status: 200
        };
        state.calls.push(rec);
        if (rec.failReview) { sse(res, [{ content: 'LESSON: Registry pushes need the upload token refreshed before each batch of retries' }], { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }, 'stop'); return; }
        if (rec.main && !rec.toolTurnDone && (raw.indexOf(REFUSE_MARK) >= 0 || raw.indexOf(SHAPE_MARK) >= 0 || raw.indexOf(IMAGE_MARK) >= 0)) {
          // one real tool turn first: the failed run has a tool trace, so the review's salience floor is met
          sse(res, [{ tool_calls: [{ index: 0, id: 'inspect_once', type: 'function', function: { name: 'station_inspect', arguments: '{}' } }] }],
            { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, 'tool_calls');
          return;
        }
        if (rec.main && raw.indexOf(REFUSE_MARK) >= 0) {
          // what OpenRouter answers when xAI refuses the request: 403, the upstream named, its reason absent
          rec.status = 403;
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Provider returned error', code: 403, metadata: { provider_name: 'xAI' } } }));
          return;
        }
        if (rec.main && raw.indexOf(IMAGE_MARK) >= 0) {
          // what OpenRouter answers when the routed model cannot take an image the request carries
          rec.status = 404;
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'No endpoints found that support image input', code: 404 } }));
          return;
        }
        if (rec.main && raw.indexOf(SHAPE_MARK) >= 0) {
          rec.status = 400;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'main stream rejected (test fault injection)', code: 400 } }));
          return;
        }
        sse(res, [{ content: 'ok, done.' }], { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, 'stop');
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function driveRun(fixture, agentId, text) {
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-refusal-fake', model: RUN_MODEL, agentId, isTask: true, messages: [{ role: 'user', content: text }] })
  });
  A.eq(r.status, 200, 'the real /api/run stream opened for ' + agentId);
  const raw = await r.text();
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
const endOf = events => events.filter(e => e.name === 'agent.run.end').pop();
async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 12000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 1500)) break;
    await sleep(200);
  }
}

(async () => {
  const mock = await startMock();
  // no aux model (the review rides the run's own model, as in the logs); governor unlimited so only the gate decides
  const fixture = SidecarFixture.create({
    prefix: 'sk-frrefusal-',
    env: { SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_MODEL: '', SKYNET_AUX_MODEL: '', SKYNET_REFLECT_MODEL: '', STARNET_REFLECT_MODEL: '', SKYNET_AUX_BUDGET: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1' }
  });
  await fixture.start();
  try {
    const frCalls = () => mock.state.calls.filter(c => c.failReview);

    // ---- ARM 1 — the upstream refused the request: one refused call, no resend, no failure review ----
    {
      const ev = await driveRun(fixture, 'fr-refused', REFUSE_MARK + ' inspect the station then push the registry update');
      const end = endOf(ev);
      A.eq(end && end.payload && end.payload.reason, 'error', 'the refused run ended with reason error');
      const errEv = ev.filter(e => e.name === 'agent.run.error').pop();
      A.ok(errEv && /openrouter http 403/.test(String(errEv.payload && errEv.payload.message)), 'the run error carries the adapter 403 sentence (' + JSON.stringify(errEv && errEv.payload) + ')');
      A.eq(errEv && errEv.payload && errEv.payload.transient, false, 'the 403 is reported as not transient');
      await settle(mock.state);
      A.eq(mock.state.calls.filter(c => c.main && c.status === 403).length, 1, 'the refused request was sent exactly once (never resent)');
      A.eq(frCalls().length, 0, 'NO failure-review request followed the provider refusal (got ' + frCalls().length + ')');
    }

    // ---- ARM 2 — control: a 400 on the request shape still earns its one failure review ----
    {
      const before = frCalls().length;
      const ev = await driveRun(fixture, 'fr-shape', SHAPE_MARK + ' inspect the station then push the registry update');
      const end = endOf(ev);
      A.eq(end && end.payload && end.payload.reason, 'error', 'the control run ended with reason error');
      await settle(mock.state);
      A.eq(frCalls().length - before, 1, 'the control failure (format_error) still fired exactly one failure review');
    }

    // ---- ARM 3 — control: a capability 404 (image input) is model_not_found on a request PART; its review still runs ----
    {
      const before = frCalls().length;
      const ev = await driveRun(fixture, 'fr-image', IMAGE_MARK + ' inspect the station then push the registry update');
      const end = endOf(ev);
      A.eq(end && end.payload && end.payload.reason, 'error', 'the image-input run ended with reason error');
      const errEv = ev.filter(e => e.name === 'agent.run.error').pop();
      A.ok(errEv && /openrouter http 404/.test(String(errEv.payload && errEv.payload.message)), 'the run error carries the adapter 404 sentence (' + JSON.stringify(errEv && errEv.payload) + ')');
      await settle(mock.state);
      A.eq(mock.state.calls.filter(c => c.main && c.status === 404).length, 1, 'the image-input request was sent exactly once');
      A.eq(frCalls().length - before, 1, 'the image-input 404 (model_not_found on a request part) still fired exactly one failure review (got ' + (frCalls().length - before) + ')');
    }
  } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }

  A.report('failreview-provider-refusal.e2e.test');
})().catch(e => { console.log('FAIL: failreview-provider-refusal.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
