/* node test/interview.test.js — the pure Intake Interview engine (frontend/app/interview.js).
   Locks the Phase-B promises: plan() asks one question per dimension, skips already-known dimensions and
   caps length; beliefFromAnswer() trims, rejects blanks, and stamps source:'interview' on the right
   dimension; questionFor() finds a dimension's question; and EVERY question targets a real dossier
   dimension (the honesty invariant — a typo'd dim would silently drop the belief). Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const I = require('../frontend/app/interview.js');
const D = require('../frontend/app/dossier.js');

/* ---------- the honesty invariant: every question maps to a real dossier dimension ---------- */
for (const q of I.QUESTIONS) {
  A.ok(D.DIM_KEYS.indexOf(q.dim) >= 0, 'question dim "' + q.dim + '" is a real dossier dimension');
  A.ok(typeof q.ask === 'string' && q.ask.length > 0, 'question for "' + q.dim + '" has an ask');
}
// there is exactly one question per dimension, and they cover every dossier dimension
A.eq(I.QUESTIONS.length, D.DIM_KEYS.length, 'one question per dossier dimension');
A.eq(I.QUESTIONS.map(q => q.dim).sort(), D.DIM_KEYS.slice().sort(), 'questions cover every dimension exactly once');

/* every chip is well-formed; skip chips carry an empty value */
for (const q of I.QUESTIONS) {
  for (const c of (q.chips || [])) {
    A.ok(typeof c.label === 'string' && c.label.length > 0, 'chip has a label (' + q.dim + ')');
    A.ok(typeof c.value === 'string', 'chip value is a string (' + q.dim + ')');
    if (c.skip) A.eq(c.value, '', 'a skip chip carries an empty value (' + q.dim + ')');
  }
}

/* ---------- plan(): skip known dimensions, preserve canonical order, cap ---------- */
const full = I.plan({});
A.eq(full.length, I.QUESTIONS.length, 'plan() with no skip asks every question');
A.eq(full.map(q => q.dim), I.QUESTIONS.map(q => q.dim), 'plan() preserves canonical question order');

const partial = I.plan({ skip: ['identity', 'goals'] });
A.eq(partial.map(q => q.dim), ['stack', 'pain', 'ambition', 'style', 'people', 'schedule', 'standing_orders'], 'plan() skips already-known dimensions');

A.eq(I.plan({ skip: D.DIM_KEYS }).length, 0, 'plan() asks nothing when every dimension is known');
A.eq(I.plan({ max: 2 }).length, 2, 'plan() honors the max cap');
A.eq(I.plan({ skip: ['identity'], max: 2 }).map(q => q.dim), ['stack', 'goals'], 'plan() applies skip then cap');

/* ---------- beliefFromAnswer(): trims, rejects blanks, stamps provenance ---------- */
const q0 = I.questionFor('stack');
A.ok(q0 && q0.dim === 'stack', 'questionFor finds a dimension question');
A.eq(I.questionFor('nonsense'), null, 'questionFor returns null for an unknown dimension');

const b = I.beliefFromAnswer(q0, '  Rust and a little Go  ');
A.eq(b, { dim: 'stack', text: 'Rust and a little Go', source: 'interview', weight: 'stated' }, 'beliefFromAnswer trims + stamps dim/source; typed words are weight stated');
// V3 §5: an answer that IS a canned chip string is mechanically-produced — weight 'seed' (informs the prompt,
// never opens the readiness gate). Only the Commander's own typed words are 'stated'.
const cannedVal = (q0.chips.find(c => c.value) || {}).value;
A.ok(cannedVal, 'the stack question still carries at least one canned chip (fixture guard)');
A.eq(I.beliefFromAnswer(q0, cannedVal).weight, 'seed', 'a canned chip answer lands as weight seed');
A.eq(I.beliefFromAnswer(q0, '   '), null, 'a blank answer yields no belief');
A.eq(I.beliefFromAnswer(q0, ''), null, 'an empty answer yields no belief');
A.eq(I.beliefFromAnswer(q0, null), null, 'a null answer yields no belief');
A.eq(I.beliefFromAnswer(null, 'x'), null, 'no question yields no belief');

/* a belief from the interview actually lands in the right dossier dimension (end-to-end with the engine) */
const dossier = D.fresh();
const belief = I.beliefFromAnswer(I.questionFor('goals'), 'Ship the Commander Dossier');
D.upsert(dossier, belief.dim, { text: belief.text, source: belief.source }, 1);
A.eq(dossier.dims.goals[0].text, 'Ship the Commander Dossier', 'an interview answer upserts into its dossier dimension');
A.eq(dossier.dims.goals[0].source, 'interview', 'the dossier records the interview provenance');

/* ---------- a TYPED skip is a skip, never a belief (bug-sweep P0) ----------
   The interview's opening line invites it ("answer or tap, “skip” anything") and the chip is labelled
   `skip`, so the typed word is the vocabulary the copy teaches. It used to land as the Commander's own
   words at weight 'stated' — the strongest belief the station holds. */
A.eq(I.beliefFromAnswer(q0, 'skip'), null, 'a typed "skip" yields no belief');
A.eq(I.beliefFromAnswer(q0, 'Skip.'), null, 'punctuation + case do not smuggle a skip past the check');
A.eq(I.beliefFromAnswer(q0, 'idk'), null, 'a typed "idk" yields no belief');
A.eq(I.beliefFromAnswer(q0, 'none'), null, 'a typed "none" yields no belief');
A.ok(I.isSkipAnswer('  N/A  '), 'isSkipAnswer normalizes whitespace and punctuation');
// WHOLE-ANSWER MATCH ONLY — a real answer that merely contains a skip word must still land.
A.eq(I.beliefFromAnswer(q0, 'skip the standup prep').weight, 'stated', 'a real answer CONTAINING "skip" still lands');
A.ok(!I.isSkipAnswer('none of the dashboards refresh'), 'a substring is not a skip');

/* ---------- an answer with NO words is not an answer (sweep/onboarding 2026-10-20) ----------
   Live on a fresh station: typing only emoji at the awakening's goal beat stored "🚀🔥💯🙏" as the Commander's
   STATED goal (and prefilled it as the first task); the intake's pain beat stored "😤😤😤" the same way. A reply
   with no letter or digit in any script carries nothing to extract — it is a non-answer, exactly like a typed skip. */
A.ok(I.isSkipAnswer('🚀🔥💯🙏'), 'an emoji-only reply is a non-answer');
A.ok(I.isSkipAnswer('😤 😤 😤'), 'emoji separated by spaces is still a non-answer');
A.ok(I.isSkipAnswer('?!…'), 'punctuation-only is a non-answer');
A.eq(I.beliefFromAnswer(q0, '🚀🔥💯🙏'), null, 'an emoji-only reply yields no belief');
A.eq(I.beliefFromAnswer(q0, 'ship 🚀 the shop').weight, 'stated', 'words WITH emoji still land');
A.eq(I.beliefFromAnswer(q0, '私は学生です').weight, 'stated', 'a non-Latin answer is a real answer');
A.eq(I.beliefFromAnswer(q0, '42').weight, 'stated', 'a number is a real answer');

A.report('interview.test');
