/* node test/openrouter-free-daily-cap.test.js — OpenRouter's FREE-MODEL DAILY CAP is a spent allowance, not a busy
   moment (sweep/providers 2026-10-20).

   OpenRouter answers the free-model per-day limit with HTTP 429 "Rate limit exceeded: free-models-per-day. Add 10
   credits to unlock 1000 free model requests per day". Its reset is the next UTC day, so a retry is doomed by
   construction. Live (sweep rig, mock OpenRouter): the run sent 7 POSTs over ~102 s and then told the Commander
   "The model provider is busy (too many requests) — wait a few seconds and try again" with a ↻ retry. The
   per-MINUTE free limit ("free-models-per-min") is a genuine short window and must stay a retryable rate limit.

   Pinned at all three seams: the sidecar classifier, the OpenRouter adapter's own pre-stream ladder (one request,
   no retry), and the BROWSER copy — friendlyerror.js loaded without `require`, which is the path real users take
   (the node build delegates to errorClass; the browser re-reads the raw text with its own mirror). Zero network. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');
const NodeFriendly = require('../frontend/app/friendlyerror.js');

function browserFriendly() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
  return ctx.Friendly;
}
const BrowserFriendly = browserFriendly();

const DAY_BODY = { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429,
  metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1792627200000' }, provider_name: null } }, user_id: 'user_x' };
const MIN_BODY = { error: { message: 'Rate limit exceeded: free-models-per-min. ', code: 429, metadata: { headers: { 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0' }, provider_name: null } } };

function orFetch(status, body, calls) {
  return async (url, init) => {
    if (!init || !init.body) return new Response('{"data":[]}', { status: 200 });
    calls.push(status);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
async function thrown(p, req) {
  try { for await (const _ of p.stream(req)) { /* drain */ } } catch (e) { return e; }
  return null;
}

(async () => {
  // ---- the adapter: a spent daily cap is ONE request, never a retry ladder ----
  {
    const calls = [];
    const p = makeOpenRouterProvider({ key: 'sk-or-v1-x', baseUrl: 'https://or.test/api/v1', fetch: orFetch(429, DAY_BODY, calls) });
    const err = await thrown(p, { model: 'meta-llama/llama-3.3-70b-instruct:free', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(err, 'daily cap: the 429 surfaces as an error');
    const cls = classifyApiError(err, { model: 'meta-llama/llama-3.3-70b-instruct:free' });
    A.eq(cls.reason, 'quota_exhausted', 'daily cap: a spent free-model daily allowance is quota_exhausted, not rate_limit');
    A.eq(cls.retryable, false, 'daily cap: not retryable (the reset is the next UTC day)');
    A.eq(calls.length, 1, 'daily cap: the adapter sends ONE request, no pre-stream retry ladder');
    A.ok(!(err && err.preStreamRetriesExhausted), 'daily cap: not marked as an exhausted transient retry');

    // ---- what the Commander is told, on BOTH friendlyerror paths ----
    for (const [label, F] of [['browser', BrowserFriendly], ['node', NodeFriendly]]) {
      const v = F.friendlyError(cls.message);
      A.eq(v.kind, 'quota_exhausted', label + ' copy: daily cap reads as a spent allowance (got ' + v.kind + ')');
      A.eq(v.retryable, false, label + ' copy: no ↻ Try again on a cap that resets tomorrow');
      A.ok(!/wait a few seconds/i.test(v.userMessage), label + ' copy: never "wait a few seconds" (' + v.userMessage + ')');
      A.ok(/OpenRouter/.test(v.userMessage) && /free/i.test(v.userMessage) && /day|daily/i.test(v.userMessage), label + ' copy: names OpenRouter\'s free-model daily limit (' + v.userMessage + ')');
      A.ok(!/ChatGPT/.test(v.userMessage), label + ' copy: does not talk about a ChatGPT subscription (' + v.userMessage + ')');
    }
  }

  // ---- the per-MINUTE free limit is a real short window: still a retryable rate limit ----
  {
    const calls = [];
    const p = makeOpenRouterProvider({ key: 'sk-or-v1-x', baseUrl: 'https://or.test/api/v1', fetch: orFetch(429, MIN_BODY, calls) });
    const err = await thrown(p, { model: 'm:free', messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 });
    const cls = classifyApiError(err, { model: 'm:free' });
    A.eq(cls.reason, 'rate_limit', 'per-minute: free-models-per-min stays a rate limit');
    A.eq(cls.retryable, true, 'per-minute: still retryable');
    for (const [label, F] of [['browser', BrowserFriendly], ['node', NodeFriendly]]) {
      A.eq(F.friendlyError(cls.message).kind, 'rate_limit', label + ' copy: per-minute stays rate_limit');
    }
  }

  // ---- neighbours that must not move: Gemini per-minute quota, Groq RPM, OpenAI insufficient_quota ----
  {
    const gem = classifyApiError(Object.assign(new Error('gemini http 429 — Quota exceeded for quota metric \'Generate Content API requests per minute\''), { status: 429 }), {});
    A.eq(gem.reason, 'rate_limit', 'Gemini per-minute quota stays a rate limit');
    const groq = classifyApiError(Object.assign(new Error('openai-compatible http 429 - Rate limit reached for model `llama` on requests per minute (RPM): Limit 30'), { status: 429 }), {});
    A.eq(groq.reason, 'rate_limit', 'Groq RPM stays a rate limit');
    A.eq(BrowserFriendly.friendlyError('openai-compatible http 429 - Rate limit reached for model `llama` on requests per minute (RPM): Limit 30').kind, 'rate_limit', 'browser: Groq RPM stays a rate limit');
    A.eq(BrowserFriendly.friendlyError('openai-compatible http 429 - [type insufficient_quota; code insufficient_quota] You exceeded your current quota, please check your plan and billing details.').kind, 'billing', 'browser: OpenAI insufficient_quota stays billing');
  }

  A.report('openrouter-free-daily-cap.test');
})().catch(e => { console.log('FAIL: openrouter-free-daily-cap.test threw -- ' + (e && e.stack || e)); process.exit(1); });
