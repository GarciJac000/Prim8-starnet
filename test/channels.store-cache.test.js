/* node test/channels.store-cache.test.js — an inbound DM no longer re-reads and re-parses every channel file, and each
   mutation is ONE durable write, with the same .bak last-known-good recovery.

   The bug (perf review 10-19, channels/store.js:148): every read did readFileSync + JSON.parse of the whole file, and
   every mutation re-read the current main, re-serialized it into <file>.bak through a SECOND durable write (fsync +
   temp + rename), then wrote the main. One Telegram DM (pushInbox, chat-record reads + lastSeen save, history load,
   two appendTurn, removeInbox) cost ~20 fsyncs, 16 parses and 15 file reads (62 ms p50 here). The good main is now
   hard-linked as its .bak instead of rewritten.

   Proves through the REAL store + REAL fs + REAL writeFileDurable (the index.js wiring):
     (1) a warm DM does ZERO file reads, and every mutation is exactly one durable write (no temp is renamed onto a .bak);
     (2) the .bak still holds the previous good version after each mutation;
     (3) a file replaced behind the store's back is re-read (the stat stamp misses), and a corrupt main still
         recovers from .bak with onRecover;
     (4) mutating what a read returned never poisons the next read;
     (5) a main write that fails leaves the previous good main in place (the .bak is a link: the main never goes
         missing, nothing is lost, nothing is half-written). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');

function countingFs() {
  const c = { reads: 0, tmpToBak: 0, tmpRenames: 0, failMainWrite: null };
  c.fs = new Proxy(fs, { get(t, p) {
    if (p === 'readFileSync') return function () { c.reads++; return t.readFileSync.apply(t, arguments); };
    if (p === 'renameSync') return function (a, b) {
      if (/\.tmp$/.test(String(a))) { c.tmpRenames++; if (/\.bak$/.test(String(b))) c.tmpToBak++; }
      if (c.failMainWrite && /\.tmp$/.test(String(a)) && String(b) === c.failMainWrite) { const e = new Error('ENOSPC: simulated'); e.code = 'ENOSPC'; throw e; }
      return t.renameSync(a, b);
    };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  return c;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-chan-cache-'));
try {
  const c = countingFs();
  let T = 1000;
  const recovered = [];
  const store = makeChannelStore({ fs: c.fs, pathMod: path, root, clock: { now: () => ++T }, writeDurable: writeFileDurable, onRecover: (f) => recovered.push(f) });
  for (let i = 0; i < 6; i++) store.appendTurn('ultron', i % 2 ? 'assistant' : 'user', 'turn ' + i);
  store.saveChatRecord('123', { agentId: 'ultron', channel: 'telegram' });
  store.pushInbox({ id: 'warm', channel: 'telegram', message: { chatId: '123', text: 'warm' } });
  store.removeInbox('warm');

  // ---- (1) one warm DM, the hub's sequence ----
  c.reads = 0; c.tmpToBak = 0; c.tmpRenames = 0;
  store.pushInbox({ id: 'tg-1', channel: 'telegram', message: { chatId: '123', text: 'hello' } });
  store.getChatRecord('123'); store.getChatRecord('123');
  store.saveChatRecord('123', { agentId: 'ultron', channel: 'telegram' });
  const hist = store.loadHistory('ultron');
  store.appendTurn('ultron', 'user', 'hello');
  store.appendTurn('ultron', 'assistant', 'hi back');
  store.removeInbox('tg-1');
  A.eq(c.reads, 0, 'a warm DM read no channel file from disk (was 15 reads + parses)');
  A.eq(c.tmpRenames, 5, 'five mutations = five durable writes (was ten)');
  A.eq(c.tmpToBak, 0, 'no .bak was re-serialized through a second durable write');
  A.eq(hist.length, 6, 'the history read was correct');

  // ---- (2) .bak = the previous good version ----
  const histFile = path.join(root, 'ultron.history.json');
  const main = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  const bak = JSON.parse(fs.readFileSync(histFile + '.bak', 'utf8'));
  A.eq(main.messages.length, 8, 'main holds both new turns');
  A.eq(bak.messages.length, 7, '.bak holds the version before the last append');
  A.eq(bak.messages[6].content, 'hello', '.bak is exactly the previous good main');
  A.eq(store.loadHistory('ultron').map(m => m.content).slice(-2), ['hello', 'hi back'], 'the store reads back what it wrote');

  // ---- (3) an external replace is seen; a corrupt main recovers from .bak ----
  const mapFile = path.join(root, 'chatmap.json');
  const ext = { version: 1, chats: { '123': { agentId: 'cypher', channel: 'telegram' }, '999': { agentId: 'nova' } } };
  fs.writeFileSync(mapFile + '.ext', JSON.stringify(ext));
  fs.renameSync(mapFile + '.ext', mapFile);          // station recovery / a hand edit replaces the file
  A.eq(store.getChatRecord('123').agentId, 'cypher', 'a file replaced behind the store is re-read, not served stale');
  A.ok(store.getChatRecord('999'), 'and its new records are visible');
  fs.writeFileSync(histFile, '{ torn');
  const rec = store.loadHistory('ultron');
  A.eq(rec.length, 7, 'a corrupt main recovers the .bak last-known-good');
  A.ok(recovered.indexOf(histFile) >= 0, 'onRecover reports the recovery');
  fs.writeFileSync(histFile, '');
  A.eq(store.loadHistory('ultron').length, 7, 'a zero-length main recovers from .bak too');
  store.appendTurn('ultron', 'user', 'after the tear');
  A.eq(JSON.parse(fs.readFileSync(histFile + '.bak', 'utf8')).messages.length, 7, 'a torn main never clobbers the good .bak');
  A.eq(store.loadHistory('ultron').length, 8, 'the next append builds on the recovered history');

  // ---- (4) a caller mutating a returned object cannot poison the cache ----
  const r1 = store.getChatRecord('123');
  r1.agentId = 'MUTATED'; r1.hopKeys = ['x'];
  const items = store.loadOutbox();
  items.push({ id: 'ghost', chatId: '1', text: 't' });
  A.eq(store.getChatRecord('123').agentId, 'cypher', 'a mutated record does not leak into the next read');
  A.eq(store.getChatRecord('123').hopKeys, undefined, 'nor do added fields');
  A.eq(store.loadOutbox().length, 0, 'nor does a pushed array item');
  store.saveChatRecord('123', { streamId: undefined, model: 'm1' });
  A.ok(!('streamId' in store.getChatRecord('123')), 'a cached write reads back exactly as JSON (undefined fields absent)');

  // ---- (5) a failed main write leaves the previous good main in place ----
  const before = fs.readFileSync(mapFile, 'utf8');
  c.failMainWrite = mapFile;
  A.throws(() => store.saveChatRecord('123', { model: 'never' }), 'the failed write surfaces to the caller');
  c.failMainWrite = null;
  A.eq(fs.readFileSync(mapFile, 'utf8'), before, 'the previous good main is still in place');
  A.eq(store.getChatRecord('123').model, 'm1', 'and reads return the last committed record');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
A.report('channels.store-cache.test');
