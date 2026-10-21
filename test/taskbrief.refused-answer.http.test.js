/* node test/taskbrief.refused-answer.http.test.js — ANSWER HOLD through the REAL run path (runOnceCore).

   The bug: a run ends with a durable question ("Include the budget figures? || yes | no"); the Commander
   answers "yes"; the run carrying that answer fails BEFORE the model says anything (here: the provider
   answers HTTP 400 on turn 0 — the same shape as an expired sign-in or a tool-less model refusal). prepare()
   had already stamped the answer and flipped the brief to 'ready', so the re-sent "yes" was no longer an
   answer: classify.js calls "yes" chat, the 'clarifying' promotion no longer fired, and the retry ran as
   tool-less small talk with no Task Brief — the original task was gone.

   Boots the actual sidecar against an isolated workspace with a mock OpenRouter, drives three real /api/run
   calls on one stream, and asserts on the request body the model receives for the retry and on the durable
   brief. Zero network beyond localhost; no real key; no model spend. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const ORIGINAL = 'Write notes.txt about the launch';
const MARKER = 'TASK_QUESTION: Include the budget figures? || yes | no';
// post-run learning passes also reach the mock; they are answered NONE and never counted as the main run
const AUX = /reflecting right after finishing a task|reviewing a task run of yours that FAILED|intake analyst|recipe author|station's recruiter|recurring, specific work topics/;

function startMock() {
  const state = { mode: 'ask', main: [] };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
        { id: 'test/notools', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: [] }
      ] }));
      return;
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      const text = t => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      };
      if (AUX.test(body)) return text('NONE');
      state.main.push({ mode: state.mode, body });
      if (state.mode === 'ask') return text(MARKER);
      if (state.mode === 'fail') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: provider rejected the request before any output', code: 400 } }));
        return;
      }
      text('Done: notes.txt is written.');
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

async function run(fixture, isTask, messages, streamId, model) {
  const r = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-or-v1-refused-answer-fake', model: model || 'test/model', agentId: 'agent', streamId: streamId || 's1', isTask, messages })
  });
  const text = await r.text();   // the SSE stream, drained to the run's end
  const ends = text.split('\n').filter(l => l.indexOf('agent.run.end') >= 0);
  return { status: r.status, text, ends };
}
const briefs = ws => { try { return JSON.parse(fs.readFileSync(path.join(ws, 'task-briefs.json'), 'utf8')); } catch (_) { return null; } };
const briefsOf = (ws, key) => { const raw = briefs(ws); const rows = raw && (raw['task-briefs'] || raw).briefs; return Array.isArray(rows) ? rows.filter(b => b.key === key) : []; };

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({
    prefix: 'starnet-refused-answer-', timeoutMs: 30000,
    env: { SKYNET_OPENROUTER_BASE: mock.base, SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0' }
  });
  try {
    await fixture.start();

    // RUN 1 — the task asks its one material question and ends waiting on the Commander.
    const asked = [{ role: 'user', content: ORIGINAL }];
    const r1 = await run(fixture, true, asked);
    A.eq(r1.status, 200, 'run 1 streams');
    let rows = briefsOf(fixture.workspace, 'stream:s1');
    A.eq(rows.length, 1, 'run 1 minted one brief for the conversation');
    A.eq(rows[0] && rows[0].status, 'clarifying', 'run 1 left the brief waiting on its question');
    const briefId = rows[0] && rows[0].id;

    // RUN 2 — the Commander answers "yes" (classify.js: chat, isTask false); the provider fails before output.
    const answer = asked.concat([{ role: 'assistant', content: MARKER }, { role: 'user', content: 'yes' }]);
    mock.state.mode = 'fail';
    const r2 = await run(fixture, false, answer);
    A.ok(mock.state.main.some(m => m.mode === 'fail'), 'run 2 really reached the model and was refused there');
    A.ok(r2.ends.some(l => /"reason":"error"/.test(l)), 'run 2 ended in an error before any output');
    rows = briefsOf(fixture.workspace, 'stream:s1');
    A.eq(rows.length, 1, 'the failed answer run minted no new brief');
    A.eq(rows[0] && rows[0].status, 'clarifying', 'the failed answer run handed the question BACK (brief clarifying again)');
    A.eq(rows[0] && rows[0].questions && rows[0].questions[0] && rows[0].questions[0].answer, '', 'the unread answer is not recorded as a decision');

    // RUN 3 — the Commander re-sends "yes". It must resume the ORIGINAL task with its tools and brief.
    mock.state.mode = 'ok';
    const before = mock.state.main.length;
    const r3 = await run(fixture, false, answer);
    A.eq(r3.status, 200, 'run 3 streams');
    const sent = mock.state.main.slice(before).find(m => m.mode === 'ok');
    A.ok(sent, 'run 3 reached the model');
    let req = {}; try { req = JSON.parse(sent.body); } catch (_) {}
    A.ok(Array.isArray(req.tools) && req.tools.length > 0, 'the retry is TASK work: the model is offered its tools (got ' + (Array.isArray(req.tools) ? req.tools.length : 'none') + ')');
    A.ok(sent.body.indexOf('ORIGINAL REQUEST: ' + ORIGINAL) >= 0, 'the retry carries the task brief with the ORIGINAL request, not the one-word answer');
    A.ok(sent.body.indexOf('DECISION: Include the budget figures? => yes') >= 0, 'and the decision the Commander made');
    rows = briefsOf(fixture.workspace, 'stream:s1');
    A.eq(rows.length, 1, 'still exactly one brief on the conversation');
    A.eq(rows[0] && rows[0].id, briefId, 'the SAME brief carried the task through');
    A.eq(rows[0] && rows[0].originalDirective, ORIGINAL, 'its original directive survived');
    A.eq(rows[0] && rows[0].questions[0].answer, 'yes', 'the answer is recorded once the model actually read it');

    // B — the HOST refuses the answering run before the model is ever called (an early `return` in runOnceCore:
    // the picked model cannot call tools). Same promise: the question comes back, the retry resumes the task.
    mock.state.mode = 'ask';
    await run(fixture, true, asked, 's2');
    A.eq((briefsOf(fixture.workspace, 'stream:s2')[0] || {}).status, 'clarifying', 'B: run 1 left the s2 brief waiting');
    mock.state.mode = 'ok';
    const calls = mock.state.main.length;
    const rb2 = await run(fixture, false, answer, 's2', 'test/notools');
    A.eq(mock.state.main.length, calls, 'B: the tool-less refusal never reached the model');
    A.ok(/does not support tool calls/.test(rb2.text), 'B: run 2 was refused by the host (tool-less model)');
    rows = briefsOf(fixture.workspace, 'stream:s2');
    A.eq(rows.length, 1, 'B: no new brief minted');
    A.eq(rows[0] && rows[0].status, 'clarifying', 'B: the refused answer run handed the question back');
    const rb3 = await run(fixture, false, answer, 's2');
    const sentB = mock.state.main.slice(calls).find(m => m.mode === 'ok');
    A.ok(rb3.status === 200 && sentB && sentB.body.indexOf('ORIGINAL REQUEST: ' + ORIGINAL) >= 0, 'B: the retry on a tool-capable model resumes the ORIGINAL task');
    A.eq((briefsOf(fixture.workspace, 'stream:s2')[0] || {}).questions[0].answer, 'yes', 'B: and records the answer');
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('taskbrief.refused-answer.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
