/* node test/update-drain-conflict.test.js — a latched save conflict pauses the update with a way out, never "try again".

   The pre-install drain refuses while CloudSave holds a conflict (the station file refused this window's copy and kept
   it aside). That never clears by waiting, so the card's old "try again in a moment" sent the user round in circles and
   the update could never install. The refusal now names the conflict, points at the save notice and ITS buttons
   (Restore this window's sessions / Reload current station / Download this window's save / Open the fresh station),
   and makes sure that notice is drawn. The install stays refused: nothing is installed over an unsaved window.

   Real modules: updates.js + UpdateCore, and the real Save/CloudSaveCore/CloudSave in one page context. The station
   file is a fake /api/save that answers the savestore's conflict refusal. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const UpdateCore = require('../frontend/app/updatecore.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function makeCase(o) {
  const calls = [], notices = [];
  let installCalls = 0, refreshes = 0;
  class Channel { constructor(fn) { this.fn = fn; } }
  const invoke = async cmd => {
    calls.push(cmd);
    if (cmd === 'starnet_update_status') return { desktop: true, currentVersion: '1.0.0', pending: null };
    if (cmd === 'starnet_update_check') return { available: true, checkedAt: 10, update: { version: '2.0.0', body: '' } };
    if (cmd === 'starnet_update_install') { installCalls++; return {}; }
    return {};
  };
  const fetch = async (url, init) => {
    const u = String(url), method = ((init && init.method) || 'GET').toUpperCase();
    calls.push(method + ' ' + u.split('?')[0]);
    if (u.startsWith('/api/save') && method === 'POST') {
      const doc = JSON.parse(init.body);
      // savestore.js: the copy is kept aside as <agent>.save-conflict-<client>.json and the write is refused
      const refused = { ok: false, stale: true, conflict: true, revision: 7, updatedAt: 1 };
      if (o.recovery !== false) refused.recovery = 'agent.save-conflict-' + (doc._saveClient || 'x') + '.json';
      if (o.reset) refused.reset = true;
      // savestore.js erasedWork: a copy from before this computer's station was reset, the station from after it (never with reset)
      if (o.predatesReset) refused.predatesReset = true;
      return { ok: true, status: 200, json: async () => refused };
    }
    if (u === '/api/update/prepare') return { ok: true, status: 200, json: async () => ({ ok: true, receipt: { id: 'receipt-1' } }) };
    if (u === '/api/update/cancel') return { ok: true, status: 200, json: async () => ({ ok: true, frozen: false }) };
    throw new Error('unexpected fetch ' + u);
  };
  const store = new Map();
  const context = {
    UpdateCore, console: { warn() {}, info() {}, log() {}, error() {} }, crypto: nodeCrypto, AbortController,
    window: { __TAURI__: { core: { invoke, Channel } }, open() {} },
    localStorage: {
      get length() { return store.size; }, key(i) { return Array.from(store.keys())[i] || null; },
      getItem(k) { return store.has(k) ? store.get(k) : null; }, setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }
    },
    Channels: { busyCount: () => 0 },
    StationUI: { refreshSave: () => { refreshes++; } },
    fetch, setTimeout, clearTimeout, queueMicrotask,
    Date, JSON, Promise, Math, String, Number, Object, Array, RegExp, Error, encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(read('frontend/app/save.js'), context);
  vm.runInContext(read('frontend/app/cloudsavecore.js'), context);
  vm.runInContext(read('frontend/app/cloudsave.js'), context);
  context.App = {
    persist() {
      calls.push('persist');
      const env = vm.runInContext('Save.envelope', context)({ agent: { id: 'agent', name: 'NOVA' }, station: { floor: 'verdant' } });
      vm.runInContext('CloudSave', context).push(env);
      return true;
    },
    pushRoster: async () => { calls.push('roster'); return true; }
  };
  vm.runInContext(read('frontend/app/updates.js') + '\n;globalThis.__Updates = Updates;', context, { filename: 'updates.js' });
  const updates = context.__Updates;
  return {
    updates, calls, notices, cloud: () => vm.runInContext('CloudSave', context),
    installCalls: () => installCalls, refreshes: () => refreshes,
    ready: async () => { await updates.init({ notify: (...a) => notices.push(a) }); await updates.check(true, 'test'); }
  };
}
const prepared = c => c.calls.includes('POST /api/update/prepare') || c.calls.includes('/api/update/prepare');

(async () => {
  {
    // the drain itself: a conflict latched by the station file's refusal is reported, and it does not pass
    const c = makeCase({});
    const drained = await c.updates.preInstallDrain(500);
    A.eq([drained.ok, drained.saveConfirmed], [false, false], 'a latched conflict fails the drain (nothing installs over an unsaved window)');
    A.ok(drained.conflict && drained.conflict.conflict === true, 'the drain reports the latched conflict');
    A.ok(c.cloud().health().conflict, 'CloudSave holds the conflict');
    const again = await c.updates.preInstallDrain(500);
    A.eq([again.ok, !!again.conflict], [false, true], 'and waiting never clears it');
  }
  {
    // the update card: names the conflict and the notice's buttons, never "try again in a moment"
    const c = makeCase({});
    await c.ready();
    const state = await c.updates.install();
    A.eq(c.installCalls(), 0, 'the native installer does not run');
    A.eq(prepared(c), false, 'no recovery point is cut over the unsaved window');
    A.eq(/try again in a moment/i.test(state.error), false, 'the card no longer says "try again in a moment" (got: ' + state.error + ')');
    A.ok(/conflict with the station file/i.test(state.error), 'the card names the conflict');
    A.ok(/kept separately on the station/i.test(state.error), 'and says this window’s copy is kept on the station');
    A.ok(/save notice at the top/i.test(state.error) && /Restore this window’s sessions/.test(state.error), 'and points at the save notice’s Restore button');
    A.ok(/Reload current station/.test(state.error), 'or its Reload button');
    A.ok(/update was not installed/i.test(state.error), 'and says the update was not installed');
    A.ok(c.refreshes() >= 1, 'the save notice is drawn (StationUI.refreshSave) so the buttons it names are on screen');
    A.ok(c.notices.some(n => /conflict with the station file/.test(String(n[0]))), 'the toast names the conflict too');
  }
  {
    // the station was RESET: the notice offers Download + Open the fresh station (no restore)
    const c = makeCase({ reset: true });
    await c.ready();
    const state = await c.updates.install();
    A.eq(c.installCalls(), 0, 'a reset refusal does not install either');
    A.ok(/station was reset/i.test(state.error) && /Open the fresh station/.test(state.error), 'a reset names the reset and the notice’s Open the fresh station button (got: ' + state.error + ')');
    A.eq(/Restore this window/.test(state.error), false, 'and never offers a restore the notice does not show');
  }
  {
    // no preserved file named: the notice has no Restore button, so the card names Download + Reload
    const c = makeCase({ recovery: false });
    await c.ready();
    const state = await c.updates.install();
    A.ok(/Download this window’s save/.test(state.error) && /Reload current station/.test(state.error), 'without a preserved copy the card names Download then Reload (got: ' + state.error + ')');
    A.eq(/Restore this window/.test(state.error), false, 'and no Restore button');
  }
  {
    // erased work (predatesReset): the copy predates this computer's station reset, so the notice deliberately has NO
    // Restore button (stationui.js refreshSaveDurability: !erased) and the station refuses that restore. The card names
    // only the notice's Download + Reload current station buttons (final-polish 10-23)
    const c = makeCase({ predatesReset: true });
    await c.ready();
    const state = await c.updates.install();
    A.eq(c.installCalls(), 0, 'an erased-work refusal does not install either');
    A.eq(/Restore this window/.test(state.error), false, 'erased work never names a Restore button the notice does not show (got: ' + state.error + ')');
    A.ok(/Download this window’s save/.test(state.error) && /Reload current station/.test(state.error), 'it names the notice’s Download then Reload current station buttons');
    A.ok(/from before this computer’s station was reset/.test(state.error), 'and says the copy is from before the reset, as the notice does');
    A.ok(/kept separately on the station/i.test(state.error) && /update was not installed/i.test(state.error), 'and that the copy is kept and the update was not installed');
  }
  A.report('update-drain-conflict');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
