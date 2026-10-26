'use strict';
/* node test/curved-dashboard.test.js — the curved dashboard (Andrew 10-25: "bring back the more curved edges … we can
   still keep our style, just with the more curved edges without the sharp pointiness … it looks really inconsistent
   with everything else"; a scanline raster was then picked and dropped 10-26 as hard to see on a monitor).
   SOURCE-LOCKED: one radius scale runs the dashboard (cards 10, keys 8, rows 6, chips 4) and is declared AFTER every
   older 2px rule it replaces, so the curve wins at equal specificity; tabs round only the corners that leave their rule;
   the COMMS heading and dock rules lose their end ticks; the lit material stays the checker, not a raster; and
   what stays square on purpose (the lamps, the speech rails) is not rounded by the layer. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const glass = fs.readFileSync(path.join(__dirname, '..', 'frontend/css/pipglass.css'), 'utf8');
const at = glass.indexOf('THE CURVED DASHBOARD');
const layer = glass.slice(at, glass.indexOf('/* ====', at + 40) > 0 ? glass.indexOf('/* ====', at + 40) : undefined);
const P = 'body.glass-demo:not(.hud-mode) #screen-game ';
const has = (sel, val) => { const i = layer.indexOf(sel); if (i < 0) return false; const body = layer.slice(layer.indexOf('{', i), layer.indexOf('}', i)); return body.indexOf(val) >= 0; };

/* ---- 1. the scale ---- */
A.ok(at > 0, 'the curved layer exists');
A.ok(/--sn-r-card: 10px; --sn-r-key: 8px; --sn-r-row: 6px; --sn-r-chip: 4px;/.test(layer), 'one scale: cards 10, keys 8, rows 6, chips 4');
// it sits after the 2px sweeps it replaces (equal specificity: the later rule wins)
for (const old of ['RAIL LEFTOVERS', 'DASHBOARD LEFTOVERS', 'PIP-BOY COMMS CARDS', 'PIP-BOY COMMS STEPS', 'PIP-BOY DOCK', 'PIP-BOY TERMINAL RAIL']) {
  A.ok(glass.indexOf(old) > 0 && glass.indexOf(old) < at, 'the curve is declared after ' + old);
}

/* ---- 2. every surface of the dashboard wears its step ---- */
A.ok(has(P + '#crew .crew-row', 'var(--sn-r-card)'), 'a crew card is a 10px card');
A.ok(has('body.glass-demo:not(.hud-mode) #left .ws-needs .ny-panel', 'var(--sn-r-card)'), 'NEEDS YOU is a 10px card');
A.ok(has(P + '#bottombar .bb-menu {', 'var(--sn-r-card)') || has(P + '#bottombar .bb-menu', 'var(--sn-r-card)'), 'a dock menu is a 10px card');
A.ok(has(P + '#chat-panel #chat-inputrow', 'var(--sn-r-card)'), 'the composer is a 10px card');
A.ok(/:is\(\.cmsg\.turnin, \.cmsg\.nudge, \.cmsg\.consent, #chat-log > \.dg-line, #gc-questions \.gc-question, #gc-states \.gc-state\) \{ border-radius: var\(--sn-r-card\); \}/.test(layer), 'the COMMS cards are 10px cards');
A.ok(/#toast-stack \.toast,\s*body\.glass-demo:not\(\.hud-mode\) \.nav-coach \{ border-radius: var\(--sn-r-card\); \}/.test(layer), 'toasts and the first-run hint are 10px cards');
// the COMMS keys carry the exact selectors of the 2px rule they replace (a looser one lost on specificity)
A.ok(layer.indexOf(P + '#chat-panel :is(.cmsg.turnin, .cmsg.nudge, .cmsg.consent, .dg-inspect) .consent-btn:not(.thumb),') > 0
  && layer.indexOf(P + '#chat-panel #chat-log .dg-line .dg-key,') > 0, 'the COMMS card keys are matched selector-for-selector');
A.ok(layer.indexOf(P + '#chat-panel #comms-presence.paused:not(.resolved)') > 0, 'the paused working line is matched too (its .paused rule outranks the plain one)');
A.ok(has(P + '#bottombar .bb-group > .bb-grp', '0 0 var(--sn-r-key) var(--sn-r-key)'), 'the dock\'s open group hangs from its rule: bottom corners only');
A.ok(has(P + '#left .ws-head :is(.ws-tab, #ws-new, #ws-addproject)', 'var(--sn-r-key) var(--sn-r-key) 0 0'), 'the tabs and + NEW stand on their rule: top corners only');
A.ok(has(P + '#chat-panel .tool-chip', 'var(--sn-r-row)'), 'a step row is a 6px row');

/* ---- 3. no pointed ends left ---- */
A.ok(/#chat-panel > h3 \{ background: linear-gradient\(var\(--pg-line\), var\(--pg-line\)\) left 10px bottom 0 \/ calc\(100% - 20px\) 1px no-repeat; \}/.test(layer), 'the COMMS heading rule is one plain line');
A.ok(/#bottombar > \.bb-group:is\(\[data-group="crew"\], \[data-group="system"\]\) \{ background: none; \}/.test(layer), 'the dock rule drops its end ticks');

/* ---- 4. what stays square ---- */
A.ok(!/dg-lamp|ny-lamp|ws-dot|cp-dot|crew-prog|ctx-cells/.test(layer), 'the lamps and meters keep their square pixel cells');
A.ok(!/\.body\b/.test(layer.replace(/\/\*[\s\S]*?\*\//g, '')), 'the speech rails are not rounded (COMMS has no bubbles)');

/* ---- 5. the lit material stays the checker (a scanline raster was tried and dropped 10-26: hard to see on a monitor) ---- */
const mesh = glass.slice(glass.indexOf('PIP-BOY MESH'), glass.indexOf('PIP-BOY TYPE SCALE'));
A.ok(/Tried and dropped 10-26: a scanline raster/.test(mesh), 'the mesh section records why the raster went');
A.ok(/--pg-dither: repeating-conic-gradient\(rgba\(var\(--ph-rgb\), \.3\) 0 25%, transparent 0 50%\) 0 0 \/ var\(--mesh-cell\) var\(--mesh-cell\);/.test(mesh), 'phosphor: the 2-screen-pixel checker at .30');
A.ok(/--pg-dither-gold: repeating-conic-gradient\(rgba\(var\(--gold-rgb\), \.32\)/.test(mesh), 'gold: the same checker at .32');
A.ok(!/repeating-linear-gradient\(180deg/.test(mesh) && !/--scan-px/.test(glass), 'no scanline raster anywhere in the dashboard\'s material');

A.report('curved-dashboard.test');
