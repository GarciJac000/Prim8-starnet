/* STARNET — pollgate.js : the ONE owner of "is anyone looking?" for the browser's background polls.

   IDLE CPU PIECE 3 (2026-10-20, "it eats my PC's resources"). Every module armed its own setInterval / setTimeout chain at
   boot or when a window opened, and only /api/halt, the group list, NEEDS YOU and the apps dock looked at document.hidden.
   Everything else — the 1 s station tick, the overseer ledger (2.5 s), journey (4 s), connectors + spotify (5 s), the rail
   widgets, the loops watcher, the open group chat — kept full cadence while the window was minimized: ~160 /api requests a
   minute with nobody looking, each parsed on the UI thread.

   THE RULE. A poll registered here runs at its own cadence (unchanged) while the page can be seen, and slows to a 30 s floor
   while the Commander is AWAY. It never stops: a loop that stops is a claim nobody can check. Coming back (visible again,
   window focus, the first input, or the first frame drawn after being away) runs every loop that is overdue against its
   own live cadence at once, then fires onWake callbacks, so nothing on screen is older than it was before.

   AWAY IS NEVER CLAIMED AGAINST THE PAGE'S OWN EVIDENCE OF BEING ON SCREEN. Some embedded webviews (the preview harness,
   some Tauri states — world.js cinecamTick) report document.hidden while still rendering, and a hands-off viewer (the idle
   cinecam) gives no input. The desktop shell has no visibility event of its own to listen to: on minimize / park-in-tray it
   calls the WebView2 controller's SetIsVisible(false) (src-tauri main.rs set_webview_on_screen), and that is exactly what
   makes Chromium set document.hidden AND stop running requestAnimationFrame. So AWAY needs every signal the page has to agree:
     · document.hidden is true, and document.visibilityState (when present) is not 'visible';
     · the document does not hold focus (document.hasFocus(), when present);
     · no input (pointer, key, wheel, focus) for 10 s — input proves the page is on screen whatever `hidden` says;
     · no frame drawn: while the rest says away, ONE rAF probe is kept out, and away is claimed only once it has gone 2 s
       unanswered. A page that is really hidden never runs it (it costs nothing there); a webview that says hidden but is
       still drawing answers within a frame and keeps its visible cadence; a frame drawn after being away is a return.
     Where requestAnimationFrame does not exist (node tests) the frame proof is skipped.

   THE VISIBLE CADENCE KEEPS ITS GRID, AS setInterval DID (fix round 4). Every real timer fires a little late (1-8 ms of
   leeway). A beat timed from when it RAN added that lateness to the next one, so a 1 s loop slid ~5 beats a minute behind
   its own phase and the live elapsed clocks it draws (the rail ticker, the station tick) jumped two seconds in one tick
   every few minutes. A beat due on schedule now starts the next interval from the time it was DUE (Blink's repeating
   timer does the same); a timer a stall held up past a whole interval runs once and then takes the grid's next point, as
   setInterval would. A run that starts a new phase (the first, a catch-up on return, runNow) anchors the grid where it ran.
   A SLOW ANSWER IS NEVER ASKED AGAIN AT ONCE (fix round 5). An awaited beat that outlasted its interval was re-run the
   moment it settled, so a sidecar slower than the cadence was asked back to back with no rest — the overseer every 3 s
   on a 2.5 s beat, never idle. The setInterval these loops replaced skipped the ticks that came while the read was out
   (each caller's busy guard) and asked on the next one: a beat that settles past its next slot now waits for the first
   grid point at or after it settles. A loop armed with { gap: true } was a setTimeout chain (re-armed after the await):
   its next beat is due a whole interval after the last one ENDED, so a 5 s read on a 4 s chain is followed by 4 s of
   rest, as before.

   THE CLOCK IS MONOTONIC (performance.now when present). Intervals measured on Date.now stalled every loop for as long as a
   backward wall-clock step (a w32time correction after resume, a manual fix) — setInterval, which these loops replaced,
   never did. Nothing here displays a time.

   A BEAT THAT NEVER SETTLES NEVER ENDS THE LOOP. A run that returns a promise is awaited before the next is scheduled (no
   overlap), but only up to its deadline, max(2 x the cadence it ran at, 15 s). Past it the beat is abandoned and the chain
   moves on; the abandoned promise answering late changes nothing (no second chain). On a return (wake) or runNow(), a beat
   still out past the deadline of the cadence in force NOW is abandoned at once and the loop runs; one inside it is awaited,
   with its deadline pulled in from the longer one an away beat was given.

   API
     PollGate.away()                         → true while every signal above says nobody can see the page
     PollGate.every(fn, { ms, awayMs, immediate, gap })
        ms: number | () => number            the visible cadence (a function is read live)
        awayMs: the floor while away (30000)  immediate: run fn now (true) or after the first ms (false)
        gap: true for a loop that was a setTimeout chain: each beat is due one interval after the last one ended
        → { stop, runNow, lastRunAt(), cadence(), interval() }
        A setTimeout chain that never overlaps a beat inside its deadline; a throw or rejection is re-raised outside the
        chain, which carries on. cadence() is the interval in force when the last run started; interval() is the one in
        force now.
     PollGate.onWake(cb) → unsubscribe      cb runs when the Commander comes back after the gate was away
   Callers fall back to their old timers when PollGate is undefined (single-file node tests load them without it).
   Dependency-free and browser-global, with injection seams for node tests (module.exports). */
'use strict';
const PollGate = (() => {
  const AWAY_MS = 30000;          // the slowest any registered poll runs while nobody is looking
  const INPUT_GRACE_MS = 10000;   // input this recent proves the page is on screen, whatever document.hidden says
  const FRAME_PROOF_MS = 2000;    // a frame probe unanswered this long proves nothing is being drawn
  const DEADLINE_MIN_MS = 15000;  // a beat's promise is waited on for max(2 x its cadence, this)
  const MIN_MS = 16;              // a misconfigured cadence can never become a busy loop

  const monotonic = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? () => performance.now() : () => Date.now();
  let now = monotonic;
  let setT = (fn, ms) => setTimeout(fn, ms);
  let clearT = id => clearTimeout(id);
  let frame = typeof requestAnimationFrame === 'function' ? cb => requestAnimationFrame(cb) : null;
  let doc = typeof document !== 'undefined' ? document : null;
  /* A beat that throws (or rejects) must stay as loud as it was under setInterval: re-raised outside the chain, it is an
     uncaught error / unhandled rejection again — the console shows it and BootGuard counts it for the diagnostics report —
     while the chain itself carries on. */
  let raise = e => { setTimeout(() => { throw e; }, 0); };
  let raiseRejection = e => { Promise.reject(e); };
  let lastInputAt = -Infinity;    // no input yet (never "recent" — a page that boots hidden is not held on screen by the clock's origin)
  let awaySeen = false;           // a due-check (or a caller) saw the gate away since the last wake
  let probeAt = 0, probeSeq = 0;  // the frame probe out (armed at probeAt, 0 = none) and its generation
  const loops = new Set();
  const wakers = new Set();

  // a frame was asked for FRAME_PROOF_MS ago and none came → true; otherwise keep (or arm) the one probe → false
  function noFrames() {
    if (probeAt) return now() - probeAt >= FRAME_PROOF_MS;
    probeAt = now();
    const mine = ++probeSeq;
    try {
      frame(() => {
        if (mine !== probeSeq) return;
        probeAt = 0;
        if (awaySeen) wake();     // drawing again after being away is a return, even with no visibilitychange
      });
    } catch (_) { /* no frame can be asked for: after FRAME_PROOF_MS the other signals decide alone */ }
    return false;
  }
  function away() {
    let out = false;
    try {
      out = !!(doc && doc.hidden)
        && !(typeof doc.visibilityState === 'string' && doc.visibilityState === 'visible')
        && !(typeof doc.hasFocus === 'function' && doc.hasFocus());
    } catch (_) { out = false; }
    out = out && now() - lastInputAt >= INPUT_GRACE_MS;
    if (out && frame) out = noFrames();
    if (out) awaySeen = true;
    return out;
  }

  function every(fn, opts) {
    const o = opts || {};
    const msOf = typeof o.ms === 'function' ? o.ms : () => o.ms;
    const awayMs = Number(o.awayMs) > 0 ? Number(o.awayMs) : AWAY_MS;
    const liveMs = () => { let v = 0; try { v = Number(msOf()); } catch (_) { v = 0; } return Math.max(MIN_MS, Number.isFinite(v) ? v : 0); };
    const interval = () => { const ms = liveMs(); return away() ? Math.max(ms, awayMs) : ms; };
    const deadlineOf = iv => Math.max(2 * iv, DEADLINE_MIN_MS);
    const gap = o.gap === true;   // a chain: each beat is due a whole interval after the last one ended (setTimeout after the await)
    // running: the token of the beat in flight (0 = none); guard: its deadline timer, due at guardAt. lastRunAt: the last
    // beat's slot on the loop's grid (what the next is due from); startedAt: when it actually started (its deadline's base)
    const l = { stopped: false, running: 0, seq: 0, timer: 0, guard: 0, guardAt: 0, lastRunAt: now(), startedAt: 0, cadence: 0 };
    function schedule() {
      if (l.stopped || l.running) return;
      if (l.timer) clearT(l.timer);
      l.timer = setT(due, Math.ceil(Math.max(0, l.lastRunAt + interval() - now())));   // ceil: a truncated delay fired a hair early and re-armed
    }
    function due() {
      l.timer = 0;
      if (l.stopped || l.running) return;
      const iv = interval();
      const at = l.lastRunAt + iv, t = now();   // the slot this beat was due in
      if (t < at) { schedule(); return; }
      run(iv, at + Math.floor((t - at) / iv) * iv);   // keep the grid: the latest slot at or before now, never "now"
    }
    function release() { l.running = 0; if (l.guard) { clearT(l.guard); l.guard = 0; } }
    // an awaited beat is over: in a chain (gap) the next comes a whole interval after it; on the grid, a slot that passed
    // while it was out is skipped (the next is the first grid point at or after now), as setInterval's busy-guarded tick did
    function afterAwait() {
      const t = now();
      if (gap) { l.lastRunAt = t; return; }
      const iv = interval(), at = l.lastRunAt + iv;
      if (t > at) l.lastRunAt = at + (Math.ceil((t - at) / iv) - 1) * iv;
    }
    // beat `token` is over (settled, or abandoned at its deadline). A token that is no longer the beat in flight is a late
    // answer from an abandoned beat: it changes nothing, so it can never start a second chain.
    function settle(token, awaited) {
      if (l.running !== token) return;
      release();
      if (awaited || gap) afterAwait();
      schedule();
    }
    function armGuard(token, at) {
      if (l.guard) clearT(l.guard);
      l.guardAt = at;
      l.guard = setT(() => { l.guard = 0; settle(token, true); }, Math.max(0, at - now()));
    }
    // slot: the grid point a scheduled beat runs in (due); absent, the run anchors a new phase where it starts
    function run(iv, slot) {
      if (l.stopped || l.running) return;
      if (l.timer) { clearT(l.timer); l.timer = 0; }
      const token = ++l.seq;
      l.running = token; l.startedAt = now(); l.lastRunAt = typeof slot === 'number' ? slot : l.startedAt; l.cadence = iv;
      let p = null;
      try { p = fn(); } catch (e) { p = null; raise(e); }   // one failed beat never ends the chain
      if (p && typeof p.then === 'function') {
        if (l.running === token) armGuard(token, l.startedAt + deadlineOf(iv));
        p.then(() => settle(token, true), e => { settle(token, true); raiseRejection(e); });
      } else settle(token);
    }
    // a beat still out when the Commander is back (or runNow asks): past the deadline of the cadence in force now it is
    // hung, so it is abandoned (→ true: free to run); inside it, it is awaited with that nearer deadline (→ false)
    function unstick() {
      if (!l.running) return true;
      const at = l.startedAt + deadlineOf(liveMs());
      if (now() >= at) { release(); return true; }
      if (at < l.guardAt) armGuard(l.running, at);
      return false;
    }
    l.catchUp = () => {
      if (l.stopped || !unstick()) return;
      if (now() - l.lastRunAt >= liveMs()) run(interval()); else schedule();
    };
    l.halt = () => { l.stopped = true; if (l.timer) { clearT(l.timer); l.timer = 0; } release(); };
    const handle = {
      stop() { l.halt(); loops.delete(l); },
      runNow() { if (!l.stopped && unstick()) run(interval()); },
      lastRunAt: () => l.lastRunAt,
      cadence: () => l.cadence || interval(),
      interval
    };
    loops.add(l);
    if (o.immediate === false) schedule(); else run(interval());
    return handle;
  }

  function onWake(cb) {
    if (typeof cb !== 'function') return () => {};
    wakers.add(cb);
    return () => wakers.delete(cb);
  }

  // back after being away: overdue loops run now, then the wake callbacks (each isolated from the others)
  function wake() {
    if (!awaySeen || away()) return;
    awaySeen = false;
    for (const l of Array.from(loops)) { try { l.catchUp(); } catch (_) { /* one loop cannot block the rest */ } }
    for (const cb of Array.from(wakers)) { try { cb(); } catch (_) { /* one consumer cannot block the rest */ } }
  }
  const onInput = () => { lastInputAt = now(); if (awaySeen) wake(); };
  const onVisibility = () => { if (doc && !doc.hidden) wake(); };

  let bound = null;
  function bind(d, w) {
    if (bound) {
      try { if (bound.d) bound.d.removeEventListener('visibilitychange', onVisibility); } catch (_) { /* a fake doc may lack it */ }
      try { if (bound.w) for (const ev of ['focus', 'pointerdown', 'pointermove', 'keydown', 'wheel']) bound.w.removeEventListener(ev, onInput, true); } catch (_) { /* same */ }
    }
    doc = d || null;
    bound = { d: doc, w: w || null };
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
    if (w && w.addEventListener) for (const ev of ['focus', 'pointerdown', 'pointermove', 'keydown', 'wheel']) w.addEventListener(ev, onInput, { passive: true, capture: true });
  }
  if (typeof document !== 'undefined' && typeof window !== 'undefined') bind(document, window);

  return {
    away, every, onWake, AWAY_MS, INPUT_GRACE_MS, FRAME_PROOF_MS, DEADLINE_MIN_MS,
    _setDocForTest(d, w) { bind(d, w); },
    _setClockForTest(fn) { now = fn || monotonic; },
    _setTimersForTest(setFn, clearFn) { setT = setFn; clearT = clearFn; },
    _setFrameForTest(fn) { frame = typeof fn === 'function' ? fn : null; probeAt = 0; probeSeq++; },
    _setRaiseForTest(onThrow, onReject) { raise = onThrow; raiseRejection = onReject || onThrow; },
    _resetForTest() {
      for (const l of Array.from(loops)) l.halt();
      loops.clear(); wakers.clear(); lastInputAt = -Infinity; awaySeen = false; probeAt = 0; probeSeq++;
    },
    _debug: () => ({ loops: loops.size, wakers: wakers.size, awaySeen, lastInputAt, probeOut: !!probeAt })
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PollGate;
