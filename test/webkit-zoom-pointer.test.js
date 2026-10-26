/* node test/webkit-zoom-pointer.test.js — a click on the station canvas picks what is UNDER THE CURSOR on a Mac too.

   TEXT SIZE is a zoom on <body> (stationui applySettings), and AUTO resolves it to 115% on any screen up to 1470pt and
   110% up to 1740pt — every MacBook Air and 14-inch MacBook Pro at default settings. A pointer event's clientX/clientY
   is VISUAL px in every engine; getBoundingClientRect is visual px in Chromium/WebView2, but WebKit (the macOS app
   window, Safari, WebKitGTK) returns it with that zoom LEFT OUT. toCanvas — `(clientX - r.left) * (cv.width / r.width)`
   in build.js (BUILD placement), world.js (clicking agents and objects on the floor) and review-world.js — then lands
   down and to the right of the cursor, worse the farther from the canvas origin. Customer report 09-26 (1470pt M2
   Air): "aim up and way left". Measured then in real WebKit: a centre click read 720,484 instead of 600,400 — the
   exact numbers the WebKit-shaped canvas below reproduces on the unfixed code.

   The fix is U.pointerRect (js/util.js): the canvas rect in clientX's px. On an engine whose rects already carry the
   zoom it hands back the very rect it read (Chromium/Windows: byte-for-byte the old mapping); where the engine leaves
   the zoom out it scales the rect by the zoom the element renders at. Which engine this is is asked once, by a probe
   under zoom:2 — 20px wide means the zoom is in the rect, 10px means it was left out.

   This file runs the REAL toCanvas of all three canvases against both engine shapes, the probe's answer and caching,
   and locks the client-point dev hooks (toCanvas's exact inverse, used by verify scripts to dispatch real clicks) to
   the same rect. The real-engine proof (Chromium as shipped, and Chromium with its pre-standard zoom semantics =
   WebKit's) is in the lane report; it needs a browser and does not belong in the fast gate. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const utilSrc = read('frontend/js/util.js');
const FILES = { build: 'frontend/app/build.js', world: 'frontend/app/world.js', review: 'frontend/agent-demo/review-world.js' };
const SRC = {};
for (const [k, f] of Object.entries(FILES)) SRC[k] = read(f);

/* ---- the production U, loaded as shipped (the object literal at the top of js/util.js) ---- */
const u0 = utilSrc.indexOf('const U = {'), u1 = utilSrc.indexOf('\n};\n', u0);
A.ok(u0 >= 0 && u1 > u0, 'fixture: js/util.js still opens with the U object literal');

/* A fake page: html > body (TEXT SIZE zoom) > wrapper > canvas. `engine` decides what getBoundingClientRect returns
   under zoom: 'chromium' = visual px (zoom carried), 'webkit' = the zoom left out. Geometry in body css px: the canvas
   sits at (100,80), 600x400 css, 1200x800 backing — the 09-26 probe's layout. */
function page(engine, bodyZoom) {
  const stats = { probes: 0, appended: 0, removed: 0 };
  const html = { nodeType: 1, parentElement: null, zoom: '1', children: [] };
  const body = { nodeType: 1, parentElement: html, zoom: String(bodyZoom), style: { zoom: String(bodyZoom) } };
  const wrap = { nodeType: 1, parentElement: body, zoom: '1' };
  const effZoom = el => { let z = 1; for (let n = el; n; n = n.parentElement) z *= parseFloat(n.zoom) || 1; return z; };
  // a box laid out at (x,y,w,h) css px in the element's own zoomed space: visual = css * effective zoom
  const rectOf = (el, x, y, w, h) => {
    const k = engine === 'chromium' ? effZoom(el) : 1;
    return { left: x * k, top: y * k, right: (x + w) * k, bottom: (y + h) * k, width: w * k, height: h * k, x: x * k, y: y * k };
  };
  const cv = { nodeType: 1, parentElement: wrap, zoom: '1', width: 1200, height: 800, calls: 0,
    getBoundingClientRect() { this.calls++; return rectOf(this, 100, 80, 600, 400); } };
  html.appendChild = el => { stats.appended++; el.parentNode = html; el.parentElement = html; };
  html.removeChild = el => { stats.removed++; el.parentNode = null; };
  const document = {
    documentElement: html, body,
    createElement() {
      stats.probes++;
      const el = { nodeType: 1, style: { cssText: '' }, parentNode: null, parentElement: null,
        get zoom() { const m = /zoom:\s*([\d.]+)/.exec(this.style.cssText); return m ? m[1] : '1'; },
        getBoundingClientRect() { const w = /width:\s*(\d+)px/.exec(this.style.cssText); return rectOf(this, -9999, 0, +w[1], +w[1]); } };
      return el;
    }
  };
  const ctx = { document, getComputedStyle: el => ({ zoom: el.zoom }), cv, stats };
  vm.createContext(ctx);
  vm.runInContext(utilSrc.slice(u0, u1 + 3) + '\nthis.U = U;', ctx);
  for (const [k, src] of Object.entries(SRC)) {
    const body = A.fnBody(src, 'function toCanvas(');
    A.ok(body && body.length < 400, `${k}: toCanvas sliced (length guard)`);
    vm.runInContext(body.replace('function toCanvas(', 'this.toCanvas_' + k + ' = function toCanvas('), ctx);
  }
  return ctx;
}
const near = (p, x, y) => p && Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;
const fmt = p => p ? `${Math.round(p.x * 1000) / 1000},${Math.round(p.y * 1000) / 1000}` : String(p);

/* ---- 1. WebKit under TEXT SIZE: the visual centre picks the centre, the far corner picks the far corner ---- */
for (const Z of [1.15, 1.1]) {
  const ctx = page('webkit', Z);
  // the canvas's VISUAL centre and its 90%/90% point: css box scaled by the body zoom (the same in every engine)
  const centre = { clientX: (100 + 300) * Z, clientY: (80 + 200) * Z };
  const far = { clientX: (100 + 540) * Z, clientY: (80 + 360) * Z };
  for (const k of Object.keys(FILES)) {
    const c = ctx['toCanvas_' + k](centre), f = ctx['toCanvas_' + k](far);
    A.ok(near(c, 600, 400), `${k} toCanvas on WebKit at ${Math.round(Z * 100)}%: a visual-centre click picks the canvas centre 600,400 (got ${fmt(c)})`);
    A.ok(near(f, 1080, 720), `${k} toCanvas on WebKit at ${Math.round(Z * 100)}%: a far click picks 1080,720, not a point down-right of it (got ${fmt(f)})`);
  }
  A.eq(ctx.stats.probes, 1, `WebKit at ${Math.round(Z * 100)}%: the engine is asked ONCE, not per pointer move`);
  A.eq(ctx.stats.removed, ctx.stats.appended, `WebKit at ${Math.round(Z * 100)}%: the engine probe never stays in the page`);
}

/* ---- 2. Chromium/WebView2 (Windows): the rect it reads is returned untouched — the very same object ---- */
for (const Z of [1, 1.15]) {
  const ctx = page('chromium', Z);
  const centre = { clientX: (100 + 300) * Z, clientY: (80 + 200) * Z };
  for (const k of Object.keys(FILES)) {
    const c = ctx['toCanvas_' + k](centre);
    A.ok(near(c, 600, 400), `${k} toCanvas on Chromium at ${Math.round(Z * 100)}%: the centre click still picks 600,400 (got ${fmt(c)})`);
  }
  if (typeof ctx.U.pointerRect === 'function') {
    let raw = null;
    const fake = { getBoundingClientRect: () => (raw = { left: 1.5, top: 2.5, width: 3.5, height: 4.5 }), nodeType: 1, parentElement: ctx.document.body, zoom: '1' };
    A.ok(ctx.U.pointerRect(fake) === raw, `Chromium at ${Math.round(Z * 100)}%: pointerRect returns the engine's own rect object (the old mapping, unchanged)`);
  } else A.ok(false, 'js/util.js exports U.pointerRect');
}

/* ---- 3. WebKit at 100% TEXT SIZE: nothing to correct, the engine's rect passes straight through ---- */
{
  const ctx = page('webkit', 1);
  for (const k of Object.keys(FILES)) A.ok(near(ctx['toCanvas_' + k]({ clientX: 400, clientY: 280 }), 600, 400), `${k} toCanvas on WebKit at 100% is unchanged`);
  if (typeof ctx.U.pointerRect === 'function') {
    let raw = null;
    const fake = { getBoundingClientRect: () => (raw = { left: 1, top: 2, width: 3, height: 4 }), nodeType: 1, parentElement: ctx.document.body, zoom: '1' };
    A.ok(ctx.U.pointerRect(fake) === raw, 'WebKit at 100%: pointerRect returns the engine rect itself');
  }
}

/* ---- 4. No engine to ask (a headless sandbox, a test): rects are left alone ---- */
{
  const ctx = { getComputedStyle: () => ({ zoom: '1.15' }) };
  vm.createContext(ctx);
  vm.runInContext(utilSrc.slice(u0, u1 + 3) + '\nthis.U = U;', ctx);
  if (typeof ctx.U.pointerRect === 'function') {
    const raw = { left: 10, top: 20, width: 30, height: 40 };
    A.ok(ctx.U.pointerRect({ getBoundingClientRect: () => raw, nodeType: 1, parentElement: null }) === raw, 'no document: pointerRect is the plain rect');
  } else A.ok(false, 'js/util.js exports U.pointerRect (no-document case)');
}

/* ---- 5. Every clientX <-> canvas mapping in the three canvases reads the same rect ---- */
const usesPointerRect = s => /const (?:t = T\(\), )?r = U\.pointerRect\(cv\)/.test(s) && !/cv\.getBoundingClientRect\(\)/.test(s);
for (const [k, src] of Object.entries(SRC)) {
  A.ok(usesPointerRect(A.fnBody(src, 'function toCanvas(')), `${k}: toCanvas reads U.pointerRect(cv), not the raw rect`);
}
// the dev hooks are toCanvas's exact inverse (a verify script dispatches a REAL click there): same rect, or the click
// they compute would miss on exactly the machines this fix is for
const hook = (src, start, end) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, src.indexOf(end, i + start.length)); };
A.ok(usesPointerRect(hook(SRC.build, 'const tileClient = (tx, ty) =>', '\n')), 'build.js tileClient (where a tile tip is said) reads U.pointerRect(cv)');
A.ok(usesPointerRect(hook(SRC.build, '_tileEvent: ([tx, ty], button) =>', 'clientY:')), 'build.js _tileEvent reads U.pointerRect(cv)');
for (const k of ['world', 'review']) {
  A.ok(usesPointerRect(hook(SRC[k], 'const _dbgPropClientPoint = (t) =>', 'return {')), `${k}: _dbgPropClientPoint reads U.pointerRect(cv)`);
  A.ok(usesPointerRect(hook(SRC[k], 'propScreenRect: (t) =>', 'const kx')), `${k}: propScreenRect reads U.pointerRect(cv)`);
}
A.ok(usesPointerRect(hook(SRC.world, 'const _dbgDeskClientPoint = (aid) =>', 'const c = curvePoint')), 'world.js _dbgDeskClientPoint reads U.pointerRect(cv)');

/* ---- 6. The shipped website app carries the same code ---- */
const MIRROR = { 'frontend/js/util.js': 'website/app/js/util.js', 'frontend/app/build.js': 'website/app/app/build.js',
  'frontend/app/world.js': 'website/app/app/world.js', 'frontend/agent-demo/review-world.js': 'website/app/agent-demo/review-world.js' };
for (const [src, dst] of Object.entries(MIRROR)) A.ok(read(src) === read(dst), `${dst} mirrors ${src} exactly (npm run sync:website)`);

A.report('webkit-zoom-pointer.test');
