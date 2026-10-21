/* node test/onboarding-answer-hygiene.test.js — what the awakening does with a beginner's typed answers.

   Both found live by the onboarding sweep (2026-10-20) on a fresh station against a mock provider:

   1. A 5,000-word answer (42,001 chars) to "what made you want to set up an agent?" was committed verbatim to the
      agent's context.md. context.md is folded into EVERY system prompt (app.js composeSystemPrompt), so the very
      next interview call already carried a 49,411-char system prompt plus the same text quoted again in the
      directive — ~93 KB per call, and every run afterwards pays for it until someone edits the doc. Each answer
      is now clipped (ANSWER_CHARS) before anything is written or quoted.

   2. At a read gate ("i need a direction here — even a rough one. / Continue →") the composer still says
      "answer to wake your agent…". Typing "teaching chemistry" + Enter there cleared the box, echoed nothing and
      dropped the words: the handler's Dialogue.answer() had no pending question and the text vanished. It now goes
      back into the composer so the next question can take it.

   Behavioral: the REAL onboarding.js and intake.js run in a vm against recording stubs. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');

function awakening(answerFor) {
  const commits = [], prefills = [];
  let nodes = 0;
  let composer = null;
  const ctx = {
    console, Promise,
    Interview: require('../frontend/app/interview.js'),
    // every timer fires on a later macrotask: a stubbed brain that answers at once (microtasks) always beats its own
    // patience windows and ceilings, as a fast real reply does — and the heartbeat's self-rescheduling timer can never
    // spin the microtask queue (report() exits the process, so its loop does not hold the test open)
    setTimeout: fn => { setImmediate(fn); return 0; }, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    World: {},
    Chat: {
      beginInterview(cb) { composer = cb; }, endInterview() {}, localLine() {},
      typeLine(segs, cb) { if (cb) Promise.resolve().then(cb); return () => {}; },
      prefill(t) { prefills.push(t); }
    },
    Dialogue: {
      open() {}, setStage() {}, ink() {}, close() {}, isOpen: () => false,
      say: async () => {},
      answer: () => false,          // a read gate: no free-text question is waiting
      node: async cfg => (++nodes > 120 ? new Promise(() => {}) : answerFor(cfg))   // a re-ask loop parks instead of spinning
    }
  };
  vm.createContext(ctx);
  vm.runInContext(read('onboarding.js') + '\nthis.Onboarding = Onboarding;', ctx);
  return { ctx, commits, prefills, composer: () => composer };
}

(async () => {
  /* ---------- 1. a wall of text is clipped before it is committed ---------- */
  const wall = 'inventory emails posters customers shipping returns '.repeat(800).trim();   // ~42k chars
  A.ok(wall.length > 40000, 'the probe answer is a wall of text (' + wall.length + ' chars)');
  const run = awakening(cfg => {
    const first = String((cfg.lines && cfg.lines[0] && cfg.lines[0].text) || '');
    if ((cfg.options || []).some(o => o.value === 'quick')) return { value: 'quick', label: 'Quick setup' };
    if (/set up an agent/.test(first)) return { value: wall, label: wall, custom: true };
    return { value: '', skip: true };
  });
  run.ctx.Onboarding.start({ docs: {}, commit: p => run.commits.push(p), wake: false, name: 'TEST', role: 'orchestrator' });
  for (let i = 0; i < 200 && !run.commits.some(c => c && c.purpose); i++) await new Promise(r => setImmediate(r));
  const purpose = (run.commits.find(c => c && c.purpose) || {}).purpose || '';
  A.ok(purpose.length > 0, 'the quick setup committed a purpose');
  A.ok(purpose.length <= 2000, 'a 42k-char answer is clipped before it is committed (got ' + purpose.length + ' chars)');
  A.ok(wall.startsWith(purpose.replace(/…$/, '').trim()), 'the clip keeps the beginning of what they said');

  // the clip counts code points: an emoji-studded wall never ends in half an emoji
  const studded = '🚀a'.repeat(1500);   // aligned so a UTF-16 slice at 1999 lands mid-emoji
  const run1b = awakening(cfg => {
    const first = String((cfg.lines && cfg.lines[0] && cfg.lines[0].text) || '');
    if ((cfg.options || []).some(o => o.value === 'quick')) return { value: 'quick', label: 'Quick setup' };
    if (/set up an agent/.test(first)) return { value: studded, label: studded, custom: true };
    return { value: '', skip: true };
  });
  run1b.ctx.Onboarding.start({ docs: {}, commit: p => run1b.commits.push(p), wake: false, name: 'TEST', role: 'orchestrator' });
  for (let i = 0; i < 200 && !run1b.commits.some(c => c && c.purpose); i++) await new Promise(r => setImmediate(r));
  const p1b = (run1b.commits.find(c => c && c.purpose) || {}).purpose || '';
  A.ok(p1b.length > 0 && Array.from(p1b).length <= 2000, 'an emoji-studded wall is clipped too (' + Array.from(p1b).length + ' code points)');
  A.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p1b), 'the clip never leaves a lone surrogate');

  /* ---------- 2. text typed at a read gate goes back to the composer, never into the void ---------- */
  const gate = awakening(() => new Promise(() => {}));   // the ceremony is parked on a beat
  gate.ctx.Onboarding.start({ docs: {}, commit() {}, wake: false, name: 'TEST', role: 'orchestrator' });
  const typed = gate.composer();
  A.ok(typeof typed === 'function', 'the awakening owns the composer');
  typed('teaching chemistry');
  A.eq(gate.prefills, ['teaching chemistry'], 'an answer typed at a read gate is handed back to the composer');
  typed('   ');
  A.eq(gate.prefills.length, 1, 'whitespace is not handed back');

  /* ---------- 2b. the intake interview: an answer typed while the question is still typing ---------- */
  const ip = [];
  let icb = null, hold = null;
  const ictx = {
    console, Interview: require('../frontend/app/interview.js'),
    setTimeout: fn => { fn(); return 0; },
    document: { addEventListener() {}, removeEventListener() {} },
    Chat: {
      beginInterview(cb) { icb = cb; }, endInterview() {}, echoUser() {}, choices() {}, prefill(t) { ip.push(t); },
      typeLine(segs, cb) { if (/\[1\//.test(segs.map(s => s.text).join(''))) { hold = cb; } else if (cb) cb(); return () => {}; }
    }
  };
  vm.createContext(ictx);
  vm.runInContext(read('intake.js') + '\nthis.Intake = Intake;', ictx);
  let committed = null;
  A.ok(ictx.Intake.start({ skip: [], onCommit: b => { committed = b; } }), 'the intake interview starts');
  A.ok(typeof hold === 'function', 'the first question is still typing');
  icb('I run a print shop');
  A.eq(ip, ['I run a print shop'], 'an intake answer typed mid-question is handed back to the composer');
  A.eq(committed, null, '…and nothing was committed for it');

  /* ---------- 3. THE MIRROR (deep meeting, live mind): a grabbed offer and a redirect ----------
     Live (2026-10-20): wakemind's directive REQUIRES offers phrased as the agent ("i could …"). Grabbing one stored
     the goal belief "Wants the station to: i could draft your launch checklist tonight." and prefilled the FIRST TASK
     with the agent's own sentence, which Start sent as the Commander's message verbatim. And the redirect box
     ("none of these — i'll say it") bypassed askStep, so an emoji-only reply landed as a STATED goal + first task. */
  function deep(mirrorPick, redirectText) {
    const upserts = [], armed = [];
    const run2 = awakening(cfg => {
      const first = String((cfg.lines && cfg.lines[0] && cfg.lines[0].text) || '');
      const opts = cfg.options || [];
      if (opts.some(o => o.value === 'deep')) return { value: 'deep', label: 'deep' };
      if (/set up an agent/.test(first)) return { value: 'I run a small poster shop and drown in customer email.', label: 'x', custom: true };
      if (opts.some(o => o.value === 'redirect')) return mirrorPick === 'redirect' ? { value: 'redirect' } : { value: 'o0' };
      if (/what would you actually hand me/.test(first)) return { value: redirectText, label: redirectText, custom: true };
      const skip = opts.find(o => o.skip);
      return skip ? { value: '', skip: true } : (opts[0] || { value: '', skip: true });
    });
    const W = require('../frontend/app/wakemind.js');
    const reply = d => {
      if (/THE OFFERS/.test(d)) return 'OFFER1: i could draft your launch checklist tonight.\nOFFER2: i could sort your inbox into three piles.\nOFFER3: NONE\nOFFER4: NONE';
      if (/THE READ/.test(d)) return 'READ: you sell posters and want your evenings back.\nPURPOSE: Keep the shop running smoothly.\nSTACK: NONE';
      return 'ACK: got it.\nASK: NONE';
    };
    Object.assign(run2.ctx, {
      WakeMind: W,
      Harness: { configured: () => true, chat: async o => ({ text: reply(String(o.messages[0].content)) }) },
      DossierStore: { upsert: (dim, b) => upserts.push({ dim, text: b.text, weight: b.weight }), beliefs: () => [] },
      PitchStore: { armFirstMove: m => armed.push(m) }
    });
    run2.ctx.Onboarding.start({ docs: {}, commit: p => run2.commits.push(p), wake: false, name: 'TEST', role: 'orchestrator' });
    return { run: run2, upserts, armed };
  }
  const settle = async (pred) => { for (let i = 0; i < 400 && !pred(); i++) await new Promise(r => setImmediate(r)); };

  const grab = deep('o0');
  await settle(() => grab.armed.length > 0);
  A.eq(grab.armed.length, 1, 'grabbing an offer arms the first task');
  A.ok(!/^\s*i could\b/i.test(grab.armed[0] || ''), 'the first task is not the agent’s own sentence: ' + grab.armed[0]);
  A.ok(/draft your launch checklist tonight/.test(grab.armed[0] || ''), '…it still carries the offer they picked: ' + grab.armed[0]);
  const g = grab.upserts.find(u => u.dim === 'goals' && /launch checklist/.test(u.text));
  A.ok(g && !/to: i could/i.test(g.text), 'the goal belief reads as a fact about the Commander, not "Wants the station to: i could …": ' + (g && g.text));

  const redir = deep('redirect', '🚀🔥💯🙏');
  await settle(() => redir.run.commits.some(c => c && c.purpose));
  A.ok(redir.run.commits.some(c => c && c.purpose), 'the emoji redirect run reached the mission');
  A.ok(!redir.upserts.some(u => u.dim === 'goals' && /🚀/.test(u.text)), 'an emoji-only redirect is not stored as a stated goal');
  A.eq(redir.armed.length, 0, 'an emoji-only redirect arms no first task');

  A.report('onboarding-answer-hygiene.test');
})();
