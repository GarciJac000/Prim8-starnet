/* dossier-persona-toggle-skin.test.js — AGENT DOSSIER › CONFIG › PERSONALITY › FINE-TUNE PERSONALITY rendered its EMOJI
   and BLUNT toggles as the browser's own white checkbox (sweep/world 2026-10-20, live computed style: appearance:auto,
   a 15px white UA box beside the phosphor labels). The CONTROL FLOOR only tints a checkbox (accent-color reaches the
   CHECKED tick, never the unchecked box), so a bare checkbox is always OS paint until a surface skin claims it — the
   dossier's switch skin was keyed on `.set-row input[type=checkbox]`, and these two sit inline in a `label.cf-desc`.
   Locks: the toggles are still emitted as checkboxes, and the dossier sheet gives them the station switch (no UA box). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const ui = read('frontend/app/stationui.js');
A.ok(/<input type="checkbox" data-persona-toggle="/.test(ui), 'the personality toggles are still emitted as checkboxes (data-persona-toggle)');

const css = read('frontend/css/agent-dossier.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
const skins = sel => rules.filter(r => r.sel.includes('input[data-persona-toggle]') && sel(r.sel));
const base = skins(s => !/::after|:checked/.test(s));
A.ok(base.length > 0, 'agent-dossier.css carries a skin rule for input[data-persona-toggle]');
const body = base.map(r => r.body).join(';');
A.ok(/(?:^|;)\s*appearance\s*:\s*none/.test(body), 'the persona toggle drops the UA checkbox (appearance:none) — else the unchecked box paints white');
A.ok(/(?:^|;)\s*background(?:-color)?\s*:[^;]*var\(--ph/.test(body), 'the persona toggle track is painted from the phosphor theme vars');
A.ok(/(?:^|;)\s*border\s*:[^;]*var\(--ph/.test(body), 'the persona toggle carries a phosphor border, not the UA ButtonBorder grey');
A.ok(base.every(r => /^\.agent-dossier\b/.test(r.sel)), 'the skin stays scoped to the dossier (a surface skin, not a second control floor)');
A.ok(skins(s => /::after/.test(s) && !/:checked/.test(s)).length > 0, 'the switch draws its knob (::after)');
A.ok(skins(s => /:checked::after/.test(s)).length > 0, 'the switch shows its ON state (:checked::after) — without it the toggle reads the same both ways');
A.report('dossier-persona-toggle-skin.test');
