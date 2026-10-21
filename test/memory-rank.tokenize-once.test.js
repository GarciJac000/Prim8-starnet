/* node test/memory-rank.tokenize-once.test.js — memory recall tokenizes each record once per call, with scores
   bit-identical to the naive single-pass ranking.

   THE BUG (perf review 2026-10-19): rank() -> lexicalScores() tokenized every notebook record for the exact query,
   again inside lexicalText, again for the expanded query, and again for each query variant, with a linear scan of
   the alias groups per token (~75-120 ms per recall at 2,000 records, on every run).
   Part 1 counts String.prototype.normalize calls (one per tokenize) across a real rank() over 200 records with two
   query variants: the old code made ~1,000, the fixed one makes ~one per record.
   Part 2 rebuilds the naive ranking (the old algorithm, verbatim) from the module's own current primitives and
   diffs it against lexicalScores() and bm25() on seeded random corpora, Unicode and the lexical rewrites included. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/context.js');
const I = C._internals || {};

let seed = 0xbadd0c;   // mulberry32
const rnd = n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
const pick = a => a[rnd(a.length)];
const WORDS = ['deploy', 'uploads', 'uploading', 'pushed', 'throttled', 'rate limit', 'rate-limits', 'ratelimit', 'long winded', 'long-winded', 'colour', 'Colors',
  'theses', 'boxes', 'churches', 'flies', 'cities', 'bus', 'gas', 'is', 'the', 'a', 'go', 'ai', 'v1', 'JS', 'TypeScript', 'postgresql', 'émigré', 'Straße', 'ﬁle',
  'İstanbul', 'ǅungla', 'ſtate', 'Ωmega', '①②', '١٢', 'naïve', 'café', 'x', '__proto__', 'constructor', 'toString', 'images',
  'Pictures', 'reboots', 'folder', 'email', 'mails', 'brief', 'terse', 'concise', 'verbose', 'wordy', '日本', 'ｆｕｌｌ', 'K', '½',
  'kisses', 'cans', 'wills', 'thats', 'ands', 'yes', 'its', "it's", '—', '...', '\n'];
const sent = n => Array.from({ length: n }, () => pick(WORDS)).join(pick([' ', ' ', '-', '_', ', ', '. ', '/']));
function rec(i) {
  const r = { id: 'm' + i, kind: pick(['note', 'fact', 'profile', 'skill', undefined]), createdAt: 1000 + rnd(1e6) };
  if (rnd(3)) r.title = sent(1 + rnd(4));
  if (rnd(2)) r.body = sent(rnd(25)); else r.content = sent(rnd(25));
  return r;
}

// ---- 1. one tokenize per record per recall ----
{
  const records = Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, kind: 'note', title: 'deploy ritual ' + i, body: 'registry uploads keep getting throttled on push number ' + i, createdAt: 1000 + i }));
  const orig = String.prototype.normalize;
  let calls = 0;
  String.prototype.normalize = function () { calls++; return orig.apply(this, arguments); };
  let top;
  try { top = C.rank(records, 'why do registry pushes get rate limited', { now: 1e6, queryVariants: ['docker uploads throttled', 'push limits'] }); }
  finally { String.prototype.normalize = orig; }
  A.ok(calls <= records.length + 20, 'rank() over 200 records with two variants tokenizes about once per record (' + calls + ' normalize calls; the old code made ~1,000)');
  A.ok(Array.isArray(top) && top.length > 0, 'and it still recalls matching notes (' + (top ? top.length : 0) + ')');
}

// ---- 2. bit-identical to the naive ranking built from the same primitives ----
const ready = ['tokenize', 'recordText', 'lexicalForm', 'lexicalStem'].every(k => typeof I[k] === 'function') && Array.isArray(I.LEXICAL_GROUPS);
A.ok(ready, 'the lexical primitives are reachable for the diff');
if (ready) {
  // the pre-2026-10-20 algorithm, verbatim, over the module's CURRENT tokenize/recordText/lexical rules
  const naiveBm25 = (records, query) => {
    const recs = Array.isArray(records) ? records : [];
    const qTerms = I.tokenize(query);
    const scores = new Array(recs.length).fill(0);
    if (!recs.length || !qTerms.length) return { scores, queried: qTerms.length > 0 };
    const K1 = 1.2;
    const docs = recs.map(r => I.tokenize(I.recordText(r)));
    const df = Object.create(null);
    for (const toks of docs) { const seen = Object.create(null); for (const t of toks) { if (!seen[t]) { seen[t] = 1; df[t] = (df[t] || 0) + 1; } } }
    const N = recs.length;
    for (let i = 0; i < recs.length; i++) {
      const tf = Object.create(null); for (const t of docs[i]) tf[t] = (tf[t] || 0) + 1;
      let relevance = 0;
      for (const qt of qTerms) {
        const f = tf[qt]; if (!f) continue;
        const idf = Math.log(1 + (N - df[qt] + 0.5) / (df[qt] + 0.5));
        relevance += idf * (f * (K1 + 1)) / (f + K1);
      }
      scores[i] = relevance;
    }
    return { scores, queried: true };
  };
  const naiveLexicalText = text => I.tokenize(I.lexicalForm(text)).map(t => {
    const group = I.LEXICAL_GROUPS.find(g => g.indexOf(t) >= 0);
    return group ? group[0] : I.lexicalStem(t);
  }).join(' ');
  const naiveLexicalScores = (records, query, opts) => {
    const list = Array.isArray(records) ? records : [];
    const exact = naiveBm25(list, query);
    const normalized = list.map(r => ({ content: naiveLexicalText(I.recordText(r)), kind: 'fact' }));
    const expanded = naiveBm25(normalized, naiveLexicalText(query));
    const variants = opts && Array.isArray(opts.queryVariants) ? opts.queryVariants.slice(0, 3).filter(q => typeof q === 'string').map(q => q.slice(0, 1000)) : [];
    const extra = variants.map(q => naiveBm25(normalized, naiveLexicalText(q)).scores);
    return { queried: exact.queried, scores: exact.scores.map((s, i) => Math.max(s, 0.65 * expanded.scores[i], ...extra.map(a => 0.5 * a[i]))) };
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  let bad = 0, scored = 0;
  for (let n = 0; n < 1200; n++) {
    const recs = Array.from({ length: rnd(40) }, (_, i) => rec(i));
    if (!rnd(20)) recs.push(null);
    const q = rnd(8) ? sent(1 + rnd(8)) : pick(['', 'the a is', '...', null]);
    const opts = rnd(2) ? { queryVariants: Array.from({ length: rnd(5) }, () => (rnd(6) ? sent(1 + rnd(5)) : pick([7, '', 'the']))) } : undefined;
    const want = naiveLexicalScores(recs, q, opts), got = C.lexicalScores(recs, q, opts);
    if (want.scores.some(x => x > 0)) scored++;
    if (want.queried !== got.queried || !same(want.scores, got.scores)) { bad++; if (bad <= 5) A.eq(got, want, 'lexicalScores differs on ' + JSON.stringify({ recs, q, opts }).slice(0, 300)); }
    const wb = naiveBm25(recs, q), gb = C.bm25(recs, q);
    if (wb.queried !== gb.queried || !same(wb.scores, gb.scores)) { bad++; if (bad <= 5) A.eq(gb, wb, 'bm25 differs on ' + JSON.stringify({ recs, q }).slice(0, 300)); }
  }
  A.eq(bad, 0, 'lexicalScores() and bm25() equal the naive ranking bit for bit on every random corpus');
  A.ok(scored > 600, 'the diff really scored matches (' + scored + ' corpora with a non-zero score)');
}

A.report('memory-rank.tokenize-once.test');
