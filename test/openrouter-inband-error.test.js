/* node test/openrouter-inband-error.test.js — an OpenRouter error keeps WHO answered and WHY (sweep/providers 2026-10-20).

   OpenRouter opens its stream with HTTP 200 (": OPENROUTER PROCESSING" keep-alives) before the upstream answers, so
   an upstream failure after that arrives IN-BAND: `data: {"error":{"code":429,"message":"Provider returned error",
   "metadata":{"raw":"…"}}}`. The adapter threw `new Error(error.message)` marked ownMessage — so the numeric code was
   never read as a status and metadata.raw (the upstream's actual words) was dropped. Live on the sweep rig: an in-band
   401 "User not found." classified `unknown`, was retried 7 times over ~106 s, and the Commander read "Something went
   wrong on that turn — try again." The pre-stream path dropped metadata.raw the same way ("openrouter http 403 —
   Provider returned error"), hiding e.g. an upstream region refusal.

   Pinned: an in-band numeric code becomes the error's status and the adapter's own "openrouter http <code>" sentence
   (what classifyApiError and the browser's friendlyerror both route on); metadata.raw rides in the message on both
   paths, bounded; a string code ("server_error") keeps today's behaviour. Injected fetch only — no network. */
'use strict';
const A = require('./_assert.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const sseFetch = (chunks, calls) => async (url, init) => {
  if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
  calls.push('sse');
  return new Response(chunks.map(c => 'data: ' + JSON.stringify(c)).join('\n\n') + '\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
const jsonFetch = (status, body, calls) => async (url, init) => {
  if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
  calls.push(status);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
async function thrown(p, req) {
  try { for await (const _ of p.stream(req)) { /* drain */ } } catch (e) { return e; }
  return null;
}
const REQ = { model: 'vendor/model', messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 };
const mk = fetch => makeOpenRouterProvider({ key: 'sk-or-v1-x', baseUrl: 'https://or.test/api/v1', fetch });

(async () => {
  // ---- in-band numeric 401: auth, not an unknown blip retried for ~100 s ----
  {
    const err = await thrown(mk(sseFetch([{ id: 'g', error: { code: 401, message: 'User not found.' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }], [])), REQ);
    A.ok(err, 'in-band 401 throws');
    A.eq(err && err.status, 401, 'in-band 401: the numeric code is the error status');
    const cls = classifyApiError(err, { model: REQ.model });
    A.eq(cls.reason, 'auth', 'in-band 401 classifies as auth (got ' + cls.reason + ')');
    A.eq(cls.retryable, false, 'in-band 401 is not retried');
    A.ok(/^openrouter http 401\b/.test(cls.message) && /User not found\./.test(cls.message), 'in-band 401 message carries the adapter label + the provider words (' + cls.message + ')');
  }
  // ---- in-band 429 wrapper: rate_limit, and the upstream's own words survive ----
  {
    const err = await thrown(mk(sseFetch([{ id: 'g', error: { code: 429, message: 'Provider returned error', metadata: { raw: 'Rate limit reached for requests', provider_name: 'Together' } } }], [])), REQ);
    const cls = classifyApiError(err, { model: REQ.model });
    A.eq(cls.reason, 'rate_limit', 'in-band 429 classifies as rate_limit (got ' + cls.reason + ')');
    A.ok(/Rate limit reached for requests/.test(cls.message), 'in-band 429: metadata.raw is kept in the message (' + cls.message + ')');
  }
  // ---- in-band string code: unchanged shape (no invented status), raw appended when present ----
  {
    const err = await thrown(mk(sseFetch([{ id: 'g', error: { code: 'server_error', message: 'Provider disconnected unexpectedly' } }], [])), REQ);
    A.ok(err && !err.status, 'in-band string code invents no HTTP status');
    A.ok(/Provider disconnected unexpectedly/.test(String(err && err.message)), 'in-band string code keeps its message');
  }
  // ---- pre-stream: metadata.raw rides in the message, bounded ----
  {
    const calls = [];
    const raw = '{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}';
    const err = await thrown(mk(jsonFetch(403, { error: { message: 'Provider returned error', code: 403, metadata: { raw, provider_name: 'OpenAI' } } }, calls)), REQ);
    A.ok(/^openrouter http 403 — Provider returned error/.test(String(err && err.message)), 'pre-stream: the adapter sentence is unchanged at its head');
    A.ok(/unsupported_country_region_territory/.test(String(err && err.message)), 'pre-stream: metadata.raw reaches the message (' + (err && err.message) + ')');
    const big = await thrown(mk(jsonFetch(502, { error: { message: 'Provider returned error', code: 502, metadata: { raw: 'x'.repeat(5000) } } }, [])), REQ);
    A.ok(String(big && big.message).length < 700, 'pre-stream: a huge metadata.raw is bounded (' + String(big && big.message).length + ' chars)');
    // a plain pre-stream 401 keeps its exact sentence
    const plain = await thrown(mk(jsonFetch(401, { error: { message: 'User not found.', code: 401 } }, [])), REQ);
    A.eq(String(plain && plain.message), 'openrouter http 401 — User not found.', 'pre-stream 401 sentence unchanged');
  }
  A.report('openrouter-inband-error.test');
})().catch(e => { console.log('FAIL: openrouter-inband-error.test threw -- ' + (e && e.stack || e)); process.exit(1); });
