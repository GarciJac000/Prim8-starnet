'use strict';
/* test/cli-theme.test.js — the terminal's /theme (bin/lib/theme.js): the app's own presets (frontend/css/style.css
   body.theme-*) plus the terminal's neon red. Locks:
     1. every app preset carries the app's exact hexes (a palette changed in style.css must be changed here too)
     2. red is the default and puts back exactly what tui.js ships (its hand-picked xterm-256 codes too)
     3. a preset retints the accent everywhere the terminal paints it: tui PALETTE/BG, the Sixel logo ramp, the camera feed
        (palette, rim, wall trim) — and status keeps its meaning (warn = the app's own, green done, cyan on green)
     4. the pick: STARNET_THEME beats the saved cli.json beats red; a save keeps cli.json's other keys; an env with no
        APPDATA / HOME has no file (never the process's own home), so a test env never reads or writes a real profile
     5. the rendered screen paints in the theme: the wordmark and the prompt's ▸ in the accent's 24-bit SGR */
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const theme = require('../bin/lib/theme.js');
const tui = require('../bin/lib/tui.js');
const sixel = require('../bin/lib/sixel.js');
const camfeed = require('../bin/lib/camfeed.js');

const T = { palette: tui.PALETTE, bg: tui.BG, logoRamp: sixel.RAMP, camfeed };
const shipped = JSON.stringify([tui.PALETTE, tui.BG, sixel.RAMP, camfeed.PALETTE]);

/* 1. the app's presets, read from the app's own stylesheet */
const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'style.css'), 'utf8');
for (const n of ['amber', 'green', 'blue', 'purple', 'white']) {
  const block = (new RegExp('body\\.theme-' + n + '\\s*\\{([^}]*)\\}')).exec(css);
  A.ok(!!block, 'style.css has body.theme-' + n);
  const v = k => ((new RegExp('--' + k + ':\\s*(#[0-9a-fA-F]{6})')).exec(block ? block[1] : '') || [])[1];
  A.eq([theme.APP[n].ph, theme.APP[n].bright, theme.APP[n].dim, theme.APP[n].text, theme.APP[n].warn].map(s => s.toLowerCase()),
    [v('ph'), v('ph-bright'), v('ph-dim'), v('text'), v('warn')].map(s => String(s).toLowerCase()), n + ': the app\'s exact hexes');
}
A.eq(theme.NAMES, ['red', 'amber', 'green', 'blue', 'purple', 'white'], 'the themes: the terminal\'s red + the app\'s presets');
A.eq(theme.DEFAULT, 'red', 'red is the default');

/* 2 + 3. apply */
A.eq(theme.apply('red', T), 'red', 'red applies');
A.eq(JSON.stringify([tui.PALETTE, tui.BG, sixel.RAMP, camfeed.PALETTE]), shipped, 'red changes nothing that ships');
for (const n of ['amber', 'green', 'blue', 'purple', 'white']) {
  const a = theme.APP[n];
  theme.apply(n, T);
  A.eq(tui.PALETTE.ph[0], a.ph, n + ': the accent is the app\'s --ph');
  A.eq([tui.PALETTE.logo[0], tui.PALETTE.brand[0], tui.BG.inv[0]], [a.ph, a.ph, a.ph], n + ': the wordmark, the prompt and the tab fill take it');
  A.eq([tui.PALETTE.am[0], tui.BG.amfill[0]], [a.warn, a.warn], n + ': what needs you is the app\'s own --warn');
  A.eq(tui.PALETTE.ok[0], n === 'green' ? '#5ce8ff' : '#5dffa8', n + ': done stays green (cyan on the green theme)');
  A.eq([tui.PALETTE.bad[0], tui.PALETTE.hi[0], tui.PALETTE.ink[0]], ['#ff6b3d', '#ffffff', '#0c0c0c'], n + ': failed, white and ink never move');
  A.ok(Object.values(tui.PALETTE).every(p => typeof p[0] === 'string' && /^#[0-9a-f]{6}$/.test(p[0]) && Number.isInteger(p[1]) && p[1] >= 16 && p[1] <= 255), n + ': every color is a hex + an xterm-256 code');
  A.eq(sixel.RAMP.length, 7, n + ': the logo ramp keeps its 7 steps');
  A.eq(sixel.RAMP[4], theme.build(n).logoRamp[4], n + ': the logo glows in the accent');
  const hx = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const near = (c, t) => Math.hypot(c[0] - t[0], c[1] - t[1], c[2] - t[2]) < 16;   // the feed's ramp is resampled to 24 steps
  A.ok(camfeed.PALETTE.some(c => near(c, hx(a.ph))), n + ': the camera feed\'s palette holds the accent');
  A.ok(!camfeed.PALETTE.some(c => c.join() === '255,46,62'), n + ': …and no longer the red');
}
theme.apply('red', T);
A.eq(JSON.stringify([tui.PALETTE, tui.BG, sixel.RAMP, camfeed.PALETTE]), shipped, 'back to red: exactly what ships, after every other theme');
A.eq(theme.apply('nope', T), 'red', 'an unknown name is red');

/* 4. the pick */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-theme-'));
const file = path.join(dir, 'sub', 'cli.json');
A.eq(theme.load({}, file), 'red', 'nothing saved: red');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ other: 1, theme: 'blue' }));
A.eq(theme.load({}, file), 'blue', 'the saved pick');
A.eq(theme.load({ STARNET_THEME: 'Amber ' }, file), 'amber', 'STARNET_THEME beats it');
A.eq(theme.load({ STARNET_THEME: 'neon' }, file), 'blue', 'an unknown STARNET_THEME is ignored');
theme.save('purple', {}, file);
A.eq(JSON.parse(fs.readFileSync(file, 'utf8')), { other: 1, theme: 'purple' }, 'a save keeps the other keys');
fs.writeFileSync(file, '{broken');
A.eq(theme.load({}, file), 'red', 'a broken cli.json is red, never a crash');
A.eq(theme.configFile({}, 'win32'), '', 'no APPDATA: no file');
A.eq(theme.configFile({}, 'linux'), '', 'no HOME: no file');
A.eq(theme.configFile({ APPDATA: path.join('C:', 'Roaming') }, 'win32'), path.join('C:', 'Roaming', 'ai.skynet.harness', 'cli.json'), 'Windows: beside the app\'s data');
A.eq(theme.configFile({ HOME: '/h' }, 'darwin'), path.join('/h', 'Library', 'Application Support', 'ai.skynet.harness', 'cli.json'), 'macOS: beside the app\'s data');
A.eq(theme.configFile({ HOME: '/h', XDG_DATA_HOME: '/x' }, 'linux'), path.join('/x', 'ai.skynet.harness', 'cli.json'), 'Linux: XDG_DATA_HOME');
A.eq(theme.load({}), 'red', 'an env with nothing in it reads no file');
A.throws(() => theme.save('amber', {}), 'an env with nothing in it writes no file');
fs.rmSync(dir, { recursive: true, force: true });

/* 5. the screen paints in it */
const segs = [['▸ ', 'brand b'], ['hi', 'fg']];
const sgrOf = hex => '38;2;' + [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';');
theme.apply('amber', T);
A.ok(tui.toAnsi(segs, 3).includes(sgrOf('#ffaa33')), 'amber: the prompt\'s ▸ is drawn in amber');
theme.apply('red', T);
A.ok(tui.toAnsi(segs, 3).includes(sgrOf('#ff2e3e')), 'red: back in the neon red');

A.report('cli-theme.test');
