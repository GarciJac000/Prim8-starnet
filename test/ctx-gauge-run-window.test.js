/* node test/ctx-gauge-run-window.test.js — MEMORY OF THIS CHAT and the setup hint measure the window a run works in
   (final-polish 10-23).

   0.14.0 stops a run's window at the model's long-context price tier (context-cost-1023: Gemini Pro / grok 200k, Claude
   Haiku 5.5 100K on a direct key; the sidecar's /api/models row carries it as runWindow), so a 1M Gemini 2.5 Pro run folds
   at ~130k. /compress measured against that window, but the bottom-bar gauge still divided by the 1M context_length (it
   read ~12% at the moment a run folded, never reaching WARN/CRIT) and the setup hint still said "remembers up to 1M
   tokens of chat". Locked here, on the REAL bodies:
     1. Harness.contextState carries runWindow (the tier window when it is below the model's), and keeps `limit` the
        model's own window, which the composer's fit checks read;
     2. the gauge (stationui.js ctxTick) measures against runWindow and its tooltip says why it is smaller, as /compress does;
     3. the self-test HUD reading (testapi.js ctx) matches the gauge;
     4. the setup hint (app.js updateHint) names the run's window and why;
     5. the website app mirror ships the same. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CtxGauge = require('../frontend/app/ctxgauge.js');
const { fnBody } = require('./_fnbody.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
function region(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker), end = src.indexOf(endMarker, start);
  A.ok(start >= 0 && end > start, label + ' is locatable');
  return src.slice(start, end);
}
const PRO = 'gemini-2.5-pro', FLASH = 'gemini-2.5-flash';
const LIMITS = { [PRO]: 1048576, [FLASH]: 1048576 };
const RUNS = { [PRO]: 200000, [FLASH]: 1048576 };

// ---- 1. contextState carries the run's window and keeps the model's ----
{
  const harness = read('frontend/app/harness.js');
  const occupancy = region(harness, '  let contextByKey = {};', '\n  // Desktop (Tauri) build:', 'the harness occupancy block');
  const readSide = region(harness, '  function contextState(agentId, streamId, messages) {', '\n  function normalizeModel(', 'contextState');
  let model = PRO;
  const store = new Map();
  const api = vm.runInNewContext(occupancy + '\n' + readSide + '\n({ contextState });', {
    CtxGauge, console: { warn() {}, log() {} }, getModel: () => model,
    contextLimitOf: id => LIMITS[id] || 0, runWindowOf: id => RUNS[id] || 0,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
  }, { filename: 'harness.js#contextState' });
  const pro = api.contextState('agent', 'ws', []);
  A.eq([pro.limit, pro.runWindow], [1048576, 200000], 'Gemini 2.5 Pro on a key: contextState keeps the 1M limit (composer fit checks) and carries the 200k run window');
  model = FLASH;
  const flash = api.contextState('agent', 'ws', []);
  A.eq([flash.limit, flash.runWindow], [1048576, 1048576], 'a model with no price tier: the run window is the whole window');
  model = 'unknown-model';
  const unknown = api.contextState('agent', 'ws', []);
  A.eq([unknown.limit, unknown.runWindow], [0, 0], 'a model the catalog does not know: no window is invented');
  model = 'no-run-window';
  LIMITS[model] = 32000;
  A.eq(api.contextState('agent', 'ws', []).runWindow, 32000, 'a catalog row without runWindow: the model window, as before');
}

// ---- 2. the gauge measures against the run's window and says why ----
const ui = read('frontend/app/stationui.js');
const tickSrc = region(ui, '  function ctxTick() {', '\n  let compactWired', 'stationui.js ctxTick');
function gauge(cs) {
  const nodes = { '.ctx-num': { textContent: '' }, '.ctx-cap': { textContent: '' } };
  const attrs = {};
  const g = { dataset: {}, style: { setProperty() {} }, querySelector: sel => nodes[sel] || null,
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } };
  vm.runInNewContext(tickSrc + '\nctxTick();', { $: sel => (sel === '#ctx-gauge' ? g : null), CtxGauge, access: { context: () => cs } },
    { filename: 'stationui.js#ctxTick' });
  return { pct: nodes['.ctx-num'].textContent, cap: nodes['.ctx-cap'].textContent, level: g.dataset.level, tip: attrs['data-tip'] || '' };
}
{
  const atFold = gauge({ model: PRO, used: 130000, limit: 1048576, runWindow: 200000, measured: true, projected: false });
  A.eq([atFold.pct, atFold.cap], ['65%', '130k / 200k'], 'Gemini 2.5 Pro: at the fold (~130k) the gauge reads 65% of the 200k a run works in, not 12% of 1M: ' + JSON.stringify(atFold));
  A.ok(atFold.tip.indexOf('The model can hold 1M, but it bills a higher rate for a prompt over 200k tokens, so a run works in 200k.') >= 0,
    'the tooltip says why the window is smaller than the model’s, as /compress does: ' + atFold.tip);
  A.ok(atFold.tip.indexOf('when it fills') < 0 && atFold.tip.indexOf('when it nears full, older turns are folded') >= 0, 'and promises the fold the way /compress words it');
  const warn = gauge({ model: PRO, used: 160000, limit: 1048576, runWindow: 200000, measured: true });
  A.eq(warn.level, 'warn', 'the gauge reaches WARN inside the run window (it never could against 1M)');
  const whole = gauge({ model: FLASH, used: 130000, limit: 1048576, runWindow: 1048576, measured: true });
  A.eq([whole.pct, whole.cap], ['12%', '130k / 1M'], 'a model with no price tier: measured against its whole window, as before');
  A.ok(whole.tip.indexOf('higher rate') < 0, 'and the tooltip names no price tier');
  const older = gauge({ model: 'm', used: 13000, limit: 200000, measured: true });
  A.eq(older.cap, '13k / 200k', 'a reading without runWindow (an older shape): the model window, as before');
}

// ---- 3. the self-test HUD reading matches the gauge ----
{
  const testapi = read('frontend/app/testapi.js');
  const ctxSrc = fnBody(testapi, '  function ctx() {');
  A.ok(ctxSrc && ctxSrc.length < 2000, 'testapi.js ctx() is sliced');
  const cs = { model: PRO, used: 130000, limit: 1048576, runWindow: 200000, measured: true };
  const r = vm.runInNewContext(ctxSrc + '\nctx();', { CtxGauge, Harness: { contextState: () => cs }, Chat: { contextRef: () => null } });
  A.eq([r.pctLabel, r.label], ['65%', '130k / 200k'], 'the self-test HUD reads the gauge’s own window');
}

// ---- 4. the setup hint names the run's window ----
{
  const app = read('frontend/app/app.js');
  const hintSrc = fnBody(app, '  function updateHint() {');
  A.ok(hintSrc && hintSrc.length < 4000, 'app.js updateHint is sliced');
  // genesisModels = what loadModels got from Harness.listModels(pickedProvider): normalized rows carrying runWindow
  const GEMINI_ROWS = [PRO, FLASH].map(id => ({ id, name: id, context_length: LIMITS[id], runWindow: RUNS[id], pricing: null }));
  function hint(id, rows) {
    const nodes = { 'in-model': { value: id }, 'model-hint': { textContent: '' }, 'in-key': { value: '' } };
    // the Harness lookups answer as a station on ANOTHER route would (a tier everywhere): the hint must not read them for the tier
    const Harness = { contextLimitOf: m => LIMITS[m] || 0, priceOf: () => null, runWindowOf: () => 200000 };
    vm.runInNewContext(hintSrc + '\nupdateHint();', {
      el: k => nodes[k], window: {}, genesisModels: rows, pickedProvider: 'gemini', codexConnected: false, syncModelPicks() {},
      isOAuthProviderId: () => false, OAUTH_GENESIS: {}, Harness, CtxGauge, usdPerM: String, genesisOffline: false
    }, { filename: 'app.js#updateHint' });
    return nodes['model-hint'].textContent;
  }
  const pro = hint(PRO, GEMINI_ROWS);
  A.eq(pro, 'remembers up to 200k tokens of chat (the model can hold 1M, but it bills a higher rate for a prompt over 200k)',
    'Gemini 2.5 Pro on a key: the setup hint names the 200k a run works in and why: ' + pro);
  A.eq(hint(FLASH, GEMINI_ROWS), 'remembers up to 1M tokens of chat', 'no price tier: the whole window, as before');
  A.eq(hint(PRO, GEMINI_ROWS.map(r => ({ id: r.id, name: r.name, context_length: r.context_length }))), 'remembers up to 1M tokens of chat',
    'a picked row without runWindow (an older sidecar): the model window, as before');
  A.eq(hint(PRO, [{ id: FLASH, name: FLASH, context_length: LIMITS[FLASH], runWindow: RUNS[FLASH] }]), 'remembers up to 1M tokens of chat',
    'an id the picked catalog does not list: the window is the model’s (any catalog), but no tier is borrowed from another route');

  // THE CARD PICKED ON THIS SCREEN decides the route, not the station's stored provider. The REAL harness lookups
  // (catalogModel prefers getProv(), which selectProviderUI never sets: only WAKE does) answer for the STATION's
  // route. StarNet credits and OpenRouter list the same id, but the sidecar's /api/models gives them different
  // runWindow: starnet is metered (the 200k tier), openrouter books the billed cost (BILLED_COST_ROUTES, the whole
  // window). genesisModels is what Harness.listModels(pickedProvider) returned (normalized rows carry runWindow).
  const harness = read('frontend/app/harness.js');
  const lookups = ['  function catalogModel(id) {', '  function contextLimitOf(id) {', '  function runWindowOf(id) {', '  function priceOf(id) {']
    .map(sig => { const b = fnBody(harness, sig); A.ok(b && b.length < 2000, 'harness.js ' + sig.trim() + ' is sliced'); return b; }).join('\n');
  const OR_ID = 'google/gemini-2.5-pro';
  const ROWS = {
    openrouter: [{ id: OR_ID, name: OR_ID, context_length: 1048576, runWindow: 1048576, pricing: null }],
    starnet: [{ id: OR_ID, name: OR_ID, context_length: 1048576, runWindow: 200000, pricing: null }]
  };
  function routedHint(stationProv, picked) {
    const modelsByProv = {};
    for (const p in ROWS) { modelsByProv[p] = {}; for (const m of ROWS[p]) modelsByProv[p][m.id] = m; }
    const Harness = vm.runInNewContext(lookups + '\n({ catalogModel, contextLimitOf, runWindowOf, priceOf });',
      { modelsByProv, getProv: () => stationProv, normalizeProviderId: p => String(p || '').toLowerCase() });
    const nodes = { 'in-model': { value: OR_ID }, 'model-hint': { textContent: '' }, 'in-key': { value: '' } };
    vm.runInNewContext(hintSrc + '\nupdateHint();', {
      el: k => nodes[k], window: {}, genesisModels: ROWS[picked].slice(), pickedProvider: picked, codexConnected: false, syncModelPicks() {},
      isOAuthProviderId: () => false, OAUTH_GENESIS: {}, Harness, CtxGauge, usdPerM: String, genesisOffline: false
    }, { filename: 'app.js#updateHint' });
    return nodes['model-hint'].textContent;
  }
  const TIER = 'remembers up to 200k tokens of chat (the model can hold 1M, but it bills a higher rate for a prompt over 200k)';
  const WHOLE = 'remembers up to 1M tokens of chat';
  A.eq(routedHint('starnet', 'openrouter'), WHOLE,
    'a StarNet-credits station picking the OPENROUTER card: an OpenRouter run keeps the whole window, so no 200k tier is named');
  A.eq(routedHint('openrouter', 'starnet'), TIER,
    'an OpenRouter station (the default) picking the STARNET card: a StarNet run works in 200k, so the hint names it');
  A.eq([routedHint('starnet', 'starnet'), routedHint('openrouter', 'openrouter')], [TIER, WHOLE], 'the station and the card agree: unchanged');
  // a picked catalog row with no runWindow (the codex sign-in list on the OPENAI card: rows are { id, name }) names no
  // tier from ANOTHER route's catalog (illustrative numbers: the rule, not a real gpt-5.5 tier)
  {
    const modelsByProv = { openai: { 'gpt-5.5': { id: 'gpt-5.5', context_length: 400000, runWindow: 272000 } } };
    const Harness = vm.runInNewContext(lookups + '\n({ catalogModel, contextLimitOf, runWindowOf, priceOf });',
      { modelsByProv, getProv: () => 'openai', normalizeProviderId: p => String(p || '').toLowerCase() });
    const nodes = { 'in-model': { value: 'gpt-5.5' }, 'model-hint': { textContent: '' }, 'in-key': { value: '' } };
    vm.runInNewContext(hintSrc + '\nupdateHint();', {
      el: k => nodes[k], window: {}, genesisModels: [{ id: 'gpt-5.5', name: 'gpt-5.5' }], pickedProvider: 'openai', codexConnected: true, syncModelPicks() {},
      isOAuthProviderId: () => false, OAUTH_GENESIS: {}, Harness, CtxGauge, usdPerM: String, genesisOffline: false
    }, { filename: 'app.js#updateHint' });
    A.eq(nodes['model-hint'].textContent, 'remembers up to 400k tokens of chat',
      'a picked row that carries no runWindow borrows no tier from another route’s catalog: ' + nodes['model-hint'].textContent);
  }
}

// ---- 5. the website app ships the same ----
{
  const web = rel => read('website/app/app/' + rel);
  A.ok(web('harness.js').indexOf('runWindow: (run > 0 && limit > 0 && run < limit) ? run : limit') >= 0, 'the website harness.js mirror carries contextState.runWindow');
  A.ok(web('stationui.js').indexOf('tier ? cs.runWindow : cs.limit') >= 0, 'the website stationui.js mirror measures the gauge against it');
  A.ok(web('app.js').indexOf('const run = row ? (Number(row.runWindow) || 0) : 0;') >= 0, 'the website app.js mirror carries the setup hint (the picked row’s runWindow)');
}

A.report('ctx-gauge-run-window');
