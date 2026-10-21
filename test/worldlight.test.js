'use strict';

const A = require('./_assert.js');
const Light = require('../frontend/app/worldlight.js');

// Two enclosed 3x3 rooms. Their common wall has one actual passable threshold;
// closing it models projectGeometry's sealed airlock (canStep is the authority).
function station(open) {
  const COLS = 8, ROWS = 5, zoneGrid = new Array(COLS * ROWS).fill(null);
  for (let y = 1; y <= 3; y++) for (let x = 1; x <= 6; x++) zoneGrid[y * COLS + x] = x <= 3 ? 'left' : 'right';
  return { COLS, ROWS, TILE: 12, W: 96, H: 60, zoneGrid,
    allRects: [{ x1: 1, y1: 1, x2: 6, y2: 3 }],
    canStep: (x, y, nx, ny) => zoneGrid[y * COLS + x] === zoneGrid[ny * COLS + nx] ||
      (open && y === 2 && ny === 2 && Math.abs(x - nx) === 1) };
}

const open = Light.buildSegments(station(true)), closed = Light.buildSegments(station(false));
const source = { x: 30, y: 30, r: 90, a: 0.8, c: [255, 190, 100] };
A.eq(open.length, 6, 'long exterior walls merge; only the two jambs split the common wall');
A.eq(closed.length, 5, 'closing the threshold produces one continuous internal wall');
A.ok(Light.visibleAt(source, 65, 30, open), 'light passes through the actual open threshold');
A.ok(!Light.visibleAt(source, 65, 30, closed), 'sealed airlock blocks the same sightline');
A.ok(!Light.visibleAt(source, 65, 13, open), 'wall blocks a ray that misses the doorway');
A.ok(!Light.visibleAt(source, 90, 30, open), 'light cannot escape the outer hull');
A.ok(Light.visibleAt(source, 35, 16, closed), 'light reaches its own room');
A.ok(!Light.visibleAt(source, 30, 140, []), 'finite reach applies without any walls');

const wall = { x1: 48, y1: 12, x2: 48, y2: 48 };
A.eq(Light.rayDistance(30, 30, 1, 0, wall), 18, 'ray hits the exact wall plane');
A.eq(Light.rayDistance(30, 30, -1, 0, wall), Infinity, 'a wall behind the source does not block the ray');
A.eq(Light.rayDistance(48, 5, 0, 1, wall), 7, 'a collinear ray cannot pass through a wall endpoint');
const polygon = Light.visibilityPolygon(source, closed, 64);
A.ok(polygon.length >= 64, 'visibility retains a smooth radial contour as well as corner rays');
A.ok(polygon.every(p => p.x <= 48 + 0.00001 && p.x >= 12 - 0.00001 && p.y >= 12 - 0.00001 && p.y <= 48 + 0.00001),
  'every polygon point stays inside the enclosed source room');
const angles = polygon.map(p => (Math.atan2(p.y - source.y, p.x - source.x) + Math.PI * 2) % (Math.PI * 2));
A.ok(angles.every((a, i) => i === 0 || a + 0.00001 >= angles[i - 1]), 'corner rays keep one winding with no wraparound self-intersection');

A.eq(Light.falloff(0), 1, 'source has full normalized intensity');
A.eq(Light.falloff(1), 0, 'light fades fully at its finite radius');
A.ok(Light.falloff(0.3) > Light.falloff(0.6), 'illumination falls with distance');
A.eq(Light.normalizeLight({ x: 0, y: 0, r: 10, c: [1, 2, 3], a: 0 }, false), null,
  'a source with no supplied energy stays off');
A.eq(Light.normalizeLight({ x: 0, y: 0, r: Infinity, c: [1, 2, 3], a: 1 }, false).r, 768,
  'oversized radii are bounded before allocation');
A.eq(Light.normalizeLight({ x: 'invalid', y: 0, r: 10 }, true), null, 'malformed positions never reach canvas');
const legacyFixture = Light.normalizeLight({ x: 30, y: 30, r: 110, rgb: '255,192,104', gain: 0.22 }, true);
A.eq(legacyFixture.a, 0.86, 'replacement restores room fixture energy formerly supplied by a separate diffuse pass');
A.eq(legacyFixture.r, 110, 'replacement preserves the bake radius and its existing two-axis coverage');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 110, gain: 0 }, true), null, 'zero fixture gain remains off');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 110, gain: 0.5 }, true).a, 0.43, 'nonlegacy fixture gains retain their intended relative strength');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 110, gain: 0.22, a: 0 }, true), null,
  'legacy gain compensation never revives an explicitly unlit source');
A.eq(Light.lightAt(65, 30, [source], closed).strength, 0, 'sample is dark across a sealed wall');
A.ok(Light.lightAt(65, 30, [source], open).strength > 0, 'sample measures actual transmission through the door');
const shadow = Light.shadowFor({ x: 35, y: 30, width: 8, height: 20 }, [source], closed);
A.ok(shadow.dx > 0 && Math.abs(shadow.dy) < 0.001, 'ground shadow points away from the visible source');
const tint = Light.lightAt(35, 30, [source, source, source], closed);
A.eq(tint.color.join(','), source.c.join(','), 'overlapping warm emitters retain their colour instead of clipping to white');
A.ok(tint.dx < -0.99 && Math.abs(tint.dy) < 0.001, 'sprite-light direction points from the body toward the actual source');
A.ok(tint.strength <= 1 && tint.energy > 1, 'sprite-light strength stays bounded while additive energy remains measurable');
const crosslit = Light.shadowFor({ x: 35, y: 30, width: 8, height: 20 },
  [source, Object.assign({}, source, { x: 40 })], closed);
A.ok(crosslit.length < shadow.length, 'opposing equal lights soften the directional shadow rather than selecting an arbitrary long one');
A.ok(shadow.penumbra > 0 && shadow.contactAlpha > 0 && shadow.contactAlpha < 0.25,
  'grounding has a bounded soft edge and contact component');
const areaLight = Light.normalizeLight(Object.assign({}, source, { softness: 2 }), false);
const edgeTransmission = Light.visibilityFraction(areaLight, 65, 18.5, open);
A.ok(edgeTransmission > 0 && edgeTransmission < 1, 'a doorway shadow has a real partial-visibility penumbra');
A.eq(Light.visibilityFraction(areaLight, 65, 18.5, closed), 0, 'softening never transmits through a sealed wall');
A.eq(Light.visibilityFraction(areaLight, 65, 30, open), 1, 'clear sightlines retain the accepted full pool brightness');
const wallAdjacent = Light.normalizeLight({ x: 47.6, y: 30, r: 50, softness: 4 }, true);
A.ok(Light.emitterOrigins(wallAdjacent, closed, 5).every(o => o.x < 48),
  'an emitter next to a wall never samples light from the neighboring room');
A.eq(Light.visibilityFraction(wallAdjacent, 65, 30, closed), 0, 'wide apertures cannot leak around their own wall plane');
A.eq(Light.emitterOrigins(areaLight, open, 1).length, 1, 'low quality retains a single wall-aware origin');
const sampledEdge = Light.lightAt(65, 18.5, [areaLight], open);
A.ok(Math.abs(sampledEdge.strength - areaLight.a * Light.falloff(Math.hypot(35, -11.5) / areaLight.r) * edgeTransmission) < 0.000001,
  'sprite samples use the same fractional visibility as the cached area-light map');
A.eq(Light.normalizeLight({ x: 30, y: 30, r: 50 }, true).beam, null,
  'a room illumination pool does not invent a directional shaft');
const housedSource = { x: 30, y: 30, r: 50, rgb: '255,222,179', emitX: 30, emitY: 10, normalX: 0, normalY: 2 };
const housedLight = Light.normalizeLight(housedSource, true);
A.eq(housedLight.beam.dy, 1, 'physical housing normals normalize independently of source energy');
A.eq(housedLight.beam.y, 10, 'shaft retains the physical housing position rather than the floor anchor');
A.ok(housedLight.beam.length > 20 && housedLight.beam.strength < 0.06,
  'projected housing shaft reaches its floor with restrained, finite intensity');

const northWalls = [{ x1: 0, y1: 36, x2: 200, y2: 36 }, { x1: 108, y1: 36, x2: 108, y2: 100 }];
const raised = { x: 102, y: 31.6, r: 26, c: [255, 220, 170], a: 0.22 };
A.ok(!Light.visibleAt(raised, 102, 51.6, northWalls), 'regression setup: raised visual source appears outside its room plane');
const mounted = Light.normalizeLight(Object.assign({}, raised, { originX: 102, originY: 42 }), false);
A.ok(Light.visibleAt(mounted, 102, 51.6, northWalls), 'a mounted north-wall lamp illuminates its own floor from its planar origin');
A.ok(!Light.visibleAt(mounted, 114, 42, northWalls), 'a mounted lamp still cannot illuminate through the adjacent wall');
A.eq(mounted.y, 31.6, 'floor-plane visibility preserves the visible emitter position');
A.ok(Math.abs(Light.lightAt(102, 51.6, [mounted], northWalls).strength - 0.22 * Light.falloff(20 / 26)) < 0.00001,
  'mounted lamp falloff remains centered on the visible emitter');
A.ok(Light.visibilityPolygon(mounted, northWalls, 64).every(p => p.y >= 36 - 0.00001 && p.x <= 108 + 0.00001),
  'mounted source visibility polygon respects wall planes while covering the visible falloff bounds');

// A Canvas command adapter checks invalidation and lifecycle, not raster appearance.
// Pixel and performance proof belongs to the integrated seeded app.
let allocations = 0;
const surfaces = [], draws = [], fills = [];
function canvasFactory(w, h) {
  allocations++;
  const listeners = {}, stack = [], context = {
    globalAlpha: 0.3, globalCompositeOperation: 'multiply', imageSmoothingEnabled: true,
    lost: false, isContextLost() { return this.lost; },
    setTransform() {}, clearRect() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, ellipse() {},
    closePath() {}, fillRect(...args) { fills.push({ context: this, style: this.fillStyle, args }); },
    fill() {}, drawImage(...args) { draws.push(args); },
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled] = stack.pop(); }
  };
  const canvas = { width: w, height: h, getContext: () => context,
    addEventListener(name, fn) { listeners[name] = fn; },
    removeEventListener(name, fn) { if (listeners[name] === fn) delete listeners[name]; },
    emit(name, event) { if (listeners[name]) listeners[name](event || {}); }, listeners };
  surfaces.push(canvas); return canvas;
}
const engine = Light.create({ canvasFactory }), output = canvasFactory(96, 60).getContext('2d');
engine.setGeometry(station(true));
const frame = { fixtures: [{ x: 30, y: 30, r: 50, rgb: '255,192,104' }], lights: [source], ambient: 0.82 };
const beforePrepare = allocations;
A.ok(engine.prepare(frame), 'current frame can be prepared before any composite pass');
A.ok(engine.sample(35, 30).strength > 0 && engine.sample(35, 30).dx < 0,
  'first-frame sprites and grounding immediately sample their current light');
A.eq(allocations, beforePrepare, 'preparation does not allocate raster surfaces');
A.eq(engine.stats().staticBuilds, 0, 'preparation does not prematurely composite the light map');
engine.drawGrounding(output, [{ x: 35, y: 30, width: 8, height: 20 }]);
A.eq(output.globalAlpha, 0.3, 'grounding restores the caller alpha');
A.eq(output.globalCompositeOperation, 'multiply', 'grounding restores the caller blend mode');
A.ok(engine.render(output), 'renderer can composite the prepared frame without supplying it twice');
const first = engine.stats(), allocBefore = allocations;
engine.render(output, frame);
A.eq(engine.stats().staticBuilds, first.staticBuilds, 'steady fixtures reuse their composed map');
A.eq(engine.stats().dynamicBuilds, first.dynamicBuilds, 'steady prop lights reuse their composed map');
A.eq(allocations, allocBefore, 'a steady frame allocates no canvas surfaces');
A.eq(output.globalAlpha, 0.3, 'illumination restores the caller alpha');
A.eq(output.globalCompositeOperation, 'multiply', 'illumination restores the caller blend mode');

engine.render(output, Object.assign({}, frame, { lights: [Object.assign({}, source, { a: 0.5 })] }));
A.eq(engine.stats().visibilityBuilds, first.visibilityBuilds, 'emission changes reuse visibility and gradient stamps');
A.eq(engine.stats().dynamicBuilds, first.dynamicBuilds + 1, 'emission changes update the visible map');
engine.prepare({ lights: [], fixtures: [], ambient: 0.62 });
A.eq(engine.sample(30, 30).strength, 0, 'source removal reaches sprites before the later lighting composite');
engine.render(output);
A.eq(engine.sample(30, 30).strength, 0, 'removed sources immediately disappear from the renderer state');
A.ok(Math.abs(engine.stats().ambient - 0.58) < 0.00001, 'high room brightness maps to the new readable exposure');
engine.render(output, { lights: [], fixtures: [], ambient: 0.82 });
A.ok(Math.abs(engine.stats().ambient - 0.70) < 0.00001, 'low room brightness remains darker without crushing to the old .82');

engine.setGeometry(station(false)); engine.render(output, { lights: [source] });
A.eq(engine.sample(65, 30).strength, 0, 'geometry invalidation closes light paths as soon as a door seals');
engine.configure({ quality: 'low' });
const huge = Object.assign(station(true), { W: 12000, H: 8000 });
engine.setGeometry(huge);
A.ok(engine.stats().resolution < 0.1, 'large worlds reduce map resolution to respect the pixel budget');
A.ok(engine.stats().cacheBytes <= 600000 * 16 + 100000, 'large-world map allocation stays bounded');
engine.dispose();
A.eq(engine.stats().sources, 0, 'dispose releases source state');
A.eq(engine.stats().cachedStamps, 0, 'dispose releases the light stamp cache');
A.eq(engine.render(output, frame), false, 'disposed engines do not draw');

const recovery = Light.create({ canvasFactory }); recovery.setGeometry(station(true));
const lostMap = surfaces[surfaces.length - 4]; recovery.render(output, frame);
let prevented = false;
lostMap.getContext('2d').lost = true;
lostMap.emit('contextlost', { preventDefault() { prevented = true; } });
A.ok(prevented, 'canvas context loss requests restoration rather than abandoning the renderer');
A.ok(recovery.render(output), 'lost cached map is recreated and rendered from the prepared source state');
A.eq(recovery.stats().contextRecoveries, 1, 'resource recovery has a measured receipt');
A.eq(recovery.stats().geometryRevision, 2, 'resource recovery invalidates geometry-bound visibility and maps');
A.ok(recovery.sample(30, 30).strength > 0, 'sources survive recovery without a fabricated lighting transition');
A.eq(Object.keys(lostMap.listeners).length, 0, 'released maps detach their event handlers');
const lostStamp = surfaces[surfaces.length - 1]; lostStamp.getContext('2d').lost = true;
A.ok(recovery.render(output, frame), 'isContextLost catches a lost stamp even without a delivered event');
A.eq(recovery.stats().contextRecoveries, 2, 'silent stamp loss triggers another rebuild');
const restoredMap = surfaces[surfaces.length - 6]; restoredMap.emit('contextrestored');
recovery.render(output, frame);
A.eq(recovery.stats().contextRecoveries, 3, 'restoration invalidates cached pixels even when context reports healthy');
recovery.dispose();

const chunkEngine = Light.create({ canvasFactory }), chunkA = canvasFactory(48, 60), chunkB = canvasFactory(48, 60);
const floorA = canvasFactory(48, 60), floorB = canvasFactory(48, 60);
chunkEngine.setGeometry(station(true), { surfaceChunks: [
  { baseCv: chunkA, interiorCv: floorA, x: 0, y: 0, w: 48, h: 60 },
  { baseCv: chunkB, interiorCv: floorB, x: 48, y: 0, w: 48, h: 60 }
] });
const beforeChunk = draws.length;
A.ok(chunkEngine.render(output, frame), 'REFIT can illuminate chunked station geometry without a whole-station mask');
const chunkDraws = draws.slice(beforeChunk);
A.ok(chunkDraws.some(d => d[0] === chunkA && d[1] === 0) && chunkDraws.some(d => d[0] === chunkB && d[1] === 48),
  'architecture silhouette retains each chunk world offset');
A.ok(chunkDraws.some(d => d[0] === floorA) && chunkDraws.some(d => d[0] === floorB),
  'both exact curved floor masks contribute to the illumination union');
const chunkBuilds = chunkEngine.stats().visibilityBuilds;
chunkEngine.render(output, Object.assign({}, frame, { lights: [Object.assign({}, source, { originX: 31, originY: 30 })] }));
A.ok(chunkEngine.stats().visibilityBuilds > chunkBuilds, 'changing the planar origin invalidates a cached light polygon');
chunkEngine.dispose();

const atmosphere = Light.create({ canvasFactory }); atmosphere.setGeometry(station(true));
atmosphere.render(output, { fixtures: [{ x: 30, y: 30, r: 18, rgb: '255,192,104' }] });
const motes = () => fills.filter(f => f.context === output && f.args[2] === 1 && f.args[3] === 1);
const moteStart = motes().length;
atmosphere.drawAtmosphere(output, { now: 0, dust: 0 });
A.eq(motes().length, moteStart, 'zero dust draws no atmospheric motes');
atmosphere.drawAtmosphere(output, { now: 0 });
const defaultMotes = motes().slice(moteStart);
A.eq(defaultMotes.length, 2, 'omitted dust gain preserves the existing two motes per visible fixture');
atmosphere.drawAtmosphere(output, { now: 0, dust: 0.5 });
const halfMotes = motes().slice(moteStart + 2);
const alphaOf = f => Number(f.style.slice(f.style.lastIndexOf(',') + 1, -1));
A.ok(Math.abs(alphaOf(halfMotes[0]) * 2 - alphaOf(defaultMotes[0])) < 0.000001,
  'positive dust gain scales mote opacity');
A.ok(Math.abs(alphaOf(defaultMotes[0]) - 0.25 * 0.86 * 0.55 * Light.falloff(0.5)) < 0.000001,
  'motes are illuminated by local falloff rather than constant brightness throughout a room');
const beforeReduced = motes().length;
atmosphere.drawAtmosphere(output, { now: 0, dust: 2, reducedMotion: true });
A.eq(motes().length, beforeReduced, 'reduced motion suppresses motes even with positive dust gain');
atmosphere.dispose();

const shafts = Light.create({ canvasFactory }); shafts.setGeometry(station(true));
shafts.render(output, { fixtures: [housedSource], reducedMotion: true });
A.eq(shafts.stats().shafts, 1, 'only the explicitly supplied physical fixture produces a shaft');
A.eq(shafts.stats().beamBuilds, 1, 'static housing shaft has its own cached visibility-masked stamp');
const shaftAllocations = allocations;
shafts.render(output, { fixtures: [housedSource], reducedMotion: true });
A.eq(allocations, shaftAllocations, 'a static shaft allocates nothing on subsequent frames or reduced motion');
const beforeAperture = shafts.stats().visibilityBuilds;
shafts.render(output, { fixtures: [Object.assign({}, housedSource, { softness: 0 })] });
A.ok(shafts.stats().visibilityBuilds > beforeAperture, 'aperture changes invalidate both lighting and shaft visibility');
const beforeHousing = shafts.stats().beamBuilds;
shafts.render(output, { fixtures: [Object.assign({}, housedSource, { emitY: 12 })] });
A.eq(shafts.stats().beamBuilds, beforeHousing + 1, 'moving visible housing rebuilds its shaft even if the planar origin is unchanged');
const shaftStamp = surfaces[surfaces.length - 1]; shaftStamp.getContext('2d').lost = true;
shafts.render(output);
A.eq(shafts.stats().contextRecoveries, 1, 'a silently lost shaft stamp is rebuilt with the other cached resources');
shafts.configure({ shafts: 0 }); shafts.render(output);
A.eq(shafts.stats().shafts, 0, 'shaft gain can be disabled without changing accepted ambient or fixture pools');
shafts.dispose();

const sampler = Light.create({ canvasFactory, sampleCacheLimit: 3 }); sampler.setGeometry(station(true));
const sampleSource = Object.assign({}, source, { a: 0.6, softness: 0 });
const sampleFrame = { lights: [sampleSource] };
sampler.prepare(sampleFrame);
const firstSample = sampler.sample(35, 30);
A.ok(sampler.sample(35, 30) === firstSample, 'an unchanged exact position reuses its read-only lighting descriptor');
A.eq(sampler.stats().sampleCacheMisses, 1, 'repeated furniture sampling performs only one visibility evaluation');
A.eq(sampler.stats().sampleCacheHits, 1, 'sample reuse has a measured cache hit');
sampler.prepare({ lights: [Object.assign({}, sampleSource)] });
A.ok(sampler.sample(35, 30) === firstSample, 'fresh source objects with identical normalized values retain cached samples');
sampler.render(output);
A.ok(sampler.sample(35, 30) === firstSample, 'the later composite of a prepared frame preserves the sample cache');
sampler.drawGrounding(output, [{ x: 35, y: 30, width: 8, height: 20 }]);
A.eq(sampler.stats().sampleCacheMisses, 1, 'grounding shares the crew and furniture sample instead of tracing it again');
A.throws(() => { firstSample.color[0] = 0; }, 'a sprite cannot accidentally modify cached lighting colour');

sampler.sample(35.000000001, 30);
A.eq(sampler.stats().sampleCacheMisses, 2, 'subpixel positions remain exact rather than snapping across wall visibility boundaries');
sampler.sample(36, 30); sampler.sample(35, 30); sampler.sample(37, 30);
A.eq(sampler.stats().sampleCacheSize, 3, 'continuous movement cannot exceed the configured sample budget');
A.eq(sampler.stats().sampleCacheEvictions, 1, 'least-recently-used samples are evicted at the budget');
A.ok(sampler.sample(35, 30) === firstSample, 'recent stationary furniture survives moving-body cache pressure');
const beforeEvicted = sampler.stats().sampleCacheMisses;
sampler.sample(35.000000001, 30);
A.eq(sampler.stats().sampleCacheMisses, beforeEvicted + 1, 'an evicted moving position is evaluated again when revisited');

// GEOMETRY-SCOPED VISIBILITY (2026-10-07): a flickering source clears the samples every frame, but the wall
// occlusion behind them is remembered per wall set. Every sample must equal a cold engine's, bit for bit.
{
  const pick = h => JSON.stringify([h.rgb, h.color, h.strength, h.energy, h.dx, h.dy, h.coherence]);
  const flick = k => ({ fixtures: [{ x: 30, y: 30, r: 50, rgb: '255,192,104', softness: 1.2 }],
    lights: [Object.assign({}, source, { a: 0.5 + 0.01 * k, softness: 2 }), { x: 70, y: 28, r: 40, a: 0.4 + 0.02 * k, c: [90, 170, 255], softness: 1, originX: 66, originY: 24 }] });
  const points = [[35, 30], [65, 30], [52, 24], [40.5, 17.25], [72, 40], [20, 44], [58.125, 31]];
  const warm = Light.create({ canvasFactory }); warm.setGeometry(station(true));
  let same = 0;
  for (let k = 0; k < 6; k++) {
    warm.prepare(flick(k));
    for (const [x, y] of points) {
      const cold = Light.create({ canvasFactory }); cold.setGeometry(station(true)); cold.prepare(flick(k));
      if (pick(warm.sample(x, y)) === pick(cold.sample(x, y))) same++;
      cold.dispose();
    }
  }
  A.eq(same, 6 * points.length, 'remembered occlusion: every flickering-frame sample equals a cold engine\'s exactly');
  A.eq(warm.stats().sampleCacheInvalidations >= 6, true, 'each power change still cleared the samples themselves');
  warm.prepare(flick(0)); A.ok(warm.sample(65, 30).strength > 0, 'the open threshold passes light (warm caches)');
  warm.setGeometry(station(false)); warm.prepare(flick(0));
  const sealed = Light.create({ canvasFactory }); sealed.setGeometry(station(false)); sealed.prepare(flick(0));
  A.eq(pick(warm.sample(65, 30)), pick(sealed.sample(65, 30)), 'a new wall set starts the occlusion caches over: the sealed door matches a cold engine');
  warm.dispose(); sealed.dispose();
}

sampler.prepare({ lights: [Object.assign({}, sampleSource, { a: 0.6000001 })] });
A.eq(sampler.stats().sampleCacheSize, 0, 'sub-byte source power changes invalidate samples immediately');
A.ok(sampler.sample(35, 30).strength > firstSample.strength, 'a power change smaller than raster-key rounding still reaches sprite samples');
sampler.prepare({ lights: [Object.assign({}, sampleSource, { c: [90, 170, 255] })] });
A.eq(sampler.sample(35, 30).color, [90, 170, 255], 'colour changes replace cached warm/cool shading in the same frame');
sampler.prepare({ lights: [Object.assign({}, sampleSource, { x: 40 })] });
A.ok(sampler.sample(35, 30).dx > 0, 'moving a source immediately reverses the cached sprite light direction');
sampler.prepare({ lights: [Object.assign({}, sampleSource, { originX: 40 })] });
A.ok(sampler.sample(35, 30).dx > 0, 'changing only a mounted source planar origin invalidates direction samples');
sampler.prepare({ lights: [Object.assign({}, sampleSource, { r: 20 })] });
A.ok(sampler.sample(35, 30).strength < firstSample.strength, 'source reach changes invalidate cached falloff');
sampler.prepare({ lights: [] });
A.eq(sampler.stats().sampleCacheSize, 0, 'source removal clears cache before any draw or composite');
A.eq(sampler.sample(35, 30).strength, 0, 'removed source cannot survive as a cached furniture highlight');
sampler.prepare(sampleFrame);
A.ok(sampler.sample(35, 30).strength > 0, 'a newly added source replaces a previously cached dark sample');
sampler.prepare(Object.assign({}, sampleFrame, { ambient: 0.72 }));
A.eq(sampler.stats().sampleCacheSize, 0, 'per-frame exposure changes invalidate the sample state');
sampler.sample(35, 30); sampler.configure({ emission: 0.5 });
A.eq(sampler.stats().sampleCacheSize, 0, 'configuration revision immediately clears the cache');
sampler.prepare(sampleFrame);
A.ok(Math.abs(sampler.sample(35, 30).strength - firstSample.strength * 0.5) < 0.000001,
  'configured emission changes are reflected in newly prepared samples');
sampler.sample(65, 30); sampler.setGeometry(station(false));
A.eq(sampler.stats().sampleCacheSize, 0, 'geometry reset invalidates samples from the previously open doorway');
sampler.prepare(sampleFrame);
A.eq(sampler.sample(65, 30).strength, 0, 'a sealed door never reuses illumination cached through the old opening');
sampler.configure({ sampleCacheLimit: 0 }); sampler.prepare(sampleFrame); sampler.sample(35, 30);
A.eq(sampler.stats().sampleCacheSize, 0, 'cache can be disabled for comparison without changing light evaluation');
sampler.configure({ emission: 1 });sampler.prepare(sampleFrame);
const preparedCount=sampler.stats().preparations;
sampler.render(output);
A.eq(sampler.stats().preparations,preparedCount,'composite reuses sources already prepared for the depth pass');
sampler.configure({ emission: .4 });sampler.render(output);
A.eq(sampler.stats().preparations,preparedCount+1,'configuration changes still refresh a previously prepared composite');
sampler.render(output,sampleFrame);
A.eq(sampler.stats().preparations,preparedCount+2,'explicit frame refresh remains supported');
sampler.dispose();
A.eq(sampler.stats().sampleCacheSize, 0, 'dispose releases all sample descriptors');

// KEY buffer (2026-09-22): the one pass that puts light ON a surface. It must be
// absent unless asked for, composite as overlay between the dark film and the glow,
// and keep its stamps tighter than the cut that made room for it.
const keyed = Light.create({ canvasFactory }); keyed.setGeometry(station(true));
const keyFrame = { fixtures: [{ x: 30, y: 30, r: 50, rgb: '255,192,104' }], lights: [source], ambient: 0.82 };
const ops = [], keyOut = Object.assign(canvasFactory(96, 60).getContext('2d'), {
  drawImage(img) { ops.push({ op: this.globalCompositeOperation, img }); } });
keyed.render(keyOut, keyFrame);
A.eq(keyed.stats().key, false, 'the key buffer is not allocated unless configured');
A.eq(ops.filter(o => o.op === 'overlay').length, 0, 'an unkeyed station composites exactly as before');
const plainSurfaces = surfaces.length, plainStamps = keyed.stats().cachedStamps;
keyed.configure({ key: 1.5, keyReach: 0.5, shadeCool: 0.1 }); ops.length = 0;
keyed.render(keyOut, keyFrame);
A.eq(keyed.stats().key, true, 'configuring a key allocates its buffers');
A.eq(surfaces.length - plainSurfaces - (keyed.stats().cachedStamps - plainStamps), 2,
  'besides its own stamps, the key costs exactly one static and one per-frame surface');
A.eq(ops.map(o => o.op).join(','), 'source-over,overlay,screen', 'the key lands between the dark film and the glow');
A.ok(keyed.stats().cachedStamps > plainStamps, 'key stamps are cached separately from the full-radius cut stamps');
const keyCut = fills.filter(f => /^rgb\(\d+,\d+,\d+\)$/.test(String(f.style))).pop();
A.ok(keyCut && /^rgb\((\d+),(\d+),(\d+)\)$/.test(keyCut.style) && +RegExp.$1 < 128 && +RegExp.$3 > 128,
  'shadeCool leans the unlit neutral toward blue, away from red');
const steady = keyed.stats(), steadySurfaces = surfaces.length;
ops.length = 0; keyed.render(keyOut, keyFrame);
A.eq(keyed.stats().dynamicBuilds, steady.dynamicBuilds, 'a steady keyed frame reuses its composed maps');
A.eq(surfaces.length, steadySurfaces, 'a steady keyed frame allocates nothing');
keyed.configure({ key: 0, shadeCool: 0 }); ops.length = 0; keyed.render(keyOut, keyFrame);
A.eq(keyed.stats().key, false, 'switching the key off releases its buffers');
A.eq(ops.filter(o => o.op === 'overlay').length, 0, 'and the composite returns to the unkeyed path');
keyed.dispose();

// LIGHT GRID + KERNELS (2026-10-10, "slower since the new textures"): a sample walks only the sources whose reach covers
// its grid cell, and a brightness-only frame reuses each point's geometry kernel — the descriptor stays exactly lightAt's
{
  const big = (() => { const COLS = 40, ROWS = 20, zg = new Array(COLS * ROWS).fill(null);
    for (let y = 1; y <= 18; y++) for (let x = 1; x <= 38; x++) zg[y * COLS + x] = x <= 19 ? 'a' : 'b';
    return { COLS, ROWS, TILE: 12, W: 480, H: 240, zoneGrid: zg, allRects: [{ x1: 1, y1: 1, x2: 38, y2: 18 }],
      canStep: (x, y, nx, ny) => zg[y * COLS + x] === zg[ny * COLS + nx] || (y === 9 && ny === 9 && Math.abs(x - nx) === 1) }; })();
  const lightsAt = (a, nudge) => Array.from({ length: 40 }, (_, i) => ({ x: 20 + (i * 53) % 440 + (nudge && i === 3 ? 7 : 0), y: 20 + (i * 37) % 200,
    r: 18 + (i * 7) % 40, a: a * (0.3 + (i % 5) / 10), c: [255 - i * 3, 150 + i, 90 + i * 2], softness: (i % 3) * 0.6 }));
  const points = Array.from({ length: 120 }, (_, i) => [15 + (i * 41.3) % 450, 15 + (i * 23.7) % 210]);
  const view = h => JSON.stringify([h.rgb, h.strength, h.color, h.dx, h.dy, h.energy, h.coherence, h.source && [h.source.x, h.source.y, h.source.a]]);
  const segs = Light.buildSegments(big);
  const brute = (lights, x, y) => Light.lightAt(x, y, lights.map(s => Light.normalizeLight(s, false, 1)).filter(Boolean), segs);
  const warm = Light.create({ canvasFactory }); warm.setGeometry(big);
  warm.prepare({ lights: lightsAt(1) }); points.forEach(([x, y]) => warm.sample(x, y));
  warm.prepare({ lights: lightsAt(0.5) });   // brightness only: the sample cache clears, the kernels stay
  const walked = warm.stats().sampleSourcesWalked;
  const reused = points.map(([x, y]) => warm.sample(x, y));
  A.eq(warm.stats().sampleSourcesWalked, walked, 'a brightness-only frame re-samples every point without walking a source again');
  const cold = Light.create({ canvasFactory }); cold.setGeometry(big); cold.prepare({ lights: lightsAt(0.5) });
  const fresh = points.map(([x, y]) => cold.sample(x, y));
  A.ok(reused.every((h, i) => view(h) === view(fresh[i])), 'a reused kernel gives the descriptor a fresh evaluation gives');
  A.ok(fresh.every((h, i) => view(h) === view(brute(lightsAt(0.5), points[i][0], points[i][1]))), '...which is exactly lightAt over EVERY source');
  A.ok(fresh.some(h => h.strength > 0) && fresh.some(h => h.strength === 0), '(the fixture spans lit and unlit points)');
  A.ok(cold.stats().sampleSourcesWalked < points.length * 40 / 3, 'the grid walks only the sources that can reach a point');
  warm.prepare({ lights: lightsAt(0.5, true) });   // a source MOVED: geometry changed, kernels rebuild
  A.ok(points.every(([x, y]) => view(warm.sample(x, y)) === view(brute(lightsAt(0.5, true), x, y))), 'a moved source rebuilds the grid and every kernel');
  warm.dispose(); cold.dispose();
}

// GROUNDING CLIP (review world-render-04): a standing body's wall clip is cached, but it was keyed on the shadow's length, which
// moves with every flicker of a nearby screen, so the 24 wall rays were re-cast every frame anyway. The clip is keyed on the
// body's maximum reach instead (shadowFor caps length at height * 0.7): a flickering light must not rebuild a still body's clip.
{
  const ground = Light.create({ canvasFactory }); ground.setGeometry(station(true));
  const still = [{ x: 35, y: 30, width: 8, height: 20 }];
  const flick = k => ({ lights: [Object.assign({}, source, { a: 0.5 + 0.05 * k, softness: 2 }),
    { x: 70, y: 28, r: 40, a: 0.9 - 0.08 * k, c: [90, 170, 255], softness: 1, originX: 66, originY: 24 }] });
  const lengths = new Set();
  for (let k = 0; k < 6; k++) {
    ground.prepare(flick(k));
    lengths.add(Light.shadowFor(still[0], [], [], ground.sample(35, 30)).length.toFixed(6));
    ground.drawGrounding(output, still);
  }
  A.ok(lengths.size > 1, '(the flicker really moves the shadow length)');
  A.eq(ground.stats().groundClipBuilds, 1, 'a still body casts its wall clip once while a nearby light flickers');
  ground.drawGrounding(output, [{ x: 36, y: 30, width: 8, height: 20 }]);
  A.eq(ground.stats().groundClipBuilds, 2, 'a body that moved gets a fresh clip');
  ground.setGeometry(station(false)); ground.prepare(flick(0)); ground.drawGrounding(output, still);
  A.eq(ground.stats().groundClipBuilds, 3, 'a new wall set rebuilds the clip (a sealed door is respected)');
  ground.dispose();
}

// NUMERIC LIGHT KEYS (2026-10-20, "eats my PC's resources"): the map keys rounded alpha to a byte, so a working screen's
// ±1.5% flicker crossed byte boundaries and re-blitted the station-sized maps several times a second. The maps now hold a
// 1.5-LSB band around the alpha they were built with; geometry, count and config still rebuild the same frame, and the
// sample key still follows every exact alpha.
{
  const lit = Light.create({ canvasFactory }); lit.setGeometry(station(true));
  const screens = Array.from({ length: 20 }, (_, i) => ({ x: 14 + (i % 10) * 7, y: 18 + Math.floor(i / 10) * 20, r: 26, c: [98, 255, 158], base: 0.16, seed: i * 0.7 }));
  const screenK = (now, s) => 0.985 + 0.01 * Math.sin(now / 900 + s) + 0.005 * Math.sin(now / 2400 + s * 1.7);   // propsprites' 'screen' flicker
  const at = (now, extra) => ({ fixtures: [{ x: 30, y: 30, r: 50, rgb: '255,192,104' }],
    lights: screens.map(s => ({ x: s.x, y: s.y, r: s.r, c: s.c, a: s.base * screenK(now, s.seed) })).concat(extra || []) });
  lit.render(output, at(0));
  const b0 = lit.stats(), bytes = new Set();
  let exactChanges = 0;
  for (let f = 1; f <= 600; f++) {
    const frame = at(f * 16.67), inv = lit.stats().sampleCacheInvalidations;
    frame.lights.forEach(l => bytes.add(Math.round(l.a * 255)));
    lit.render(output, frame);
    if (lit.stats().sampleCacheInvalidations > inv) exactChanges++;
  }
  A.ok(bytes.size > 1, '(setup: the flicker really crosses byte boundaries, which the old byte key rebuilt on)');
  A.eq(lit.stats().dynamicBuilds, b0.dynamicBuilds, '600 frames of screen flicker never rebuild the composed prop map');
  A.eq(lit.stats().staticBuilds, b0.staticBuilds, '...nor the static fixture map');
  A.eq(exactChanges, 600, 'the sample cache still follows every exact alpha change');
  const steady = at(600 * 16.67);
  lit.render(output, steady); const s1 = lit.stats();
  steady.lights[3] = Object.assign({}, steady.lights[3], { a: steady.lights[3].a + 3 / 255 });
  lit.render(output, steady);
  A.eq(lit.stats().dynamicBuilds, s1.dynamicBuilds + 1, 'a 3/255 step (a light switching state) rebuilds that very frame');
  lit.render(output, steady);
  A.eq(lit.stats().dynamicBuilds, s1.dynamicBuilds + 1, '...exactly once');
  const extra = { x: 70, y: 30, r: 20, c: [255, 120, 200], a: 0.12 };
  for (const [what, next] of [['adding a light', at(600 * 16.67, [extra])], ['moving a light', at(600 * 16.67, [Object.assign({}, extra, { x: 71 })])],
    ['recolouring a light', at(600 * 16.67, [Object.assign({}, extra, { x: 71, c: [255, 120, 210] })])],
    ['a new planar origin', at(600 * 16.67, [Object.assign({}, extra, { x: 71, c: [255, 120, 210], originX: 72 })])], ['removing a light', at(600 * 16.67)]]) {
    const before = lit.stats().dynamicBuilds; lit.render(output, next);
    A.eq(lit.stats().dynamicBuilds, before + 1, what + ' rebuilds the prop map the same frame');
  }
  const base = at(600 * 16.67), ramp = [];
  for (let i = 1; i <= 30; i++) {   // a slow fade, 0.6/255 a frame: the map follows it in steps of under 1.5/255
    const before = lit.stats().dynamicBuilds, frame = at(600 * 16.67);
    frame.lights[0] = Object.assign({}, base.lights[0], { a: base.lights[0].a + i * 0.6 / 255 });
    lit.render(output, frame); ramp.push(lit.stats().dynamicBuilds - before);
  }
  A.eq(ramp.join(''), '001'.repeat(10), 'a fade rebuilds every third 0.6-LSB step: the map never lags 1.5 LSB behind the light');
  const lift = lit.stats().dynamicBuilds; lit.configure({ propLift: 0.5 }); lit.render(output, base);
  A.eq(lit.stats().dynamicBuilds, lift + 1, 'a prop config change rebuilds the prop map');
  const st0 = lit.stats().staticBuilds; lit.render(output, Object.assign({}, base, { ambient: 0.72 }));
  A.eq(lit.stats().staticBuilds, st0 + 1, 'an exposure change from prepare() rebuilds the static map (it never bumps configRevision)');
  const fx = lit.stats().staticBuilds; lit.render(output, Object.assign({}, base, { ambient: 0.72, fixtures: [{ x: 30, y: 30, r: 50, rgb: '255,192,104', gain: 0.5 }] }));
  A.eq(lit.stats().staticBuilds, fx + 1, 'a fixture dimmed past the band rebuilds the static map');
  lit.dispose();
}

A.report('WorldLight spatial illumination');
