/* test/save-adopt-merge.test.js — ONE window, the station "went back" (support reports 10-15…10-25: #121, #153,
   starnet-releases#4, the androo.agi inbox). A window's save landed but its ACK never arrived; the window died (crash,
   power loss, a killed app) before its next save was sent; the reopened window resumed that next save from the browser
   cache on the old revision and was refused as ANOTHER window's change — and so was every save after it, so the station
   file froze while the window kept working. Live repro: dev/save-unclean-exit-repro.mjs.

   Drives the REAL page (frontend/app/cloudsave.js in a vm) -> the REAL /api/save, /api/save/adopt handlers sliced out of
   sidecar/index.js -> the REAL savestore on a temp workspace (test/_save-restore-kit.js). A "restart" is a new store
   process over the same files.
     a. a cache that names its window (0.14.1): that window's newer work lands as itself — no conflict, no merge;
     b. …and a cache OLDER than the head that window wrote (a cache that could not hold the newer save) gives way to the
        station file, which is resumed;
     c. a cache from 0.14.0 or earlier (no window named) is merged at boot: the window saved last is the base, the station
        file's other sessions come back into it, a session deleted in the window stays deleted, the station file is copied
        aside first, the window's growth never goes behind the station's rating watermark, and its next save lands;
     d. a station file saved AFTER the window (a terminal's approval change while the app was closed) is the base: its
        approval modes stand, the window's sessions are added, the window's whole save is kept beside it;
     e. a cache of ANOTHER station (another founding) is never merged or taken as that window's work: preserved, untouched. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const K = require('./_save-restore-kit.js');
const { workspace, turn, stationDoc, sidecar, page, conflictFiles } = K;

const titles = doc => (doc && Array.isArray(doc.workstreams) ? doc.workstreams : []).map(w => w.id);
const clone = v => JSON.parse(JSON.stringify(v));
const backups = root => fs.readdirSync(root).filter(n => /^agent\.save-before-adopt-\d+\.json$/.test(n));
// what App.persist does: the window's state, stamped with this page's revision and writer, into the cache, then queued
function persist(cs, cache, doc) {
  const d = Object.assign(clone(doc), { _saveDirty: true, _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now() });
  cache.set('starnet.save', JSON.stringify(d)); cs.push(d);
  return d;
}
const tick = () => new Promise(r => setTimeout(r, 3));
// one window (`cs`) writes a first save; then the station writes its NEXT save (the window's request whose ACK is lost) and
// the window's cache moves on to a newer edit that was never sent. Returns { root, cache, head } before the window dies.
async function lostAckThenDeath(opts) {
  const root = workspace();
  const host = sidecar(root);
  const cache = new Map(); const cs = page(host, cache);
  await cs.reconcile(null);
  const first = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'S1', history: [turn('user', 'one')] }] });
  persist(cs, cache, first); A.eq(await cs.flush({ force: true }), true, 'fixture: the first save lands');
  await tick();
  // the window's next save is written by the station, but its acknowledgement never reaches the window
  const headDoc = Object.assign(clone(first), opts && opts.headExtra ? opts.headExtra(clone(first)) : {});
  headDoc.workstreams = headDoc.workstreams.concat([{ id: 'S2', history: [turn('user', 'two')] }]);
  const head = host.saveStore.save('agent', Object.assign({}, headDoc, { _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now(), _saveDirty: true }), { compareRevision: true });
  A.ok(head.ok === true, 'fixture: the station writes the window\'s unacknowledged save');
  await tick();
  // …and the window's cache holds its newest edit on the revision it last heard (never sent: the window dies here)
  const newest = clone(headDoc); newest.workstreams.push({ id: 'S3', history: [turn('user', 'three')] });
  const cached = Object.assign(newest, { _saveDirty: true, _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now() }, opts && opts.cacheExtra ? opts.cacheExtra : {});
  if (opts && opts.legacy) delete cached._saveClient;
  cache.set('starnet.save', JSON.stringify(cached));
  return { root, cache, head, writer: cs.writerId() };
}

(async () => {
  try {
    // ================= a. the window that wrote the head comes back with its newer work =================
    {
      const { root, cache, head } = await lostAckThenDeath();
      const host = sidecar(root);                                   // a fresh station process: the app reopened
      const Z = page(host, cache);
      const resumed = await Z.reconcile(JSON.parse(cache.get('starnet.save')));
      A.eq(titles(resumed), ['general', 'S1', 'S2', 'S3'], 'a: the reopened window resumes its newest work');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'a: no conflict — no other window wrote this station');
      A.eq(titles(host.saveStore.load('agent')), ['general', 'S1', 'S2', 'S3'], 'a: the station file now holds that work');
      A.eq(host.saveStore.load('agent')._saveRevision, head.revision + 1, 'a: as the next revision after the head the window wrote');
      A.eq(conflictFiles(root), [], 'a: nothing was preserved as a conflict');
      A.eq([Z.mergeNotice(), backups(root).length], [null, 0], 'a: and nothing needed merging');
      const next = persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'S4', history: [turn('user', 'four')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'a: the next save lands');
      A.eq(titles(host.saveStore.load('agent')), titles(next), 'a: and keeps landing');
      const cached = JSON.parse(cache.get('starnet.save'));
      A.eq([cached._saveDirty, cached._saveRevision], [false, host.saveStore.load('agent')._saveRevision], 'a: the browser cache is clean at the station revision');
    }

    // ================= b. a cache OLDER than the head that same window wrote gives way to the station file =================
    {
      const { root, cache } = await lostAckThenDeath({ cacheExtra: { updatedAt: 1 } });
      const stale = JSON.parse(cache.get('starnet.save')); stale.workstreams = stale.workstreams.filter(w => w.id !== 'S2' && w.id !== 'S3');
      cache.set('starnet.save', JSON.stringify(stale));             // the cache could not take the newer saves: it holds S1 only
      const before = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      const host = sidecar(root);
      const Z = page(host, cache);
      const resumed = await Z.reconcile(stale);
      A.eq(titles(resumed), ['general', 'S1', 'S2'], 'b: the window resumes the station file, which holds that window\'s newer save');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'b: no conflict');
      A.eq(fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8'), before, 'b: the older cache never replaced the station file');
      A.eq(JSON.parse(cache.get('starnet.save'))._saveDirty, false, 'b: the cache now holds the station file, clean');
    }

    // ================= c. a cache from 0.14.0 or earlier is MERGED at boot, never refused =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true,
        headExtra: d => ({ workstreams: d.workstreams.concat([{ id: 'only-on-station', history: [turn('user', 'made by a routine')] }, { id: 'deleted-in-window', history: [turn('user', 'x')] }]),
          stationStats: { ratingSyncAt: 50, xp: 70 }, agent: Object.assign({}, d.agent, { stats: { xp: 70 } }) }),
        cacheExtra: { deletedIds: ['deleted-in-window'], stationStats: { ratingSyncAt: 10, xp: 5 } } });
      const legacy = JSON.parse(cache.get('starnet.save'));
      legacy.workstreams = legacy.workstreams.filter(w => w.id !== 'only-on-station' && w.id !== 'deleted-in-window');
      legacy.agent = Object.assign({}, legacy.agent, { stats: { xp: 5 } });
      cache.set('starnet.save', JSON.stringify(legacy));
      A.ok(!('_saveClient' in legacy), 'fixture: the cache names no window (0.14.0)');
      const stationBefore = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      const host = sidecar(root);
      const Z = page(host, cache);
      const resumed = await Z.reconcile(legacy);
      A.eq(titles(resumed), ['general', 'S1', 'S2', 'S3', 'only-on-station'], 'c: the window resumes its own work with the station file\'s other session brought back');
      A.ok(!titles(resumed).includes('deleted-in-window'), 'c: a session deleted in the window stays deleted');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'c: no conflict latched');
      const durable = host.saveStore.load('agent');
      A.eq(titles(durable), titles(resumed), 'c: the station file holds exactly what the window resumed');
      A.eq([durable.stationStats.ratingSyncAt, durable.agent.stats.xp], [50, 70], 'c: the station\'s growth projection never goes behind its rating watermark');
      const note = Z.mergeNotice();
      A.ok(note && note.base === 'window' && note.added === 1 && /^agent\.save-before-adopt-\d+\.json$/.test(String(note.backup)), 'c: the merge is reported: the window was the base, one session came back, where the copy is (' + JSON.stringify(note) + ')');
      A.eq(backups(root).length, 1, 'c: the station file was copied aside first');
      A.eq(fs.readFileSync(path.join(root, note.backup), 'utf8'), stationBefore, 'c: byte for byte');
      A.eq(conflictFiles(root), [], 'c: nothing was preserved as a refused save');
      const next = persist(Z, cache, Object.assign(clone(resumed), { workstreams: resumed.workstreams.concat([{ id: 'after', history: [turn('user', 'after')] }]) }));
      A.eq(await Z.flush({ force: true }), true, 'c: the window\'s next save lands');
      A.eq(titles(host.saveStore.load('agent')), titles(next), 'c: with everything in it');
    }

    // ================= d. a station file saved AFTER the window is the base =================
    {
      const root = workspace();
      const host0 = sidecar(root);
      const cache = new Map(); const W = page(host0, cache);
      await W.reconcile(null);
      const start = stationDoc({ agents: [{ id: 'scout', name: 'SCOUT', approvalMode: 'full' }], workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }] });
      persist(W, cache, start); await W.flush({ force: true });
      // the window's last edit: cached, never sent (old build: no writer in the cache)
      const unsent = persist(W, cache, Object.assign(clone(start), { workstreams: start.workstreams.concat([{ id: 'unsent', history: [turn('user', 'mine')] }]) }));
      const legacy = Object.assign({}, unsent); delete legacy._saveClient; cache.set('starnet.save', JSON.stringify(legacy));
      await tick();
      // the app is closed; the terminal turns SCOUT's approval back to ASK (written on the save's own revision)
      const cur = host0.saveStore.load('agent');
      const patched = Object.assign(clone(cur), { updatedAt: Date.now() + 1000, _saveClient: 'approval-' + Date.now(), _saveDirty: false });
      patched.agents[0].approvalMode = 'ask';
      A.ok(host0.saveStore.save('agent', patched, { compareRevision: true }).ok, 'fixture: the terminal\'s approval change lands');
      const host = sidecar(root);
      const Z = page(host, cache);
      const resumed = await Z.reconcile(legacy);
      A.eq(resumed.agents[0].approvalMode, 'ask', 'd: the terminal\'s later approval change stands');
      A.eq(titles(resumed), ['general', 'unsent'], 'd: and the window\'s unsent session is added to it');
      await Z.flush({ force: true });
      A.eq(Z.health().conflict, null, 'd: no conflict latched');
      const note = Z.mergeNotice();
      A.ok(note && note.base === 'station' && note.added === 1 && typeof note.kept === 'string', 'd: reported with the station file as the base and where the window\'s whole save is kept (' + JSON.stringify(note) + ')');
      const kept = JSON.parse(fs.readFileSync(path.join(root, note.kept), 'utf8'));
      A.eq([kept.agents[0].approvalMode, titles(kept)], ['full', ['general', 'unsent']], 'd: the window\'s own save is kept whole beside the station');
    }

    // ================= e. a cache of ANOTHER station is never merged =================
    {
      const { root, cache } = await lostAckThenDeath({ legacy: true });
      const other = JSON.parse(cache.get('starnet.save')); other.agent = { id: 'agent', name: 'SOL', createdAt: 999999 };
      cache.set('starnet.save', JSON.stringify(other));
      const before = fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8');
      const host = sidecar(root);
      const Z = page(host, cache);
      await Z.reconcile(other);
      A.eq(await Z.flush({ force: true }), false, 'e: another station\'s copy is refused');
      A.ok(Z.health().conflict && Z.health().conflict.conflict === true, 'e: as a conflict');
      A.eq(fs.readFileSync(path.join(root, 'agent.save.json'), 'utf8'), before, 'e: the station file is untouched');
      A.eq([Z.mergeNotice(), backups(root).length], [null, 0], 'e: nothing was merged');
      A.eq(conflictFiles(root).length, 1, 'e: the copy is preserved beside the station');
    }
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e));
  } finally {
    K.cleanup();
  }
  A.report('save-adopt-merge');
})();
