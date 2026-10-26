'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeSaveStore } = require('../sidecar/savestore.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-cas-'));
const deps = { fs, pathMod: path, root, clock: { now: () => 1000 } };
try {
  let store = makeSaveStore(deps);
  const save = doc => store.save('agent', doc, { compareRevision: true });
  const baseline = { agent: { id: 'agent' }, updatedAt: 1, workstreams: [] };
  // review 10-23 #2: a first save on an EMPTY file takes the clock revision (here 1000), never 1, so no stale window of a
  // station that was there before can hold a number the new line reaches
  const R = save(baseline).revision - 1;
  assert.equal(R + 1, 1000, 'a first save on an empty file takes the clock revision');
  const a = structuredClone(store.load('agent')), b = structuredClone(a);
  a.updatedAt = 2; a.workstreams.push({ id: 'a', history: ['A'] });
  assert.equal(save(a).revision, R + 2);
  assert.equal(save(a).revision, R + 2, 'lost response retry is idempotent');
  b.updatedAt = 9000; b.workstreams.push({ id: 'b', history: ['B'] });
  const conflict = save(b);
  assert.equal(conflict.conflict, true, 'a fresh timestamp cannot disguise a stale read');
  assert.deepEqual(store.load('agent').workstreams, a.workstreams, 'current station remains unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, conflict.recovery))).workstreams, b.workstreams, 'conflicting work is durably recoverable');
  assert.equal(save({ ...baseline, updatedAt: 9999 }).conflict, true, 'unversioned old clients cannot bypass CAS');
  store = makeSaveStore(deps);
  assert.equal(store.load('agent')._saveRevision, R + 2, 'revision survives restart');
  const current = store.load('agent'); current.updatedAt = -10; current.workstreams.push({ id: 'c' });
  assert.equal(save(current).revision, R + 3, 'reload permits a new edit');
  assert.equal(save(current).revision, R + 3, 'a replay remains idempotent after server clock correction');
  // support report 2026-10-21: a window whose acknowledgement arrived too late still holds revision 3, while the
  // station already holds that window's write as revision 4. Its next save is its own newer work, not a conflict.
  const win = (id, at, extra) => ({ ...structuredClone(current), _saveRevision: R + 3, _saveClient: id, updatedAt: at, ...(extra || {}) });
  assert.equal(save(win('window-a', 100, { workstreams: [{ id: 'late' }] })).revision, R + 4, 'the late-acknowledged write lands');
  assert.equal(save(win('window-a', 200, { workstreams: [{ id: 'late' }, { id: 'next' }] })).revision, R + 5, 'the same window builds on its own unacknowledged write');
  assert.deepEqual(store.load('agent').workstreams.map(w => w.id), ['late', 'next']);
  assert.equal(save(win('window-a', 150, { workstreams: [{ id: 'older' }] })).conflict, true, 'a delayed older request from that window never replaces its newer save');
  assert.equal(save(win('window-b', 900, { workstreams: [] })).conflict, true, 'another window on the old revision is still a conflict');
  assert.equal(save(win('window-c', 400, { _saveRevision: R + 5 })).revision, R + 6);
  assert.equal(save(win('window-a', 500)).conflict, true, 'once another window has written, the first window is behind for real');
  assert.deepEqual(store.load('agent').workstreams.map(w => w.id), ['a', 'c'], 'window-c\'s save stands');
  assert.equal(save(win('window-c', 600, { _saveRevision: R + 6, workstreams: [{ id: 'c-late' }] })).revision, R + 7);
  store = makeSaveStore(deps);
  assert.equal(save(win('window-c', 700, { _saveRevision: R + 6 })).conflict, true, 'after a restart the store cannot vouch for the head: preserved, never accepted');
  assert.deepEqual(store.load('agent').workstreams.map(w => w.id), ['c-late']);
  // conflict snapshots are bounded (audit 2026-09-25 #18): the newest N per agent survive, the rest are pruned
  const small = makeSaveStore({ ...deps, conflictKeep: 3 });
  const conflictsFor = id => fs.readdirSync(root).filter(n => n.indexOf(id + '.save-conflict-') === 0);
  fs.writeFileSync(path.join(root, 'other.save-conflict-keep.json'), '{}');
  const stale = small.load('agent');
  let last;
  for (let i = 0; i < 12; i++) {
    const doc = { ...stale, _saveRevision: 1, _saveClient: 'client' + String(i).padStart(2, '0'), workstreams: [{ id: 'w' + i }] };
    last = small.save('agent', doc, { compareRevision: true });
    assert.equal(last.conflict, true, 'each stale save is still refused and recorded');
    const when = new Date(Date.now() + (i + 1) * 60000);   // strictly increasing mtimes, newer than the earlier conflicts
    fs.utimesSync(path.join(root, last.recovery), when, when);
  }
  const kept = conflictsFor('agent').sort();
  assert.equal(kept.length, 3, 'only the newest 3 conflict snapshots are kept (got ' + kept.length + ')');
  assert.ok(kept.indexOf(last.recovery) >= 0, 'the snapshot just written is always kept');
  assert.deepEqual(kept, ['agent.save-conflict-client09.json', 'agent.save-conflict-client10.json', 'agent.save-conflict-client11.json'], 'the newest ones are the ones kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, last.recovery))).workstreams, [{ id: 'w11' }], 'the kept snapshot is intact');
  assert.equal(conflictsFor('other').length, 1, 'another agent\'s conflict snapshots are never touched');
  console.log('save-concurrency: stale edits, durable recovery, replay, old clients, restart and bounded conflicts PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
