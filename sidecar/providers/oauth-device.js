/* sidecar/providers/oauth-device.js — ONE generic RFC 8628 OAuth 2.0 Device Authorization Grant wire.

   Unlike codex-auth.js (which speaks OpenAI's PROPRIETARY usercode/token/exchange wire), the new
   subscription providers — xAI Grok and Moonshot Kimi — both speak the STANDARD device-code grant, so this
   is ONE parameterized module rather than a fork per provider. `makeDeviceOAuth(config)` closes over a
   provider's constants and returns the three legs the browser drives on an interval, plus the freshness check:

     1. startDeviceLogin()  POST config.deviceUrl  -> { device_code, user_code, verification_uri, interval }
        The user opens verification_uri (or verification_uri_complete) and enters user_code. `device_code` is
        the OPAQUE poll handle — the composition root keeps it SERVER-SIDE (a pending-login map) and never
        sends it to the browser, exactly as codex keeps its PKCE code_verifier server-side.
     2. pollDeviceLogin({ device_code })  POST config.tokenUrl (grant_type=…:device_code) -> { pending } | tokens
     3. refreshTokens({ refresh_token })  POST config.tokenUrl (grant_type=refresh_token) -> rotated tokens

   `fetch` is INJECTED so the wire is testable headlessly with a recording fake; every leg is capped by the
   SAME connect timeout the other adapters use (SKYNET_PROVIDER_CONNECT_MS). Errors are authError() instances
   carrying { provider, code, reloginRequired }; NO token material is ever placed in an error message.

   config = {
     providerId, clientId, deviceUrl, tokenUrl,
     scope?              — space-delimited scope string, sent on the DEVICE leg only
     deviceExtraBody?    — extra fields on the DEVICE leg only (e.g. Grok's referrer:'starnet')
     headers?            — extra request headers on EVERY auth leg (e.g. Kimi's X-Msh-* set)
     encoding            — 'form' (application/x-www-form-urlencoded) | 'json'
     refreshSkewSeconds  — refresh margin when using expires_at/JWT-exp (Grok 120, Kimi 300)
     halfLifeRefresh?    — when true, refresh once past 50% of the token's lifetime OR within skew of expiry,
                           whichever window is LARGER (Kimi's short-lived-access posture)
     forbiddenIsAllowlist? — when true, a 403 on the token endpoint is an ACCOUNT ALLOWLIST rejection, NOT a
                           dead refresh token: surfaced as a transient, non-relogin error (Grok's OAuth surface
                           can 403 an active subscriber; the fix is the API-key provider, not a re-sign-in).
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.oauthDevice = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const POLL_MIN_INTERVAL_S = 1;                 // floor on the device poll cadence (RFC 8628 default is 5)
  const DEVICE_LOGIN_TIMEOUT_S = 15 * 60;        // give up after 15 minutes (matches the issuers' expires_in)
  const SLOW_DOWN_BUMP_S = 5;                     // RFC 8628 §3.5: on slow_down add 5s to the interval

  function pickFetch(opts) {
    const f = (opts && opts.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('oauth-device requires fetch (Node 18+) or opts.fetch');
    return f;
  }

  // Each leg is a short POST — none should hang the sidecar. Cap with the shared connect timeout (env
  // SKYNET_PROVIDER_CONNECT_MS, default 30s). undefined on old platforms => un-timed (graceful degrade).
  function authTimeoutSignal() {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env.SKYNET_PROVIDER_CONNECT_MS);
      const n = v != null && String(v).trim() !== '' ? parseInt(v, 10) : NaN;
      const ms = (isFinite(n) && n > 0) ? n : 30000;
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    } catch (_) {}
    return undefined;
  }

  function authError(providerId, message, code, relogin) {
    const e = new Error(message);
    e.provider = providerId || 'oauth-device';
    e.code = code || 'oauth_device_error';
    e.reloginRequired = !!relogin;
    return e;
  }

  // ---- JWT helpers (some access tokens are JWTs carrying `exp`; opaque tokens simply decode to {}) ----
  function decodeJwtClaims(token) {
    if (typeof token !== 'string' || (token.match(/\./g) || []).length !== 2) return {};
    let payload = token.split('.')[1] || '';
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    try {
      const json = Buffer.from(payload, 'base64').toString('utf8');
      const claims = JSON.parse(json);
      return (claims && typeof claims === 'object') ? claims : {};
    } catch (e) { return {}; }
  }
  function isoToMs(iso) {
    if (typeof iso !== 'string' || !iso.trim()) return 0;
    const t = Date.parse(iso);
    return isFinite(t) ? t : 0;
  }
  function isoNow(nowMs) {
    if (typeof nowMs !== 'number') return '';
    return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function makeDeviceOAuth(config) {
    config = config || {};
    const providerId = String(config.providerId || 'oauth-device');
    const clientId = String(config.clientId || '');
    const deviceUrl = String(config.deviceUrl || '');
    const tokenUrl = String(config.tokenUrl || '');
    const scope = (typeof config.scope === 'string' && config.scope.trim()) ? config.scope.trim() : '';
    const deviceExtraBody = (config.deviceExtraBody && typeof config.deviceExtraBody === 'object') ? config.deviceExtraBody : {};
    const staticHeaders = (config.headers && typeof config.headers === 'object') ? config.headers : {};
    const encoding = config.encoding === 'json' ? 'json' : 'form';
    const refreshSkewSeconds = Number(config.refreshSkewSeconds) >= 0 ? Number(config.refreshSkewSeconds) : 120;
    const halfLifeRefresh = config.halfLifeRefresh === true;
    const forbiddenIsAllowlist = config.forbiddenIsAllowlist === true;

    // Serialize a body per the provider's wire encoding, attaching the right Content-Type + static headers.
    function encodeBody(fields) {
      const clean = {};
      for (const k of Object.keys(fields)) { if (fields[k] != null && fields[k] !== '') clean[k] = String(fields[k]); }
      if (encoding === 'json') {
        return { body: JSON.stringify(clean), headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, staticHeaders) };
      }
      return { body: new URLSearchParams(clean).toString(), headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, staticHeaders) };
    }

    // pull the OAuth-spec error code out of a non-2xx body ({ error, error_description } or nested { error:{...} })
    async function readErr(resp) {
      let code = '', desc = '';
      try {
        const err = await resp.json();
        const errObj = err && err.error;
        if (typeof errObj === 'string') { code = errObj.trim(); desc = String(err.error_description || err.message || '').trim(); }
        else if (errObj && typeof errObj === 'object') { code = String(errObj.code || errObj.type || '').trim(); desc = String(errObj.message || '').trim(); }
        else if (typeof err.code === 'string') { code = err.code.trim(); desc = String(err.message || '').trim(); }
      } catch (_) {}
      return { code: code.toLowerCase(), desc };
    }

    // ---- leg 1: request a device + user code ----
    async function startDeviceLogin(opts) {
      opts = opts || {};
      const doFetch = pickFetch(opts);
      const fields = Object.assign({ client_id: clientId }, deviceExtraBody);
      if (scope) fields.scope = scope;
      const enc = encodeBody(fields);
      let resp;
      try {
        resp = await doFetch(deviceUrl, { method: 'POST', headers: enc.headers, body: enc.body, signal: authTimeoutSignal() });
      } catch (e) {
        throw authError(providerId, 'Failed to request device code: ' + ((e && e.message) || e), 'device_code_request_failed');
      }
      if (resp.status !== 200) {
        const { code } = await readErr(resp);
        throw authError(providerId, 'Device code request returned status ' + resp.status + '.', code || 'device_code_request_error');
      }
      let data; try { data = await resp.json(); } catch (e) { data = {}; }
      const device_code = String(data.device_code || '');
      const user_code = String(data.user_code || '');
      const verification_uri = String(data.verification_uri || data.verification_url || '');
      const verification_uri_complete = String(data.verification_uri_complete || data.verification_url_complete || '');
      const interval = Math.max(POLL_MIN_INTERVAL_S, parseInt(data.interval, 10) || 5);
      const expires_in = parseInt(data.expires_in, 10) || DEVICE_LOGIN_TIMEOUT_S;
      if (!device_code || !user_code || !verification_uri) throw authError(providerId, 'Device code response missing required fields.', 'device_code_incomplete');
      return { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in };
    }

    // ---- leg 2: poll ONCE. Returns { pending, interval? } while the user finishes, or the token payload. ----
    async function pollDeviceLogin(opts) {
      opts = opts || {};
      const doFetch = pickFetch(opts);
      const device_code = String(opts.device_code || '');
      if (!device_code) throw authError(providerId, 'pollDeviceLogin requires a device_code.', 'device_code_missing');
      const enc = encodeBody({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: clientId });
      let resp;
      try {
        resp = await doFetch(tokenUrl, { method: 'POST', headers: enc.headers, body: enc.body, signal: authTimeoutSignal() });
      } catch (e) {
        // network hiccup mid-poll — keep polling rather than aborting the whole login.
        return { pending: true };
      }
      if (resp.status === 200) return await readTokenPayload(resp, opts.now);
      // A 5xx / 408 / 429 during the poll is transient — keep polling (never a terminal failure here).
      if (resp.status >= 500 || resp.status === 408 || resp.status === 429) return { pending: true };
      const { code, desc } = await readErr(resp);
      if (code === 'authorization_pending') return { pending: true };
      if (code === 'slow_down') return { pending: true, interval: Math.max(POLL_MIN_INTERVAL_S, (parseInt(opts.interval, 10) || 5) + SLOW_DOWN_BUMP_S) };
      if (code === 'access_denied' || code === 'authorization_denied') throw authError(providerId, desc || 'Sign-in was denied.', 'access_denied');
      if (code === 'expired_token') throw authError(providerId, desc || 'The sign-in code expired before it was approved. Start again.', 'expired_token');
      throw authError(providerId, desc || ('Device auth polling returned status ' + resp.status + '.'), code || 'device_code_poll_error');
    }

    // ---- token refresh: trade the refresh_token for a fresh access_token ----
    async function refreshTokens(opts) {
      opts = opts || {};
      const doFetch = pickFetch(opts);
      const refresh_token = opts.refresh_token;
      if (typeof refresh_token !== 'string' || !refresh_token.trim()) {
        throw authError(providerId, 'Sign-in is missing its refresh token. Sign in again.', 'oauth_missing_refresh_token', true);
      }
      const enc = encodeBody({ grant_type: 'refresh_token', refresh_token: refresh_token, client_id: clientId });
      let resp;
      try {
        resp = await doFetch(tokenUrl, { method: 'POST', headers: enc.headers, body: enc.body, signal: authTimeoutSignal() });
      } catch (e) {
        throw authError(providerId, 'Token refresh failed: ' + ((e && e.message) || e), 'oauth_refresh_failed', false);
      }
      if (resp.status === 429) {
        // a token-endpoint 429 is the auth service throttling refreshes, never a spent quota or an empty wallet
        throw authError(providerId, 'The sign-in service is rate-limiting token refresh (HTTP 429). Your credentials are still valid; wait a minute and try again.', 'oauth_rate_limited', false);
      }
      if (resp.status === 403 && forbiddenIsAllowlist) {
        // xAI's OAuth API surface enforces a server-side allowlist and can 403 an ACTIVE subscriber. This is NOT a
        // dead refresh token — a re-sign-in won't help. Steer the user to the API-key provider instead.
        throw authError(providerId, 'This account is not enabled for xAI OAuth API access (403). Use the XAI (API KEY) provider instead.', 'xai_oauth_forbidden', false);
      }
      if (resp.status !== 200) {
        const { code, desc } = await readErr(resp);
        let relogin = false;
        let ecode = code || 'oauth_refresh_failed';
        // RFC 6749 §5.2: invalid_grant/invalid_token are CREDENTIAL verdicts (re-login helps).
        // invalid_request is a malformed-REQUEST verdict (a provider tightened a field, or our encoder
        // dropped one) — re-login mints a new token that fails the same way, so marking the sign-in dead
        // put the user in an unbreakable reconnect loop over a credential that was never invalid.
        if (code === 'invalid_grant' || code === 'invalid_token') relogin = true;
        if ((resp.status === 401 || resp.status === 403) && !relogin) relogin = true;   // a 401/403 (non-allowlist) means the refresh token is dead
        const message = desc ? 'Token refresh failed: ' + desc : ('Token refresh failed with status ' + resp.status + '.');
        throw authError(providerId, message, ecode, relogin);
      }
      const payload = await readTokenPayload(resp, opts.now);
      // keep the old refresh_token if the issuer did not rotate one (RFC 6749 §6 allows omission)
      if (!payload.refresh_token) payload.refresh_token = refresh_token.trim();
      return payload;
    }

    // shared 200 → normalized token envelope fields. Computes a durable expires_at (ms epoch) from expires_in at
    // persist time so the freshness check survives a restart; falls back to the JWT `exp` when expires_in absent.
    async function readTokenPayload(resp, nowMs) {
      let tokens; try { tokens = await resp.json(); } catch (e) {
        throw authError(providerId, 'Token response was not valid JSON.', 'oauth_token_invalid_json', true);
      }
      const access_token = String(tokens.access_token || '').trim();
      if (!access_token) throw authError(providerId, 'Token response was missing an access_token.', 'oauth_token_no_access', true);
      const refresh_token = String(tokens.refresh_token || '').trim();
      const now = typeof nowMs === 'number' ? nowMs : 0;
      let expires_at = 0;
      const expires_in = parseInt(tokens.expires_in, 10);
      if (isFinite(expires_in) && expires_in > 0 && now) expires_at = now + expires_in * 1000;
      else {
        const claims = decodeJwtClaims(access_token);
        if (typeof claims.exp === 'number') expires_at = claims.exp * 1000;
      }
      const out = { access_token, last_refresh: isoNow(now) };
      if (refresh_token) out.refresh_token = refresh_token;
      if (expires_at > 0) out.expires_at = expires_at;
      if (tokens.token_type) out.token_type = String(tokens.token_type);
      return out;
    }

    // Is the stored access token due for a refresh? `nowMs` is INJECTED (deterministic backend law); absent =>
    // fail SAFE (return true => refresh). Uses the persisted expires_at when present, else the JWT exp, else true.
    function accessTokenIsExpiring(tokens, nowMs) {
      if (typeof nowMs !== 'number') return true;
      const skewMs = refreshSkewSeconds * 1000;
      const expAt = Number(tokens && tokens.expires_at) || 0;
      if (expAt > 0) {
        if (halfLifeRefresh) {
          const issued = isoToMs(tokens && tokens.last_refresh);
          const lifetime = issued > 0 ? Math.max(0, expAt - issued) : 0;
          const margin = Math.max(skewMs, lifetime / 2);   // refresh once past 50% of life OR within skew — whichever window is larger
          return nowMs >= (expAt - margin);
        }
        return nowMs >= (expAt - skewMs);
      }
      const claims = decodeJwtClaims(tokens && tokens.access_token);
      if (typeof claims.exp === 'number') return claims.exp <= (nowMs / 1000) + refreshSkewSeconds;
      return true;   // opaque token, no expiry hint -> refresh before every run (fail safe)
    }

    return { startDeviceLogin, pollDeviceLogin, refreshTokens, accessTokenIsExpiring, decodeJwtClaims, providerId, refreshSkewSeconds };
  }

  return { makeDeviceOAuth, decodeJwtClaims };
});
