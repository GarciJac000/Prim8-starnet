/* node test/fork-marker-perf.test.js — the choice-marker grammar costs one pass over the text, and reads exactly what it did.

   perf p5 (2026-10-20, a user: "eats my PC's resources"): fork.js's FORK / TASK_QUESTION line grammar was a lazy prefix
   followed by three quantifiers that all eat spaces, so a line holding a long space run was tried every way the run splits,
   at every position. The live reply runs Fork.liveText on its whole open paragraph every frame (chat.js shownProse), the
   history render and the 900 ms group paint run stripMarkers / readable on every message: a 20-line ASCII box cost
   ~200 ms per frame, one 400-space line ~8 s.
   Locked here through the module's own exports (the functions chat.js, group-chat.js and the sidecar call):
     1. a padded box, a long padded line with a marker on it, an open marker after a long run — each well under budget;
     2. the SAME answers as the 10-14 grammar (kept below verbatim as the oracle) on random text built from the
        characters the grammar cares about — markers, decoration, list numbers, spaces, CR / LS line ends. */
'use strict';
const A = require('./_assert.js');
const F = require('../frontend/app/fork.js');

/* ---------- 1. cost: these took 0.2–8 s each on the old grammar ---------- */
const box = (w, h) => { const l = ['+' + '-'.repeat(w) + '+']; for (let i = 0; i < h; i++) l.push('|' + ' '.repeat(w) + '|'); l.push(l[0]); return l.join('\n'); };
const sp = ' '.repeat(400);
const heavy = [
  'Here is the layout:\n' + box(58, 20) + '\nmore text',                      // a padded box, no marker anywhere
  'A FORK: aside first\n' + box(58, 20) + '\nFORK: a or b? || a | b',          // the same box once the text names a keyword
  'x' + sp + 'y FORK: which one? || a | b',                                     // a marker on a long padded line
  'a || b FORK:' + sp + 'x',                                                    // a keyword and a colon, no `||` after them
  'intro\nx' + sp + 'y TASK_QUESTION: which',                                  // the marker still arriving, after a long run
  '| Fork |' + sp + '| a || b |' + sp + '|'                                      // a padded table row naming the keyword
];
const t0 = Date.now();
for (const s of heavy) { F.liveText(s); F.stripMarkers(s); F.readable(s); F.parse(s); F.TaskIntent.parse(s); F.TaskIntent.strip(s); }
const spent = Date.now() - t0;
A.ok(spent < 300, 'six padded texts through every marker reader cost ' + spent + ' ms (the old grammar spent seconds on the 400-space line alone)');
A.eq(F.parse('x' + sp + 'y FORK: which one? || a | b'), { question: 'which one?', options: ['a', 'b'] }, 'a marker on a long padded line still parses');
A.eq(F.liveText('intro\nx' + sp + 'y TASK_QUESTION: which'), 'intro\nx' + sp + 'y', 'the open marker after a long run is still held back');

/* ---------- 2. the same answers as the 10-14 grammar ---------- */
const DECO = '[*_`~]*';
const FORK_KEY = '\\bF(?:ORK|ork)', TASK_KEY = '[Tt][Aa][Ss][Kk]_[Qq][Uu][Ee][Ss][Tt][Ii][Oo][Nn]', MK = '(?:' + FORK_KEY + '|' + TASK_KEY + ')';
const oldSource = key => '^([^\\n]*?)[ \\t>+-]*(?:\\d{1,2}[.)])?[ \\t]*' + DECO + '[ \\t]*' + key + DECO + '[ \\t]*:' + DECO + '[ \\t]*([^\\n]*?)[ \\t]*' + DECO
  + '[ \\t]*\\|\\|[ \\t]*([^\\n]*?)[ \\t]*$';
const O = (() => {   // the 10-14 readers, verbatim but for their names
  const LINE = new RegExp(oldSource(FORK_KEY), 'm'), LINE_ALL = new RegExp(oldSource(FORK_KEY), 'gm');
  const TASK_LINE = new RegExp(oldSource(TASK_KEY), 'm'), TASK_LINE_ALL = new RegExp(oldSource(TASK_KEY), 'gm');
  const ANY_LINE_ALL = new RegExp(oldSource(MK), 'gm');
  const OPEN_TAIL = new RegExp('(^|\\n)([^\\n]*?)[ \\t>+-]*(?:\\d{1,2}[.)])?[ \\t]*' + DECO + '[ \\t]*' + MK + DECO + '[ \\t]*:[^\\n]*$');
  const undeco = s => String(s == null ? '' : s).replace(/^[\s*_`~]+|[\s*_`~]+$/g, '');
  function stripWith(re, text) {
    const s = String(text == null ? '' : text);
    re.lastIndex = 0; if (!re.test(s)) return s; re.lastIndex = 0;
    return s.replace(re, (m, pre) => String(pre || '').replace(/[ \t]+$/, '')).replace(/\n{3,}/g, '\n\n').trim();
  }
  function parse(text) {
    const m = LINE.exec(String(text == null ? '' : text)); if (!m) return null;
    const question = undeco(m[2]).slice(0, 160);
    const options = m[3].split('|').map(undeco).filter(Boolean).slice(0, 3).map(s => s.length > 48 ? s.slice(0, 47) + '…' : s);
    return !question || options.length < 2 ? null : { question, options };
  }
  function stripMarkers(text) { const s = String(text == null ? '' : text); const out = stripWith(TASK_LINE_ALL, stripWith(LINE_ALL, s)); return out === s ? s : out; }
  function halfKeyword(w) {
    const up = w.toUpperCase();
    if (w !== up && w !== 'Fork' && w.indexOf('_') < 0) return false;
    return 'TASK_QUESTION:'.indexOf(up) === 0 || ((w === up || w === 'Fork') && 'FORK:'.indexOf(up) === 0);
  }
  function liveText(text) {
    let s = stripMarkers(text);
    const open = OPEN_TAIL.exec(s);
    if (open) return s.slice(0, open.index) + open[1] + open[2].replace(/[ \t]+$/, '');
    const half = /(^|[\s*_`~:>-])([A-Za-z_]{3,13})$/.exec(s);
    if (half && halfKeyword(half[2])) s = s.slice(0, half.index + half[1].length).replace(/[ \t*_`~]+$/, '');
    return s;
  }
  function readable(text) {
    const s = String(text == null ? '' : text);
    ANY_LINE_ALL.lastIndex = 0; if (!ANY_LINE_ALL.test(s)) return s; ANY_LINE_ALL.lastIndex = 0;
    return s.replace(ANY_LINE_ALL, (m, pre, q, opts) => {
      const head = String(pre || '').replace(/[ \t]+$/, '');
      const list = String(opts || '').split('|').map(undeco).filter(Boolean).map(o => '- ' + o).join('\n');
      return (head ? head + '\n' : '') + undeco(q) + (list ? '\n' + list : '');
    });
  }
  // TaskIntent.parse over the old grammar (its option dedupe is the module's own, unchanged)
  function taskParse(text) {
    const m = TASK_LINE.exec(String(text == null ? '' : text)); if (!m) return null;
    const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
    const question = clean(undeco(m[2]), 240), raw = m[3].split('|').map(undeco).join('|');
    if (raw.trim() === '[free text]') return question ? { question, options: [], mode: 'conversation' } : null;
    const deduped = F.TaskIntent.dedupeOptions(raw.split('|'));
    const options = deduped.length >= 2 ? deduped : raw.split('|').map(x => clean(x, 72)).filter(Boolean).slice(0, 3);
    return question && options.length >= 2 ? { question, options } : null;
  }
  return { parse, stripMarkers, liveText, readable, taskStrip: t => stripWith(TASK_LINE_ALL, t).trim(), strip: t => stripWith(LINE_ALL, t).trim(), taskParse };
})();
A.ok(O.parse('a FORK: q? || x | y') && !O.parse('hello'), 'the oracle reads a marker (guards a mistyped oracle)');

let seed = 20261020;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];
const TOKS = ['FORK', 'Fork', 'FORk', 'fork', 'TASK_QUESTION', 'task_question', 'Task_Question', 'TASK_QU', 'FOR', 'task_q', '||', '||', '|', ':', ': ',
  ' ', ' ', '  ', '\t', '\n', '\n', '\r', '\r\n', ' ', ' ', '﻿', '*', '**', '_', '`', '~', '>', '+', '-', '1', '12', '123', '.', ')', '1. ',
  'a', 'b', 'q?', 'x', 'é', 'xFORK', '_FORK', '9'];
const LEADS = ['', ' ', '  ', '- ', '> ', '+ ', '1. ', '12) ', '123. ', '**', '* ', ' ** ', '`', '~~', '\t', ' -  ** ', '1.**', 'x', 'x ', '9.'];
const DECOS = ['', '', '*', '**', ' ', '  ', ' * ', '_', '`', '\t', '* *', ' ** '];
const KEYS = ['FORK', 'Fork', 'TASK_QUESTION', 'task_question', 'FORKS', 'fork', 'xFORK'];
const noise = k => { let s = ''; for (let n = Math.floor(rnd() * k); n > 0; n--) s += pick(TOKS); return s; };
const marker = () => noise(3) + pick(LEADS) + pick(KEYS) + pick(DECOS) + (rnd() < 0.9 ? ':' : '') + pick(DECOS) + noise(4) + pick(DECOS)
  + (rnd() < 0.85 ? '||' : '|') + pick(DECOS) + noise(4) + pick(DECOS);
function sample() {
  if (rnd() < 0.4) return noise(17) || 'x';
  let s = '';
  for (let n = 1 + Math.floor(rnd() * 3), i = 0; i < n; i++) s += (i ? pick(['\n', '\n', '\r', '\r\n', ' ', ' ']) : '') + (rnd() < 0.8 ? marker() : noise(5));
  return s;
}
const N = 12000;
let diffs = 0, read = 0, first = '';
for (let k = 0; k < N; k++) {
  const s = sample();
  const pairs = [['parse', O.parse(s), F.parse(s)], ['stripMarkers', O.stripMarkers(s), F.stripMarkers(s)], ['liveText', O.liveText(s), F.liveText(s)],
    ['readable', O.readable(s), F.readable(s)], ['strip', O.strip(s), F.strip(s)], ['TaskIntent.strip', O.taskStrip(s), F.TaskIntent.strip(s)],
    ['TaskIntent.parse', O.taskParse(s), F.TaskIntent.parse(s)]];
  if (O.stripMarkers(s) !== s) read++;
  for (const [name, a, b] of pairs) if (JSON.stringify(a) !== JSON.stringify(b)) { diffs++; if (!first) first = name + ' on ' + JSON.stringify(s) + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b); }
}
A.ok(read > N / 10, 'the samples hold real markers (' + read + ' of ' + N + ' texts carry one)');
A.eq(diffs, 0, 'every reader answers exactly as the 10-14 grammar did' + (first ? ' — first difference: ' + first : ''));

A.report('fork-marker-perf.test');
