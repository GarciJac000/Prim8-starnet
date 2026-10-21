/* node test/provider-403-truth.test.js — a provider 403 is not automatically "your key was rejected", and never "the
   station restarted" (sweep/providers 2026-10-20).

   Three live-walked lies, all on a 403 whose key is perfectly valid:
     · OpenRouter's per-KEY credit limit ("Key limit exceeded (total limit). Manage it using …/settings/keys") read as
       auth → "The provider rejected the API key — check it, or paste a new one". The key is fine; its limit is not.
     · An upstream REGION refusal behind OpenRouter (metadata.raw unsupported_country_region_territory) read as auth.
     · Any provider/proxy 403 whose text says "Forbidden" ("openai-compatible http 403 - Forbidden") read, in the
       BROWSER, as StarNet's own stale page token → "The station restarted — reload this page" with a RELOAD door,
       while the node classifier called the same text auth. The sidecar's own token gate is "sidecar HTTP 403".
   Pinned on the sidecar classifier and on BOTH friendlyerror paths (browser = loaded without require). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const NodeFriendly = require('../frontend/app/friendlyerror.js');
const BrowserFriendly = (() => {
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8'), ctx);
  return ctx.Friendly;
})();
const both = [['browser', BrowserFriendly], ['node', NodeFriendly]];
const e403 = msg => Object.assign(new Error(msg), { status: 403 });

const KEY_LIMIT = 'openrouter http 403 — Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys';
const REGION = 'openrouter http 403 — Provider returned error — {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}';
const FORBIDDEN = ['openai-compatible http 403 - Forbidden', 'openrouter http 403 — Forbidden', 'Anthropic http 403 - forbidden: Request not allowed'];

// ---- key credit limit: a spending limit on the KEY, not a rejected key ----
A.eq(classifyApiError(e403(KEY_LIMIT), {}).reason, 'billing', 'classifier: OpenRouter key limit is billing, not auth');
A.eq(classifyApiError(e403(KEY_LIMIT), {}).retryable, false, 'classifier: key limit is not retried');
for (const [label, F] of both) {
  const v = F.friendlyError(KEY_LIMIT);
  A.eq(v.kind, 'billing', label + ': key limit reads as billing (got ' + v.kind + ')');
  A.ok(!/rejected the API key/i.test(v.userMessage), label + ': key limit never says the key was rejected (' + v.userMessage + ')');
  A.ok(/limit/i.test(v.userMessage) && /key/i.test(v.userMessage), label + ': key limit names the key\'s limit (' + v.userMessage + ')');
}

// ---- upstream region refusal: the model is unavailable here, the key is fine ----
A.eq(classifyApiError(e403(REGION), {}).reason, 'model_not_found', 'classifier: a region refusal is the model being unavailable, not auth');
for (const [label, F] of both) {
  const v = F.friendlyError(REGION);
  A.eq(v.kind, 'model_not_found', label + ': region refusal reads as model unavailable (got ' + v.kind + ')');
  A.ok(!/rejected the API key/i.test(v.userMessage), label + ': region refusal never blames the key');
}

// ---- a provider's "Forbidden" is the provider's, never the station's own stale token ----
for (const msg of FORBIDDEN) {
  for (const [label, F] of both) {
    const v = F.friendlyError(msg);
    A.ok(v.kind !== 'stale_session', label + ': "' + msg + '" is not a stale station session (got ' + v.kind + ': ' + v.userMessage + ')');
    A.ok(!/station restarted/i.test(v.userMessage), label + ': "' + msg + '" never claims the station restarted');
  }
}

// ---- the station's OWN token gate still gets the reload door ----
for (const [label, F] of both) {
  A.eq(F.friendlyError('sidecar HTTP 403 — forbidden').kind, 'stale_session', label + ': the sidecar\'s own 403 is still stale_session');
}
// ---- neighbours: a real rejected key and a no-credit 403 keep their verdicts ----
A.eq(classifyApiError(Object.assign(new Error('openrouter http 401 — User not found.'), { status: 401 }), {}).reason, 'auth', 'classifier: 401 User not found stays auth');
A.eq(BrowserFriendly.friendlyError('openrouter http 401 — User not found.').kind, 'auth', 'browser: 401 User not found stays auth');
A.eq(classifyApiError(e403("xai http 403 — Your newly created team doesn't have any credits yet. You can purchase credits on https://console.x.ai/team"), {}).reason, 'billing', 'classifier: xAI no-credit 403 stays billing');

A.report('provider-403-truth.test');
