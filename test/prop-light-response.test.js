/* Integer RGBA raster adapter exercises real canonical prop pixels and overlay
   composition. It is not a substitute for the integrated CRT/world visual check. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/propsprites.js'), 'utf8');
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const color = value => {
  if (value.startsWith('#')) {
    let hex = value.slice(1); if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const n = parseInt(hex, 16); return [n >>> 16, (n >>> 8) & 255, n & 255, 1];
  }
  const channels = value.match(/[\d.]+/g).map(Number); return channels.length === 3 ? [...channels, 1] : channels;
};
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
class Canvas {
  constructor(env, width = 0, height = 0) { this.env = env; this.listeners = new Map(); this.width = width; this.height = height; }
  set width(w) { this._w = w; this.reset(); } get width() { return this._w; }
  set height(h) { this._h = h; this.reset(); } get height() { return this._h; }
  reset() { this.pixels = new Uint8ClampedArray((this._w || 0) * (this._h || 0) * 4); this.ctx = new Context(this); }
  getContext() { return this.ctx; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  lose(dispatch = true) { this.ctx.lost = true; if (dispatch && this.listeners.has('contextlost')) this.listeners.get('contextlost')(); }
}
class Context {
  constructor(canvas) {
    this.canvas = canvas; this.matrix = [1,0,0,1,0,0]; this.stack = []; this.draws = [];
    this.fillStyle = '#000000'; this.globalAlpha = 1; this.globalCompositeOperation = 'source-over'; this.imageSmoothingEnabled = true;
  }
  state() { return { matrix: this.matrix.slice(), fillStyle: this.fillStyle, globalAlpha: this.globalAlpha,
    globalCompositeOperation: this.globalCompositeOperation, imageSmoothingEnabled: this.imageSmoothingEnabled }; }
  save() { this.stack.push(this.state()); } restore() { Object.assign(this, this.stack.pop()); }
  transform(...m) { this.matrix = multiply(this.matrix, m); }
  translate(x, y) { this.transform(1,0,0,1,x,y); } scale(x, y) { this.transform(x,0,0,y,0,0); }
  setTransform(...m) { this.matrix = m; }
  blend(x, y, rgba) {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const i = (y * this.canvas.width + x) * 4, out = this.canvas.pixels;
    const s = Math.max(0, Math.min(1, rgba[3] * this.globalAlpha)), d = out[i + 3] / 255;
    if (this.globalCompositeOperation === 'source-in') {
      for (let c = 0; c < 3; c++) out[i+c] = rgba[c]; out[i+3] = Math.round(s*d*255); return;
    }
    assert.equal(this.globalCompositeOperation, 'source-over', 'raster supports the actual blend modes used here');
    const a = s + d * (1-s); if (!a) return;
    for (let c = 0; c < 3; c++) out[i+c] = Math.round((rgba[c]*s + out[i+c]*d*(1-s)) / a);
    out[i+3] = Math.round(a*255);
  }
  fillRect(x, y, w, h) {
    if (!(w > 0 && h > 0)) return;
    const m = this.matrix, pt = (x,y) => [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
    const points = [pt(x,y),pt(x+w,y),pt(x,y+h),pt(x+w,y+h)], xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
    const rgba = color(this.fillStyle);
    for (let yy = Math.max(0, Math.floor(Math.min(...ys))); yy < Math.min(this.canvas.height, Math.max(...ys)); yy++)
      for (let xx = Math.max(0, Math.floor(Math.min(...xs))); xx < Math.min(this.canvas.width, Math.max(...xs)); xx++) this.blend(xx, yy, rgba);
  }
  clearRect(x, y, w, h) {
    for (let yy = y; yy < y+h; yy++) for (let xx = x; xx < x+w; xx++) this.canvas.pixels.fill(0, (yy*this.canvas.width+xx)*4, (yy*this.canvas.width+xx)*4+4);
  }
  drawImage(image, x, y) {
    if (this.failDraw) throw Error('draw unavailable');
    this.draws.push({ image, x, y, state: this.state() });
    assert.equal(arguments.length, 3, 'light responses are native-size blits');
    const m = this.matrix;
    for (let yy = 0; yy < image.height; yy++) for (let xx = 0; xx < image.width; xx++) {
      const i = (yy*image.width+xx)*4;
      this.blend(Math.round(m[0]*(x+xx)+m[2]*(y+yy)+m[4]),Math.round(m[1]*(x+xx)+m[3]*(y+yy)+m[5]),[...image.pixels.slice(i,i+3),image.pixels[i+3]/255]);
    }
  }
  getImageData() {
    if (this.canvas.env.failRead) throw Error('readback unavailable');
    this.canvas.env.reads++; return { data: this.canvas.pixels.slice() };
  }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w*h*4) }; }
  putImageData(image) { this.canvas.pixels.set(image.data); }
  isContextLost() { return !!this.lost; }
  beginPath() {} closePath() {} moveTo() {} lineTo() {} arc() {} ellipse() {} rect() {} fill() {} stroke() {} clip() {} fillText() {}
  measureText() { return { width: 0 }; }
  createLinearGradient() { return { addColorStop() {} }; }
}
function harness(src = source) {
  const env = { reads: 0, canvases: [] };
  const document = { createElement(tag) { assert.equal(tag, 'canvas'); const cv = new Canvas(env); env.canvases.push(cv); return cv; } };
  const context = vm.createContext({ module: { exports: {} }, document, console, U: { hash, shade: c => c } });
  vm.runInContext(src, context);
  const props = context.module.exports, target = new Canvas(env, 220, 180);
  props.setCtx(target.ctx); props.setNow(1400);
  return { props, target, env };
}
const f = extra => ({ t: 'crate', x: 5, y: 7, w: 2, h: 1, id: 'freight', ...extra });
const east = { color: [128,192,240], strength: .75, dx: 1, dy: 0 };

test('optional response paints inside the actual rigid prop without altering its draw or own hues', () => {
  const { props, target, env } = harness(), prop = f(), input = JSON.stringify(prop);
  props.draw(prop, false); const before = target.pixels.slice();
  const state = target.ctx.state();
  assert.equal(props.drawLightResponse(prop, east), true);
  assert.deepEqual(target.ctx.state(), state); assert.equal(JSON.stringify(prop), input);
  let changed = 0, maxDelta = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (!before[i+3]) assert.equal(target.pixels[i+3], 0, 'response cannot grow art into empty pixels');
    assert.equal(target.pixels[i+3], before[i+3], 'overlay preserves actual native coverage');
    for (let c = 0; c < 3; c++) { const delta = Math.abs(target.pixels[i+c]-before[i+c]); if (delta) changed++; maxDelta = Math.max(maxDelta, delta); }
  }
  assert.ok(changed > 100, 'existing furniture visibly receives the supplied practical light');
  assert.ok(maxDelta <= 42, 'low-alpha treatment preserves authored local colour');
  assert.equal(env.reads, 1, 'one native-mask readback on a cold response');
  assert.equal(props.lightResponseStats().draws, 1);
});

test('direction changes the lit side and every bright edge stays one native pixel inside opaque casing', () => {
  const { props, target, env } = harness();
  props.drawLightResponse(f(), east); const right = target.ctx.draws.at(-1).image;
  const mask = env.canvases[0], alpha = mask.pixels, solid = (x,y) => x>=0&&y>=0&&x<mask.width&&y<mask.height&&alpha[(y*mask.width+x)*4+3]>=250;
  let bright = 0;
  for (let y = 0; y < right.height; y++) for (let x = 0; x < right.width; x++) {
    const a = right.pixels[(y*right.width+x)*4+3];
    if (!solid(x,y)) assert.equal(a, 0, 'translucent bloom/contact pixels receive no second halo');
    if (a > 32) { bright++; assert.equal(solid(x+1,y), false, 'bright rim is on the source-facing one-pixel edge'); }
    assert.ok(a <= 42, 'even the lit edge stays restrained');
  }
  assert.ok(bright > 0);
  props.drawLightResponse(f(), { ...east, dx: -1 }); const left = target.ctx.draws.at(-1).image;
  const energy = (cv, side) => {
    let sum = 0; for (let y=0;y<cv.height;y++) for (let x=0;x<cv.width;x++) if (side === (x >= cv.width/2)) {
      const i=(y*cv.width+x)*4; sum+=(cv.pixels[i]+cv.pixels[i+1]+cv.pixels[i+2])*cv.pixels[i+3];
    } return sum;
  };
  assert.ok(energy(right,true)>energy(left,true), 'east light brightens the east-facing furniture side');
  assert.ok(energy(left,false)>energy(right,false), 'west light brightens the west-facing furniture side');
});

test('quantized static responses reuse native overlays across instances, mount height and minor sample jitter', () => {
  const { props, target, env } = harness(); props.drawLightResponse(f(), east);
  const base = target.ctx.draws.at(-1), allocated = env.canvases.length;
  props.drawLightResponse(f({ x: -2, y: 4, mount: 'surface' }), { color: [130,190,241], strength: .76, dx: 1, dy: .01 });
  const mounted = target.ctx.draws.at(-1);
  assert.equal(mounted.image, base.image); assert.equal(env.canvases.length, allocated); assert.equal(env.reads, 1);
  assert.deepEqual([mounted.x,mounted.y], [-2*12-16,4*12-48-8], 'existing eight-pixel surface lift applied exactly once');
  assert.equal(mounted.state.imageSmoothingEnabled, false);
  assert.equal(props.lightResponseStats().hits, 1);
});

test('decals, dynamic silhouettes, missing samples and oversized footprints have zero response cost', () => {
  const { props, target, env } = harness();
  assert.equal(props.canLightResponse(f()), true);
  for (const t of ['rug','cablerun','hazardpad','outbox','bunk','holopet','unknown']) {
    assert.equal(props.canLightResponse(f({ t })), false, 'caller can skip sampling ' + t);
    assert.equal(props.drawLightResponse(f({ t }), east), false, t);
  }
  for (const light of [null, {}, { ...east, strength: 0 }, { ...east, strength: NaN }, { ...east, color: [NaN,2,3] }]) assert.equal(props.drawLightResponse(f(), light), false);
  for (const invalid of [{ w: 1000 }, { h: -1 }, { x: Infinity }, { w: 1.5 }]) assert.equal(props.drawLightResponse(f(invalid), east), false);
  assert.equal(env.canvases.length, 0); assert.equal(target.ctx.draws.length, 0); assert.equal(props.lightResponseStats().bytes, 0);
});

// 418 distinct quantized lights on one mask: past any entry budget up to 4096 keys.
const nth = i => ({ ...east, color: [(i%16)*16,(Math.floor(i/16)%16)*16,Math.floor(i/256)*16] });

test('the budget is 384 overlays / 1 Mi px (4 MiB RGBA), and the stats report the bounds the cache enforces', () => {
  const { props, target } = harness(); target.ctx.drawImage = () => {};
  const limits = source.match(/const RESPONSE_LIMIT = (\d+), RESPONSE_PIXELS = (\d+), RESPONSE_SINGLE = (\d+);/);
  assert.ok(limits, '(the budget line is found)');
  let stats = props.lightResponseStats();
  assert.deepEqual([stats.maxEntries, stats.maxPixels, stats.maxBytes, stats.maxSinglePixels], [384, 1048576, 4194304, 65536]);
  assert.deepEqual(limits.slice(1).map(Number), [stats.maxEntries, stats.maxPixels, stats.maxSinglePixels], 'the stats are the real constants');
  // The pixel bound the stats report is the one the cache fills to and holds. (It binds first: the smallest overlay, a
  // 1x1 footprint's, is 44 x 68 px, so at most 350 fit under 384 entries.) A 2x1 crate's is 56 x 68: 275 fit.
  for (let i=0;i<stats.maxEntries+34;i++) assert.equal(props.drawLightResponse(f(), nth(i)), true);
  stats = props.lightResponseStats();
  assert.deepEqual([stats.entries, stats.pixels, stats.builds, stats.evictions], [275, 275*56*68, 418, 418-275]);
  assert.equal(Math.floor(stats.maxPixels / (56*68)), 275); assert.ok(stats.entries <= stats.maxEntries);
  // a 30x3 footprint's overlay is 392 x 92 px, so exactly floor(1 Mi / 36064) = 29 fit
  props.invalidateLightResponse();
  for (let i=0;i<40;i++) assert.equal(props.drawLightResponse(f({ w: 30, h: 3 }), nth(i)), true);
  stats = props.lightResponseStats();
  assert.deepEqual([stats.entries, stats.pixels, stats.bytes], [29, 29*392*92, 29*392*92*4]);
  assert.equal(Math.floor(stats.maxPixels / (392*92)), 29);
});

test('entry and pixel budgets evict old responses while steady repeats remain cached', () => {
  const { props } = harness();
  const cap = props.lightResponseStats().maxEntries;
  for (let i=0;i<cap+34;i++) props.drawLightResponse(f(), nth(i));
  let stats = props.lightResponseStats(); assert.ok(stats.evictions > 0); assert.ok(stats.entries <= stats.maxEntries); assert.ok(stats.pixels <= stats.maxPixels);
  assert.equal(stats.bytes, stats.pixels*4); assert.ok(stats.bytes <= stats.maxBytes);
  for (let i=0;i<40;i++) props.drawLightResponse(f({ w: 30, h: 3 }), nth(i));
  stats = props.lightResponseStats(); assert.ok(stats.pixels <= stats.maxPixels, 'large authored footprints obey the pixel budget too');
  assert.ok(stats.entries <= stats.maxEntries);
  const builds = stats.builds; props.drawLightResponse(f({ w: 30, h: 3 }), nth(39));
  assert.equal(props.lightResponseStats().builds, builds);
  props.invalidateLightResponse(); stats = props.lightResponseStats(); assert.equal(stats.entries, 0); assert.equal(stats.bytes, 0);
});

// THE LRU CLIFF (2026-10-20): a frame's on-screen props are a cyclic working set, and an LRU smaller than one misses
// on every lookup. 80 crates, each its own light, overflow the old 96-entry / 256 Ki px budget by pixels: under it they
// rebuilt (and read the mask back) 80 times a frame. Under the 4x budget they build once.
test('a frame working set past the old budget is built once, then every repeat draw hits the cache', () => {
  const { props, target, env } = harness(); target.ctx.drawImage = () => {};
  const N = 80, crates = Array.from({ length: N }, (_, i) => f({ x: 1 + (i % 10) * 3, y: 1 + Math.floor(i / 10) * 2, id: 'c' + i }));
  const perFrame = [];
  for (let fr = 0; fr < 6; fr++) {
    props.setNow(1000 + fr * 16.7);
    const s0 = props.lightResponseStats(), reads = env.reads;
    for (let i = 0; i < N; i++) assert.equal(props.drawLightResponse(crates[i], nth(i)), true);
    const s1 = props.lightResponseStats();
    perFrame.push([s1.builds - s0.builds, s1.hits - s0.hits, s1.evictions - s0.evictions, env.reads - reads]);
  }
  assert.ok(props.lightResponseStats().pixels > 262144, '(setup: this working set is past the old 256 Ki px budget)');
  assert.deepEqual(perFrame[0], [N, 0, 0, 1], 'a cold frame builds each response, reading the shared mask back once');
  assert.deepEqual(perFrame.slice(1), Array(5).fill([0, N, 0, 0]), 'every later frame hits: no build, eviction or readback');
});

test("a mask's opaque flags are read back once, whatever lights land on it", () => {
  const { props, target, env } = harness(); target.ctx.drawImage = () => {};
  for (let i=0;i<48;i++) assert.equal(props.drawLightResponse(f(), nth(i % 16)), true);
  assert.deepEqual([props.lightResponseStats().builds, env.reads], [16, 1], 'sixteen overlays from one readback');
  assert.equal(props.drawLightResponse(f({ w: 3 }), east), true);
  assert.equal(env.reads, 2, 'another footprint is another mask: its own one readback');
  props.invalidateLightResponse();   // the overlays go; the masks (and their flags) stay
  for (let i=0;i<16;i++) props.drawLightResponse(f(), nth(i));
  props.drawLightResponse(f({ w: 3 }), east);
  assert.deepEqual([props.lightResponseStats().builds, env.reads], [34, 2], 'rebuilt overlays reuse the flags');
  env.canvases[0].lose(false);   // a lost mask is replaced by a new canvas, which is read back once
  for (let i=0;i<16;i++) props.drawLightResponse(f(), nth(i));
  assert.deepEqual([props.lightResponseStats().builds, env.reads], [50, 3]);
});

/* SAME PICTURE AS TRUNK. The budget and the per-mask flags change only what an overlay costs, never what it is. The
   oracle is the module with trunk's responseOverlay (VERBATIM, 2026-10-20, before the 4x budget) and trunk's budget
   spliced back in; both draw the same scenes into a context that records every blit, and every blit must match:
   position, state and every overlay pixel. */
const TRUNK_LIMITS = 'const RESPONSE_LIMIT = 96, RESPONSE_PIXELS = 262144, RESPONSE_SINGLE = 65536;';
const TRUNK_OVERLAY = `function responseOverlay(f,light) {
    const mask=shadowMask(f);if(!mask)return null;
    const key=[f.t,f.w||1,f.h||1,f.r||0,f.m||0,light.direction,light.strength,...light.color].join('|');
    let hit=lightResponses.get(key);
    if(hit) {
      const g=hit.cv.getContext('2d');
      if(hit.mask===mask&&g&&!(g.isContextLost&&g.isContextLost())) {
        lightResponses.delete(key);lightResponses.set(key,hit);responseMetrics.hits++;return hit.cv;
      }
      dropResponse(key);
    }
    const w=mask.width,h=mask.height,pixels=w*h;
    if(pixels>RESPONSE_SINGLE)return null;
    const alpha=mask.getContext('2d').getImageData(0,0,w,h).data;
    if(alpha.length!==pixels*4)return null;
    let minX=w,minY=h,maxX=-1,maxY=-1;
    // Ignore the translucent spill already carried by old art. A physical rim
    // belongs to its opaque casing, not to a halo or a contact shadow on the deck.
    const solid=(x,y)=>x>=0&&y>=0&&x<w&&y<h&&alpha[(y*w+x)*4+3]>=250;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(solid(x,y)) {
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    if(maxX<0)return null;
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const g=cv.getContext('2d');if(!g||!g.createImageData||!g.putImageData)return null;
    const image=g.createImageData(w,h),out=image.data;
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2,rx=Math.max(1,(maxX-minX)/2),ry=Math.max(1,(maxY-minY)/2);
    const span=Math.abs(light.dx)+Math.abs(light.dy)||1,sx=Math.round(light.dx),sy=Math.round(light.dy);
    const grey=light.color.reduce((sum,v)=>sum+v,0)/3;
    const tint=light.color.map(v=>Math.round(v*.45+grey*.55));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++) {
      if(!solid(x,y))continue;
      const facing=responseClamp(.5+(((x-cx)/rx)*light.dx+((y-cy)/ry)*light.dy)/(2*span),0,1);
      const rim=light.direction>=0&&!solid(x+sx,y+sy);
      const shadeA=light.strength*.12*Math.pow(1-facing,1.4);
      const tintA=light.strength*(.055*facing+(rim?.105:0));
      const a=tintA+shadeA*(1-tintA),i=(y*w+x)*4;
      if(!a)continue;
      for(let c=0;c<3;c++)out[i+c]=Math.round((tint[c]*tintA+RESPONSE_SHADE[c]*shadeA*(1-tintA))/a);
      out[i+3]=Math.round(a*255);
    }
    g.putImageData(image,0,0);
    while(lightResponses.size>=RESPONSE_LIMIT||responsePixels+pixels>RESPONSE_PIXELS) {
      dropResponse(lightResponses.keys().next().value);responseMetrics.evictions++;
    }
    hit={cv,mask,pixels};lightResponses.set(key,hit);responsePixels+=pixels;responseMetrics.builds++;
    if(cv.addEventListener)cv.addEventListener('contextlost',()=>{if(lightResponses.get(key)===hit)dropResponse(key);},{once:true});
    return cv;
  }`;
function trunkSource() {
  const { fnBody } = require('./_fnbody');
  const overlay = fnBody(source, 'function responseOverlay(');
  assert.ok(overlay.length > 400 && overlay.length < 6000, '(responseOverlay found)');
  const limits = /const RESPONSE_LIMIT = \d+, RESPONSE_PIXELS = \d+, RESPONSE_SINGLE = 65536;/;
  assert.ok(limits.test(source), '(the budget line is found)');
  const out = source.replace(limits, () => TRUNK_LIMITS).replace(overlay, () => TRUNK_OVERLAY);
  assert.ok(out.includes(TRUNK_LIMITS) && out.includes(TRUNK_OVERLAY) && out !== source);
  return out;
}
function recorded(src, frames) {
  const { props, target, env } = harness(src), blits = [];
  target.ctx.drawImage = function (image, x, y) {
    assert.equal(arguments.length, 3);
    blits.push({ x, y, w: image.width, h: image.height, pixels: Buffer.from(image.pixels), state: this.state() });
  };
  const perFrame = [];
  frames.forEach((scene, k) => {
    props.setNow(4000 + k * 16.7);
    const s0 = props.lightResponseStats(), reads = env.reads;
    const lit = scene.map(([prop, light]) => props.drawLightResponse(prop, light));
    const s1 = props.lightResponseStats();
    perFrame.push({ lit, builds: s1.builds - s0.builds, reads: env.reads - reads });
  });
  return { blits, perFrame, stats: props.lightResponseStats() };
}
function sameBlits(a, b, name) {
  assert.equal(a.blits.length, b.blits.length, name + ': as many blits as trunk');
  a.blits.forEach((x, i) => {
    const y = b.blits[i];
    assert.deepEqual([x.x, x.y, x.w, x.h, x.state], [y.x, y.y, y.w, y.h, y.state], name + ' blit ' + i + ': placed as trunk places it');
    assert.equal(Buffer.compare(x.pixels, y.pixels), 0, name + ' blit ' + i + ': every overlay pixel equals trunk');
  });
  assert.deepEqual(a.perFrame.map(r => r.lit), b.perFrame.map(r => r.lit), name + ': the same props lit on every frame');
}

test('every overlay drawn equals trunk, under the budget and past it; past it the builds cost what trunk costs', () => {
  const trunk = trunkSource();
  // A station of mixed rigid props, each in its own light, a fifth of them flickering frame to frame: past trunk's
  // 96 entries / 256 Ki px, under the 4x budget.
  const TYPES = ['crate', 'desk', 'chair', 'shelf', 'stool', 'bench', 'toolbox', 'bookshelf'];
  const props = Array.from({ length: 120 }, (_, i) => {
    const t = TYPES[i % TYPES.length];
    return Object.assign({ t, x: 2 + (i % 12) * 3, y: 2 + Math.floor(i / 12) * 3, id: 'p' + i }, t === 'crate' ? { w: 2, h: 1 } : {},
      i % 9 === 4 ? { mount: 'surface' } : {});
  });
  const station = k => props.map((p, i) => [p, { color: [(i * 37) % 256, (i * 91) % 256, (i * 53 + (i % 5 ? 0 : k * 16)) % 256],
    strength: .25 + (i % 6) / 8 + (i % 5 ? 0 : (k % 2) * .125), dx: Math.cos(i), dy: (i % 7 === 3 ? 0 : Math.sin(i)) }]);
  const frames = Array.from({ length: 5 }, (_, k) => station(k));
  const now = recorded(source, frames), was = recorded(trunk, frames);
  sameBlits(now, was, 'under the budget');
  assert.ok(now.blits.length >= 5 * 100, '(setup: ' + now.blits.length + ' blits, most props lit)');
  assert.ok(was.perFrame.slice(1).every(r => r.builds > 50), '(setup: past the old budget trunk rebuilds every frame)');
  assert.equal(now.stats.evictions, 0, 'the station sits under the 4x budget');
  assert.ok(now.perFrame.slice(1).every(r => r.builds <= 24 && r.reads === 0), 'and only the flickering props build, with no readback');
  // Past the 4x budget: 40 overlays of 392 x 92 px in a cycle, 29 fit. Same plain LRU as trunk, so the same builds.
  const big = Array.from({ length: 40 }, (_, i) => [f({ w: 30, h: 3, id: 'big' + i, x: 1, y: 1 + i * 4 }), nth(i)]);
  const past = [big, big, big], nowPast = recorded(source, past), wasPast = recorded(trunk, past);
  sameBlits(nowPast, wasPast, 'past the budget');
  assert.deepEqual(nowPast.perFrame.map(r => r.builds), wasPast.perFrame.map(r => r.builds), 'past the budget it builds what trunk builds');
  assert.ok(nowPast.perFrame.every(r => r.builds === 40), '(setup: a cycle past the budget misses every lookup)');
  assert.equal(nowPast.stats.pixels <= nowPast.stats.maxPixels && nowPast.stats.entries <= nowPast.stats.maxEntries, true);
});

test('lost overlay and native mask contexts are rebuilt, and lost main context skips safely', () => {
  const { props, target, env } = harness(); props.drawLightResponse(f(), east);
  const first = target.ctx.draws.at(-1).image; first.lose();
  assert.equal(props.lightResponseStats().entries, 0); assert.equal(props.lightResponseStats().bytes, 0);
  assert.equal(props.drawLightResponse(f(), east), true); assert.notEqual(target.ctx.draws.at(-1).image, first);
  const second = target.ctx.draws.at(-1).image, mask = env.canvases[0]; mask.lose(false);
  assert.equal(props.drawLightResponse(f(), east), true); assert.notEqual(target.ctx.draws.at(-1).image, second);
  const builds = props.lightResponseStats().builds; target.lose();
  assert.equal(props.drawLightResponse(f(), east), false); assert.equal(props.lightResponseStats().builds, builds);
});

test('optional readback/blit failure never poisons the authoritative prop context or later draws', () => {
  const { props, target, env } = harness();
  const before = target.ctx.state(); env.failRead = true;
  assert.equal(props.drawLightResponse(f(), east), false); assert.deepEqual(target.ctx.state(), before);
  env.failRead = false; assert.equal(props.drawLightResponse(f(), east), true);
  target.ctx.failDraw = true; assert.equal(props.drawLightResponse(f(), east), false); assert.deepEqual(target.ctx.state(), before);
  target.ctx.failDraw = false; assert.doesNotThrow(() => props.draw(f(), true, { heat: .6, prog: .2 }));
  assert.equal(props.lightResponseStats().failures, 2);
});

test('cached silhouette lighting leaves real workstation heat and progress content live on every draw', () => {
  const { props, env } = harness(), desk = f({ t: 'desk' });
  const frame = (time, heat, prog) => {
    const cv = new Canvas(env, 220, 180); props.setCtx(cv.ctx); props.setNow(time);
    props.draw(desk, true, { heat, prog });
    assert.equal(props.drawLightResponse(desk, east), true);
    return cv;
  };
  const first = frame(400, .2, .25), builds = props.lightResponseStats().builds;
  const second = frame(1200, .8, .75);
  assert.equal(props.lightResponseStats().builds, builds, 'light cache does not become an animated-art cache');
  assert.notDeepEqual(first.pixels, second.pixels, 'real heat/progress still repaint the canonical desk');
  const i = ((desk.y*12-5)*second.width + desk.x*12+10)*4;
  assert.ok(second.pixels[i+1] > first.pixels[i+1], 'the newly published progress strip remains visibly current');
});
