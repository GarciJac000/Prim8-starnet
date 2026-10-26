/* THE VOID's star loops (2026-10-20, "eats my PC's resources"): the default sky built one rgba() string per star per
   frame — ~470 throwaway strings a frame at 1920x1080 — out of only 34 distinct values. Each star now carries its level
   strings from build(), and draw() assigns fillStyle only when it changes; the other skies' three-step near twinklers
   keep their strings the same way. THE VOID is FROZEN (spacebg.js law 1) and every sky is signed off, so each draw
   stream must stay byte-identical: every fillRect/drawImage with the fillStyle and globalAlpha in force at that call,
   over seeded frames, hashes to the golden recorded on the pre-change code. */
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/spacebg.js'), 'utf8');

// Recorded on trunk 6134e4ed4 (before the change). A deliberate change to a sky's look re-records its hash.
const GOLDEN = {
  'void@1280x720': '40acc033235b27d4255abac06403543780b06096a5c2a9a037b78c675fd34189',
  'void@1920x1080': 'bc4202387a16ad20871a23cdbec8dc37c37dbc70c06452a653e2276dabc19553',
  'galaxy@1280x720': '364ce91743b677d1e72db07252d9e9db7215c33d4759598a9b264a14b796450c',
  'belt@1280x720': '89b300f9cd07bacfe8c8e834a318768927cf8f71472f7ff8eb9d48d37de7c924',
  'nursery@1280x720': 'dbe66140ddfc3ff2d4bf1609166d898b6bca7afcd6be0f812e0de0b87ab4a4a4',
  'ocean@1280x720': 'c55bc0d5735f0d0883b58e2cd46c2ebc111730e1e522e6ad055adbfb24c6c79a',
  // re-recorded 2026-10-21 (still tier): a CITY car advanced 16 ms per DRAW, so its speed was the draw rate's. It now
  // follows the wall clock (16 per 60 Hz frame), and this harness draws 16.7 ms frames: each car is 0.2% further along.
  // render-still.test.js proves the cars hold their place at any draw rate.
  'city@1280x720': '065c20a211696f8bd23b8a320ee327baf8d48d09ce223e8f0920af3e6f94cbdf',
};

function load() {
  const images = [];
  const noop = () => {};
  const scratch = () => new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop: noop }), createLinearGradient: () => ({ addColorStop: noop }) },
  { get: (o, k) => k in o ? o[k] : noop, set: (o, k, v) => { o[k] = v; return true; } });
  const document = { createElement: () => { const c = { width: 0, height: 0 }, g = scratch(); c.getContext = () => g; images.push(c); return c; } };
  const window = { devicePixelRatio: 1, screen: { width: 1920, height: 1080 }, matchMedia: () => ({ matches: false }) };
  // Main realm (a vm context's global lookups make the plate build crawl). `performance` is shadowed so the living-gas
  // plates advance exactly one generator step a frame: the stream cannot depend on this machine's speed.
  const SpaceBG = new Function('document', 'window', 'performance', source + '\nreturn SpaceBG;')(document, window, undefined);
  return { SpaceBG, images };
}

// Weather (meteors, the belt's fireballs) is Math.random at draw time by design: seed it for the run, so a hash is a hash.
function seeded(fn) {
  const random = Math.random; let s = 0x2545F491;
  Math.random = () => { s = Math.imul(s ^ (s >>> 15), 0x2C1B3C6D) + 0x6D2B79F5 | 0; return (s >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = random; }
}

function run(id, w, h, frames) { return seeded(() => {   // one sky, its own module instance
  const { SpaceBG, images } = load();
  SpaceBG.setBackdrop(id);
  const ops = [], sets = [];
  let fs_ = '#000000';
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over',
    set fillStyle(v) { fs_ = v; sets.push(v); }, get fillStyle() { return fs_; },
    fillRect(x, y, rw, rh) { ops.push('R' + fs_ + '|' + this.globalAlpha + '|' + x + ',' + y + ',' + rw + ',' + rh); },
    drawImage(img, x, y, dw, dh) { ops.push('D' + images.indexOf(img) + '|' + this.globalAlpha + '|' + x + ',' + y + ',' + dw + ',' + dh); },
    createRadialGradient: () => ({ addColorStop() {} }) };
  SpaceBG.draw(ctx, w, h, 100000);                   // builds the sky (seeded) and draws frame 0
  const repeats = [];
  const toFixed = Number.prototype.toFixed;
  let fixed = 0;
  Number.prototype.toFixed = function (d) { fixed++; return toFixed.call(this, d); };
  try {
    for (let f = 1; f <= frames; f++) {
      const from = sets.length;
      SpaceBG.draw(ctx, w, h, 100000 + f * 16.7);
      for (let i = from + 1; i < sets.length; i++) if (sets[i] === sets[i - 1]) repeats.push(sets[i]);
    }
  } finally { Number.prototype.toFixed = toFixed; }
  return { hash: crypto.createHash('sha256').update(ops.join('\n')).digest('hex'), fixed, repeats, rects: ops.filter(o => o[0] === 'R').length, sets: sets.length };
}); }

for (const [id, w, h, frames] of [['void', 1280, 720, 300], ['void', 1920, 1080, 300], ['galaxy', 1280, 720, 120], ['belt', 1280, 720, 120],
  ['nursery', 1280, 720, 120], ['ocean', 1280, 720, 120], ['city', 1280, 720, 120]]) {
  const key = id + '@' + w + 'x' + h, r = run(id, w, h, frames);
  if (process.env.RECORD_VOID_GOLDEN) { console.log(key, r.hash, 'toFixed/frame', (r.fixed / frames).toFixed(1), 'rects', r.rects, 'sets', r.sets); continue; }
  assert.equal(r.hash, GOLDEN[key], key + ': the draw stream is byte-identical to the signed-off sky');
  assert.ok(r.rects > frames * 50, key + ': (the sky really was drawn)');
  if (id !== 'void') continue;
  assert.equal(r.fixed, 0, key + ': a VOID frame builds no rgba() strings once the sky is built');
  assert.deepEqual(r.repeats.slice(0, 3), [], key + ': fillStyle is assigned only when it changes');
}
if (!process.env.RECORD_VOID_GOLDEN) console.log('spacebg-void-strings: byte-identical sky streams, 0 per-frame VOID strings, no repeated VOID fillStyle: OK');
