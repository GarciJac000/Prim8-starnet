/* mobile-topbar-glass-cascade.test.js — the phone-width topbar contract must survive the DEFAULT skin.
   topbar.css/interface.css hide the COMMANDER level lamp at ≤600px so UPLINK (the link-truth lamp) keeps the
   room (locked by test/mobile-control-reachability.test.js). But glass is the default skin (glass-boot.js turns
   it on unless ?glass=0), and its bare-readout rules — `body.glass-demo:not(.hud-mode) #topbar #tb-station
   { display:grid }` and the `.tb-status` divider padding — out-rank a bare `#topbar #tb-station` at any width.
   Live at 390×844 (sweep/world 2026-10-20): the lamp still showed, #topbar scrollWidth 503 in a 380 box, and the
   status cluster sat at x 338–495 — UPLINK clipped to "UPLI", ONLINE / LINK DOWN off-screen. This test reads the
   cascade, not just the presence of a rule: the glass sheet itself must carry the phone-width override at the
   same specificity as the rule it beats. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const glass = read('frontend/css/pipglass.css');
const boot = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/glass-boot.js'), 'utf8');
A.ok(/classList\.toggle\('glass-demo'/.test(boot), 'glass is still the default skin (glass-boot.js) — the reason this cascade matters');

// the glass rule that out-ranks the topbar.css phone rule is still there (else this lock is moot, not broken)
A.ok(/body\.glass-demo:not\(\.hud-mode\) #topbar #tb-station\s*\{[^}]*display:\s*grid/.test(glass),
  'glass still lays the level lamp out as a grid (the rule a bare #topbar #tb-station cannot beat)');

// every @media (max-width: N) block with N ≤ 600 in the glass sheet, flattened
const phone = [];
for (const m of glass.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)) {
  if (+m[1] > 600) continue;
  let i = m.index + m[0].length, depth = 1, j = i;
  while (j < glass.length && depth) { if (glass[j] === '{') depth++; else if (glass[j] === '}') depth--; j++; }
  phone.push(glass.slice(i, j - 1));
}
const phoneCss = phone.join('\n');
A.ok(/body\.glass-demo:not\(\.hud-mode\) #topbar #tb-station\s*\{[^}]*display:\s*none/.test(phoneCss),
  'at phone width the glass sheet hides the level lamp at glass specificity');
const status = /body\.glass-demo:not\(\.hud-mode\) #topbar \.tb-status\s*\{([^}]*)\}/.exec(phoneCss);
A.ok(status && /padding-left:\s*0/.test(status[1]) && /margin-left:\s*0/.test(status[1]),
  'at phone width the glass UPLINK cluster drops its 16px+16px divider inset (the room UPLINK needs at 390px)');
A.report('mobile-topbar-glass-cascade.test');
