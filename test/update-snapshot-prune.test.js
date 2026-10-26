/* node test/update-snapshot-prune.test.js — pre-update recovery points are pruned to the newest three (bug 31db37b0).

   Every INSTALL UPDATE attempt (retries and failed installs too) wrote another whole-station bundle into
   update-snapshots and nothing ever removed one: one station held 670 MB in 7 read-only bundles. After a VERIFIED
   prepare, and once at boot, the newest three bundles + their receipts stay and the older ones go. Only
   `pre-*.starnet-backup.json` and its `.receipt.json` are ever touched, the bundle the prepare just verified (or the
   live receipt's) is never removed, read-only files are made writable first, and a file that cannot be removed is
   reported and left without failing the update. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../sidecar/station-recovery.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const Prep = require('../sidecar/update-preparation.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-snapshot-prune-'));
const ws = path.join(sandbox, 'workspaces');
const snaps = path.join(sandbox, 'update-snapshots');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'agent.save.json'), JSON.stringify({ version: 1, agentId: 'agent', updatedAt: 1, doc: { agent: { id: 'agent' } } }));

const DAY = 24 * 3600 * 1000;
const BASE = Date.parse('2026-01-01T00:00:00Z');
// an old bundle + receipt, read-only like prepare leaves them, with an mtime `ageDays` after BASE
function seed(version, ageDays, opts) {
  fs.mkdirSync(snaps, { recursive: true });
  const name = 'pre-' + version + '-' + (BASE + ageDays * DAY) + '-old.starnet-backup.json';
  const file = path.join(snaps, name);
  fs.writeFileSync(file, '{"schema":"starnet.station-recovery"}');
  if (!(opts && opts.noReceipt)) fs.writeFileSync(file + '.receipt.json', '{}');
  const t = new Date(BASE + ageDays * DAY);
  for (const f of [file, file + '.receipt.json']) {
    if (!fs.existsSync(f)) continue;
    fs.utimesSync(f, t, t);
    fs.chmodSync(f, 0o400);
  }
  return name;
}
const bundlesNow = () => (fs.existsSync(snaps) ? fs.readdirSync(snaps) : []).filter(n => /^pre-.+\.starnet-backup\.json$/.test(n) && fs.statSync(path.join(snaps, n)).isFile()).sort();
const exists = n => fs.existsSync(path.join(snaps, n));
function reset() {
  if (fs.existsSync(snaps)) {
    for (const n of fs.readdirSync(snaps)) { try { fs.chmodSync(path.join(snaps, n), 0o666); } catch (e) { console.log('chmod ' + n + ': ' + e.code); } }
    fs.rmSync(snaps, { recursive: true, force: true });
  }
}
function makePrep(extra) {
  let clock = Date.now();
  return Prep.makeUpdatePreparation(Object.assign({
    fs, path, recovery: R, writeDurable: writeFileDurable, workspaceRoot: ws,
    now: () => clock, newId: () => 'new', appVersion: () => '0.14.0', sleep: async () => { clock += 25; }
  }, extra || {}));
}

(async () => {
  try {
    A.eq(Prep.KEEP_SNAPSHOTS, 3, 'the newest three pre-update recovery points are kept');

    // ---- 1. the boot pass: 6 old bundles -> the newest 3 stay with their receipts; nothing else in the folder is touched
    const old = [seed('0.10.7', 1), seed('0.11.0', 2), seed('0.11.4', 3), seed('0.12.0', 4), seed('0.12.3', 5), seed('0.12.5', 6)];
    fs.writeFileSync(path.join(snaps, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(snaps, 'pre-0.9.0-1-x.starnet-backup.json.tmp-123-abcd'), 'partial');
    fs.writeFileSync(path.join(snaps, 'station.starnet-backup.json'), '{}');          // a user's own export, not a pre-update bundle
    fs.writeFileSync(path.join(snaps, 'pre-gone.starnet-backup.json.receipt.json'), '{}');   // an orphan receipt
    fs.mkdirSync(path.join(snaps, 'pre-folder.starnet-backup.json'));                 // a directory with a bundle's name
    const boot = makePrep();
    const pass = boot.pruneSnapshots();
    A.eq(bundlesNow(), old.slice(3).sort(), 'the boot pass keeps exactly the three newest bundles');
    for (const n of old.slice(0, 3)) {
      A.eq(exists(n), false, 'an older bundle is removed even though it was read-only: ' + n);
      A.eq(exists(n + '.receipt.json'), false, 'and its receipt with it');
    }
    for (const n of old.slice(3)) A.eq(exists(n + '.receipt.json'), true, 'a kept bundle keeps its receipt: ' + n);
    A.eq(pass.removed.length, 6, 'the pass reports the 3 bundles + 3 receipts it removed');
    A.eq(pass.errors, [], 'with no errors');
    for (const n of ['notes.txt', 'pre-0.9.0-1-x.starnet-backup.json.tmp-123-abcd', 'station.starnet-backup.json', 'pre-gone.starnet-backup.json.receipt.json', 'pre-folder.starnet-backup.json']) {
      A.eq(exists(n), true, 'nothing else in update-snapshots is touched: ' + n);
    }
    A.eq(makePrep().pruneSnapshots().removed, [], 'a second pass removes nothing');

    // ---- 2. a verified prepare keeps itself + the two newest older ones
    const prep = makePrep();
    const made = await prep.prepare({ targetVersion: '0.14.1', browserStore: {} });
    A.eq(made.ok, true, 'prepare succeeds');
    const mine = path.basename(made.receipt.snapshot.file);
    A.eq(bundlesNow(), [old[4], old[5], mine].sort(), 'after a verified prepare: this recovery point + the two newest older ones');
    A.eq(fs.existsSync(made.receipt.receiptFile), true, 'the receipt this prepare returned is on disk');
    A.eq(exists(old[3]) || exists(old[3] + '.receipt.json'), false, 'the oldest remaining bundle and its receipt went');
    A.eq(made.pruned, 2, 'prepare reports what it pruned');
    // the boot-time pass while frozen on a live receipt never removes that receipt's bundle, even keeping just one
    const keepOne = boot.pruneSnapshots.call(null);
    A.eq(keepOne.errors, [], 'a pass from another instance runs clean');
    const frozenPass = Prep.pruneSnapshots({ fs, path, dir: snaps, keep: 1, protect: [made.receipt.snapshot.file] });
    A.eq(bundlesNow(), [mine], 'keep:1 with the live receipt protected keeps exactly the live recovery point');
    A.eq(fs.existsSync(made.receipt.receiptFile), true, 'and its receipt');
    A.eq(frozenPass.errors, [], 'cleanly');
    prep.cancel();
    reset();

    // ---- 3. clock skew: older bundles stamped in the FUTURE never push out the one this prepare just verified
    const future = Date.now() + 365 * DAY;
    const skewed = [];
    for (let i = 0; i < 4; i++) {
      const n = seed('0.13.' + i, 0);
      const t = new Date(future + i * DAY);
      fs.chmodSync(path.join(snaps, n), 0o600); fs.utimesSync(path.join(snaps, n), t, t); fs.chmodSync(path.join(snaps, n), 0o400);
      skewed.push(n);
    }
    const skewPrep = makePrep();
    const skewMade = await skewPrep.prepare({ targetVersion: '0.14.1', browserStore: {} });
    A.eq(skewMade.ok, true, 'prepare succeeds under clock skew');
    A.eq(bundlesNow(), [path.basename(skewMade.receipt.snapshot.file), skewed[2], skewed[3]].sort(), 'the verified recovery point is always kept, plus the two newest others');
    skewPrep.cancel();
    reset();

    // ---- 4. a file that cannot be removed is reported and left; the update is not failed by it
    const locked = [seed('0.12.0', 1), seed('0.12.1', 2), seed('0.12.2', 3), seed('0.12.3', 4)];
    const lockedReceipt = path.join(snaps, locked[0] + '.receipt.json');
    const fsLocked = new Proxy(fs, { get(t, p) {
      if (p === 'unlinkSync') return f => { if (path.resolve(f) === path.resolve(lockedReceipt)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.unlinkSync(f); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    const lockedPrep = makePrep({ fs: fsLocked });
    const lockedMade = await lockedPrep.prepare({ targetVersion: '0.14.1', browserStore: {} });
    A.eq(lockedMade.ok, true, 'a locked old receipt never fails the update');
    A.eq(exists(locked[0]), true, 'its bundle stays (removed only together with its receipt, on a later pass)');
    A.eq(exists(locked[1]) || exists(locked[1] + '.receipt.json'), false, 'the other surplus bundle still goes');
    lockedPrep.cancel();
    const retry = makePrep().pruneSnapshots();
    A.eq(exists(locked[0]), false, 'the next pass removes the formerly locked one');
    A.eq(retry.errors, [], 'cleanly');

    A.report('update-snapshot-prune.test');
  } finally {
    reset();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
