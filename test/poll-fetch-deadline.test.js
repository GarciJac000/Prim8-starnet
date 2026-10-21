/* node test/poll-fetch-deadline.test.js — the PollGate beats that returned a bare fetch now give it a 15 s deadline
   (idle CPU piece 3 fix round, 2026-10-20).

   world.js pollFeedState (the NO FEED intake nag + BUILD MODE start facts, every 60 s) read the sidecar with no signal.
   One request the sidecar accepted and never answered (harness.js: "a socket the sidecar accepted and never answered")
   held the beat's promise open for good. PollGate now abandons such a beat at its own deadline (test/pollgate.test.js);
   the read also aborts at 15 s like every other bounded poll (emergency-control, widgets, Harness.api), so an abandoned
   read never keeps a connection slot to the sidecar either.

   GENUINE (executed): world.js's REAL pollFeedState (A.fnBody) runs in a vm context whose fetch never answers unless its
   signal aborts; U.timeoutSignal is the deadline helper. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const drain = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };

// a station that accepts every read and never answers it — unless the read's signal aborts
function hangingStation() {
  const asked = [], deadlines = [];
  const fetch = (url, opts) => {
    asked.push({ url: String(url), signal: opts && opts.signal });
    return new Promise((_, reject) => {
      const s = opts && opts.signal;
      if (s) s.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })));
    });
  };
  const U = { timeoutSignal(ms) { const c = new AbortController(); deadlines.push({ ms, fire: () => c.abort() }); return c.signal; } };
  return { fetch, U, asked, deadlines };
}

(async () => {
  /* ---- world.js pollFeedState ---- */
  {
    const src = A.fnBody(read('frontend/app/world.js'), 'function pollFeedState(');
    A.ok(src.length > 200 && src.length < 6000, 'fixture: pollFeedState sliced from world.js (' + src.length + ' chars)');
    const st = hangingStation();
    const ctx = vm.createContext({ fetch: st.fetch, U: st.U, apiUrl: u => u, Promise, Object, Array,
      feedState: { known: false, fed: false, schedOff: false, offJobs: [] }, startFacts: null, routingNags: null, buildRoutingNags: () => [] });
    vm.runInContext(src + '\nthis.pollFeedState = pollFeedState;', ctx, { filename: 'world.js#pollFeedState' });
    let settled = false;
    const p = ctx.pollFeedState();
    A.ok(p && typeof p.then === 'function', 'pollFeedState returns its read (PollGate awaits it)');
    p.then(() => { settled = true; }, () => { settled = true; });
    await drain();
    A.eq(st.asked.length, 3, 'it asks the station for channels, cron and routing triggers');
    A.ok(st.asked.every(a => a.signal), 'every one of those reads carries a deadline signal (they had none)');
    A.eq(st.deadlines.map(d => d.ms).join(','), '15000,15000,15000', 'each deadline is 15 s, like the other bounded polls');
    A.eq(settled, false, 'fixture: the station never answers');
    st.deadlines.forEach(d => d.fire());
    await drain();
    A.eq(settled, true, 'at the deadline the read gives up and the beat settles (it stayed open for good)');
    A.eq(ctx.feedState.known, false, 'nothing answered: the last known feed truth is kept, never guessed');
  }

  /* ---- group-chat.js watch(): the station-wide group list (fix round 2, 2026-10-20) ----
     The watch is an awaited PollGate beat every 4 s. Its /api/groups list read had no signal: when the sidecar accepted it
     and never answered (every groupSessions read awaits the durable store's `ready`), PollGate abandoned the beat at its
     15 s deadline and the next beat opened ANOTHER read — one more hung socket every 15 s (12 open after 3 min), until
     Chromium's six per host were gone and every /api call queued behind them. GENUINE (executed): the REAL pollgate.js
     (fake monotonic clock + timers through its seams) and the REAL group-chat.js over a small El DOM; the list read answers
     the first time (discover) and then never, unless its signal aborts. U.timeoutSignal fires on the same fake clock. */
  {
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
    let clock = 1e6, seq = 0;
    const timers = new Map();
    const setT = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + Math.max(0, ms || 0) }); return id; };
    const clearT = id => { timers.delete(id); };
    const G = require('../frontend/app/pollgate.js');
    G._resetForTest(); G._setClockForTest(() => clock); G._setTimersForTest(setT, clearT); G._setFrameForTest(null);
    G._setDocForTest({ hidden: false, addEventListener() {}, removeEventListener() {} }, null);
    const U = { timeoutSignal(ms) { const c = new AbortController(); setT(() => c.abort(Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })), ms); return Object.assign(c.signal, { deadlineMs: ms }); } };
    const reads = [];
    let open = 0, maxOpen = 0, answered = false;
    const listed = () => ({ status: 200, ok: true, json: async () => ({ ok: true, result: { roster: [], groups: [] } }) });
    const body = new El('body'), head = new El('head');
    for (const id of ['comms-idbar', 'chat-input', 'chat-log', 'chat-queued', 'chat-inputrow']) { const e = new El('div'); e.id = id; body.append(e); }
    const ctx = vm.createContext({
      document: { body, head, hidden: false, addEventListener() {}, createElement: t => new El(t), createTextNode: t => Object.assign(new El('#text'), { textContent: t }), getElementById: id => all(body).find(e => e.id === id) },
      console: { log() {}, warn() {}, error() {}, debug() {} }, crypto: { randomUUID: () => 'u' }, queueMicrotask, performance: { now: () => clock },
      setTimeout: setT, clearTimeout: clearT, JSON, PollGate: G, U, AbortController,
      fetch: (url, opts) => {
        if (/\?/.test(String(url))) return Promise.resolve(listed());
        const signal = opts && opts.signal;
        const rec = { at: clock, abortedAt: null, signal: !!signal };
        reads.push(rec);
        if (!answered) { answered = true; return Promise.resolve(listed()); }   // discover's first read
        open++; maxOpen = Math.max(maxOpen, open);
        return new Promise((_, reject) => {   // accepted, never answered — unless its signal aborts
          if (signal) signal.addEventListener('abort', () => { open--; rec.abortedAt = clock; reject(signal.reason || new Error('aborted')); });
        });
      },
      Chat: { consentPhrase: () => '', consentInspect: () => null, clockLabel: () => '', breakLabel: () => '' },
      App: { pushRoster: async () => {}, agents: () => [], persist() {}, refreshRail() {}, openWorkstream() {} },
      StationUI: { notify() {}, toggleTerm() {}, closeTerm() {} },
      Workstreams: { get: () => null, list: () => [], activeId: () => null, adopt: o => o, generalId: () => 'home', isDeleted: () => false }
    });
    vm.runInContext(read('frontend/app/group-chat.js') + '\nglobalThis.GroupChat = GroupChat;', ctx, { filename: 'group-chat.js' });
    ctx.GroupChat.bind(null);   // mounts the module: discover() + the station-wide watch
    await drain();
    const until = clock + 3 * 60000;
    for (;;) {
      let nx = null; for (const [id, t] of timers) if (t.at <= until && (!nx || t.at < nx[1].at)) nx = [id, t];
      if (!nx) break; timers.delete(nx[0]); clock = nx[1].at; nx[1].fn(); await drain();
    }
    const watchReads = reads.slice(1);
    A.ok(watchReads.length >= 8, 'fixture: the watch kept beating for 3 minutes (' + watchReads.length + ' list reads)');
    A.ok(watchReads.every(r => r.signal), 'every watch list read carries a deadline signal (it had none)');
    A.ok(watchReads.filter(r => r.abortedAt != null).length >= watchReads.length - 1 && watchReads.every(r => r.abortedAt == null || r.abortedAt - r.at === 15000), 'each hung watch read is aborted 15 s after it went out: ' + JSON.stringify(watchReads.map(r => r.abortedAt == null ? null : r.abortedAt - r.at)));
    A.ok(maxOpen <= 1, 'a station that never answers the list holds at most ONE watch read open (' + maxOpen + '; it was 12 after 3 min)');
    A.eq(open <= 1, true, '…and no hung read is left behind it');
    A.ok(watchReads.slice(1).every((r, i) => r.at - watchReads[i].at >= 15000), 'each read is given its full 15 s before the next one asks');
    G._resetForTest();
  }

  A.report('poll-fetch-deadline.test');
})().catch(e => { console.error(e); process.exit(1); });
