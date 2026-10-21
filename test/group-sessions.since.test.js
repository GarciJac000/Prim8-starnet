'use strict';
/* group-sessions.since.test.js — the open group chat's poll asks "since" (idle CPU piece 3, 2026-10-20).
   The open group re-read its whole group every 0.9 s, and nearly every answer was the group it already had. get(id, since)
   now answers { unchanged: true } when nothing a reader can see has moved, and the full group (with a fresh stamp) when
   anything has: a committed write (revision), a streamed draft, the end of a draft, or a restart (boot recovery rewrites
   turn states without a revision bump). Real module, real fs in a temp dir, fake runner. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-since-'));
let sequence = 0, execute;
const deps = { fs, path, root, now: () => ++sequence, id: () => 's' + (++sequence), log: () => {}, sweepMs: 1e9,
  roster: () => [{ id: 'agent', name: 'Lead' }, { id: 'research', name: 'Researcher' }],
  execute: async o => { o.emit('agent.run.start', { runId: o.runId }); return execute(o); },
  readFile: async () => ({ name: 'r.md', content: 'aGk=', bytes: 2, hash: 'h' }), decodeFile: f => ({ text: 'hi', hash: f.hash }),
  uploadFile: (name, content) => ({ name, content, hash: 'h' + content.length }) };
async function waitFor(fn) { for (let n = 0; n < 400; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); }

(async () => {
  let api = makeGroupSessions(deps); await api.ready;
  const g = await api.create({ members: ['agent', 'research'] });
  const other = await api.create({ members: ['agent'] });

  // a read carries its stamp; the same stamp back answers unchanged, with nothing else in it
  const first = await api.get(g.id);
  assert.equal(typeof first.stamp, 'string', 'a full read carries a stamp');
  assert.ok(first.stamp.length > 0 && Array.isArray(first.messages), 'the full read is the whole group');
  const same = await api.get(g.id, first.stamp);
  assert.deepEqual(same, { id: g.id, unchanged: true, stamp: first.stamp }, 'the same stamp back: { unchanged: true } and nothing more');
  assert.deepEqual(Object.keys(await api.get(g.id, '')).includes('messages'), true, 'no since: the full group, as before');
  assert.equal((await api.get(g.id, 'stale.1.0')).unchanged, undefined, 'a stamp that is not current: the full group');

  // a committed write (a message → a queued turn) moves the stamp
  let release, streamedOnce;
  const gate = new Promise(r => { release = r; });
  const tokened = new Promise(r => { streamedOnce = r; });
  execute = async o => {
    o.emit('agent.token', { runId: o.runId, delta: 'Thinking about it' });
    streamedOnce();
    await gate;
    o.emit('agent.token', { runId: o.runId, delta: ' — more' });
    return { reason: 'done', messages: [{ role: 'assistant', content: 'Thinking about it — more' }] };
  };
  const sent = await api.send(g.id, { key: 'k1', text: 'hello group' });
  assert.ok(sent.revision > first.revision, 'fixture: the send bumped the revision');
  const afterSend = await api.get(g.id, first.stamp);
  assert.ok(afterSend.messages && afterSend.messages.some(m => m.content === 'hello group'), 'after a committed write the old stamp gets the full group');
  assert.notEqual(afterSend.stamp, first.stamp, '…with a new stamp');

  // a streamed draft moves the stamp without a revision bump
  await tokened;
  await waitFor(async () => (await api.get(g.id)).turns.some(t => t.state === 'running' && t.draft));
  const drafting = await api.get(g.id);
  assert.equal(drafting.turns.find(t => t.draft).draft, 'Thinking about it', 'fixture: the draft is visible');
  assert.equal((await api.get(g.id, drafting.stamp)).unchanged, true, 'nothing moved since: unchanged');
  // another group's stamp is untouched by this group's stream
  const otherFirst = await api.get(other.id);
  release();
  await api.idle(g.id);
  assert.equal((await api.get(other.id, otherFirst.stamp)).unchanged, true, 'one group streaming never makes another group re-send');
  const done = await api.get(g.id, drafting.stamp);
  assert.ok(done.messages, 'after more tokens and the end of the turn the old stamp gets the full group');
  assert.ok(!done.turns.some(t => t.draft), 'the draft is gone with the finished turn');
  assert.ok(done.messages.some(m => m.content === 'Thinking about it — more'), 'and the reply is posted');

  // a draft write alone (same revision) moves the stamp: drive the module's own draft path and compare
  execute = async o => {
    o.emit('agent.token', { runId: o.runId, delta: 'one' });
    await new Promise(r => setTimeout(r, 30));
    o.emit('agent.token', { runId: o.runId, delta: ' two' });
    await new Promise(r => setTimeout(r, 30));
    return { reason: 'done', messages: [{ role: 'assistant', content: 'one two' }] };
  };
  await api.send(g.id, { key: 'k2', text: 'again' });
  await waitFor(async () => (await api.get(g.id)).turns.some(t => t.draft === 'one'));
  const one = await api.get(g.id);
  await waitFor(async () => (await api.get(g.id)).turns.some(t => t.draft === 'one two'));
  const two = await api.get(g.id, one.stamp);
  assert.equal(two.revision, one.revision, 'fixture: no committed write between the two tokens');
  assert.ok(two.turns && two.turns.some(t => t.draft === 'one two'), 'a streamed token at the same revision is a full answer with the new draft');
  await api.idle(g.id);

  // a restart over the same workspace: the old stamp never reads as unchanged, even at an equal revision
  const before = await api.get(g.id);
  api.close();
  const restarted = makeGroupSessions(deps); await restarted.ready;
  const back = await restarted.get(g.id, before.stamp);
  assert.ok(back.messages, 'after a restart the previous boot\'s stamp gets the full group');
  assert.equal(back.revision, before.revision, 'fixture: at the same revision');
  assert.notEqual(back.stamp, before.stamp, 'the stamp carries the boot');
  assert.equal((await restarted.get(g.id, back.stamp)).unchanged, true, 'and the new boot\'s stamp works as before');
  restarted.close();

  // the stamp is exact only if every draft write goes through setDraft/dropDraft
  const src = fs.readFileSync(path.join(__dirname, '../sidecar/group-sessions.js'), 'utf8');
  const raw = src.split('\n').filter(l => /drafts\.(set|delete|clear)\(/.test(l) && !/function (setDraft|dropDraft)/.test(l));
  assert.deepEqual(raw, [], 'no raw drafts.set / drafts.delete outside setDraft / dropDraft');

  console.log('group-sessions.since: unchanged answers, committed writes, streamed drafts, per-group stamps and restarts PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
