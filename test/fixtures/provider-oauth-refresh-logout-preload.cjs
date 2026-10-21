'use strict';
// Loaded only by provider-oauth-refresh-logout-race.e2e.test.js. It answers every outbound fetch the sidecar makes
// (no real network), and HOLDS each OAuth token-endpoint refresh until the test releases it, keyed by the refresh
// token presented: <ws>/started-<rt> appears when the refresh is in flight, <ws>/release-<rt> lets it answer.
// A refresh token starting with R_FAIL is answered invalid_grant (the failure branch); every other one succeeds.
const fs = require('node:fs');
const path = require('node:path');
const FRESH = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: 1900000000 })).toString('base64url') + '.c2ln';
const originalFetch = globalThis.fetch;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async function (raw, options) {
  const u = new URL(String(raw && raw.url ? raw.url : raw));
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return originalFetch(raw, options);
  // a device sign-in (RFC 8628) completes at once: the "new sign-in" a late refresh must never merge over
  if (/\/device_authorization$|\/device\/code$/.test(u.pathname)) {
    return json(200, { device_code: 'DC_NEWSIGNIN', user_code: 'NEW-SIGN', verification_uri: 'https://auth.example.test/verify', interval: 5, expires_in: 600 });
  }
  if (!/\/oauth2?\/token$|\/api\/oauth\/token$/.test(u.pathname)) return json(503, { error: 'offline test fixture' });
  const root = process.env.STARNET_WORKSPACES;
  const body = String((options && options.body) || '');
  if (/device_code/.test(body)) return json(200, { access_token: 'NEWSIGNIN_ACCESS', refresh_token: 'R_NEWSIGNIN', token_type: 'Bearer', expires_in: 3600 });
  let rt = '';
  try { rt = new URLSearchParams(body).get('refresh_token') || ''; } catch (_) {}
  if (!rt) { try { rt = JSON.parse(body).refresh_token || ''; } catch (_) {} }
  rt = String(rt).replace(/[^A-Za-z0-9_-]/g, '');
  fs.writeFileSync(path.join(root, 'started-' + rt), u.hostname + u.pathname);
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, 'release-' + rt))) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > 15000) { clearInterval(timer); reject(new Error('test release timed out')); }
    }, 20);
  });
  if (rt.indexOf('R_FAIL') === 0) return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
  return json(200, { access_token: FRESH, refresh_token: 'ROTATED_' + rt, token_type: 'Bearer', expires_in: 3600 });
};
