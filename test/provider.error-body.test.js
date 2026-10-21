/* node test/provider.error-body.test.js — every adapter keeps the provider's parsed error body on the error it
   throws (err.body), so errorClass decides on the CODE, not on prose (Hermes audit Step 2, 2026-09-22).

   Audit finding (29bb21d80): anthropic.js, openai-compatible.js, openrouter.js and gemini.js built
   `new Error('<p> http N - ' + detail)` from error.message alone; codex.js was fixed in Step 1. Pinned per adapter:
     · err.body is the parsed JSON body, and a code-bearing error classifies by its code (OpenAI/OpenRouter
       `insufficient_quota` behind a generic message = billing; Anthropic `overloaded_error`; Gemini
       `RESOURCE_EXHAUSTED` mid-stream = a rate limit, not an empty wallet);
     · the REPORTED message stays the adapter's own sentence (label + "http N") — the UI routes on it
       (friendlyerror.js /(grok|kimi).*http 40[13]/ -> the RECONNECT door) — the body rides along for its code;
     · existing verdicts hold (Anthropic 529 overloaded, "prompt is too long" overflow, a plain 429 rate limit).
   Injected fetch only — no network. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeGeminiProvider } = require('../sidecar/providers/gemini.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const REQ = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 };
function jsonFetch(status, body, calls) {
  return async (url, init) => {
    if (!init || !init.body) return new Response('{"data":[],"models":[]}', { status: 200 });
    calls.push(status);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
const sseFetch = lines => async (url, init) => {
  if (!init || !init.body) return new Response('{"data":[],"models":[]}', { status: 200 });
  return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
async function thrown(p, req) {
  try { for await (const _ of p.stream(req || REQ)) { /* drain */ } }
  catch (e) { return e; }
  return null;
}
const line = o => 'data: ' + JSON.stringify(o);
// Every adapter that reads an HTTP error body, built over one fetch double (catalog GETs answered empty). They all read
// the body through provider.runtime.readErrorBody (2026-10-20): anthropic/codex/gemini/openrouter used to call
// res.json() then res.text(), which threw on every non-JSON body and read it with no idle guard and no Stop.
const CATALOG = '{"data":[],"models":[]}';
const ADAPTERS = [
  ['openai-compatible', (fetch) => makeOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', fetch })],
  ['anthropic', (fetch) => makeAnthropicProvider({ key: 'k', fetch })],
  ['codex', (fetch) => makeCodexProvider({ token: 't', fetch })],
  ['gemini', (fetch) => makeGeminiProvider({ key: 'k', fetch })],
  ['openrouter', (fetch) => makeOpenRouterProvider({ key: 'k', fetch })]
];

(async () => {
  // ---- OpenAI-compatible: the body rides; a generic message with code insufficient_quota is billing ----
  {
    const calls = [];
    const body = { error: { message: 'Request failed', type: 'insufficient_quota', code: 'insufficient_quota' } };
    const err = await thrown(makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1', fetch: jsonFetch(429, body, calls) }));
    A.eq(err && err.body, body, 'openai-compatible: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'm' });
    A.eq(cls.reason, 'billing', 'openai-compatible: insufficient_quota on a 429 is an empty wallet, not a rate limit');
    A.eq(cls.retryable, false, 'openai-compatible: …and is not retried');
    A.eq(calls.length, 1, 'openai-compatible: one request, no retry ladder');
    A.ok(/^openai-compatible http 429 - /.test(cls.message), 'openai-compatible: the reported message keeps the adapter\'s own sentence');

    // a device-OAuth provider's dead token must still read as "<Name> http 401" — the RECONNECT door keys on it
    const kimi = await thrown(makeOpenAICompatibleProvider({ label: 'Kimi For Coding', key: 'tok', baseUrl: 'https://api.kimi.com/coding/v1',
      fetch: jsonFetch(401, { error: { message: 'The access token is invalid', type: 'invalid_authentication_error' } }, []) }));
    const kcls = classifyApiError(kimi, { model: 'kimi-for-coding' });
    A.eq(kcls.reason, 'auth', 'kimi 401: auth');
    A.ok(/(grok|kimi).*http 40[13]/.test(kcls.message.toLowerCase()), 'kimi 401: the message the UI routes on is intact (' + kcls.message + ')');
    A.ok(kimi.body && kimi.body.error.type === 'invalid_authentication_error', 'kimi 401: the body rides alongside');

    // a mid-stream error frame carries its body too
    const mid = await thrown(makeOpenAICompatibleProvider({ key: 'k', baseUrl: 'https://compat.test/v1',
      fetch: sseFetch([line({ error: { message: 'This model\'s maximum context length is 8192 tokens', code: 'context_length_exceeded' } })]) }));
    A.eq(mid && mid.body && mid.body.error.code, 'context_length_exceeded', 'openai-compatible: a stream error frame keeps its body');
    A.eq(classifyApiError(mid, { model: 'm' }).reason, 'context_overflow', 'openai-compatible: …and classifies by its code');
  }

  // Error headers do not end a response: a partial error body must still time out or cancel. A stalled body keeps
  // the HTTP status already received (review providers-tools-07): it is that status, never a no-bytes stall.
  {
    const priorIdle = process.env.SKYNET_PROVIDER_IDLE_MS;
    process.env.SKYNET_PROVIDER_IDLE_MS = '180';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      for (const [name, make] of ADAPTERS) for (const partial of [false, true]) {
        for (const cancel of [false, true]) {
          let controller, cancelled = 0, calls = 0;
          const response = new Response(new ReadableStream({
            start(c) { controller = c; if (partial) c.enqueue(new TextEncoder().encode('{"error":')); },
            cancel() { cancelled++; }
          }), { status: 400 });
          const ac = new AbortController();
          const p = make(async (_url, init) => { if (!init || !init.body) return new Response(CATALOG); calls++; return response; });
          const pending = thrown(p, Object.assign({}, REQ, { signal: ac.signal }));
          // Wait for the actual error-body reader, so cancellation is strictly after response headers.
          while (!response.body.locked) await sleep(1);
          if (cancel) ac.abort();
          const observed = await Promise.race([pending.then(error => ({ settled: true, error })), sleep(700).then(() => ({ settled: false }))]);
          if (!observed.settled) { controller.close(); await pending; }
          const label = name + ' error ' + (partial ? 'partial body' : 'headers only') + (cancel ? ' cancel' : ' idle');
          A.eq(observed.settled, true, label + ': settles before fixture cleanup');
          A.eq(cancelled, 1, label + ': cancels the response body');
          A.eq(calls, 1, label + ': no adapter retry');
          A.eq(response.body.locked, false, label + ': releases its reader');
          if (cancel) A.eq(observed.error, null, label + ': caller cancellation returns cleanly');
          else {
            A.eq(observed.error && observed.error.status, 400, label + ': the received HTTP status survives the stalled body');
            A.ok(observed.error && observed.error.code !== 'PROVIDER_STREAM_TIMEOUT', label + ': it is not reported as a no-bytes stall');
            A.ok(observed.error && /http 400/.test(observed.error.message) && /error body did not finish/.test(observed.error.message), label + ': the message says the status and that the body stalled');
            A.eq(classifyApiError(observed.error, { model: 'm' }).retryable, false, label + ': a 400 routes as a 400, not a retryable timeout');
          }
        }
      }
      // Total duration may exceed the idle ceiling while bytes keep arriving. Split a UTF-8 codepoint.
      const body = { error: { message: 'café refused Bearer fixture-token-value with a long diagnostic message', type: 'fixture_error', code: 'fixture_refusal' } };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const accent = bytes.indexOf(0xc3);
      const cuts = [0, accent + 1, accent + 2, accent + 20, accent + 40, bytes.length];
      let part = 0, cancelled = 0;
      const response = new Response(new ReadableStream({
        async pull(c) {
          if (part === cuts.length - 1) { c.close(); return; }
          await sleep(60);
          c.enqueue(bytes.slice(cuts[part], cuts[++part]));
        }, cancel() { cancelled++; }
      }), { status: 422, headers: { 'x-request-id': 'error-progress-99' } });
      const started = Date.now();
      const err = await thrown(makeOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', fetch: async (_url, init) => (!init || !init.body) ? new Response('{"data":[]}') : response }));
      A.ok(Date.now() - started > 180, 'progressing error body outlives a single idle window');
      A.eq(err && err.status, 422, 'progressing body keeps the real HTTP status');
      A.eq(err && err.body, body, 'stream decoding preserves structured error and split UTF-8');
      A.ok(err && err.message.includes('request error-progress-99') && err.message.includes('type fixture_error') && err.message.includes('code fixture_refusal'), 'correlation and structured diagnostics survive');
      A.ok(err && err.message.includes('café') && !err.message.includes('fixture-token-value'), 'readable UTF-8 and message redaction survive');
      A.eq(cancelled, 0, 'progressing error body is not cancelled');
      A.eq(response.body.locked, false, 'completed error body releases its reader');
    } finally {
      if (priorIdle === undefined) delete process.env.SKYNET_PROVIDER_IDLE_MS;
      else process.env.SKYNET_PROVIDER_IDLE_MS = priorIdle;
    }
  }

  // A proxy streaming a huge error page is read only up to a cap, then cancelled: 500 characters are kept anyway.
  for (const [name, make] of [['openai-compatible', (fetch) => makeOpenAICompatibleProvider({ baseUrl: 'https://proxy.test/v1', fetch })]].concat(ADAPTERS.slice(1))) {
    let sent = 0, cancelled = 0;
    const chunk = new TextEncoder().encode('<html>' + 'x'.repeat(8192));
    const response = new Response(new ReadableStream({
      pull(c) { sent += chunk.byteLength; c.enqueue(chunk); if (sent > 8 * 1024 * 1024) c.close(); },
      cancel() { cancelled++; }
    }), { status: 502 });
    const err = await thrown(make(async (_url, init) => (!init || !init.body) ? new Response(CATALOG) : response));
    A.eq(err && err.status, 502, name + ': a huge error page keeps its status');
    A.eq(cancelled, 1, name + ': a huge error page is cancelled at the cap');
    A.ok(sent < 1024 * 1024, name + ': and is never read whole (read ' + sent + ' bytes)');
    A.eq(response.body.locked, false, name + ': the capped body releases its reader');
  }

  // A proxy's non-JSON error page. A non-JSON body never rides as err.body (errorClass reads only a provider's
  // structured error). anthropic/codex/gemini/openrouter keep the status text, as before the shared reader: a proxy's
  // prose is not a provider's error. openai-compatible quoted the page text before that reader and still does, so
  // its quote stays redacted and on one line.
  const SEP = { anthropic: '-', codex: '—', gemini: '-', openrouter: '—' };
  for (const [name, make] of ADAPTERS) {
    const html = '<html><body><h1>502</h1>upstream connect error or disconnect/reset before headers. reset reason: overflow\n' +
      'echo: Authorization: Bearer fixture-tok-123456 key sk-fixture-abcdefgh123</body></html>';
    const err = await thrown(make(async (_url, init) => (!init || !init.body) ? new Response(CATALOG)
      : new Response(html, { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } })));
    A.eq(err && err.status, 502, name + ' HTML 502: the status survives');
    A.ok(err && err.message.startsWith(name + ' http 502 '), name + ' HTML 502: the adapter\'s own sentence leads (' + (err && err.message.slice(0, 40)) + ')');
    if (SEP[name]) A.eq(err && err.message, name + ' http 502 ' + SEP[name] + ' Bad Gateway', name + ' HTML 502: the page text stays out of the message');
    A.ok(err && !/fixture-tok-123456|sk-fixture-abcdefgh123/.test(err.message), name + ' HTML 502: tokens and keys in the page are redacted');
    A.ok(err && !/[\r\n]/.test(err.message), name + ' HTML 502: control characters are collapsed');
    A.eq(err && err.body, undefined, name + ' HTML 502: a non-JSON body never rides as a structured error');
  }

  // ROUTING (review p4-wire): a gateway's text/plain 503 says "connection reset" / "Connection refused", and a WAF's
  // 403 page says "flagged by security policy". The browser's error copy (friendlyerror.js loaded WITHOUT require, the
  // path real users get) reads transport and policy words BEFORE the status, so with that prose in the message a 503
  // the gateway answered read "The connection dropped before the reply finished", and the 403 read as a content block
  // (also in errorClass, which moves retry/fallback/rotate). The four adapters keep the status text instead.
  {
    const BrowserFriendly = (() => {
      const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8'), ctx);
      return ctx.Friendly;
    })();
    A.eq(typeof BrowserFriendly.friendlyError, 'function', 'browser-mode friendlyerror loads');
    const pages = [
      ['envoy reset 503', 503, 'Service Unavailable', 'upstream connect error or disconnect/reset before headers. reset reason: connection reset'],
      ['envoy refused 503', 503, 'Service Unavailable', 'upstream connect error or disconnect/reset before headers. reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused'],
      ['waf 403', 403, 'Forbidden', '<html><body>Request flagged by security policy</body></html>']
    ];
    for (const [name, make] of ADAPTERS.slice(1)) for (const [label, status, statusText, text] of pages) {
      const err = await thrown(make(async (_url, init) => (!init || !init.body) ? new Response(CATALOG)
        : new Response(text, { status, statusText, headers: { 'Content-Type': text[0] === '<' ? 'text/html' : 'text/plain' } })));
      const tag = name + ' ' + label;
      A.eq(err && err.message, name + ' http ' + status + ' ' + SEP[name] + ' ' + statusText, tag + ': the message is the status sentence');
      const kind = BrowserFriendly.friendlyError(err && err.message).kind;
      const reason = classifyApiError(err, { model: 'm' }).reason;
      if (status === 503) A.eq(kind, 'provider_server_error', tag + ': the browser tells it as a provider fault, never a dropped connection (got ' + kind + ')');
      else {
        A.ok(kind !== 'content_policy_blocked', tag + ': the browser never calls it a content block (got ' + kind + ')');
        A.eq(reason, 'auth', tag + ': errorClass reads the 403, not the page\'s policy words (got ' + reason + ')');
      }
    }
  }

  // Cleanup failure must be observable without replacing the original result or exposing its error text.
  {
    const failopen = require('../sidecar/failopen.js');
    const tag = 'providers.openai_compatible.error_reader_release';
    const initialCount = failopen.counts()[tag] || 0;
    const priorIdle = process.env.SKYNET_PROVIDER_IDLE_MS;
    const priorWarn = console.warn;
    const warnings = [];
    const cleanupSecret = 'https://fixture-user:fixture-pass@fixture.invalid/?token=fixture-url-secret body=fixture-body-secret';
    process.env.SKYNET_PROVIDER_IDLE_MS = '40';
    try {
      for (const mode of ['complete', 'idle', 'cancel', 'cancel-logger-throws']) {
        const response = new Response(mode === 'complete' ? '{"error":{"message":"original refusal","code":"fixture_refusal"}}' : new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('{"error":')); }
        }), { status: 422 });
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = () => {
          const reader = getReader();
          return { read: () => reader.read(), cancel: () => reader.cancel(),
            releaseLock() { reader.releaseLock(); throw new Error(cleanupSecret); } };
        };
        console.warn = (...args) => {
          if (mode === 'cancel-logger-throws') throw new Error('fixture logger unavailable');
          warnings.push(args.map(String).join(' '));
        };
        const ac = new AbortController();
        const p = makeOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1',
          fetch: async (_url, init) => (!init || !init.body) ? new Response('{"data":[]}') : response });
        const pending = thrown(p, Object.assign({}, REQ, { signal: ac.signal }));
        if (mode.startsWith('cancel')) {
          while (!response.body.locked) await new Promise(resolve => setTimeout(resolve, 1));
          ac.abort();
        }
        const err = await pending;
        if (mode.startsWith('cancel')) A.eq(err, null, mode + ': release failure cannot replace cancellation');
        else if (mode === 'idle') {
          A.eq(err && err.status, 422, 'release failure cannot replace the status of a stalled error body');
          A.ok(err && err.code !== 'PROVIDER_STREAM_TIMEOUT', 'a stalled error body is not a no-bytes stall');
        } else {
          A.eq(err && err.status, 422, 'release failure cannot replace HTTP status');
          A.eq(err && err.body && err.body.error.code, 'fixture_refusal', 'original structured error survives cleanup failure');
        }
        A.eq(response.body.locked, false, mode + ': reader release was attempted');
      }
      A.eq((failopen.counts()[tag] || 0) - initialCount, 4, 'every cleanup failure is counted, even when logging throws');
      A.eq(warnings.length, 3, 'cleanup failures emit throttled diagnostics');
      A.ok(warnings.every(w => w.includes(tag) && w.endsWith('error response reader release failed')), 'diagnostics carry the fixed cleanup tag and message');
      A.ok(warnings.every(w => !/fixture-user|fixture-pass|fixture-url-secret|fixture-body-secret|fixture.invalid/.test(w)), 'cleanup exception URL, credentials and response text never reach diagnostics');
    } finally {
      console.warn = priorWarn;
      if (priorIdle === undefined) delete process.env.SKYNET_PROVIDER_IDLE_MS;
      else process.env.SKYNET_PROVIDER_IDLE_MS = priorIdle;
    }
  }

  // ---- OpenRouter: code only in the body (the message is generic) ----
  {
    const calls = [];
    const body = { error: { message: 'Request failed', code: 'insufficient_quota' } };
    const err = await thrown(makeOpenRouterProvider({ key: 'k', fetch: jsonFetch(429, body, calls) }));
    A.eq(err && err.body, body, 'openrouter: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'm' });
    A.eq(cls.reason, 'billing', 'openrouter: the code decides (the message alone read as a plain rate limit)');
    A.ok(/^openrouter http 429 — /.test(cls.message), 'openrouter: the reported message keeps the adapter\'s own sentence');
    const plain = await thrown(makeOpenRouterProvider({ key: 'k', fetch: jsonFetch(429, { error: { message: 'Rate limit exceeded: free-models-per-min', code: 429 } }, []) }));
    A.eq(classifyApiError(plain, { model: 'm' }).reason, 'rate_limit', 'openrouter: a plain 429 (numeric code) stays a rate limit');
  }

  // ---- Anthropic: the typed error rides; verdicts hold ----
  {
    const calls = [];
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    const err = await thrown(makeAnthropicProvider({ key: 'k', fetch: jsonFetch(529, body, calls) }));
    A.eq(err && err.body, body, 'anthropic: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'claude-test' });
    A.eq(cls.reason, 'overloaded', 'anthropic: 529 overloaded_error is overloaded');
    A.eq(cls.retryable, true, 'anthropic: …and retryable');
    A.ok(/^anthropic http 529 - Overloaded/.test(cls.message), 'anthropic: the reported message keeps the adapter\'s own sentence');

    const tooLong = await thrown(makeAnthropicProvider({ key: 'k', fetch: jsonFetch(400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 215000 tokens > 200000 maximum' } }, []) }));
    A.eq(classifyApiError(tooLong, { model: 'claude-test' }).reason, 'context_overflow', 'anthropic: "prompt is too long" still folds history (no regression)');

    // mid-stream: Anthropic can send an error EVENT after a 200; its type decides even when the prose is generic
    const mid = await thrown(makeAnthropicProvider({ key: 'k', fetch: sseFetch([
      line({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      line({ type: 'error', error: { type: 'overloaded_error', message: 'upstream hiccup' } })
    ]) }));
    A.eq(mid && mid.body && mid.body.error.type, 'overloaded_error', 'anthropic: a stream error event keeps its body');
    A.eq(classifyApiError(mid, { model: 'claude-test' }).reason, 'overloaded', 'anthropic: the typed error decides (the prose alone was "unknown")');
  }

  // ---- Gemini: RESOURCE_EXHAUSTED is a rate limit, mid-stream too ----
  {
    const calls = [];
    const body = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
    const err = await thrown(makeGeminiProvider({ key: 'k', fetch: jsonFetch(429, body, calls) }));
    A.eq(err && err.body, body, 'gemini: the parsed error body rides on the thrown error');
    const cls = classifyApiError(err, { model: 'gemini-test' });
    A.eq(cls.reason, 'rate_limit', 'gemini: an HTTP 429 RESOURCE_EXHAUSTED is a rate limit');
    A.ok(/^gemini http 429 - /.test(cls.message), 'gemini: the reported message keeps the adapter\'s own sentence');

    const mid = await thrown(makeGeminiProvider({ key: 'k', fetch: sseFetch([line(body)]) }));
    A.eq(mid && mid.body, body, 'gemini: a stream error frame keeps its body');
    const mcls = classifyApiError(mid, { model: 'gemini-test' });
    A.eq(mcls.reason, 'rate_limit', 'gemini: mid-stream RESOURCE_EXHAUSTED is a rate limit by its status code (the prose alone read "quota" -> billing)');
    A.eq(mcls.retryable, true, 'gemini: …and retryable');
    const daily = await thrown(makeGeminiProvider({ key: 'k', fetch: sseFetch([line({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'You have hit your daily quota for this model; quota resets in 20 hours.' } })]) }));
    A.eq(classifyApiError(daily, { model: 'gemini-test' }).reason, 'quota_exhausted', 'gemini: a spent DAILY allowance under the same status is quota_exhausted');
  }

  // ---- Codex (Step 1 already kept the body): the message keeps its sentence too; a failed stream keeps its code ----
  {
    const err = await thrown(makeCodexProvider({ token: 't', fetch: jsonFetch(429, { error: { message: 'Codex quota exceeded', code: 'usage_limit_reached' } }, []) }));
    const cls = classifyApiError(err, { model: 'gpt-5.5' });
    A.eq(cls.reason, 'quota_exhausted', 'codex: usage_limit_reached is a spent quota');
    A.ok(/^codex http 429 — Codex quota exceeded/.test(cls.message), 'codex: the reported message is the adapter\'s sentence, label + status intact');
    const failed = await thrown(makeCodexProvider({ token: 't', fetch: sseFetch([line({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'The usage limit has been reached' } } })]) }));
    A.eq(classifyApiError(failed, { model: 'gpt-5.5' }).reason, 'quota_exhausted', 'codex: a response.failed carrying usage_limit_reached is a spent quota');
  }

  A.report('provider.error-body.test');
})().catch(e => { console.log('FAIL: provider.error-body.test threw -- ' + (e && e.stack || e)); process.exit(1); });
