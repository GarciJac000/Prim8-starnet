'use strict';
/* node test/css-parse.test.js — every stylesheet parses the way it reads (10-21). From 10-03 to 10-21 a comment in
   pipglass.css had lost its opening "/*": its prose became part of the next rule's selector, and the browser threw that
   whole rule away (the inbox session list's gap and padding) without a sound. Nothing failed; the rail just ran on an
   older sheet's spacing for 18 days.
   GENUINE (executed): a small tokenizer walks each sheet as a browser would — comments, strings, blocks — and reports a
   stray "*" "/" outside any comment (a comment that lost its opener), prose in a selector, an unclosed comment or string,
   and an unbalanced brace; it is shown to catch the 10-03 break before it is trusted on the real sheets. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

function lint(src) {
  const out = [];
  const lineOf = i => src.slice(0, i).split('\n').length;
  let i = 0, depth = 0, prelude = '', preStart = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) { out.push(lineOf(i) + ': unclosed comment'); break; } i = e + 2; continue; }
    if (c === '*' && d === '/') { out.push(lineOf(i) + ': a stray */ outside any comment (a comment lost its /* opener)'); i += 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      if (src[j] !== c) out.push(lineOf(i) + ': unclosed string');
      prelude += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '{') {
      // a selector never reads like a sentence: four plain lowercase words in a row (bracket and paren contents set aside)
      const p = prelude.trim().replace(/\([^)]*\)/g, '()').replace(/\[[^\]]*\]/g, '[]');
      if (!p.startsWith('@') && /(?:^|\s)[a-z]+ [a-z]+ [a-z]+ [a-z]+(?:\s|$)/.test(p)) out.push(lineOf(preStart) + ': prose in a selector: ' + p.replace(/\s+/g, ' ').slice(0, 60));
      depth++; prelude = ''; i++; preStart = i; continue;
    }
    if (c === '}') { depth--; if (depth < 0) { out.push(lineOf(i) + ': an extra }'); depth = 0; } prelude = ''; i++; preStart = i; continue; }
    if (c === ';') { prelude = ''; i++; preStart = i; continue; }
    if (!prelude.trim()) preStart = i;
    prelude += c; i++;
  }
  if (depth > 0) out.push('end: ' + depth + ' unclosed {');
  return out;
}

/* ---- 1. it catches the 10-03 break (the comment's opener gone, its prose before the next rule) ---- */
const broken = [
  'body .a { color: red; }',
  '',
  '   INBOX SESSION ROWS (Andrew 10-02: "they just look a bit cheap"). Two lines, like a mail inbox: the AGENT\'S',
  '   NAME on top in its own colour, the session title under it.',
  '   ============================================================ */',
  'body.glass-demo.rows-inbox #left #workstreams { gap: 1px; padding: 4px 4px 8px; }'
].join('\n');
const found = lint(broken);
A.ok(found.some(f => /stray \*\/ outside any comment/.test(f)), 'a comment that lost its opener is reported (its closer stands alone): ' + JSON.stringify(found));
A.ok(found.some(f => /prose in a selector/.test(f)), 'its prose in front of the next rule is reported as a selector that reads like a sentence');
A.eq(lint(broken.replace('\n   INBOX', '\n/* ===\n   INBOX')), [], 'with the opener back the same sheet is clean');
A.eq(lint('a[title="one two three four"]::before { content: "it is a sentence here"; } @media (max-width: 9px) { b { c: d; } }'), [],
  'strings, attribute values and at-rule preludes are not selectors');
A.ok(lint('a { b: c; ').length === 1 && lint('a { b: c; } }').length === 1 && lint('/* never closed').length === 1, 'an unclosed block, an extra brace and an unclosed comment are each reported');

/* ---- 2. every stylesheet the app loads ---- */
const dir = path.join(__dirname, '..', 'frontend', 'css');
const sheets = fs.readdirSync(dir).filter(f => f.endsWith('.css'));
A.ok(sheets.length > 30, 'the app\'s stylesheets are found (' + sheets.length + ')');
for (const f of sheets) A.eq(lint(fs.readFileSync(path.join(dir, f), 'utf8')), [], f + ' parses as it reads (no rule silently dropped)');

A.report('css-parse.test');
