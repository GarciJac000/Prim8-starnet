/* node test/e2e.run-stream-pool.test.js — EIGHT PAUSED RUNS, ONE PAGE, A BROWSER'S SIX CONNECTIONS (real sidecar, 2026-10-21).

   A browser opens at most six HTTP/1.1 connections to one host. POST /api/run used to answer with the run's own stream,
   held open through every approval pause, so five paused conversations plus the station's SSE bridge filled the pool and
   Approve/Deny, the next run and the NEEDS YOU feeds queued in the browser behind the runs waiting on them (reproduced
   live on an isolated station). Now a page holds ONE stream (GET /api/run/stream) and each run names it.

   This boots the actual sidecar (hermetic fixture, ASK mode, a scripted local model) and talks to it through an
   http.Agent capped at six sockets per host — the browser's pool, exactly. Pins the station half end to end: the stream's
   ready line, POST /api/run answered at once with a receipt, every run's lines on the one stream under its own key, eight
   runs paused on approvals while only the SSE bridge + the stream hold sockets, Approve/Deny / a ninth run / a feed read
   answered at once, a withdrawn run cancelled, the stream closing cancelling the run still on it (and its record saying
   what it waited on), a refused stream id, and the per-run response path unchanged for a body that names no stream. The
   control proves the cap bites: the same sidecar through the same pool with per-run responses starves the Deny. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { sseQuery } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CREW = ['crew1', 'crew2', 'crew3', 'crew4', 'crew5', 'crew6', 'crew7', 'crew8', 'crew9', 'crew10', 'crew11', 'crew12'];

function startMockProvider() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        const messages = parsed.messages || [];
        const toolNames = (parsed.tools || []).map(t => t && t.function && t.function.name);
        const lastUser = messages.map(m => m.role).lastIndexOf('user');
        const words = String(userWords(messages[lastUser] || {}) || '').trim();   // the Commander's own words (host notes stripped)
        const used = messages.slice(lastUser + 1).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const call = (name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: name + '_' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
        };
        const say = text => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
        };
        const m = /^write brief (\S+)$/.exec(words);
        if (m && toolNames.indexOf('fs_write') >= 0) {
          if (toolNames.indexOf('brief_proceed') >= 0 && used.indexOf('brief_proceed') < 0) call('brief_proceed', { objective: 'Write brief ' + m[1], deliverable: 'brief-' + m[1] + '.md' });
          else if (used.indexOf('fs_write') < 0) call('fs_write', { path: 'brief-' + m[1] + '.md', content: '# Brief ' + m[1] + '\n' });
          else say('finished ' + m[1]);
        } else say('Done.');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// ---- http through ONE agent capped at six sockets per host: the browser's per-host pool ----
function request(pool, B, method, path, opts) {
  const o = opts || {};
  const u = new URL(B + path);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: pool, headers: o.headers || {} }, res => resolve({ req, res }));
    req.on('error', reject);
    if (o.body != null) req.write(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    req.end();
  });
}
async function json(pool, B, method, path, H, body) {
  const t0 = Date.now();
  const { res } = await request(pool, B, method, path, { headers: H, body });
  let text = '';
  for await (const c of res) text += c;
  let j = null; try { j = JSON.parse(text); } catch (_) { j = { raw: text }; }
  return { status: res.statusCode, type: String(res.headers['content-type'] || ''), j, ms: Date.now() - t0 };
}
// read an NDJSON (or SSE) response line by line into `lines`
function readLines(res, lines, sse) {
  let buf = '';
  res.setEncoding('utf8');
  res.on('data', c => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let s = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (sse) { if (!s.startsWith('data:')) continue; s = s.slice(5).trim(); }
      if (!s) continue;
      try { lines.push(Object.assign({ at: Date.now() }, JSON.parse(s))); } catch (_) {}
    }
  });
}
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out waiting for ' + label);
}
const socketsOf = (pool) => Object.values(pool.sockets).reduce((n, a) => n + a.length, 0);
const queuedOn = (pool) => Object.values(pool.requests).reduce((n, a) => n + a.length, 0);

(async () => {
  const mock = await startMockProvider();
  const fixture = SidecarFixture.create({ prefix: 'sk-run-stream-pool-', env: {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', STARNET_OPENROUTER_KEY: 'sk-or-v1-local-proof',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''   // ASK mode: every write waits on the Commander
  } });
  const pools = [];
  try {
    await fixture.start();
    const B = fixture.baseUrl, token = fixture.token;
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const roster = await fetch(B + '/api/roster', { method: 'POST', headers: H, body: JSON.stringify({ agents: CREW.map(id => ({ agentId: id, system: 'You write briefs.', name: id.toUpperCase(), model: 'test/model' })) }) });
    A.eq(roster.status, 200, 'the crew is on the roster');
    const runBody = (agentId, extra) => Object.assign({ key: 'sk-or-v1-local-proof', model: 'test/model', agentId, isTask: true, streamId: 'ws_' + agentId, placed: ['cabinet'],
      messages: [{ role: 'user', content: 'write brief ' + agentId }] }, extra || {});
    const rowOf = async (runId) => (((await (await fetch(B + '/api/runs?agent=*&runId=' + encodeURIComponent(runId), { headers: H })).json()).runs) || [])[0] || null;

    // ===================== THE FIX: one stream for every run =====================
    const pool = new http.Agent({ keepAlive: true, maxSockets: 6 });
    pools.push(pool);
    const sse = await request(pool, B, 'GET', '/api/channels/events?' + sseQuery(token), { headers: { 'X-StarNet-Token': token, Origin: B } });
    A.eq(sse.res.statusCode, 200, 'the station bus (SSE) holds its one connection, as a page\'s does');
    sse.res.resume();
    const st = await request(pool, B, 'GET', '/api/run/stream', { headers: { 'X-StarNet-Token': token, Origin: B } });
    A.eq(st.res.statusCode, 200, 'GET /api/run/stream opens');
    A.ok(/ndjson/.test(String(st.res.headers['content-type'])), 'it is an NDJSON stream');
    const lines = [];
    readLines(st.res, lines);
    const ready = await until(() => lines.find(l => l.stream === 'ready'), 5000, 'the ready line');
    A.ok(typeof ready.id === 'string' && ready.id.length >= 8, 'the first line names the stream');
    const streamId = ready.id;

    // eight runs, each naming the stream with its own key: every POST is answered at once with a receipt
    const runs = [];
    for (let i = 0; i < 8; i++) {
      const key = 'key' + String(i).padStart(9, '0');
      const r = await json(pool, B, 'POST', '/api/run', H, runBody(CREW[i], { stream: { id: streamId, key } }));
      A.eq(r.status, 200, CREW[i] + ': POST /api/run is answered');
      A.ok(/json/.test(r.type) && r.j && r.j.ok === true && r.j.stream === streamId && typeof r.j.runId === 'string', CREW[i] + ': …with a receipt naming its run and the stream, not the run\'s own stream');
      runs.push({ agentId: CREW[i], key, runId: r.j.runId });
    }
    const promptOf = (run) => lines.find(l => l.k === run.key && l.name === 'permission.prompt');
    await until(() => runs.every(promptOf), 20000, 'eight approvals on the one stream');
    A.ok(true, 'all EIGHT runs reached their approval (with per-run responses only five could start)');
    for (const run of runs) {
      const start = lines.find(l => l.k === run.key && l.name === 'agent.run.start');
      A.eq(start && start.payload && start.payload.runId, run.runId, run.agentId + ': its lines carry its own key and run');
      A.ok(/brief-crew\d+\.md/.test(String(promptOf(run).payload.argsSummary || '')) && String(promptOf(run).payload.argsSummary).indexOf(run.agentId) >= 0, run.agentId + ': its approval is its own');
    }
    A.eq(socketsOf(pool), 2, 'eight paused runs + the SSE bridge hold TWO sockets (per-run responses wanted nine of six)');
    A.eq(queuedOn(pool), 0, 'nothing queued behind them');

    // Deny, a ninth run, a feed read and the other seven answers all go straight through
    const deny = await json(pool, B, 'POST', '/api/consent', H, { runId: runs[7].runId, promptId: promptOf(runs[7]).payload.promptId, decision: 'deny' });
    A.ok(deny.status === 200 && deny.j.ok === true, 'Deny on the 8th paused run is applied');
    A.ok(deny.ms < 1000, 'Deny is answered within a second (' + deny.ms + ' ms)');
    const ninthKey = 'key' + String(8).padStart(9, '0');
    const ninth = await json(pool, B, 'POST', '/api/run', H, runBody(CREW[8], { stream: { id: streamId, key: ninthKey } }));
    A.ok(ninth.status === 200 && ninth.ms < 1000, 'a ninth run starts at once (' + ninth.ms + ' ms)');
    runs.push({ agentId: CREW[8], key: ninthKey, runId: ninth.j.runId });
    await until(() => promptOf(runs[8]), 10000, 'the ninth approval');
    const feed = await json(pool, B, 'GET', '/api/workshop/pending?agent=crew1', H);
    A.ok(feed.status === 200 && feed.ms < 1000, 'the NEEDS YOU builds feed loads (' + feed.status + ', ' + feed.ms + ' ms)');
    for (const run of runs.filter((_, i) => i !== 7)) {
      const ok = await json(pool, B, 'POST', '/api/consent', H, { runId: run.runId, promptId: promptOf(run).payload.promptId, decision: 'once' });
      A.ok(ok.status === 200 && ok.j.ok === true && ok.ms < 1000, run.agentId + ': Approve is applied within a second (' + ok.ms + ' ms)');
    }
    await until(() => runs.every(run => lines.some(l => l.k === run.key && l.end === true)), 20000, 'every run\'s end line');
    for (const run of runs) {
      const end = lines.find(l => l.k === run.key && l.name === 'agent.run.end' && l.payload && l.payload.runId === run.runId);
      A.eq(end && end.payload.reason, 'done', run.agentId + ': ran to its end on the stream');
      const endAt = lines.findIndex(l => l.k === run.key && l.end === true);
      A.ok(!lines.slice(endAt + 1).some(l => l.k === run.key), run.agentId + ': its end line is its last');
    }
    const denied = await rowOf(runs[7].runId);
    A.ok(denied && (denied.toolTrace || []).some(t => t.name === 'fs_write' && !t.ok), 'the denied run\'s write did not happen');
    const approved = await rowOf(runs[0].runId);
    A.ok(approved && (approved.toolTrace || []).some(t => t.name === 'fs_write' && t.ok), 'an approved run\'s write did');

    // a withdrawn run (its page's Stop) is cancelled; the others on the stream are untouched
    const wKey = 'withdrawn00a', keep = 'keepalive00b';
    const w = await json(pool, B, 'POST', '/api/run', H, runBody(CREW[9], { stream: { id: streamId, key: wKey } }));
    const k = await json(pool, B, 'POST', '/api/run', H, runBody(CREW[10], { stream: { id: streamId, key: keep } }));
    await until(() => lines.find(l => l.k === wKey && l.name === 'permission.prompt') && lines.find(l => l.k === keep && l.name === 'permission.prompt'), 10000, 'two more approvals');
    const wd = await json(pool, B, 'POST', '/api/run/stream/withdraw', H, { stream: streamId, key: wKey });
    A.ok(wd.status === 200 && wd.j.ok === true && wd.j.live === true, 'withdrawing a live run says so');
    const wRow = await until(async () => { const r = await rowOf(w.j.runId); return r && r.reason ? r : null; }, 10000, 'the withdrawn run\'s record');
    A.eq(wRow.reason, 'cancelled', 'the withdrawn run was stopped (the page-gone path its own response closing took)');
    A.ok(!lines.some(l => l.k === keep && l.name === 'agent.run.end'), 'the other run on the stream keeps waiting');
    // a withdrawal that beats its run: the run is refused before any work
    const early = await json(pool, B, 'POST', '/api/run/stream/withdraw', H, { stream: streamId, key: 'beatenbypost' });
    A.ok(early.j.ok === true && early.j.live === false, 'a withdrawal ahead of its run is remembered');
    const beaten = await json(pool, B, 'POST', '/api/run', H, runBody(CREW[11], { stream: { id: streamId, key: 'beatenbypost' } }));
    A.ok(beaten.status === 409 && beaten.j.code === 'run_withdrawn', 'the run arriving after its withdrawal is refused (409 run_withdrawn)');

    // a routine's Run now / Retry (detached) and a workshop shift — runs a BUTTON starts — ride the same stream
    const mk = await json(pool, B, 'POST', '/api/cron', H, { name: 'pool digest', prompt: 'summarize the pool', schedule: 'every 1h', agentId: CREW[11], model: 'test/model', provider: 'openrouter' });
    A.eq(mk.status, 200, 'a routine is created');
    const jobId = mk.j && mk.j.job && mk.j.job.id;
    const rKey = 'routine000aa';
    const rn = await json(pool, B, 'POST', '/api/cron/run', H, { id: jobId, detach: true, stream: { id: streamId, key: rKey } });
    A.ok(rn.status === 200 && /json/.test(rn.type) && rn.j.ok === true && rn.j.stream === streamId && typeof rn.j.runId === 'string', 'Run now is answered at once with a receipt (' + rn.status + ')');
    await until(() => lines.some(l => l.k === rKey && l.end === true), 15000, 'the routine run\'s end line');
    const rEnd = lines.find(l => l.k === rKey && l.name === 'agent.run.end');
    A.ok(rEnd && rEnd.payload && rEnd.payload.runId === rn.j.runId, 'the routine\'s run lines arrive on the page\'s stream under its key');
    const sKey = 'workshop00aa';
    const sh = await json(pool, B, 'POST', '/api/workshop/shift', H, { agentId: CREW[11], stream: { id: streamId, key: sKey } });
    A.ok(sh.status === 200 && sh.j.ok === true && sh.j.stream === streamId, 'a workshop shift is answered at once with a receipt');
    await until(() => lines.some(l => l.k === sKey && l.end === true), 15000, 'the shift\'s end line');
    const sRes = lines.filter(l => l.k === sKey && !l.end).pop();
    A.ok(sRes && sRes.name === 'workshop.shift.result' && sRes.payload && typeof sRes.payload.fired === 'boolean', 'its last line is its workshop.shift.result (' + (sRes && sRes.payload && sRes.payload.reason) + ')');
    A.eq(socketsOf(pool), 2, 'still two sockets: the SSE bridge + the one stream');

    // the stream closing (a reload, a closed tab) cancels the run still on it, and its record says what it waited on
    st.req.destroy();
    const kRow = await until(async () => { const r = await rowOf(k.j.runId); return r && r.reason ? r : null; }, 10000, 'the run left on the closed stream');
    A.eq(kRow.reason, 'cancelled', 'closing the page\'s stream stops the run on it, as closing its own response did');
    A.ok(kRow.pageClosed && (kRow.pageClosed.waitingOn || []).some(s => /approval/.test(s)), 'and its record says the page left while it waited on an approval');
    const gone = await json(pool, B, 'POST', '/api/run', H, runBody(CREW[11], { stream: { id: streamId, key: 'afterclose00' } }));
    A.ok(gone.status === 409 && gone.j.code === 'run_stream_gone', 'a run naming a stream the station no longer holds is refused (409 run_stream_gone)');
    A.ok(!(await rowOf('afterclose00')), 'and nothing ran');

    // a body that names no stream: the response IS the run's stream, as always
    const legacyLines = [];
    const legacy = await request(pool, B, 'POST', '/api/run', { headers: H, body: runBody(CREW[11]) });
    A.ok(/ndjson/.test(String(legacy.res.headers['content-type'])), 'without a stream the run answers with its own NDJSON stream');
    readLines(legacy.res, legacyLines);
    const lp = await until(() => legacyLines.find(l => l.name === 'permission.prompt'), 10000, 'the per-run response\'s approval');
    const lRun = legacyLines.find(l => l.name === 'agent.run.start').payload.runId;
    await json(pool, B, 'POST', '/api/consent', H, { runId: lRun, promptId: lp.payload.promptId, decision: 'once' });
    await until(() => legacyLines.some(l => l.name === 'agent.run.end' && l.payload && l.payload.runId === lRun), 10000, 'the per-run response\'s end');
    A.ok(!legacyLines.some(l => 'k' in l), 'its lines carry no stream key');
    sse.req.destroy();

    // ===================== THE CONTROL: per-run responses through the same six sockets =====================
    const pool2 = new http.Agent({ keepAlive: true, maxSockets: 6 });
    pools.push(pool2);
    const sse2 = await request(pool2, B, 'GET', '/api/channels/events?' + sseQuery(token), { headers: { 'X-StarNet-Token': token, Origin: B } });
    sse2.res.resume();
    const per = [];
    for (let i = 0; i < 5; i++) {
      const l = [];
      const r = await request(pool2, B, 'POST', '/api/run', { headers: H, body: runBody(CREW[i]) });
      readLines(r.res, l);
      per.push({ req: r.req, lines: l });
    }
    await until(() => per.every(p => p.lines.some(l => l.name === 'permission.prompt')), 15000, 'five per-run approvals');
    A.eq(socketsOf(pool2), 6, 'control: the SSE bridge + five paused per-run responses fill all six sockets');
    const p0 = per[0].lines.find(l => l.name === 'permission.prompt');
    const r0 = per[0].lines.find(l => l.name === 'agent.run.start').payload.runId;
    let answered = false;
    const stuck = json(pool2, B, 'POST', '/api/consent', H, { runId: r0, promptId: p0.payload.promptId, decision: 'deny' }).then(r => { answered = true; return r; });
    await sleep(1500);
    A.eq(answered, false, 'control: the Deny is still queued behind the runs it should answer after 1.5 s');
    A.eq(queuedOn(pool2), 1, 'control: …queued inside the client\'s pool, never sent');
    for (const p of per.slice(1)) p.req.destroy();   // four of the pages "leave": sockets free up
    const late = await stuck;
    A.ok(answered && late.status === 200, 'control: it went out only once a run\'s connection closed');
    per[0].req.destroy();
    sse2.req.destroy();
  } catch (e) {
    A.ok(false, 'e2e.run-stream-pool threw: ' + ((e && e.stack) || e));
  } finally {
    for (const p of pools) { try { p.destroy(); } catch (_) {} }
    try { await fixture.stop(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.run-stream-pool');
})();
