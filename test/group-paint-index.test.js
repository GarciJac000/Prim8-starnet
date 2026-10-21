/* node test/group-paint-index.test.js — a group transcript paint walks the turns once, not once per message.

   perf p5 (2026-10-20, a user: "eats my PC's resources"): while an agent streams in a group, every 0.9 s read that brings a
   new draft repaints the transcript, and paint() asked EVERY turn about EVERY message — its follow-ups, the replies a pause
   stopped (and whether each was retried), its own turn — plus every question and shared file: O(messages × turns) per paint.
   GENUINE (executed): the REAL frontend/app/group-chat.js runs in a vm over a small DOM (as test/group-poll-idle.test.js),
   reading a 600-turn group through a fake /api/groups whose turns count how often they are asked who they follow:
     1. the transcript still says what it said: the paused reply nobody retried, the follow-up handoff, the reply stopped by
        you, the answer that keeps its question — each under the message it belongs to, in order;
     2. a streamed draft's repaint reads each turn's links a bounded number of times (it was hundreds of thousands). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

/* a long group: 300 asks, each answered by NOVA — except every 50th, which a pause stopped before it ran (every 100th of those
   was retried); every 40th answer was followed up by COPY; every 60th answer was stopped by you; every 70th answers a question */
const P = 300;
const group = { id: 'g1', title: 'Launch', members: ['agent', 'copy'], leadId: 'agent', revision: 3, paused: false, artifacts: [], questions: [], messages: [], turns: [] };
for (let k = 0; k < P; k++) {
  const u = 'u' + k, t = 't' + k;
  group.messages.push({ id: u, author: 'user', content: 'ask ' + k, at: 0 });
  if (k % 50 === 7) {
    group.turns.push({ id: t, origin: u, agentId: 'copy', state: 'stopped', reason: 'Paused before it ran' });
    if (k % 100 === 7) { group.turns.push({ id: t + 'r', origin: u, agentId: 'copy', state: 'completed', retryOf: t }); group.messages.push({ id: 'a' + k, author: 'copy', content: 'retried ' + k, at: 0, turnId: t + 'r' }); }
    continue;
  }
  const stoppedByYou = k % 60 === 11;
  group.turns.push({ id: t, origin: u, agentId: 'agent', state: stoppedByYou ? 'stopped' : 'completed', reason: stoppedByYou ? 'stopped by you' : undefined });
  const msg = { id: 'a' + k, author: 'agent', content: 'reply ' + k, at: 0, turnId: t, partial: stoppedByYou || undefined, artifactIds: k % 30 === 5 ? ['gone'] : undefined };
  if (k % 70 === 13) { group.questions.push({ id: 'q' + k, turnId: 'x' + k, agentId: 'copy', question: 'which one for ' + k + '?', state: 'answered' }); msg.questionId = 'q' + k; }
  group.messages.push(msg);
  if (k % 40 === 3) { group.turns.push({ id: 'f' + k, origin: u, parent: t, agentId: 'copy', state: 'completed' }); group.messages.push({ id: 'b' + k, author: 'copy', content: 'follow-up ' + k, at: 0, turnId: 'f' + k }); }
}
const T = group.turns.length;
let draftSeq = 0, linkReads = 0;
const body = new El('body'), head = new El('head');
for (const id of ['comms-idbar', 'chat-input', 'chat-log', 'chat-queued', 'chat-inputrow']) { const e = new El('div'); e.id = id; body.append(e); }
const ws = { id: 'g1', agentId: 'agent', title: 'Launch', conversationMode: 'group', history: [] };
const counted = t => new Proxy(t, { get(o, k) { if (k === 'parent' || k === 'origin' || k === 'retryOf') linkReads++; return o[k]; } });
let clock = 1e9, seq = 0;
const timers = new Map();
const ctx = vm.createContext({
  document: { body, head, hidden: false, addEventListener() {}, createElement: tg => new El(tg), createTextNode: tx => Object.assign(new El('#text'), { textContent: tx }), getElementById: id => all(body).find(e => e.id === id) },
  console, crypto: { randomUUID: () => 'u' }, queueMicrotask, Date, performance: { now: () => clock },
  setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + (ms || 0) }); return id; }, clearTimeout: id => { timers.delete(id); },
  fetch: async url => {
    if (!/\?id=/.test(String(url))) return { status: 200, ok: true, json: async () => ({ ok: true, result: { roster: [{ id: 'agent', name: 'NOVA' }, { id: 'copy', name: 'COPY' }], groups: [] } }) };
    const result = Object.assign(JSON.parse(JSON.stringify(group)), { stamp: 'boot.' + group.revision + '.' + draftSeq });
    result.turns = result.turns.map(counted);
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  },
  Chat: { consentPhrase: () => '', consentInspect: () => null, clockLabel: () => '', breakLabel: () => '' },
  App: { pushRoster: async () => {}, agents: () => [{ id: 'agent', name: 'NOVA' }, { id: 'copy', name: 'COPY' }], persist() {}, refreshRail() {}, openWorkstream() {} },
  StationUI: { notify() {}, toggleTerm() {}, closeTerm() {} },
  Workstreams: { get: id => (id === 'g1' ? ws : null), list: () => [ws], activeId: () => 'g1', adopt: o => Object.assign(ws, o), generalId: () => 'home' }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/group-chat.js'), 'utf8') + '\nglobalThis.GroupChat = GroupChat;', ctx);
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

(async () => {
  ctx.GroupChat.bind(ws); await settle();
  const log = ctx.document.getElementById('gc-log');
  A.ok(log && log.children.length > P, 'the long group painted (' + (log ? log.children.length : 0) + ' rows)');

  /* ---------- 1. what the transcript says, where ---------- */
  const rows = log.children, text = rows.map(r => r.textContent);
  const after = id => { const i = rows.findIndex(r => r.getAttribute('data-message-id') === id); return i < 0 ? null : text[i + 1]; };
  A.ok(/^COPY did not run · stopped by the pause/.test(after('u57') || ''), 'a reply a pause stopped is said under its ask');
  A.ok(!/did not run/.test(after('u7') || '') && text.filter(s => /did not run · stopped by the pause/.test(s)).length === 3,
    'a retried one is not (3 of the 6 paused asks were never retried)');
  A.eq(after('a3'), 'NOVA asked COPY to follow up', 'a follow-up handoff sits under the reply it followed');
  A.eq(text.filter(s => s === 'NOVA asked COPY to follow up').length, 8, 'every follow-up, once');
  const stopped = rows.find(r => r.getAttribute('data-message-id') === 'a11');
  A.ok(stopped && /stopped by you · work did not complete/.test(stopped.textContent), 'a reply you stopped says so');
  const asked = rows.find(r => r.getAttribute('data-message-id') === 'a13');
  A.ok(asked && /COPY asked: which one for 13\?/.test(asked.textContent), 'an answer keeps the question it answered');

  /* ---------- 2. a streamed draft's repaint ---------- */
  const nodes = rows.slice();
  group.turns.push({ id: 'live', origin: 'u299', agentId: 'agent', state: 'running', draft: 'thinking about it' });
  draftSeq++; linkReads = 0;
  await advance(950);
  const per = linkReads;
  A.ok(log.children.some(r => /thinking about it/.test(r.textContent)), 'the draft painted');
  A.ok(per > 0 && per <= 4 * (T + 1), 'the repaint asked the ' + (T + 1) + ' turns who they follow ' + per + ' times (once per message per turn was ~' + (2 * P * T) + ')');
  A.ok(nodes.every(n => log.children.includes(n)), 'every committed row kept its node');
  A.report('group-paint-index.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
