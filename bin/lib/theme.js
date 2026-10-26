'use strict';
/* bin/lib/theme.js — the terminal's color themes: the StarNet app's own presets (frontend/css/style.css body.theme-*:
   amber, green, blue, purple, white — the same hexes the app paints with) plus the terminal's neon red, its default.

   A theme moves the ACCENT only: the rules, labels, tabs, the prompt, the wordmark (the Sixel logo's glow ramp too) and
   the camera feed's lit screens and working rim. Status keeps its meaning — the app's own "warn" color for what needs
   you (each preset picked one that never clashes with its accent), green for done (cyan on the green theme), orange for
   failed. Pure data + one apply() that sets the palettes the renderer already reads (tui PALETTE/BG, sixel RAMP,
   camfeed's accent ramp, rim and wall trim). The pick is saved beside the app's data (cli.json); STARNET_THEME overrides it. */
const fs = require('fs');
const path = require('path');

// the app's presets, verbatim from style.css (--ph, --ph-bright, --ph-dim, --text, --warn)
const APP = {
  amber: { ph: '#ffaa33', bright: '#ffd9a3', dim: '#b9791c', text: '#eec88f', warn: '#ffe97a' },
  green: { ph: '#3dff70', bright: '#ccffdb', dim: '#1fae4e', text: '#8fe3ac', warn: '#ffb641' },
  blue: { ph: '#46c8ff', bright: '#c8efff', dim: '#1e87ba', text: '#97d5ee', warn: '#ffc861' },
  purple: { ph: '#b46bff', bright: '#e6d4ff', dim: '#7d3fc4', text: '#c8a9ee', warn: '#ffb84a' },
  white: { ph: '#e8f0e8', bright: '#ffffff', dim: '#97a397', text: '#d2dcd2', warn: '#ffc247' }
};
const NAMES = ['red', 'amber', 'green', 'blue', 'purple', 'white'];
const DEFAULT = 'red';
const BLURB = { red: 'neon red (the terminal\'s own)', amber: 'classic amber', green: 'Pip-Boy green', blue: 'cold blue', purple: 'violet', white: 'white phosphor' };

const hexRgb = h => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * t)); };
// the nearest xterm-256 color (6×6×6 cube or the grey ramp), for terminals without 24-bit color
function c256(hex) {
  const [r, g, b] = hexRgb(hex);
  const lv = [0, 95, 135, 175, 215, 255], q = v => lv.reduce((bi, l, i) => Math.abs(l - v) < Math.abs(lv[bi] - v) ? i : bi, 0);
  const [qr, qg, qb] = [q(r), q(g), q(b)], cube = [lv[qr], lv[qg], lv[qb]];
  const gi = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10))), gv = 8 + gi * 10;
  const d = (x, y, z) => (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2;
  return d(...cube) <= d(gv, gv, gv) ? 16 + 36 * qr + 6 * qg + qb : 232 + gi;
}
const pair = hex => [hex, c256(hex)];

// the terminal's red, exactly as tui.js ships it (the default: choosing red changes nothing)
const RED = {
  palette: { fg: '#d9d2d4', dim: '#7f666b', rule: '#7a1c28', lbl: '#ff4757', ph: '#ff3b4e', am: '#ffb43a', ok: '#5dffa8', logo: '#ff2e3e', logohi: '#ffb0b8', brand: '#ff2e3e' },
  bg: { sel: '#3a0c14', card: '#1f1405', inv: '#ff3b4e', amfill: '#ffb43a' },
  logoRamp: [[70, 4, 14], [118, 8, 22], [170, 14, 32], [215, 24, 44], [255, 46, 62], [255, 104, 116], [255, 176, 184]],
  camRamp: [[40, 2, 8], [70, 4, 14], [118, 8, 22], [170, 14, 32], [215, 24, 44], [255, 46, 62], [255, 104, 116], [255, 176, 184]],
  rim: [255, 70, 84], trim: [60, 15, 21]
};

// one theme, every color the terminal paints with
function build(name) {
  if (!APP[name]) return RED;
  const t = APP[name];
  const dark = k => mix(t.ph, '#000000', k);
  return {
    palette: {
      fg: t.text, dim: mix(t.text, '#0c0c0c', 0.45), rule: dark(0.55), lbl: mix(t.ph, t.bright, 0.12), ph: t.ph,
      am: t.warn, ok: name === 'green' ? '#5ce8ff' : '#5dffa8', logo: t.ph, logohi: t.bright, brand: t.ph
    },
    bg: { sel: dark(0.8), card: mix(t.warn, '#000000', 0.88), inv: t.ph, amfill: t.warn },
    // the same shape as the red ramps: dim glow → the accent → a hot core
    logoRamp: [0.73, 0.54, 0.33, 0.16].map(k => hexRgb(dark(k))).concat([hexRgb(t.ph), hexRgb(mix(t.ph, t.bright, 0.5)), hexRgb(t.bright)]),
    camRamp: [0.84, 0.73, 0.54, 0.33, 0.16].map(k => hexRgb(dark(k))).concat([hexRgb(t.ph), hexRgb(mix(t.ph, t.bright, 0.5)), hexRgb(t.bright)]),
    rim: hexRgb(mix(t.ph, '#ffffff', 0.1)), trim: hexRgb(dark(0.765))
  };
}

// where the pick is kept: beside the StarNet app's own data (the terminal already reads its workspace there). Read from
// the env it is given only (never the process's own home), so an env without APPDATA / HOME has no file: nothing is kept.
function configFile(env, platform) {
  const e = env || process.env, p = platform || process.platform, home = e.HOME || e.USERPROFILE || '';
  const base = p === 'win32' ? e.APPDATA : p === 'darwin' ? (home && path.join(home, 'Library', 'Application Support'))
    : (e.XDG_DATA_HOME || (home && path.join(home, '.local', 'share')));
  return base ? path.join(base, 'ai.skynet.harness', 'cli.json') : '';
}
const known = n => NAMES.indexOf(String(n || '').toLowerCase().trim()) >= 0;
// the theme to start with: STARNET_THEME, else the saved pick, else red
function load(env, file) {
  const e = env || process.env;
  if (known(e.STARNET_THEME)) return String(e.STARNET_THEME).toLowerCase().trim();
  const f = file === undefined ? configFile(e) : file;
  try { const j = f && JSON.parse(fs.readFileSync(f, 'utf8')); if (j && known(j.theme)) return j.theme; } catch (_) {}
  return DEFAULT;
}
// keep a pick (other keys in cli.json are kept as they were)
function save(name, env, file) {
  const f = file === undefined ? configFile(env) : file;
  if (!f) throw new Error('no APPDATA / HOME to keep it under');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (_) {}
  j.theme = name;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  return f;
}

// set the palettes the renderer reads: tui's PALETTE/BG (each a [hex, xterm-256] pair), the Sixel logo's RAMP (in
// place), camfeed's accent ramp. Returns the theme's name.
// The renderer's own pairs are kept the first time a theme is applied, so red puts back exactly what tui.js ships (its
// hand-picked xterm-256 codes too, e.g. the ask card's 234, chosen over a loud olive).
const ORIGINAL = new WeakMap();
function apply(name, targets) {
  const n = known(name) ? String(name).toLowerCase().trim() : DEFAULT;
  const t = build(n), o = targets || {};
  for (const tbl of [o.palette, o.bg]) if (tbl && !ORIGINAL.has(tbl)) ORIGINAL.set(tbl, Object.assign({}, tbl));
  const set = (tbl, from) => { if (!tbl) return; const orig = ORIGINAL.get(tbl); for (const k of Object.keys(from)) tbl[k] = n === DEFAULT && orig[k] ? orig[k] : pair(from[k]); };
  set(o.palette, t.palette);
  set(o.bg, t.bg);
  if (Array.isArray(o.logoRamp)) o.logoRamp.splice(0, o.logoRamp.length, ...t.logoRamp);
  if (o.camfeed && typeof o.camfeed.setAccent === 'function') o.camfeed.setAccent(t.camRamp, t.rim, t.trim);
  return n;
}

module.exports = { NAMES, DEFAULT, BLURB, APP, build, apply, load, save, configFile, known, c256 };
