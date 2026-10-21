/* node test/channels.telegram.linear.test.js — the Telegram converter's heading and fence rules run in linear time,
   with byte-identical output to the old regexes.

   THE BUG (perf review 2026-10-19): the heading rule /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm backtracked
   cubically — one heading line with 2,000 spaces before more text took ~6 s, and a streaming reply is re-converted
   on every 1.5 s edit. The fence opener ```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n was quadratic on a fence + spaces.
   Part 1 drives the REAL toTelegramHtml / toPlainText on those inputs under a time bound (it fails on the old code).
   Part 2 diffs the new rules against verbatim copies of the old regexes on adversarial and seeded random input. */
'use strict';
const A = require('./_assert.js');
const TF = require('../sidecar/channels/telegram.format.js');
const { toTelegramHtml, toPlainText } = TF;
const I = TF._internals || {};

const ms = fn => { const t = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const BOUND = 400;   // the old code needs ~6,000 ms on the 2,000-space heading; linear code needs well under 5

// ---- 1. the real call path stays fast on the adversarial shapes ----
{
  const heading = '# a' + ' '.repeat(2000) + 'x';
  const h = ms(() => toTelegramHtml(heading));
  A.ok(h.ms < BOUND, 'toTelegramHtml: a heading with 2,000 inner spaces converts in ' + h.ms.toFixed(1) + ' ms (bound ' + BOUND + ')');
  A.eq(h.out.html, '<b>a' + ' '.repeat(2000) + 'x</b>', 'that heading still becomes one bold line with its spaces kept');
  const p = ms(() => toPlainText(heading));
  A.ok(p.ms < BOUND, 'toPlainText: the same heading converts in ' + p.ms.toFixed(1) + ' ms (bound ' + BOUND + ')');
  A.eq(p.out, 'a' + ' '.repeat(2000) + 'x', 'the plain fallback keeps the heading text without the #');
  const tabs = ('## b' + ' \t'.repeat(500) + 'c ##  \n').repeat(4);
  const t = ms(() => toTelegramHtml(tabs));
  A.ok(t.ms < BOUND, 'mixed space/tab runs on four heading lines convert in ' + t.ms.toFixed(1) + ' ms');
  const fence = '```' + ' '.repeat(40000) + 'x';
  const f = ms(() => toTelegramHtml(fence));
  A.ok(f.ms < BOUND, 'a fence followed by 40,000 spaces converts in ' + f.ms.toFixed(1) + ' ms (old code: ~2 s)');
  const fp = ms(() => toPlainText(fence));
  A.ok(fp.ms < BOUND, 'toPlainText on the same fence converts in ' + fp.ms.toFixed(1) + ' ms');
  // linear, not merely faster: 20x the spaces stays inside the same bound (the old code would need hours here,
  // so this only runs once the small case proved the new code is in place)
  if (h.ms < BOUND) {
    const big = ms(() => toTelegramHtml('# a' + ' '.repeat(40000) + 'x\n'.repeat(1) + ('### ' + ' '.repeat(5000) + '#\n').repeat(8)));
    A.ok(big.ms < BOUND, '40,000 inner spaces plus eight 5,000-space headings convert in ' + big.ms.toFixed(1) + ' ms');
  }
}

// ---- 2. identical output to the old regexes ----
const OLD_HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const OLD_FENCE_BLOCK = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const OLD_FENCE_BODY = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;
A.ok(typeof I.replaceHeadings === 'function' && I.FENCE_BLOCK instanceof RegExp && I.FENCE_BODY instanceof RegExp, 'the new rules are reachable for the diff');
if (typeof I.replaceHeadings === 'function' && I.FENCE_BLOCK instanceof RegExp && I.FENCE_BODY instanceof RegExp) {
  const bold = b => '<b>' + b + '</b>';
  const span = (m, a, b) => '{' + JSON.stringify([m, a, b]) + '}';   // the whole match AND its groups must agree
  let bad = 0;
  const check = (s, why) => {
    const cases = [
      ['heading html', I.replaceHeadings(s, bold), s.replace(OLD_HEADING, (m, b) => bold(b))],
      ['heading plain', I.replaceHeadings(s, b => b), s.replace(OLD_HEADING, '$1')],
      ['fence block', s.replace(I.FENCE_BLOCK, (m, lang, body) => span(m, lang || '', body)), s.replace(OLD_FENCE_BLOCK, (m, lang, body) => span(m, lang, body))],
      ['fence body', s.replace(I.FENCE_BODY, (m, body) => span(m, body)), s.replace(OLD_FENCE_BODY, (m, body) => span(m, body))],
    ];
    for (const [label, got, want] of cases) {
      if (got !== want) { bad++; if (bad <= 8) A.eq(got, want, label + ' differs from the old regex on ' + JSON.stringify(s) + (why ? ' (' + why + ')' : '')); }
    }
  };
  const fixed = [
    '#', '# ', '#  ', '#   ', '#\t', '#\t\t', '# \t', '#a', '# a', '# a ', '# a  ', '# #', '# ##', '# ###', '# # #', '# a# #', '# a #',
    '# a##', '# a ## ', '# a ## b ##', '# a ##b', '####### a', '###### a', '    # a', '   # a', '\t\t\t# a', '\t\t\t\t# a', ' # # # ',
    '# a\n## b\n### c ###', '# a\r\n## b\r\n', '# a\rb', '# a # b', '# a ', '#  \n#   \n# \n', 'x\n# a\n\n# b  #  \n',
    '# \u0001' + '0\u0002 tail', '# a\t#\t', '# ' + ' '.repeat(50) + 'x', '#' + ' '.repeat(30), '## ' + '#'.repeat(30),
    '```\ncode```', '```js\ncode\n```', '```  js  \r\ncode```', '``` \t \n x ```', '```js x\ncode```', '```\n```', '``````',
    '```\r\n```', '```js', '``` js\n', '```\n\n```\n```x\n```', '```' + ' '.repeat(40) + '\nx```', '```c++\na```', '```_-+\nb```',
  ];
  for (const s of fixed) check(s, 'fixed case');
  // seeded random strings drawn from the characters both rules key on
  let seed = 0x5eed;   // mulberry32: deterministic, and every output bit is usable (a float LCG degenerates)
  const rnd = n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const PIECES = [' ', ' ', '\t', '#', '#', '##', 'a', 'b', 'x', '\n', '\r\n', '\r', ' ', '`', '```', '```', 'js', '-', '+', '_', '1', '&amp;', '*', '\u0001' + '0\u0002'];
  for (let n = 0; n < 30000; n++) {
    const len = 1 + rnd(24);
    let s = rnd(3) === 0 ? '#'.repeat(1 + rnd(7)) + (rnd(2) ? ' ' : '') : '';
    for (let i = 0; i < len; i++) s += PIECES[rnd(PIECES.length)];
    check(s, 'random #' + n);
  }
  A.eq(bad, 0, 'the new heading and fence rules match the old regexes on every fixed and random input');
}

A.report('channels.telegram.linear.test');
