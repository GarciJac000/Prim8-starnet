'use strict';
/* node test/curved-dashboard.test.js — the curved dashboard (Andrew 10-25: "bring back the more curved edges … we can
   still keep our style, just with the more curved edges without the sharp pointiness … it looks really inconsistent
   with everything else"; a scanline raster and the mesh were then dropped 10-26 — hard to see, and they moiré when zoomed
   out — for the windows' own glass, plus one organization pass over the whole dashboard).
   SOURCE-LOCKED: one radius scale runs the dashboard (cards 10, keys 8, rows 6, chips 4) and is declared AFTER every
   older 2px rule it replaces, so the curve wins at equal specificity; tabs round only the corners that leave their rule;
   the COMMS heading and dock rules lose their end ticks; the lit material is the windows' glass, pattern-free; and
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

/* ---- 5. the lit material is the WINDOWS' glass (10-26): no pattern (a mesh / raster moirés when zoomed out), no corner light ---- */
const mat = glass.slice(glass.indexOf("THE WINDOWS' GLASS ON THE DASHBOARD"), glass.indexOf('PIP-BOY TYPE SCALE'));
A.ok(glass.indexOf("THE WINDOWS' GLASS ON THE DASHBOARD") > 0 && glass.indexOf('PIP-BOY MESH (') < 0, 'the mesh section is replaced by the windows\' glass');
A.ok(/--pg-dither: linear-gradient\(120deg, rgba\(var\(--ph-rgb\), \.2\), rgba\(var\(--ph-rgb\), \.07\)\);/.test(mat), 'phosphor: the windows\' 120° tint .20 → .07');
A.ok(/--pg-dither-gold: linear-gradient\(120deg, rgba\(var\(--gold-rgb\), \.22\), rgba\(var\(--gold-rgb\), \.07\)\);/.test(mat), 'gold: the same at .22 → .07');
A.ok(!/repeating-(conic|linear)-gradient/.test(mat) && !/--mesh-cell|--scan-px/.test(glass), 'no repeating pattern in the dashboard\'s material (it beats against the device grid when zoomed out)');
A.ok(!/165deg/.test(mat), 'no corner light in it (that read as the old glossy glow)');
A.ok(/:is\(#crew \.crew-row:not\(\.selected\):not\(\.asking\), #left #workstreams \.ws-row:not\(\.sel\), #bottombar \.bb-group:not\(\.open\) > \.bb-grp, #chat-panel \.cmsg-empty \.cmsg-starter\) \{ box-shadow: none; \}/.test(mat), 'at rest nothing glows');
A.ok(/\.crew-row\.selected:not\(\.asking\),[\s\S]*?\{\s*border-color: rgba\(var\(--ph-rgb\), \.5\); box-shadow: 0 0 12px rgba\(var\(--ph-rgb\), \.16\); --pg-glow: var\(--pg-lit-glow\);/.test(mat), 'a lit pane wears the window item\'s .5 frame, 12px halo and soft type bloom');
A.ok(/\.crew-row\.asking,[\s\S]*?\{\s*border-color: rgba\(var\(--gold-rgb\), \.5\); box-shadow: 0 0 12px rgba\(var\(--gold-rgb\), \.16\);/.test(mat), 'a wait wears the same in gold');
A.ok(!/!important/.test(mat), 'the glass wins by its selectors, not by !important');

/* ---- 6. the dashboard pass (10-26) ---- */
const pass = glass.slice(glass.indexOf('THE DASHBOARD PASS'));
A.ok(glass.indexOf('THE DASHBOARD PASS') > 0 && !/!important/.test(pass), 'the pass exists and wins by its selectors');
A.ok(/#crew :is\(\.crew-status, \.crew-step, \.crew-clock\) \{ --sn-type-meta: 14px;/.test(pass), 'the rail reads in two weights: status, step and clock on the quiet 14px line');
A.ok(/#crew \.crew-portrait \{ width: 46px; height: 55px; \}/.test(pass) && /#crew \.crew-row \{ padding-top: 6px; padding-bottom: 6px;/.test(pass), 'the crew card is the 62px card ("go 62")');
A.ok(/#left #workstreams \.ws-row\.attn > \.ws-meta \{ display: none; \}/.test(pass), 'a waiting session row no longer doubles its wait with a chip');
A.ok(/\.ny-item:not\(:has\(> \.ny-keys\)\) \{ grid-template-columns: 34px minmax\(0, 1fr\) 14px; \}/.test(pass), 'a keyless NEEDS YOU row keeps only the caret\'s width');
A.ok(/#comms-presence\.paused:not\(\.resolved\) \{ border: 0;[^}]*box-shadow: inset 3px 0 0 rgba\(var\(--gold-rgb\), \.8\);/.test(pass), 'COMMS: the waiting line is a gold rail, not a second framed box');
A.ok(!/\.crew-hide \{/.test(pass), 'the CREW keys keep the + key\'s own box (Andrew 10-23)');

A.report('curved-dashboard.test');
