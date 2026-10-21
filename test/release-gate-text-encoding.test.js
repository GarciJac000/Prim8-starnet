/* node test/release-gate-text-encoding.test.js — the release/QA gate scripts print what the operator reads at cut
   time (release:preflight relays claims.mjs's status line verbatim). A UTF-8 middle dot or ellipsis saved through a
   cp1252 round trip becomes "Â·" / "â€¦" in the checklist; this pins the gate sources free of that signature. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// U+00C2 followed by a Latin-1 punctuation byte (Â· Â§ Â©) or the U+00E2 U+20AC lead of a mangled dash/quote/ellipsis
const MOJIBAKE = /Â[ -¿]|â€/;
const hits = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.(mjs|cjs|js)$/.test(e.name)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (MOJIBAKE.test(line)) hits.push(path.relative(ROOT, p).replace(/\\/g, '/') + ':' + (i + 1));
    });
  }
})(path.join(ROOT, 'scripts'));
A.eq(hits, [], 'release/QA gate scripts carry no double-encoded UTF-8 text');

const claims = fs.readFileSync(path.join(ROOT, 'scripts/qa/product-perfect/claims.mjs'), 'utf8');
A.ok(/' authority · '/.test(claims), 'the claims status line separates its fields with a real middle dot');
A.report('release-gate-text-encoding.test');
