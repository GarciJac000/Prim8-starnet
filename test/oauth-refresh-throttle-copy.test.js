/* node test/oauth-refresh-throttle-copy.test.js — a 429 from a SIGN-IN token endpoint is a throttle, not a spent quota and
   never an empty wallet (sweep/providers 2026-10-20; the third "known-unbuilt" Codex 429 defect, still live on trunk).

   codex-auth.js (auth.openai.com/oauth/token) and oauth-device.js (Grok / Kimi token endpoints) threw "…provider quota
   exhausted (429)…" for ANY refresh 429. Quota is enforced at the inference API, not the token endpoint — a 429 there is
   the auth service throttling refreshes. Worse, the browser read the word "quota" as `billing`: the Commander of a
   ChatGPT / SuperGrok / Kimi SUBSCRIPTION (no wallet exists) was told "Your provider account is out of credit — top it
   up, then try again". Pinned: the refresh 429 keeps its code (codex_rate_limited / oauth_rate_limited, relogin false)
   and its sentence now reads as the transient rate limit it is, on the classifier and on BOTH friendlyerror paths. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const codexAuth = require('../sidecar/providers/codex-auth.js');
const { makeDeviceOAuth } = require('../sidecar/providers/oauth-device.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const NodeFriendly = require('../frontend/app/friendlyerror.js');
const BrowserFriendly = (() => {
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8'), ctx);
  return ctx.Friendly;
})();
const throttled = async () => new Response(JSON.stringify({ error: { message: 'Too Many Requests' } }), { status: 429, headers: { 'Content-Type': 'application/json' } });

async function refreshError(fn) { try { await fn(); } catch (e) { return e; } return null; }

(async () => {
  const codexErr = await refreshError(() => codexAuth.refreshTokens({ fetch: throttled, refresh_token: 'r', now: 0 }));
  const device = makeDeviceOAuth({ providerId: 'grok', clientId: 'c', deviceUrl: 'https://auth.test/device', tokenUrl: 'https://auth.test/token', encoding: 'form' });
  const grokErr = await refreshError(() => device.refreshTokens({ fetch: throttled, refresh_token: 'r', now: 0 }));
  for (const [label, err, code] of [['codex', codexErr, 'codex_rate_limited'], ['grok', grokErr, 'oauth_rate_limited']]) {
    A.ok(err, label + ': a token-endpoint 429 throws');
    A.eq(err && err.code, code, label + ': keeps its rate-limited code');
    A.eq(err && err.reloginRequired, false, label + ': never forces a re-sign-in');
    const msg = String(err && err.message);
    A.ok(!/quota/i.test(msg), label + ': the sentence does not claim a spent quota (' + msg + ')');
    A.eq(classifyApiError(err, {}).reason, 'rate_limit', label + ': the classifier reads a throttle');
    for (const [side, F] of [['browser', BrowserFriendly], ['node', NodeFriendly]]) {
      const v = F.friendlyError(msg);
      A.eq(v.kind, 'rate_limit', label + ' ' + side + ': reads as a transient rate limit (got ' + v.kind + ': ' + v.userMessage + ')');
      A.ok(!/out of credit|top it up/i.test(v.userMessage), label + ' ' + side + ': a subscription refresh throttle never says "out of credit"');
      A.eq(v.retryable, true, label + ' ' + side + ': retry is the honest door');
    }
  }
  A.report('oauth-refresh-throttle-copy.test');
})().catch(e => { console.log('FAIL: oauth-refresh-throttle-copy.test threw -- ' + (e && e.stack || e)); process.exit(1); });
