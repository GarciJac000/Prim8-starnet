/* node test/intake-plain-questions.test.js — the intake interview asks PLAIN questions, rendered as written.

   Found live by the onboarding sweep (2026-10-20) on a fresh station, COMMANDER › Start a guided interview:
   1. The stack question rendered as "so i reach for the right tools instead of guessing —what’s open on your
      screen right now? that’s the honest answer." Answered literally ("just this StarNet window"), it was saved
      as the Commander's STATED stack. Several asks still carried the retired scene register — a hypothetical
      ("say i work for you for a year, free and tireless — what exists at the end…"), "catch yourself
      complaining", "the rule you catch yourself repeating" — the decode-work the PLAIN-QUESTION LAW
      (docs/ONBOARDING_V3_PLAN.md §1, Andrew 2026-07-20) bans: personality lives in reactions, never in questions.
   2. intake.js typed the lead-in and the ask as back-to-back segments with nothing between them, so every
      question rendered glued: "guessing —what’s", "silhouette.what does".

   Behavioral: the REAL intake.js runs in a vm against a recording Chat stub, so the assertion is on the line
   the Commander actually sees. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const I = require('../frontend/app/interview.js');

/* ---------- 1. no decode-work shapes in any ask (the plain-question law) ---------- */
const BANNED = /open on your screen|free and tireless|catch yourself|honest answer|lands on your desk|month ends well|say i work for you|carry myself/i;
for (const q of I.QUESTIONS) {
  A.ok(!BANNED.test(q.ask), 'the ' + q.dim + ' ask is a plain question (no scene-register shape): ' + q.ask);
  A.ok(/\?$/.test(q.ask.trim()), 'the ' + q.dim + ' ask ends as a question');
}

/* ---------- 2. the rendered line keeps a space between the lead-in and the ask ---------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'intake.js'), 'utf8');
const lines = [];
const ctx = {
  console,
  Interview: I,
  setTimeout: fn => { fn(); return 0; },   // run the paced beats synchronously
  document: { addEventListener() {}, removeEventListener() {} },
  Chat: {
    beginInterview() {}, endInterview() {}, echoUser() {}, choices() {},
    typeLine(segs, cb) { lines.push(segs.map(s => s.text).join('')); if (cb) cb(); return () => {}; }
  }
};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.Intake = Intake;', ctx);
A.ok(ctx.Intake.start({ skip: [] }), 'the intake interview starts');
const first = I.QUESTIONS[0];
const asked = lines.find(l => l.indexOf(first.ask) >= 0) || '';
A.ok(asked.length > 0, 'the first question was typed');
A.ok(asked.indexOf(first.pre + ' ' + first.ask) >= 0, 'the lead-in and the ask are separated by a space: ' + asked);
A.ok(!/[—.,]\S/.test(asked.replace(/^\[\d+\/\d+\]\s*/, '').replace(/\b[a-z]\.[a-z]\b/gi, '')), 'no punctuation is glued to the next word: ' + asked);

A.report('intake-plain-questions.test');
