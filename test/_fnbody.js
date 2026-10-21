'use strict';
/* test/_fnbody.js — fnBody on its own, so a node:test file can slice a function without pulling in the
   _assert.js runner (whose report()/exit contract lint-gate-can-fail enforces on every file that loads it).
   _assert.js re-exports it: existing callers are unchanged. */
/* fnBody(src, header) → the source of exactly ONE function, from its declaration to its OWN closing brace.
   Source-lock tests in this repo slice chat.js by a magic char count (`src.slice(i, i + 2600)`), which silently
   overruns into the NEXT function as bodies grow: a `why:` assertion aimed at suggestCandidate happily matched
   seedCandidate's, and deleting the line under test left the test green. Brace-count to the real end instead —
   then every lock binds the function it names, and nothing else. Quotes, template literals and comments are
   skipped so a brace inside a string or a prose comment can't end the body early.
   THE ONE CONCRETE HAZARD, named rather than hand-waved: REGEX LITERALS ARE NOT PARSED. A quote character inside
   a regex CHARACTER CLASS — `/[^']+/`, `/["']/` — opens the string-skip above, which then runs to the next
   matching quote somewhere later in the file, swallowing every brace in between. The scan does not end at the
   function's real closing brace and the returned slice RUNS LONG into whatever follows. It fails open (a longer
   body still contains everything the caller asserts) but a `!/…/.test(body)` assertion aimed at that function can
   then be satisfied — or falsified — by a NEIGHBOUR's source. So: any caller scanning a function that contains a
   quote inside a regex class MUST keep a length guard (assert the body is non-empty AND shorter than the file, or
   shorter than a sane bound) — that guard is what catches a mis-scan. This is a test helper, not a JS parser, and
   teaching it regex-vs-division would cost more than the guard. Returns '' if the header is absent. */
function fnBody(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) { if (src[i] === '\\') { i++; continue; } if (src[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

module.exports = { fnBody };
