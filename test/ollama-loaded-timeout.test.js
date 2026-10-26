/* node test/ollama-loaded-timeout.test.js — #99 follow-up: a native Ollama turn that hits the connect ceiling while the
   model sat LOADED the whole wait is not re-sent.

   Ollama's /api/chat sends no headers until its first token, and the OLLAMA card gives it 300 s (registry
   connectTimeoutMs). That ceiling classified as a retryable `timeout`: the adapter re-sent twice, then the loop's ladder
   kept going (a connect-phase timeout is deliberately not an idle stall). Every re-send aborts Ollama mid-request and
   sends the same prompt again, so a CPU-spilled model that needs more than 300 s to answer a ~27k-token task prompt
   could never finish, and COMMS showed retry lines instead of where the model sat.

   Locked here (real adapter inside the real loop, mock Ollama whose /api/chat never answers):
     · /api/ps listed the model at every read of the attempt, and no other StarNet call is open on that Ollama:
       ONE /api/chat send, the run ends `error` with failureCode local_timeout, not transient, and the message keeps
       the placement sentence (ollama-native.js placementNote)
     · the model was NOT listed (a load that may have hung): today's ladder, unchanged (several sends, `timeout`)
     · listed at the timeout but missing at an earlier read of the same attempt (the load ate the wait): that attempt
       is re-sent once; the next one, loaded throughout, ends the turn
     · another StarNet call still open on that Ollama (this turn may have been queued behind it): re-sent as before
     · /api/ps unreadable at the timeout: nothing proven, re-sent as before
     · errorClass: the adapter's flag is its own non-retryable reason; an unflagged connect timeout stays `timeout` */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const errorClass = require('../sidecar/providers/errorClass.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOW = () => new Response(JSON.stringify({ model_info: { 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools'] }), { status: 200 });
// The reporter's card: qwen3 8B at a 32k window, 45% of it in VRAM.
const LOADED = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 10e9, size_vram: 4.5e9, context_length: 32768 }] };
const EMPTY = { models: [] };

/* A mock Ollama whose /api/chat never answers (headers withheld until aborted). `ps(s)` decides each /api/ps answer
   (null = HTTP 500, unreadable); `chatsFor(text)` counts the sends whose last user message is `text`. */
function mockOllama(ps) {
  const s = { psReads: 0, sends: [], aborts: 0, onSend: null };
  s.chatsFor = text => s.sends.filter(t => t === text).length;
  s.fetch = async (url, init) => {
    if (url.endsWith('/api/show')) return SHOW();
    if (url.endsWith('/api/ps')) {
      s.psReads++;
      const body = ps(s);
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{"error":"busy"}', { status: 500 });
    }
    if (url.endsWith('/api/chat')) {
      const msgs = JSON.parse(init.body).messages || [];
      s.sends.push(String((msgs[msgs.length - 1] || {}).content || ''));
      if (s.onSend) s.onSend(s);
      return new Promise((_, reject) => {
        const fail = () => { s.aborts++; reject(init.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (init.signal.aborted) fail();   // like fetch: a signal already aborted (the stop below fires inside a send) rejects at once
        else init.signal.addEventListener('abort', fail, { once: true });
      });
    }
    return new Response('{"data":[]}', { status: 200 });
  };
  return s;
}

// One loop run on the real adapter; returns the run result plus the agent.run.error payloads it emitted.
async function runTurn(provider, text, signal) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const dropped = [];
  const emit = makeEmitter(bus, e => dropped.push(e));
  const res = await runAgentLoop({
    provider, emit, model: 'qwen3:8b', agentId: 'a', runId: 'r-' + text, random: () => 0.5, signal,
    messages: [{ role: 'user', content: text }],
    cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) })
  });
  return { res, errors: seq.filter(e => e.name === 'agent.run.error').map(e => e.payload), dropped };
}

let port = 11700;
const adapter = (s, extra) => makeOpenAICompatibleProvider(Object.assign(
  { fetch: s.fetch, baseUrl: 'http://127.0.0.1:' + (port++) + '/v1', nativeOllama: true, connectTimeoutMs: 90, waitNoteMs: 10 }, extra || {}));

(async () => {
  // ---- 1. loaded at every read, nothing else open: one send, then the truth ----
  {
    const s = mockOllama(() => LOADED);
    const { res, errors, dropped } = await runTurn(adapter(s), 'task');
    A.eq(s.chatsFor('task'), 1, 'a connect timeout on a model loaded the whole wait is sent once, never re-sent');
    A.eq(res.reason, 'error', 'the run ends in error at once');
    A.eq(res.failureCode, 'local_timeout', 'with its own failure code, not the retryable `timeout`');
    A.eq(errors.length, 1, 'one agent.run.error');
    const msg = (errors[0] && errors[0].message) || '';
    A.ok(/timed out/.test(msg), 'the message still says it timed out: ' + msg);
    A.ok(/Ollama on this computer had qwen3:8b loaded only 45% on the GPU, the rest on the CPU at a 32k window but sent no response to/.test(msg),
      'and carries the placement sentence: ' + msg);
    A.eq(errors[0] && errors[0].transient, false, 'and is not marked transient');
    A.eq(dropped.length, 0, 'every event passed the contract');
  }

  // ---- 1b. no wait probe (waitNoteMs 0): the read at the timeout decides alone ----
  {
    const s = mockOllama(() => LOADED);
    const { res } = await runTurn(adapter(s, { waitNoteMs: 0 }), 'task');
    A.eq([s.chatsFor('task'), res.failureCode], [1, 'local_timeout'], 'without the probe a loaded model at the timeout still ends the turn');
  }

  // ---- 2. not listed as loaded: today's ladder, unchanged ----
  {
    const s = mockOllama(() => EMPTY);
    const { res, errors } = await runTurn(adapter(s), 'task');
    A.ok(s.chatsFor('task') > 1, 'a model /api/ps does not list is re-sent as before (sends: ' + s.chatsFor('task') + ')');
    A.eq(res.failureCode, 'timeout', 'and ends as the retryable timeout it was');
    A.ok(/not listed as loaded/.test((errors[0] && errors[0].message) || ''), 'saying the model was not listed');
  }

  // ---- 3. missing at an earlier read of the attempt, listed at its timeout: the load ate the wait, so once more ----
  {
    let loaded = false;
    const s = mockOllama(st => { if (!loaded && st.aborts > 0) loaded = true; return loaded ? LOADED : EMPTY; });
    const { res } = await runTurn(adapter(s), 'task');
    A.eq(s.chatsFor('task'), 2, 'the attempt that saw the load finish is re-sent once; the next, loaded throughout, is not');
    A.eq(res.failureCode, 'local_timeout', 'and that second timeout ends the turn');
  }

  // ---- 4. another StarNet call still open on that Ollama: this turn may have queued behind it, so re-sent ----
  // (a re-send is proven by the second send; the rest of the ladder is case 2's, so the run is stopped there)
  const stopAtSecond = s => { const ac = new AbortController(); s.onSend = st => { if (st.chatsFor('task') >= 2) ac.abort(); }; return ac.signal; };
  {
    const s = mockOllama(() => LOADED);
    const turn = adapter(s);
    const bg = makeOpenAICompatibleProvider({ fetch: s.fetch, baseUrl: 'http://127.0.0.1:' + (port - 1) + '/v1', nativeOllama: true });
    const ac = new AbortController();
    const bgRun = (async () => { try { for await (const e of bg.stream({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'quest' }], signal: ac.signal })) void e; } catch (_) {} })();
    await sleep(20);
    const { res } = await runTurn(turn, 'task', stopAtSecond(s));
    A.eq(s.chatsFor('task'), 2, 'a turn with another StarNet call open on that Ollama is re-sent as before');
    A.eq(res.reason, 'cancelled', 'and was still on the ladder when stopped');
    ac.abort();
    await bgRun;
  }

  // ---- 5. /api/ps unreadable at the timeout: nothing proven, re-sent as before ----
  {
    const s = mockOllama(st => (st.aborts > 0 ? null : LOADED));
    const { res } = await runTurn(adapter(s), 'task', stopAtSecond(s));
    A.eq(s.chatsFor('task'), 2, 'an unreadable status at the timeout keeps the ladder');
    A.eq(res.reason, 'cancelled', 'and was still on it when stopped');
  }

  // ---- 6. errorClass: the adapter's flag is its own reason ----
  {
    const flagged = Object.assign(new Error('provider stream connect timed out after 300000ms with no bytes received'), { code: 'PROVIDER_STREAM_TIMEOUT', timeout: true, phase: 'connect', localModelTimeout: true });
    const v = errorClass.classifyApiError(flagged, { model: 'qwen3:8b' });
    A.eq([v.reason, v.retryable, v.shouldFallback], ['local_timeout', false, false], 'a flagged connect timeout is local_timeout: not retried, no fallback');
    const plain = Object.assign(new Error('provider stream connect timed out after 300000ms with no bytes received'), { code: 'PROVIDER_STREAM_TIMEOUT', timeout: true, phase: 'connect' });
    A.eq([errorClass.classifyApiError(plain, {}).reason, errorClass.classifyApiError(plain, {}).retryable], ['timeout', true], 'an unflagged connect timeout is still the retryable timeout');
  }

  A.report('ollama-loaded-timeout.test');
})();
