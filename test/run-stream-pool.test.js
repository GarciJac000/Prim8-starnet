'use strict';
/* run-stream-pool.test.js — EIGHT PAUSED RUNS MUST NOT STARVE THE PAGE (2026-10-21).

   A browser opens at most six HTTP/1.1 connections to one host (Chromium, WebView2, WebKit). Each run used to hold one
   for its whole life (POST /api/run answered with the run's own stream), so five conversations paused on approvals plus
   the station's SSE bridge filled the pool: proven live on an isolated station, the 6th-8th runs never started, and
   Approve/Deny (POST /api/consent), a new run and the NEEDS YOU feeds sat queued in the browser for 15 s+ while the paused
   runs waited on them.

   This runs the REAL page half (harness.js runStream + chat(), executed whole) against the REAL station half
   (sidecar/run-streams.js), with a fetch that keeps a browser's per-host pool: six connections, a request queued until
   one frees, a streamed response holding its connection until it ends. Pins: eight paused runs + the SSE bridge hold TWO
   connections; every run's lines reach its own chat(); consent, a ninth run and a feed read are answered at once; Stop
   withdraws the run (and a Stop that beats the POST sends no run at all); a lost stream fails every run on it the way a
   lost response did; the idle stream closes; a station without the route, a stream held back before its first line, or
   one that closed under the POST, still runs the turn on its own response; and a run a BUTTON starts (Harness.streamPost:
   Run now / Retry / an app refresh / a workshop build) rides the same stream. The control (chat() without runStream, as
   before the fix) starves exactly as seen live — so this test has teeth. */
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { webcrypto } = require('node:crypto');
const { makeRunStreams } = require('../sidecar/run-streams.js');

const enc = new TextEncoder();
const tick = () => new Promise(r => setImmediate(r));
async function until(cond, rounds = 400) { for (let i = 0; i < rounds && !cond(); i++) await tick(); return !!cond(); }
function abortError() { return new DOMException('The operation was aborted.', 'AbortError'); }

/* ---- the station + the browser's connection pool ---- */
function makeStation(opts) {
  const o = opts || {};
  const POOL = o.pool || 6;
  let seq = 0, runSeq = 0;
  const rs = makeRunStreams({ uuid: () => 'stream-' + (++seq), keepAliveMs: 1e9, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  const st = { rs, active: 0, peak: 0, queue: [], log: [], runs: new Map(), withdraws: [], consents: [], streamGets: 0, streams: [] };

  // ---- the pool: a request waits for one of POOL connections; its response frees it when its body is done ----
  function acquire(signal) {
    if (st.active < POOL) { st.active++; st.peak = Math.max(st.peak, st.active); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      st.queue.push(w);
      if (signal) signal.addEventListener('abort', () => { const i = st.queue.indexOf(w); if (i >= 0) { st.queue.splice(i, 1); reject(abortError()); } }, { once: true });
    });
  }
  function release() { const next = st.queue.shift(); if (next) next.resolve(); else st.active--; }
  function oneShot() { let done = false; return () => { if (!done) { done = true; release(); } }; }

  function json(status, obj) {
    const text = JSON.stringify(obj);
    const r = { ok: status >= 200 && status < 300, status, headers: { get: k => /content-type/i.test(k) ? 'application/json' : null }, body: {},
      json: async () => JSON.parse(text), text: async () => text };
    r.clone = () => Object.assign({}, r);
    return r;
  }
  // a streamed body: holds its connection until it closes, errors or is aborted by the page
  function streamed(signal, onAbort) {
    const free = oneShot();
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; }, cancel() { free(); if (onAbort) onAbort(); } });
    const s = {
      body, free,
      push(text) { try { ctrl.enqueue(enc.encode(text)); } catch (_) {} },
      close() { try { ctrl.close(); } catch (_) {} free(); },
      error(e) { try { ctrl.error(e); } catch (_) {} free(); }
    };
    if (signal) signal.addEventListener('abort', () => { s.error(abortError()); if (onAbort) onAbort(); }, { once: true });
    return s;
  }
  function startRun(agentId, write, finish) {
    const runId = 'run-' + (++runSeq), promptId = 'p-' + runSeq;
    const run = { runId, promptId, agentId, gone: false, answered: null, write, finish };
    st.runs.set(runId, run);
    setImmediate(() => {
      if (run.gone) return;
      write('agent.run.start', { runId, agentId, model: 'test/model' });
      write('agent.token', { runId, agentId, delta: 'reply from ' + agentId });
      write('permission.prompt', { promptId, agentId, tool: 'fs.write', scope: 'write', argsSummary: 'brief-' + agentId + '.md' });
    });
    return run;
  }
  function endRun(run) {
    if (run.gone) return;
    run.write('agent.run.end', { runId: run.runId, agentId: run.agentId, reason: 'done' });
    run.finish();
  }

  st.fetch = async function (url, init) {
    init = init || {};
    const method = String(init.method || 'GET').toUpperCase();
    st.log.push({ phase: 'asked', method, url });
    await acquire(init.signal);
    if (init.signal && init.signal.aborted) { release(); throw abortError(); }
    st.log.push({ phase: 'sent', method, url });
    if (url === '/api/channels/events') return { ok: true, status: 200, body: streamed(init.signal).body, headers: { get: () => 'text/event-stream' } };
    if (url === '/api/run/stream') {
      st.streamGets++;
      if (o.noStreamRoute) { release(); return json(404, { error: 'not found' }); }
      const res = new EventEmitter();
      res.writableEnded = false; res.destroyed = false;
      const s = streamed(init.signal, () => { res.destroyed = true; res.emit('close'); });
      res.write = (c) => { s.push(String(c)); return true; };
      st.streams.push({ res, s });
      if (o.holdReady) { st.held = (st.held || 0) + 1; return { ok: true, status: 200, body: s.body, headers: { get: () => 'application/x-ndjson' } }; }   // a buffering proxy: nothing arrives
      st.rs.open(res);
      return { ok: true, status: 200, body: s.body, headers: { get: () => 'application/x-ndjson' } };
    }
    if (url === '/api/run' && method === 'POST') {
      const body = JSON.parse(init.body);
      st.log.push({ phase: 'run', agentId: body.agentId, viaStream: !!body.stream });
      if (typeof st.beforeRun === 'function') st.beforeRun(body);
      if (body.stream) {
        const sink = st.rs.attach(body.stream.id, body.stream.key);
        if (!sink) { release(); return json(409, st.rs.has(body.stream.id) ? { error: 'withdrawn', code: 'run_withdrawn' } : { error: 'gone', code: 'run_stream_gone' }); }
        const run = startRun(body.agentId, (n, p) => sink.write(n, p), () => sink.end());
        sink.onGone(() => { run.gone = true; });
        release();
        if (st.loseAnswer) { st.loseAnswer = false; throw new TypeError('network error'); }   // the station took it; its answer never arrived
        return json(200, { ok: true, runId: run.runId, stream: sink.streamId });
      }
      let run;   // the run's own response, as before the fix
      const s = streamed(init.signal, () => { if (run) run.gone = true; });
      run = startRun(body.agentId, (n, p) => s.push(JSON.stringify({ name: n, payload: p }) + '\n'), () => s.close());
      return { ok: true, status: 200, body: s.body, headers: { get: () => 'application/x-ndjson' } };
    }
    if (url === '/api/run/stream/withdraw') { const b = JSON.parse(init.body); st.withdraws.push(b); const r = st.rs.withdraw(b.stream, b.key); release(); return json(200, r); }
    if (url === '/api/consent') {
      const b = JSON.parse(init.body);
      const run = st.runs.get(b.runId);
      st.consents.push(b);
      const ok = !!(run && !run.gone && run.promptId === b.promptId && !run.answered);
      if (ok) { run.answered = b.decision; setImmediate(() => endRun(run)); }
      release();
      return json(200, { ok, decision: b.decision });
    }
    if (url === '/api/workshop/pending') { release(); return json(200, { pending: [] }); }
    if (url === '/api/cron/run') {   // a routine's Run now / Retry: refused, or a run whose lines end with its outcome
      const body = JSON.parse(init.body);
      st.log.push({ phase: 'routine', viaStream: !!body.stream });
      if (body.id === 'busy') { release(); return json(409, { error: 'this routine is already running — wait for it to finish' }); }
      const lines = [['agent.run.start', { runId: 'routine-run', agentId: 'crew1' }], ['agent.token', { runId: 'routine-run', delta: 'digest' }], ['agent.run.end', { runId: 'routine-run', reason: 'done' }]];
      if (body.stream) {
        const sink = st.rs.attach(body.stream.id, body.stream.key);
        if (!sink) { release(); return json(409, { code: 'run_stream_gone' }); }
        st.routineFinish = () => { for (const [n, p] of lines) sink.write(n, p); sink.end(); };
        release();
        return json(200, { ok: true, runId: 'routine-run', stream: sink.streamId });
      }
      const s = streamed(init.signal);
      st.routineFinish = () => { for (const [n, p] of lines) s.push(JSON.stringify({ name: n, payload: p }) + '\n'); s.close(); };
      return { ok: true, status: 200, body: s.body, headers: { get: () => 'application/x-ndjson' } };
    }
    release();
    return json(404, { error: 'not found' });
  };
  st.sent = (u) => st.log.filter(x => x.phase === 'sent' && x.url === u).length;
  st.asked = (u) => st.log.filter(x => x.phase === 'asked' && x.url === u).length;
  return st;
}

/* ---- the page half, executed whole from harness.js ---- */
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
function slice(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  A.ok(a >= 0 && b > a, 'harness.js still has ' + JSON.stringify(from.trim().slice(0, 40)));
  return src.slice(a, b);
}
function page(st, opts) {
  const o = opts || {};
  const timers = [];
  const scope = {
    TextDecoder, TextEncoder, ReadableStream, AbortController, DOMException, console, crypto: webcrypto,
    setTimeout: (fn, ms) => { const t = { fn, ms, dead: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.dead = true; },
    DESKTOP: false, DEVMODE: true,
    getModel: () => 'test/model', getProv: () => 'openrouter', getKey: () => '', getReasoningEffort: () => '', getBaseUrl: () => '',
    providerNeedsKey: () => false, fetch: st.fetch,
    U: { bus: { emit() {} } }, totals: { calls: 0, tokens: 0, cost: 0 }, runModels: {}, internalRuns: new Set(),
    registerRun() {}, foldContextCost() {}
  };
  let code = slice(SOURCE, '  function sidecarErrorDetail(', '  /* Run an agent turn/task through the LOCAL SIDECAR')
    .replace(/  \/\* ONE STREAM FOR EVERY RUN THIS PAGE WATCHES[\s\S]*$/, '');
  if (!o.legacy) code += slice(SOURCE, '  const runStream = (() => {', '  /* Run an agent turn/task through the LOCAL SIDECAR');
  code += slice(SOURCE, '  async function chat(', '  /* Read-only fetch of an agent');
  const api = vm.runInNewContext(code + '\n;({ chat, runStream: typeof runStream !== "undefined" ? runStream : null, streamPost: typeof streamPost !== "undefined" ? streamPost : null })', scope);
  // run the page's timers of one length (or all): the idle close (the stream outlives its last run) and the ready wait
  api.runTimers = (ms) => { for (const t of timers.filter(x => ms == null || x.ms === ms)) { timers.splice(timers.indexOf(t), 1); if (!t.dead) t.fn(); } };
  api.idle = () => api.runTimers(4000);
  api.timers = timers;
  return api;
}
// one conversation: a chat() whose permission.prompt is recorded (the page shows the card), holding its result/error
function converse(pg, agentId, signal) {
  const c = { agentId, prompt: null, result: null, error: null, settled: false };
  c.promise = pg.chat({ messages: [{ role: 'user', content: 'write the brief' }], agentId, signal, onPermission: p => { c.prompt = p; }, onRunId: id => { c.runId = id; } })
    .then(r => { c.result = r; }, e => { c.error = e; }).finally(() => { c.settled = true; });
  return c;
}
async function answer(st, c, decision) {
  const r = await st.fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: c.runId, promptId: c.prompt.promptId, decision }) });
  return r.json();
}

(async () => {
  // ================= THE FIX: eight paused conversations hold ONE stream =================
  {
    const st = makeStation();
    const pg = page(st);
    st.fetch('/api/channels/events', {});   // the station's SSE bridge: always one connection
    const convs = [];
    for (let i = 1; i <= 8; i++) convs.push(converse(pg, 'crew' + i));
    A.ok(await until(() => convs.every(c => c.prompt)), 'all EIGHT runs reached their approval (before the fix only five did)');
    A.eq(st.streamGets, 1, 'the page opened ONE run stream for all eight runs');
    A.eq(st.sent('/api/run'), 8, 'all eight POST /api/run left the page');
    A.eq(st.active, 2, 'eight paused runs + the SSE bridge hold TWO connections (was nine wanted, six allowed)');
    A.eq(st.queue.length, 0, 'nothing is queued behind them');
    A.eq(pg.runStream.state().runs, 8, 'the stream carries the eight runs');
    A.ok(convs.every(c => c.prompt && c.prompt.argsSummary === 'brief-' + c.agentId + '.md'), 'each conversation got ITS OWN approval (lines routed by key)');

    // Approve / Deny, a NEW run and a NEEDS YOU feed read are all answered at once
    const deny = await answer(st, convs[7], 'deny');
    A.ok(deny.ok, 'Deny on the 8th paused run is answered');
    const ninth = converse(pg, 'crew9');
    A.ok(await until(() => ninth.prompt), 'a ninth run still starts and reaches its approval');
    const feed = await (await st.fetch('/api/workshop/pending', {})).json();
    A.ok(Array.isArray(feed.pending), 'the NEEDS YOU builds feed still loads');
    for (const c of convs.slice(0, 7)) A.ok((await answer(st, c, 'once')).ok, 'Approve on ' + c.agentId + ' is answered');
    A.ok((await answer(st, ninth, 'once')).ok, 'Approve on the ninth run is answered');
    A.ok(await until(() => convs.every(c => c.settled) && ninth.settled), 'every run finished once answered');
    for (const c of convs.concat([ninth])) {
      A.ok(!c.error, c.agentId + ' finished without an error' + (c.error ? ': ' + c.error.message : ''));
      A.eq(c.result && c.result.text, 'reply from ' + c.agentId, c.agentId + ' read its own reply, never another run\'s');
      A.eq(c.result && c.result.endReason, 'done', c.agentId + ' saw its own end');
    }
    // eight POSTs sent at once may briefly fill the pool, but each is answered at once and frees its connection: nothing
    // stays queued, and what is held afterwards is the SSE bridge + the one stream
    A.eq(st.queue.length, 0, 'the burst of POSTs drained');
    A.eq(st.active, 2, 'after the burst: the SSE bridge + the run stream');

    // the idle stream closes: an idle page holds no extra connection, and the station forgets it
    A.eq(pg.runStream.state().runs, 0, 'no run left on the stream');
    A.eq(st.active, 2, 'the stream outlives its last run briefly (back-to-back runs reuse it)');
    pg.idle();
    await until(() => st.active === 1);
    A.eq(st.active, 1, 'after the idle wait only the SSE bridge holds a connection');
    A.eq(st.rs.size(), 0, 'the station closed its side of the stream');
    A.eq(pg.runStream.state().open, false, 'the page holds no run stream while idle');

    // the next run opens a fresh stream
    const again = converse(pg, 'crew10');
    A.ok(await until(() => again.prompt), 'a run after the idle close opens a new stream and starts');
    A.eq(st.streamGets, 2, 'one new stream for it');
    await answer(st, again, 'once');
    A.ok(await until(() => again.settled) && again.result && again.result.endReason === 'done', 'and finishes on it');
  }

  // ================= THE CONTROL: without the shared stream, the pool starves (what was seen live) =================
  {
    const st = makeStation();
    const pg = page(st, { legacy: true });
    st.fetch('/api/channels/events', {});
    const convs = [];
    for (let i = 1; i <= 8; i++) convs.push(converse(pg, 'crew' + i));
    await until(() => convs.filter(c => c.prompt).length >= 5);
    for (let i = 0; i < 50; i++) await tick();
    A.eq(convs.filter(c => c.prompt).length, 5, 'control: only five runs reach their approval');
    A.eq(st.sent('/api/run'), 5, 'control: the 6th-8th POST /api/run never leave the page');
    A.eq(st.active, 6, 'control: the SSE bridge + five run streams fill the six connections');
    let answered = false;
    st.fetch('/api/consent', { method: 'POST', body: JSON.stringify({ runId: convs[0].runId, promptId: convs[0].prompt.promptId, decision: 'deny' }) }).then(() => { answered = true; });
    for (let i = 0; i < 50; i++) await tick();
    A.eq(answered, false, 'control: Deny is queued behind the paused runs it should answer');
    A.eq(st.sent('/api/consent'), 0, 'control: the consent request never left the page');
    // unwedge the control so the process can end: the paused runs end, the queue drains
    for (const c of convs.filter(x => x.prompt)) { const r = st.runs.get(c.runId); if (r) setImmediate(() => { r.write('agent.run.end', { runId: r.runId, reason: 'done' }); r.finish(); }); }
    await until(() => answered);
    A.ok(answered, 'control: the Deny only went out once a run ended on its own');
  }

  // ================= Stop: the run is withdrawn (its fetch abort, before) =================
  {
    const st = makeStation();
    const pg = page(st);
    const ac = new AbortController();
    const c = converse(pg, 'crew1', ac.signal);
    const other = converse(pg, 'crew2');
    A.ok(await until(() => c.prompt && other.prompt), 'two runs paused');
    ac.abort();
    A.ok(await until(() => c.settled), 'the stopped chat() settles');
    A.ok(c.error && c.error.name === 'AbortError', 'a Stop rejects with the AbortError, as an aborted fetch did');
    A.ok(c.error && !c.error.starnetTransport, 'a Stop is never marked as a transport loss');
    A.ok(await until(() => st.withdraws.length === 1), 'the page withdrew the stopped run on the station');
    const run = [...st.runs.values()].find(r => r.agentId === 'crew1');
    A.ok(run && run.gone, 'the station let the stopped run go (the page-gone path its own response closing took)');
    A.ok(!other.settled, 'the other run on the stream is untouched');
    await answer(st, other, 'once');
    A.ok(await until(() => other.settled) && other.result && other.result.text === 'reply from crew2', 'the other run finishes normally');
  }

  // ================= a Stop that beats the station: no run is sent at all =================
  {
    const st = makeStation();
    const pg = page(st);
    const ac = new AbortController();
    const c = converse(pg, 'crew1', ac.signal);
    ac.abort();
    A.ok(await until(() => c.settled), 'a run stopped while connecting settles');
    A.ok(c.error && /cannot reach the STARNET sidecar/.test(c.error.message) && !c.error.starnetTransport, 'it keeps the old Stop-while-connecting words, unmarked');
    for (let i = 0; i < 20; i++) await tick();
    A.eq(st.sent('/api/run'), 0, 'no POST /api/run left the page');
  }

  // ================= the POST reached the station but its answer was lost: the run is withdrawn, never left unwatched =================
  {
    const st = makeStation();
    const pg = page(st);
    st.loseAnswer = true;
    const c = converse(pg, 'crew1');
    A.ok(await until(() => c.settled), 'the run whose answer was lost settles');
    A.ok(c.error && c.error.starnetTransport === 'fetch' && /cannot reach the STARNET sidecar/.test(c.error.message), 'as the old lost POST: cannot reach the sidecar, a transport loss');
    A.ok(await until(() => st.withdraws.length === 1), 'the page withdrew it');
    const run = [...st.runs.values()].find(r => r.agentId === 'crew1');
    A.ok(run && run.gone, 'the station let it go (the lost connection used to stop it)');
  }

  // ================= the stream is lost mid-run: every run on it reads as its own stream breaking =================
  {
    const st = makeStation();
    const pg = page(st);
    const a = converse(pg, 'crew1'), b = converse(pg, 'crew2');
    A.ok(await until(() => a.prompt && b.prompt), 'two runs paused');
    const boom = new TypeError('network error');
    st.streams[0].s.error(boom);
    A.ok(await until(() => a.settled && b.settled), 'both runs settle');
    for (const c of [a, b]) {
      A.ok(c.error && c.error.starnetTransport === 'read', c.agentId + ': a lost stream is a transport loss at the read site');
      A.eq(c.error && c.error.message, 'network error', c.agentId + ': the browser\'s own error is kept');
    }
    A.eq(pg.runStream.state().open, false, 'the dead stream is forgotten');
    const next = converse(pg, 'crew3');
    A.ok(await until(() => next.prompt), 'the next run opens a fresh stream');
  }

  // ================= the stream ends cleanly mid-run: a reply cut short, as an ended response was =================
  {
    const st = makeStation();
    const pg = page(st);
    const a = converse(pg, 'crew1');
    A.ok(await until(() => a.prompt), 'a run paused');
    st.streams[0].s.close();
    A.ok(await until(() => a.settled), 'it settles');
    A.ok(a.error && a.error.starnetTransport === 'eof' && /disconnected before completion/.test(a.error.message), 'an ended stream without the run\'s end is the old "reply stream disconnected"');
  }

  // ================= a station without the route: the run streams on its own response =================
  {
    const st = makeStation({ noStreamRoute: true });
    const pg = page(st);
    const a = converse(pg, 'crew1');
    A.ok(await until(() => a.prompt), 'without the route the run still starts');
    A.eq(st.log.filter(x => x.phase === 'run' && x.viaStream).length, 0, 'it went without a stream');
    await answer(st, a, 'once');
    A.ok(await until(() => a.settled) && a.result && a.result.endReason === 'done', 'and finishes on its own response');
    const b = converse(pg, 'crew2');
    A.ok(await until(() => b.prompt), 'a later run starts');
    A.eq(st.streamGets, 1, 'the page does not ask for the missing route again');
    await answer(st, b, 'once');
    await until(() => b.settled);
  }

  // ================= runs a BUTTON starts (Run now / Retry / an app refresh / a workshop build) ride the same stream =================
  {
    const st = makeStation();
    const pg = page(st);
    st.fetch('/api/channels/events', {});
    const convs = [];
    for (let i = 1; i <= 5; i++) convs.push(converse(pg, 'crew' + i));
    A.ok(await until(() => convs.every(c => c.prompt)), 'five conversations paused');
    const seen = [];
    const r = await pg.streamPost('/api/cron/run', { id: 'job1', detach: true }, { onEvent: (n) => seen.push(n) });
    A.ok(r.ok && r.status === 200 && r.j.stream, 'Run now is answered at once with its receipt');
    A.eq(st.log.filter(x => x.phase === 'routine' && x.viaStream).length, 1, 'it named the page\'s stream');
    A.eq(st.active, 2, 'five paused conversations + a routine + the SSE bridge still hold two connections');
    st.routineFinish();
    const last = await r.done;
    A.eq(last && last.name, 'agent.run.end', 'done resolves with the routine\'s last line');
    A.eq(seen.join(','), 'agent.run.start,agent.token,agent.run.end', 'onEvent saw every line, in order');
    const refused = await pg.streamPost('/api/cron/run', { id: 'busy', detach: true });
    A.ok(!refused.ok && refused.status === 409 && /already running/.test(refused.j.error || ''), 'a refused Run now resolves ok:false with the station\'s own words');
    A.eq(await refused.done, null, 'and has nothing to wait on');
    for (const c of convs) await answer(st, c, 'once');
    A.ok(await until(() => convs.every(c => c.settled && c.result)), 'the conversations finish');
  }
  {
    const st = makeStation({ noStreamRoute: true });
    const pg = page(st);
    const r = await pg.streamPost('/api/cron/run', { id: 'job1', detach: true });
    A.ok(r.ok, 'without the stream route Run now still starts');
    A.eq(st.log.filter(x => x.phase === 'routine' && x.viaStream).length, 0, '…on its own response');
    st.routineFinish();
    const last = await r.done;
    A.eq(last && last.name, 'agent.run.end', 'and its lines are read from that response');
  }
  {
    const pg = page({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const r = await pg.streamPost('/api/cron/run', { id: 'job1' });
    A.ok(!r.ok && r.status === 0 && /could not be reached/.test(r.j.error || ''), 'an unreachable station resolves ok:false, status 0 (never throws)');
    let rejected = false;
    try { await r.done; } catch (_) { rejected = true; }
    A.ok(rejected, 'its done rejects');
  }

  // ================= a stream held back before its first line (a buffering proxy) never holds a run =================
  {
    const st = makeStation({ holdReady: true });
    const pg = page(st);
    const a = converse(pg, 'crew1');
    for (let i = 0; i < 20; i++) await tick();
    A.eq(st.sent('/api/run'), 0, 'held back: the run waits for the stream\'s first line…');
    pg.runTimers(10000);   // …but not for ever
    A.ok(await until(() => a.prompt), '…then it starts on its own response');
    A.eq(st.log.filter(x => x.phase === 'run' && x.viaStream).length, 0, 'it never named the held-back stream');
    A.eq(pg.runStream.state().heldBack, true, 'the page remembers the stream was held back');
    const b = converse(pg, 'crew2');
    A.ok(await until(() => b.prompt), 'the next run goes straight to its own response');
    A.eq(st.held, 1, 'without asking for a stream again');
    await answer(st, a, 'once'); await answer(st, b, 'once');
    A.ok(await until(() => a.settled && b.settled) && a.result && b.result, 'both finish');
  }

  // ================= the stream closed under the POST (a station restart): sent once more on its own response =================
  {
    const st = makeStation();
    const pg = page(st);
    const warm = converse(pg, 'crew1');
    A.ok(await until(() => warm.prompt), 'a run on the stream');
    st.beforeRun = () => { st.beforeRun = null; st.streams[0].res.emit('close'); };   // the station forgets the page's stream
    const b = converse(pg, 'crew2');
    A.ok(await until(() => b.prompt || b.settled), 'the run refused for a gone stream still starts');
    A.ok(!b.error, 'no error reaches the conversation' + (b.error ? ': ' + b.error.message : ''));
    A.ok(st.log.some(x => x.phase === 'run' && x.agentId === 'crew2' && x.viaStream), 'the station refused it on the gone stream first');
    A.ok(st.log.some(x => x.phase === 'run' && x.agentId === 'crew2' && !x.viaStream), 'then it was sent once more on its own response');
    await answer(st, b, 'once');
    A.ok(await until(() => b.settled) && b.result && b.result.endReason === 'done', 'and it finishes');
    st.streams[0].s.error(new TypeError('network error'));   // the restart's other half: the page's stream breaks too
    A.ok(await until(() => warm.settled) && warm.error && warm.error.starnetTransport === 'read', 'the run that was on it reads a lost connection');
  }

  A.report('run-stream-pool');
})().catch(e => { console.error(e); process.exit(1); });
