'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/app/emergency-control.js', 'utf8');
const tick = () => new Promise(r => setImmediate(r));
function element() { return { textContent: '', hidden: false, disabled: false, style: {}, listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; }, setAttribute(k, v) { this.tip = v; } }; }
function snapshot(halted) { return { halted, subsystems: Object.fromEntries(['cron', 'nightshift', 'loops'].map(k => [k, { halted }])) }; }
(async () => {
  const recovery = element();
  const nodes = { 'automation-resume': recovery };
  let current = snapshot(true), failRead = false, partial = false;
  const calls = [], notices = [];
  let focus;
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes[id], addEventListener() {}, hidden: false },
    window: { addEventListener(k, fn) { if (k === 'focus') focus = fn; } }, setInterval() {}, AbortSignal,
    U: vm.runInNewContext(fs.readFileSync('frontend/js/util.js', 'utf8') + ';U', {
      AbortSignal: {}, AbortController, DOMException, setTimeout() {}
    }),
    StationUI: { notify: m => notices.push(m) },
    fetch: async (path, opts) => {
      calls.push([path, opts]);
      if (opts.method === 'GET') { if (failRead) throw new Error('offline'); return { ok: true, json: async () => current }; }
      if (path.endsWith('/resume')) {
        current = snapshot(false);
        if (partial) { current.halted = true; current.subsystems.loops.halted = true; }
        return { ok: !partial, json: async () => ({ ...current, ok: !partial, errors: partial ? { loops: 'disk failed' } : {} }) };
      }
      current = snapshot(true);
      return { ok: true, json: async () => ({ cronHaltPersisted: true, nightshiftHaltPersisted: true, loopsHaltPersisted: true }) };
    }
  });
  await tick();
  assert.equal(recovery.textContent, 'RESUME AUTOMATION', 'boot reflects old persisted stops');
  assert.equal(calls.filter(c => c[1].method === 'POST').length, 0, 'hydration never resumes');
  await recovery.listeners.click();
  assert.equal(recovery.textContent, 'RESUME AUTOMATION');
  assert.equal(recovery.style.display, 'none', 'hidden wins over .bb paint');
  assert.equal(calls.at(-1)[1].method, 'GET', 'POST success is rechecked');
  assert.deepEqual(JSON.parse(calls.find(c => c[0].endsWith('/resume'))[1].body), { confirm: true });
  assert.ok(!calls.some(c => /posture|cron\/arm|loops\/control/.test(c[0])), 'no posture or permissions mutation');
  await recovery.listeners.click();
  assert.equal(calls.filter(c => c[1].method === 'POST').length, 1, 'stale recovery clicks never stop healthy automation');
  current = snapshot(true);
  await focus();
  partial = true;
  await recovery.listeners.click();
  assert.equal(recovery.textContent, 'RESUME AUTOMATION');
  assert.match(recovery.tip, /Could not resume: loops/);
  assert.match(notices.at(-1), /loops/);
  failRead = true;
  await recovery.listeners.click();
  assert.equal(recovery.textContent, 'CHECK AUTOMATION', 'unknown is never described as resumed');
  assert.match(recovery.tip, /Could not verify/);
  const writes = calls.filter(c => c[1].method === 'POST').length;
  await recovery.listeners.click();
  assert.equal(calls.filter(c => c[1].method === 'POST').length, writes, 'unknown-state retry only reads');
  assert.ok(calls.every(c => c[1].method !== 'POST' || c[0] === '/api/halt/resume'), 'recovery never calls global stop');
  /* fix round 5 (2026-10-20): ONE /api/halt READ ON RETURN. GENUINE (executed): the REAL pollgate.js and the REAL
     emergency-control.js in one page, on a fake clock + timer queue, with reads answering after 40 ms. Coming back from
     away, PollGate's wake ran the overdue beat, and this file's own visibilitychange and focus listeners each started
     another refresh() beside it: three reads at once (trunk: two), the first two answers thrown away. */
  {
    let T = 1e6, seq = 0, reads = 0;
    const timers = new Map();
    const docL = {}, winL = {};
    const doc = { hidden: false, visibilityState: 'visible', hasFocus: () => !doc.hidden, getElementById: id => (id === 'automation-resume' ? element() : null),
      addEventListener(k, fn) { (docL[k] = docL[k] || []).push(fn); }, removeEventListener() {} };
    const win = { addEventListener(k, fn) { (winL[k] = winL[k] || []).push(fn); }, removeEventListener() {} };
    const ctx = vm.createContext({ document: doc, window: win, performance: { now: () => T }, console, AbortController,
      setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: T + Math.max(0, ms || 0) }); return id; },
      clearTimeout: id => { timers.delete(id); }, setInterval() { throw new Error('the gated page arms no bare interval'); },
      U: { timeoutSignal: () => undefined },
      fetch: async () => { reads++; return new Promise(res => { const id = ++seq; timers.set(id, { fn: () => res({ ok: true, json: async () => snapshot(false) }), at: T + 40 }); }); } });
    vm.runInContext(fs.readFileSync('frontend/app/pollgate.js', 'utf8'), ctx);
    vm.runInContext(source, ctx);
    const advance = async ms => { const until = T + ms; for (;;) { let nx = null; for (const [id, t] of timers) if (t.at <= until && (!nx || t.at < nx[1].at)) nx = [id, t]; if (!nx) break; timers.delete(nx[0]); T = Math.max(T, nx[1].at); nx[1].fn(); await tick(); } T = until; };
    await advance(100);
    assert.equal(reads, 1, 'fixture: the boot read, once');
    await advance(10000);
    assert.equal(reads, 3, 'fixture: on screen, a read every 5 s');
    doc.hidden = true; doc.visibilityState = 'hidden';
    for (const fn of docL.visibilitychange || []) fn();
    await advance(40000);
    const away = reads;
    assert.ok(away - 3 <= 2, 'fixture: away, the read slows to the 30 s floor (' + (away - 3) + ' in 40 s)');
    // back: the page is shown (visibilitychange), then the window takes focus — what a restore from the tray fires
    doc.hidden = false; doc.visibilityState = 'visible';
    for (const fn of docL.visibilitychange || []) fn();
    for (const fn of winL.focus || []) fn({ type: 'focus' });
    await advance(100);
    assert.equal(reads - away, 1, 'BACK: one /api/halt read on return (PollGate\'s catch-up), not three (wake + visibilitychange + focus): ' + (reads - away));
    // a focus with nothing in flight (alt-tab back to a page that was never away) still reads at once, as before
    await advance(2000);
    const beforeFocus = reads;
    for (const fn of winL.focus || []) fn({ type: 'focus' });
    await advance(50);
    assert.equal(reads - beforeFocus, 1, 'a focus with no read in flight still reads the pause state at once');
  }
  console.log('PASS emergency control: hydrated recovery, explicit action, read-back, partial failure and offline truth');
})().catch(e => { console.error(e); process.exitCode = 1; });
