'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('browser live doctor sends the explicit consent bit and returns the receipt', async () => {
  const oldFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ report: { rows: [] }, text: 'receipt' }) };
  };
  try {
    delete require.cache[require.resolve('../frontend/app/diagnostics.js')];
    const Diag = require('../frontend/app/diagnostics.js');
    const out = await Diag.runLive({ confirmed: true, agentId: 'captain' });
    assert.equal(seen.url, '/api/diagnostics/live');
    assert.equal(seen.opts.method, 'POST');
    assert.deepEqual(seen.body, { confirmedLiveProbes: true, agentId: 'captain' });
    assert.equal(out.text, 'receipt');
  } finally { global.fetch = oldFetch; }
});

test('settings keeps live probes behind a checkbox and renders the receipt as text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
  assert.match(src, /id="diag-live-consent"/);
  assert.match(src, /!liveConsent \\|\\| !liveConsent\.checked/);
  assert.match(src, /liveOut\.textContent = result\.text/);
  // plain words (UX night 2026-10-26): the same two promises, said the way a newcomer reads them
  assert.match(src, /It sends no chat messages and shares no secrets/);
});
