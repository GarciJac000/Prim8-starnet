'use strict';
/* run-streams.test.js — the page's ONE run stream (sidecar/run-streams.js): every run a page watches rides one response,
   so a browser's six connections per host are never spent one per live run (2026-10-21: five paused conversations + the
   SSE bridge left Approve/Deny no connection). Pins the wire (ready line, keyed run lines, end line, keepalive), the
   watcher law (the stream closing or a withdrawal is that run's response closing), and that a withdrawal which beats its
   run refuses the run. */
const A = require('./_assert.js');
const { EventEmitter } = require('node:events');
const { makeRunStreams, runStreamOf, KEY_RE } = require('../sidecar/run-streams.js');

function fakeRes() {
  const r = new EventEmitter();
  r.chunks = []; r.writableEnded = false; r.destroyed = false;
  r.write = (c) => { if (r.writableEnded) throw new Error('write after end'); r.chunks.push(String(c)); return true; };
  r.lines = () => r.chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return r;
}
function harness() {
  const timers = [];
  let n = 0;
  const rs = makeRunStreams({
    uuid: () => 'stream-' + (++n), keepAliveMs: 1000,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; }
  });
  return { rs, timers };
}
const KEY = 'k1aaaaaaaaaa', KEY2 = 'k2bbbbbbbbbb';

// ---- open: the ready line names the stream; a keepalive interval is armed and writes a blank line ----
{
  const { rs, timers } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  A.eq(id, 'stream-1', 'the injected id source names the stream');
  A.eq(res.lines()[0].stream, 'ready', 'the first line says the stream is ready');
  A.eq(res.lines()[0].id, id, '…and names the id the page puts on its runs');
  A.eq(rs.size(), 1, 'one stream registered');
  A.eq(timers.length, 1, 'a keepalive timer is armed');
  timers[0].fn();
  A.eq(res.chunks[res.chunks.length - 1], '\n', 'keepalive is a blank line (every NDJSON reader skips it)');
}

// ---- attach + write + end: run lines carry the page's key; the last line ends that run only ----
{
  const { rs } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  const a = rs.attach(id, KEY), b = rs.attach(id, KEY2);
  A.ok(a && b, 'two runs join one stream');
  A.eq(a.streamId, id, 'the sink names its stream');
  A.eq(rs.runsOn(id), 2, 'both runs ride it');
  A.ok(a.write('agent.run.start', { runId: 'r1', agentId: 'agent' }), 'a line is written');
  b.write('agent.token', { runId: 'r2', delta: 'hé "quoted"\n' });
  a.end();
  const lines = res.lines().slice(1);
  A.eq(lines[0].k, KEY, 'run line carries its key');
  A.eq(lines[0].name, 'agent.run.start', 'run line carries the event name');
  A.eq(lines[0].payload.runId, 'r1', '…and the payload, unchanged');
  A.eq(lines[1].k, KEY2, 'the other run keeps its own key');
  A.eq(lines[1].payload.delta, 'hé "quoted"\n', 'payload text survives (escapes, unicode, newlines inside JSON)');
  A.eq(JSON.stringify(lines[2]), JSON.stringify({ k: KEY, end: true }), 'the end line is exactly {k,end:true}');
  A.ok(/^\{"k":"k1aaaaaaaaaa","end":true\}$/.test(res.chunks.join('').split('\n').filter(Boolean)[3]), 'the end line wire shape is fixed (the page matches it without parsing)');
  A.ok(/^\{"k":"k2bbbbbbbbbb","name":/.test(res.chunks.join('').split('\n').filter(Boolean)[2]), 'the key leads every run line (the page routes on the prefix)');
  A.eq(a.write('agent.token', { delta: 'late' }), false, 'an ended run writes nothing more');
  A.eq(rs.runsOn(id), 1, 'an ended run leaves the stream');
  a.end();
  A.eq(res.lines().filter(l => l.end).length, 1, 'end is said once');
}

// ---- attach refusals: unknown stream (a restart), malformed key, duplicate key ----
{
  const { rs } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  A.eq(rs.attach('no-such-stream', KEY), null, 'a stream the station does not hold refuses the run');
  A.eq(rs.attach(id, 'short'), null, 'a malformed key is refused');
  A.eq(rs.attach(id, 'bad key with spaces'), null, 'a key outside the charset is refused');
  A.ok(rs.attach(id, KEY), 'a good key joins');
  A.eq(rs.attach(id, KEY), null, 'a key already on the stream is refused (one run per key)');
}

// ---- the watcher law: the stream closing is every run's response closing ----
{
  const { rs, timers } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  const gone = [];
  const a = rs.attach(id, KEY), b = rs.attach(id, KEY2);
  a.onGone(() => gone.push('a')); b.onGone(() => gone.push('b'));
  b.end();   // a finished run is not "gone" when the page later leaves
  res.emit('close');
  A.eq(gone.join(','), 'a', 'closing the stream stops every run still on it, and only those');
  A.eq(rs.size(), 0, 'the stream is forgotten');
  A.ok(timers[0].cleared, 'its keepalive stops');
  A.eq(a.write('agent.token', {}), false, 'a run off the stream writes nothing');
  res.emit('close');
  A.eq(gone.length, 1, 'gone runs once');
  A.eq(rs.attach(id, 'k3cccccccccc'), null, 'a closed stream takes no new run');
}

// ---- an error on the response is a close too ----
{
  const { rs } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  let gone = 0;
  rs.attach(id, KEY).onGone(() => gone++);
  res.emit('error', new Error('ECONNRESET'));
  A.eq(gone, 1, 'a socket error stops the runs on the stream');
}

// ---- withdraw: a live run is gone at once; one not yet arrived is refused when it arrives ----
{
  const { rs } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  let gone = 0;
  const a = rs.attach(id, KEY);
  a.onGone(() => gone++);
  const w = rs.withdraw(id, KEY);
  A.eq(JSON.stringify(w), JSON.stringify({ ok: true, live: true }), 'withdrawing a live run says so');
  A.eq(gone, 1, 'the withdrawn run is gone (its response closing, before)');
  A.eq(a.write('agent.token', {}), false, 'and writes nothing more');
  a.end();
  A.eq(res.lines().filter(l => l.end).length, 0, 'no end line for a run the page already left');
  const early = rs.withdraw(id, KEY2);
  A.eq(JSON.stringify(early), JSON.stringify({ ok: true, live: false }), 'a withdrawal ahead of its run is remembered');
  A.eq(rs.attach(id, KEY2), null, 'the run arriving after its withdrawal is refused');
  A.eq(rs.withdraw('no-such', KEY).ok, false, 'withdrawing on an unknown stream is refused');
  A.eq(rs.withdraw(id, 'x').ok, false, 'a malformed key is refused');
}

// ---- remembered withdrawals are bounded ----
{
  const { rs } = harness();
  const id = rs.open(fakeRes());
  for (let i = 0; i < 400; i++) rs.withdraw(id, 'key-' + String(i).padStart(8, '0'));
  A.ok(rs.attach(id, 'key-' + String(0).padStart(8, '0')), 'the oldest remembered withdrawal is forgotten past the bound');
  A.eq(rs.attach(id, 'key-' + String(399).padStart(8, '0')), null, 'a recent one still refuses its run');
}

// ---- release: leave without an end line (the station refused the run after attaching it) ----
{
  const { rs } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  let gone = 0;
  const a = rs.attach(id, KEY);
  a.onGone(() => gone++);
  a.release();
  res.emit('close');
  A.eq(gone, 0, 'a released run is not stopped by the page leaving');
  A.eq(res.lines().filter(l => l.k).length, 0, 'and said nothing on the stream');
}

// ---- a finished/destroyed response never takes a write (an http write after end() emits an uncaught 'error') ----
{
  const { rs, timers } = harness();
  const res = fakeRes();
  const id = rs.open(res);
  const a = rs.attach(id, KEY);
  res.writableEnded = true;
  A.notThrows(() => a.write('agent.token', {}), 'a write after the response ended does not throw');
  A.eq(a.write('agent.token', {}), false, '…and reports it was not written');
  A.notThrows(() => timers[0].fn(), 'the keepalive on an ended response does not throw');
  A.eq(rs.size(), 0, 'a keepalive that cannot be written closes the stream');
}

// ---- runStreamOf: only a { stream: { id, key } } body names a stream ----
A.eq(runStreamOf({}), null, 'no stream field: the run streams on its own response');
A.eq(runStreamOf({ stream: 'x' }), null, 'a non-object stream field is ignored');
A.eq(runStreamOf({ stream: { key: KEY } }), null, 'no id: no stream');
A.eq(JSON.stringify(runStreamOf({ stream: { id: 'stream-1', key: KEY } })), JSON.stringify({ id: 'stream-1', key: KEY }), 'id + key read');
A.ok(KEY_RE.test('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), 'a 32-hex page key is a valid key');

A.report('run-streams.test');
