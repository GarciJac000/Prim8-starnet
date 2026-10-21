/* node test/group-poll-idle.test.js — the open group chat's poll asks only "since": every 0.9 s on screen (trunk's
   cadence, always), every 30 s while the Commander is away (idle CPU piece 3, 2026-10-20).

   THE COST. The open group re-downloaded its whole group every 0.9 s forever — minimized or not — JSON.stringified it to
   decide whether to paint, and every change (each streamed draft too) remapped every message into the workstream; every
   revision also ran App.persist + a full rail rebuild.

   GENUINE (executed): the REAL frontend/app/group-chat.js runs in a vm over the small El DOM from group-stop-truth.test.js,
   with a fake clock + timer queue, a fake /api/groups that honours `since` like sidecar/group-sessions.js, and a PollGate
   stub (away flag + onWake). Counted: ?id= reads, App.persist, whole-group JSON.stringify calls, transcript node identity. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.events = {}; this.value = ''; this.style = { setProperty() {} }; this._cls = new Set(); const self = this; this.classList = { add: c => self._cls.add(c), remove: c => self._cls.delete(c), toggle: (c, on) => (on === undefined ? (self._cls.has(c) ? self._cls.delete(c) : self._cls.add(c)) : (on ? self._cls.add(c) : self._cls.delete(c))), contains: c => self._cls.has(c) }; }
  get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get isConnected() { return true; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; if (k === 'class') this.className = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelectorAll() { return []; } querySelector() { return null; }
  addEventListener(k, fn) { (this.events[k] = this.events[k] || []).push(fn); }
  focus() {}
  append(...n) { for (const e of n) { const x = typeof e === 'string' ? Object.assign(new El('#text'), { textContent: e }) : e; if (x.parentElement) x.remove(); x.parentElement = this; this.children.push(x); } }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...n) { for (const c of this.children) c.parentElement = null; this.children = []; this.append(...n); }
  before(n) { this.parentElement && this.parentElement.append(n); }
  insertBefore(n, ref) { if (n.parentElement) n.remove(); const i = ref ? this.children.indexOf(ref) : -1; n.parentElement = this; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; } }
  get textContent() { return this._text != null ? this._text : this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
}
const all = e => [e, ...e.children.flatMap(all)];

/* one station: a group whose stamp moves like group-sessions.js's (revision + draft writes); `stamps:false` = an old sidecar */
/* realU: the REAL frontend/js/util.js loaded into the page first, so U.timeoutSignal is the app's own (its AbortController
   fallback, on this fake timer queue). hanging: the sidecar accepts every ?id= read and never answers it */
/* realGate: the REAL frontend/app/pollgate.js drives the page's loops on the same fake clock + timers (no stub); listMs: the
   station-wide /api/groups list read answers after that long (listReads records each one's start and end) */
function harness({ stamps = true, realU = false, realGate = false, listMs = 0 } = {}) {
  let clock = 1e9, wallStep = 0, seq = 0, persists = 0, groupStringifies = 0, away = false, draftSeq = 0, hanging = false;
  const timers = new Map(), reads = [], wakers = [], listReads = [];
  const server = { id: 'g1', title: 'Launch', members: ['agent', 'copy'], leadId: 'agent', revision: 3, paused: false, artifacts: [], questions: [],
    messages: [{ id: 'm1', seq: 1, author: 'user', content: 'hello', at: 1 }, { id: 'm2', seq: 2, author: 'agent', content: 'hi there', at: 2, turnId: 't1' }],
    turns: [{ id: 't1', origin: 'm1', agentId: 'agent', state: 'completed', endedAt: 2 }] };
  const stampOf = () => 'boot.' + server.revision + '.' + draftSeq;
  const body = new El('body'), head = new El('head');
  for (const id of ['comms-idbar', 'chat-input', 'chat-log', 'chat-queued', 'chat-inputrow']) { const e = new El('div'); e.id = id; body.append(e); }
  const ws = { id: 'g1', agentId: 'agent', title: 'Launch', conversationMode: 'group', history: [] };
  const isGroup = v => !!(v && typeof v === 'object' && Array.isArray(v.turns) && Array.isArray(v.messages));
  const ctx = vm.createContext({
    document: { body, head, hidden: false, addEventListener() {}, createElement: tg => new El(tg), createTextNode: tx => Object.assign(new El('#text'), { textContent: tx }), getElementById: id => all(body).find(e => e.id === id) },
    console, crypto: { randomUUID: () => 'u' }, queueMicrotask,
    Date: class extends Date { static now() { return clock + wallStep; } },   // the wall clock (can be stepped)
    performance: { now: () => clock },                                         // the monotonic clock (never steps)
    JSON: { stringify: (v, ...r) => { if (isGroup(v)) groupStringifies++; return JSON.stringify(v, ...r); }, parse: JSON.parse },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: id => { timers.delete(id); },
    fetch: async (url, init) => {
      url = String(url);
      if (!/\?id=/.test(url)) {
        const list = { status: 200, ok: true, json: async () => ({ ok: true, result: { roster: [{ id: 'agent', name: 'NOVA' }, { id: 'copy', name: 'COPY' }], groups: [] } }) };
        const rec = { at: clock, end: null }; listReads.push(rec);
        if (!listMs) { rec.end = clock; return list; }
        return new Promise(res => { const id = ++seq; timers.set(id, { fn: () => { rec.end = clock; res(list); }, at: clock + listMs }); });
      }
      reads.push(url);
      if (hanging) return new Promise((_res, rej) => { const sig = init && init.signal; if (sig) sig.addEventListener('abort', () => rej(sig.reason || new Error('aborted'))); });
      const since = (url.match(/[?&]since=([^&]*)/) || [])[1];
      const result = stamps && since && decodeURIComponent(since) === stampOf() ? { id: 'g1', unchanged: true, stamp: stampOf() }
        : Object.assign(JSON.parse(JSON.stringify(server)), stamps ? { stamp: stampOf() } : {});
      return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
    },
    PollGate: { away: () => away, AWAY_MS: 30000, onWake: cb => { wakers.push(cb); return () => {}; } },
    Chat: { consentPhrase: () => '', consentInspect: () => null, clockLabel: () => '', breakLabel: () => '' },
    App: { pushRoster: async () => {}, agents: () => [{ id: 'agent', name: 'NOVA' }, { id: 'copy', name: 'COPY' }], persist() { persists++; }, refreshRail() {}, openWorkstream() {} },
    StationUI: { notify() {}, toggleTerm() {}, closeTerm() {} },
    Workstreams: { get: id => (id === 'g1' ? ws : null), list: () => [ws], activeId: () => 'g1', adopt: o => Object.assign(ws, o), generalId: () => 'home' }
  });
  if (realGate) { delete ctx.PollGate; vm.runInContext(read('frontend/app/pollgate.js'), ctx); }
  if (realU) { ctx.AbortController = AbortController; ctx.DOMException = DOMException; vm.runInContext(read('frontend/js/util.js'), ctx); }
  vm.runInContext(read('frontend/app/group-chat.js') + '\nglobalThis.GroupChat = GroupChat;', ctx);
  const settle = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
  async function advance(ms) {
    const until = clock + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); clock = Math.max(clock, next[1].at); next[1].fn(); await settle();
    }
    clock = until;
  }
  return { ctx, ws, server, reads, wakers, listReads, advance, pendingIn: () => [...timers.values()].map(t => t.at - clock), settle, log: () => ctx.document.getElementById('gc-log'),
    persists: () => persists, groupStringifies: () => groupStringifies, setAway: v => { away = v; }, hang: v => { hanging = v; }, draft: () => { draftSeq++; }, now: () => clock, stepWall: ms => { wallStep += ms; } };
}

(async () => {
  /* (b) a visible, idle group: read at trunk's 0.9 s, every read a since-read (fix round 3: on screen the cadence never
     slows; it was every 3 s while idle, so a turn another member started showed up to 3 s late) */
  {
    const h = harness();
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    A.eq(h.reads.length, 1, 'binding the group reads it at once');
    A.ok(h.log() && h.log().children.length > 0, 'fixture: the transcript painted');
    await h.advance(9000);
    A.ok(h.reads.length - 1 >= 10, 'visible + idle: a read every 0.9 s, as trunk (10 in 9 s; it read every 3 s) — got ' + (h.reads.length - 1));

    /* (d) every later read carries the stamp of the group on screen; an unchanged answer touches nothing */
    A.ok(h.reads.slice(1).every(u => /&since=boot\.3\.0$/.test(u)), 'later reads send since=<the stamp on screen>: ' + h.reads[1]);
    const nodes = h.log().children.slice(), persisted = h.persists(), stringified = h.groupStringifies();
    await h.advance(9000);
    A.ok(h.reads.length >= 6, 'fixture: more idle reads happened');
    A.eq(h.persists(), persisted, 'an unchanged answer never persists the station');
    A.eq(h.groupStringifies(), stringified, 'an unchanged answer is never stringified');
    A.ok(h.log().children.length === nodes.length && h.log().children.every((n, i) => n === nodes[i]), 'an unchanged answer leaves every transcript node as it was');

    /* a streamed draft (same revision): painted, but the workstream is not re-adopted and the station not persisted */
    const adoptedHistory = h.ws.history;
    h.server.turns.push({ id: 't2', origin: 'm1', agentId: 'copy', state: 'running' });
    h.server.revision++; h.draft();
    await h.advance(4000);   // a few 0.9 s reads
    A.ok(h.ws.history !== adoptedHistory && h.persists() > persisted, 'a revision bump adopts and persists, as before');
    const persistedAtRun = h.persists(), historyAtRun = h.ws.history;
    // a live turn: the poll keeps the 0.9 s beat
    const before = h.reads.length;
    for (let i = 0; i < 4; i++) { h.server.turns[1].draft = 'streaming ' + i; h.draft(); await h.advance(900); }
    A.ok(h.reads.length - before >= 4, '(c) a live turn keeps the 0.9 s cadence (' + (h.reads.length - before) + ' reads in 3.6 s)');
    A.eq(h.persists(), persistedAtRun, 'streamed drafts never persist the station');
    A.ok(h.ws.history === historyAtRun, 'streamed drafts never re-adopt the workstream (its history is the same array)');
    A.eq(h.groupStringifies(), stringified, 'a stamped group is never stringified to decide whether to paint');
  }

  /* (a) hidden with no input: one read per 30 s; back on screen, a read at once */
  {
    const h = harness();
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    h.setAway(true);
    await h.advance(20000);
    A.eq(h.reads.length, 1, 'away: no further read in the next 20 s (was ~22)');
    await h.advance(11000);
    A.eq(h.reads.length, 2, 'away: one read per 30 s — slower, never stopped');
    h.setAway(false);
    A.eq(h.wakers.length, 1, 'the group chat registers one wake');
    h.wakers[0](); await h.settle();
    A.eq(h.reads.length, 3, 'back on screen: the open group is read at once');
    await h.advance(899);
    A.eq(h.reads.length, 3, '…and the 0.9 s cadence resumes from that read');
    await h.advance(1);
    A.eq(h.reads.length, 4, '…the next read 0.9 s after it');
  }

  /* (e) an older sidecar (no stamp): every read is a full one compared whole, as before */
  {
    const h = harness({ stamps: false });
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    await h.advance(9000);
    A.ok(h.reads.every(u => !/since=/.test(u)), 'no stamp from the station: no since is ever sent');
    A.ok(h.reads.length - 1 >= 10, 'read every 0.9 s, as before (' + (h.reads.length - 1) + ' in 9 s)');
    const persisted = h.persists();
    await h.advance(9000);
    A.eq(h.persists(), persisted, 'an unchanged full answer still paints nothing new (the whole-group comparison)');
    A.ok(h.groupStringifies() > 0, 'the whole-group comparison is what decides, as before');
    h.server.messages.push({ id: 'm3', seq: 3, author: 'agent', content: 'new', at: 3 }); h.server.revision++;
    await h.advance(4000);
    A.ok(h.ws.history.some(m => m.content === 'new'), 'a real change from an older sidecar still lands');
  }

  /* (f) fix round (2026-10-20): a backward wall-clock step never stalls the open group's poll. Its due check ran on
     Date.now, so a w32time correction after resume skipped every read until the wall clock caught up — even a live turn's. */
  {
    const h = harness();
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    A.eq(h.reads.length, 1, 'fixture: bound and read once');
    h.stepWall(-5 * 60000);
    await h.advance(9000);
    A.ok(h.reads.length - 1 >= 10, 'the wall clock stepped back 5 min: the group is still read every 0.9 s (' + (h.reads.length - 1) + ' more reads in 9 s)');
  }

  /* (g) fix round 4 (2026-10-20): THE OPEN GROUP'S READ HAS A DEADLINE TOO. Only the station-wide watch had one: an open
     group's read the sidecar accepted and never answered (every groupSessions read awaits the durable store's `ready`)
     left the chain waiting on it for good — it never rescheduled, the wake catch-up returned early on the read "in
     flight", and the transcript froze with nothing on screen saying so until the Commander switched chats. */
  {
    const h = harness({ realU: true });
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    A.eq(h.reads.length, 1, 'fixture: bound and read once');
    h.hang(true);
    await h.advance(900);
    const hungAt = h.reads.length;
    A.eq(hungAt, 2, 'fixture: the next read went out and the sidecar sits on it');
    await h.advance(20000);
    A.ok(h.reads.length > hungAt, 'a read the sidecar never answers ends at its 15 s deadline and the poll carries on (' + (h.reads.length - hungAt) + ' more reads in 20 s; it was 0 — the chain was dead)');
    A.ok(h.reads.length - hungAt <= 2, '…one hung read at a time, never a pile (' + (h.reads.length - hungAt) + ' in 20 s)');
    A.eq(h.ctx.document.getElementById('gc-notice').textContent, '', 'a read that ran past its deadline puts nothing on screen: it is simply asked again');
    const atWake = h.reads.length;
    h.hang(false);
    h.server.messages.push({ id: 'm9', seq: 9, author: 'agent', content: 'after the hang', at: 9 }); h.server.revision++;
    await h.advance(16000);
    A.ok(h.reads.length > atWake, 'the station answering again is read');
    A.ok(h.ws.history.some(m => m.content === 'after the hang'), '…and the open group repaints with what changed meanwhile (it stayed frozen)');
  }

  /* (i) fix round 5 (2026-10-20): A READ THAT ANSWERED LEAVES NO DEADLINE BEHIND. The open group's read deadline was
     U.timeoutSignal — native AbortSignal.timeout in WebView2, whose timer cannot be cleared (its fallback's neither) — so
     every 0.9 s read left a live signal and a pending 15 s timer that later aborted a request long finished: ~16 alive
     at any moment, ~1.1 extra timer wake-ups a second while a group was open. Executed with the app's own util.js. */
  {
    const h = harness({ realU: true });
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    await h.advance(20000);
    A.ok(h.reads.length >= 20, 'fixture: the open group was read every 0.9 s (' + h.reads.length + ' reads in 20 s)');
    const deadlines = h.pendingIn().filter(ms => ms > 4000);   // the beat (0.9 s) and the watch chain (4 s) are the only shorter ones
    A.ok(deadlines.length <= 1, 'answered reads leave no pending deadline timer behind (' + deadlines.length + ' pending; it was ~16)');
  }

  /* (h) fix round 5 (2026-10-20): THE STATION-WIDE WATCH KEEPS ITS REST. In trunk it was a chain: the next tick was armed
     4 s after the read finished (setTimeout(tick, 4000) after the await). On PollGate's bare grid a list read that took
     4 s or more was asked again the moment it settled (its slot had passed), so under a loaded sidecar /api/groups was
     read back to back with no gap, exactly when the sidecar was struggling. The REAL pollgate.js drives the REAL watch. */
  {
    const h = harness({ realGate: true, listMs: 5000 });
    h.ctx.GroupChat.bind(h.ws); await h.settle();
    await h.advance(60000);
    const watchReads = h.listReads.slice(1).filter(r => r.end != null);   // [0] is discover()'s one-off read at bind
    A.ok(watchReads.length >= 4, 'fixture: the watch read the list several times in 60 s (' + watchReads.length + ')');
    const rests = watchReads.slice(1).map((r, i) => r.at - watchReads[i].end);
    A.ok(rests.length >= 3 && rests.every(ms => ms >= 4000), 'a 5 s list read is followed by the chain\'s 4 s of rest before the next one: ' + JSON.stringify(rests) + ' ms (it was 0: back to back)');
    A.ok(watchReads.length <= 7, '…so a 5 s read is asked about every 9 s, as the chain did (' + watchReads.length + ' reads in 60 s)');
  }

  A.report('group-poll-idle.test');
})().catch(e => { console.error(e); process.exit(1); });
