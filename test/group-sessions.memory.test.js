'use strict';
/* group-sessions.memory.test.js — the committed group state lives in memory (idle-CPU pass 2026-10-19).
   The open group's poll, the station-wide list, the 5 s sweep and every pump step used to re-read and re-parse the WHOLE
   group-sessions.json (shared files inline as base64) and clone the group once or twice more. Real module, real fs (a
   counting facade over it), fake runner.
   A. IDLE READS NOTHING: after boot, get/list/sweep/file never read group-sessions.json; a whole turn (pump, the group
      tools, a judgment question, an approval) reads it only as each durable write's own pre-image check (2 per write).
   B. NO IN-PLACE MUTATION: the snapshot a turn started from (the one handed to execute) is byte-for-byte unchanged after
      every later commit, and a mixed workload with every committed snapshot deep-frozen finishes with no TypeError.
   C. ATOMIC FAILURE: a refused mutator or a failed durable write leaves memory AND disk at the previous commit.
   D. MEMORY = DISK: the committed snapshot is exactly the file's JSON (no undefined keys), and a restart reads it back.
   E. An E-STOP that lands before boot settles still persists the pause. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-'));
const MAIN = path.join(root, 'group-sessions.json');
const io = { reads: 0, writes: 0, failRename: false, committed: [] };
const same = p => path.resolve(String(p)) === MAIN;
const cfs = { ...fs,
  readFileSync: (p, ...rest) => { if (same(p)) io.reads++; return fs.readFileSync(p, ...rest); },
  renameSync: (from, to) => {
    if (same(to)) { if (io.failRename) throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); io.writes++; io.committed.push(fs.readFileSync(from, 'utf8')); }
    return fs.renameSync(from, to);
  } };
let sequence = 0, execute, api;
const seen = [], logs = [], problems = [];
const deps = { fs: cfs, path, root, now: () => ++sequence, id: () => 'm' + (++sequence), log: m => logs.push(m),
  roster: () => [{ id: 'agent', name: 'Lead' }, { id: 'research', name: 'Researcher' }, { id: 'engineer', name: 'Engineer' }],
  execute: async o => { seen.push({ o, at: JSON.stringify(o.g) }); o.emit('agent.run.start', { runId: o.runId }); return execute(o); },
  // `encoding: undefined` on purpose: attach and a conversion spread it into the record, and the committed copy must not
  // keep a key the file does not hold
  readFile: async () => ({ name: 'result.md', content: 'aGVsbG8=', encoding: undefined, bytes: 5, hash: 'hash' }),
  decodeFile: f => ({ text: Buffer.from(f.content, 'base64').toString(), hash: f.hash }),
  uploadFile: (name, content) => ({ name, content, encoding: undefined, hash: 'h' + content.length }) };
const finish = content => ({ reason: 'done', messages: [{ role: 'assistant', content }] });
const disk = () => JSON.parse(fs.readFileSync(MAIN, 'utf8'));
const pub = g => ({ ...g, artifacts: g.artifacts.map(({ content, ...a }) => a) });
async function waitFor(fn) { for (let n = 0; n < 200; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); }

(async () => {
  try {
    /* ---- A. idle reads nothing; a turn reads only for its own writes ---- */
    api = makeGroupSessions({ ...deps, sweepMs: 1e9 }); await api.ready;
    execute = async () => finish('Hello');
    const g = await api.create({ members: ['agent', 'research', 'engineer'] });
    const up = await api.attach(g.id, { name: 'notes.txt', content: 'bm90ZXM=' });
    io.reads = 0; io.writes = 0;
    for (let n = 0; n < 10; n++) { await api.get(g.id); await api.list(); }
    for (let n = 0; n < 5; n++) await api.sweep();
    for (let n = 0; n < 3; n++) assert.equal((await api.file(g.id, up.artifacts[0].id)).content, 'bm90ZXM=');
    assert.deepEqual([io.reads, io.writes], [0, 0], 'polls, the station-wide list, the sweep and file downloads read nothing from disk');

    let answered = null;
    execute = async o => {
      if (o.t.agentId === 'research') {
        const tools = Object.fromEntries(o.tools.map(t => [t.name, t]));
        const pubd = JSON.parse((await tools['group.publish'].run({ path: 'result.md' })).content);
        assert.equal(pubd.content, undefined, 'the publish receipt never carries the bytes');
        assert.equal(JSON.parse((await tools['group.read'].run({ artifactId: pubd.id })).content).text, 'hello');
        assert.equal((await o.prompt({ tool: 'fs.write', argsSummary: 'x' })), 'once');
        answered = await o.askCommander({ question: 'Which format?', options: ['Short', 'Long'] });
        assert.ok(!(await tools['group.handoff'].run({ agentId: 'engineer', request: 'Review the file' })).isError);
      }
      return finish('done by ' + o.t.agentId);
    };
    await api.send(g.id, { key: 'turn', text: '@Researcher share it' });
    await waitFor(async () => (await api.get(g.id)).turns.some(t => t.approval));
    const ap = (await api.get(g.id)).turns.find(t => t.approval).approval;
    await api.answer(g.id, { promptId: ap.promptId, decision: 'once' });
    await waitFor(async () => ((await api.get(g.id)).questions || []).some(q => q.state === 'pending'));
    const q = (await api.get(g.id)).questions.find(x => x.state === 'pending');
    await api.answerQuestion(g.id, { questionId: q.id, text: 'Short' });
    await api.idle(g.id);
    assert.equal(answered && answered.text, 'Short');
    const done = await api.get(g.id);
    assert.deepEqual(done.turns.map(t => [t.agentId, t.state]), [['research', 'completed'], ['engineer', 'completed']]);
    assert.ok(io.writes >= 8, 'the turn committed its claim, run start, approval, question, answer, handoff, publish and result (' + io.writes + ')');
    // one pre-image read per durable write (writeJsonResilient reads the current main once since perf 10-19; it was two)
    assert.equal(io.reads, io.writes, 'every read of the file was a durable write\'s own pre-image check, never pump/ask/tools state');

    /* ---- B. the snapshot a turn started from is never touched by a later commit ---- */
    assert.ok(seen.length >= 2);
    for (const s of seen) assert.equal(JSON.stringify(s.o.g), s.at, 'the committed snapshot handed to execute is unchanged after every later write');
    /* ---- D. the committed snapshot IS the file's JSON, key for key ---- */
    for (const s of seen) assert.deepStrictEqual(JSON.parse(JSON.stringify(s.o.g)), s.o.g, 'committed state holds no undefined/non-JSON values');
    for (const s of seen) assert.ok(io.committed.some(text => isDeepStrictEqual(JSON.parse(text).groups[s.o.g.id], s.o.g)), 'what a turn started from is exactly a group the file held');
    const artifact = seen.at(-1).o.g.artifacts.find(a => a.name === 'notes.txt');
    assert.ok(artifact && !('encoding' in artifact), 'an undefined field from uploadFile never survives into the committed copy');
    // get() also names the group's stamp (idle CPU piece 3, 2026-10-20: the open group's poll asks "since"); it is transport
    // metadata, not group state, so the file holds everything else
    const unstamped = ({ stamp, ...g }) => g;
    assert.deepStrictEqual(unstamped(await api.get(g.id)), pub(disk().groups[g.id]), 'what the API serves is what the file holds');
    assert.deepStrictEqual((await api.list()).templates, disk().templates);
    // a group's very FIRST commit: a conversion with a kickoff hands that snapshot straight to its lead's turn
    execute = async () => finish('parts handed out');
    const conv = await api.create({ id: 'conv', conversionKey: 'conv', originalAgentId: 'agent', members: ['agent', 'research'], kickoff: 'Hand out the parts',
      history: [{ role: 'user', content: 'see the file', attachments: [{ path: 'notes.md', name: 'notes.md' }] }] });
    await api.idle(conv.id);
    const first = seen.at(-1).o.g;
    assert.equal(first.id, conv.id); assert.equal(first.artifacts.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first, 'the first commit of a group holds no undefined key either');
    assert.ok(io.committed.some(text => isDeepStrictEqual(JSON.parse(text).groups[conv.id], first)), 'and is exactly what the file held');

    /* ---- C. a refused mutator and a failed durable write change nothing ---- */
    let before = await api.get(g.id), raw = fs.readFileSync(MAIN, 'utf8');
    // a membership change that would retire work, a title, then a refused value: the half-applied copy is thrown away
    await assert.rejects(api.configure(g.id, { revision: before.revision, members: ['agent'], title: 'Half done', maxTurns: 0 }), /1–100/);
    assert.deepStrictEqual(await api.get(g.id), before, 'memory is unchanged after a refused write');
    assert.equal(fs.readFileSync(MAIN, 'utf8'), raw, 'and so is the disk');
    await api.control(g.id, { action: 'pause' });
    before = await api.get(g.id); raw = fs.readFileSync(MAIN, 'utf8');
    io.failRename = true;
    await assert.rejects(api.send(g.id, { key: 'lost', text: 'never saved' }), /injected EIO/);
    io.failRename = false;
    assert.deepStrictEqual(await api.get(g.id), before, 'a failed durable write never shows a message the file does not hold');
    assert.equal(fs.readFileSync(MAIN, 'utf8'), raw);
    await api.send(g.id, { key: 'lost', text: 'never saved' });
    assert.equal((await api.get(g.id)).messages.filter(m => m.key === 'lost').length, 1, 'the retried send lands exactly once');
    const live = await api.get(g.id);
    api.close();
    api = makeGroupSessions({ ...deps, sweepMs: 1e9 }); await api.ready;
    const reread = await api.get(g.id);
    assert.deepStrictEqual(unstamped(reread), unstamped(live), 'a restart reads back exactly the group the old process served');
    assert.notEqual(reread.stamp, live.stamp, '…under a new boot stamp, so a poll holding the old one gets the full group');

    /* ---- B (frozen). every committed snapshot deep-frozen: a mixed workload writes nothing in place ---- */
    api.close();
    api = makeGroupSessions({ ...deps, sweepMs: 1e9, freezeCommitted: true }); await api.ready;
    const f = await api.create({ members: ['agent', 'research', 'engineer'] });
    const tool = async (o, name, args) => { const r = await o.tools.find(t => t.name === name).run(args); if (r.isError) problems.push(name + ': ' + r.content); return r; };
    execute = async o => {
      if (!Object.isFrozen(o.g) || !Object.isFrozen(o.t)) problems.push('the frozen seam is off');
      if (o.t.agentId === 'agent' && !o.t.parent) {
        await tool(o, 'group.publish', { path: 'result.md' });
        await tool(o, 'group.handoff', { agentId: 'research', request: 'Check it ' + o.t.id });
      }
      if (o.t.agentId === 'engineer') { await o.prompt({ tool: 'fs.write', argsSummary: 'y' }); await o.askCommander({ question: 'Tone?', options: ['Dry'] }); }
      return finish('ok ' + o.t.agentId);
    };
    await api.send(f.id, { key: 'f1', text: 'start' }); await api.idle(f.id);
    await api.send(f.id, { key: 'f2', text: '@engineer go' });
    await waitFor(async () => (await api.get(f.id)).turns.some(t => t.approval));
    await api.answer(f.id, { promptId: (await api.get(f.id)).turns.find(t => t.approval).approval.promptId, decision: 'deny' });
    await waitFor(async () => ((await api.get(f.id)).questions || []).some(x => x.state === 'pending'));
    await api.answerQuestion(f.id, { questionId: (await api.get(f.id)).questions.find(x => x.state === 'pending').id, text: 'Dry' });
    await api.idle(f.id);
    const fa = await api.attach(f.id, { key: 'k', name: 'a.txt', content: 'YQ==' });
    await api.send(f.id, { key: 'f3', text: 'with file', artifactIds: [fa.artifacts.at(-1).id] }); await api.idle(f.id);
    let cur = await api.get(f.id);
    await api.configure(f.id, { revision: cur.revision, title: 'Renamed', instructions: 'Be brief', maxTurns: 3 });
    await api.control(f.id, { action: 'save-group', title: 'Crew' });
    await api.control(f.id, { action: 'save-group', title: 'Crew' });
    await api.invite(f.id, { agentId: 'engineer' });
    await api.control(f.id, { action: 'pause' });
    await api.send(f.id, { key: 'f4', text: 'queued while paused' });
    await api.control(f.id, { action: 'stop-all' });
    cur = await api.get(f.id);
    await api.control(f.id, { action: 'retry', turnId: cur.turns.find(t => t.state === 'stopped').id }); await api.idle(f.id);
    const branch = await api.fork(f.id, {});
    await api.dropAgent('research');
    await api.halt();
    await api.control(f.id, { action: 'resume' });
    await api.control(branch.id, { action: 'delete' });
    await assert.rejects(api.get(branch.id), /not found/);
    cur = await api.get(f.id);
    assert.equal(cur.title, 'Renamed'); assert.deepEqual(cur.members, ['agent', 'engineer']);
    assert.equal((await api.list()).templates.length, 1, 'save-group replaced its template, never pushed into the shared array');
    assert.deepStrictEqual(unstamped(cur), pub(disk().groups[f.id]), 'frozen run: memory and disk still agree');
    const inPlace = /read.only|frozen|not extensible|Cannot (assign|add|delete|define)/i;
    assert.deepEqual(problems, [], 'every tool call and every frozen check passed');
    assert.deepEqual(logs.filter(m => inPlace.test(m)), [], 'no worker died writing to a committed snapshot');
    assert.deepEqual(cur.turns.filter(t => t.state === 'failed' || inPlace.test(t.reason || '')).map(t => t.reason), [], 'no turn failed on one');
    assert.ok(cur.turns.filter(t => t.state === 'completed').length >= 6, 'and the workload really ran (' + cur.turns.map(t => t.state).join(',') + ')');
    api.close();

    /* ---- E. E-STOP before boot settles ---- */
    const e = makeGroupSessions({ ...deps, sweepMs: 1e9 });
    await e.halt();
    assert.equal((await e.get(f.id)).paused, true, 'the pause is committed in memory');
    assert.equal(disk().groups[f.id].paused, true, 'and on disk');
    e.close();
    api = null;
    console.log('group-sessions.memory: idle reads nothing, turns read only their own writes, snapshots never mutated (frozen run), refused and failed writes atomic, memory = disk, E-STOP before boot PASS');
  } finally { api?.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
