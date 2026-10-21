/* node test/camera-settle.test.js — CAMERA SETTLE (perf, 2026-10-20: "it eats my PC's resources").

   The follow-lock (session select and the idle cinecam, which owns the camera after 2 min hands-off) eased
   scale/panX/panY geometrically with no snap. In float64 that reaches its target exactly only after ~400 frames
   (6.6 s per cine shot; a pan target near 0 took 150 s), and every cache keyed on the camera — the belt atlas
   (conveyor zoomSame), the prop shadow layer stamp — was dropped and rebuilt on every one of those frames. On a
   walking subject the pan never settles, so a joint snap (camLerp's rule: scale AND pan settled) never fires and
   the zoom crept for the whole shot. The fix snaps EACH axis on its own once its remaining motion is under
   CAM_SETTLE_PX device pixels — invisible, and the zoom lands in ~1.5 s.

   This lifts the real FOLLOW-LOCK + camLerp block out of world.js and runs it frame by frame. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const from = world.indexOf('    if (camLock && !camAnim) {   // FOLLOW-LOCK');
const to = world.indexOf('    /* THE BACKDROP — what the station floats in');
A.ok(from > 0 && to > from && to - from < 4000, 'world.js carries the FOLLOW-LOCK + camLerp settle block right before THE BACKDROP');
const block = world.slice(from, to);

// the settle threshold is one named constant next to the cinecam's own (a quarter device pixel)
const constM = /\n  const CAM_SETTLE_PX = ([0-9.]+);/.exec(world);
A.ok(constM && +constM[1] === 0.25, 'CAM_SETTLE_PX is declared at module scope as 0.25 device px');
const SETTLE = constM ? +constM[1] : 0.25;

// what must NOT move: hudmode.test pins the seated-framing line, and camLerp keeps its own joint snap
A.ok(block.includes('const fy = (camLock.seatAt && (lb.seated || lb.sitting)) ? camLock.seatAt : 0.56;'), 'the hudmode-pinned `const fy` line is byte-identical');
A.ok(block.includes('      if (Math.abs(camLerp.scale - scale) < 0.01 && Math.abs(camLerp.panX - panX) < 1 && Math.abs(camLerp.panY - panY) < 1) {\n' +
  '        scale = camLerp.scale; panX = camLerp.panX; panY = camLerp.panY; camLerp = null;'), 'camLerp keeps its own settle rule untouched');

const easeSrc = A.fnBody(world, '  function easeK(k60, dt)');
const posM = /\n  const bodyPosX = [^\n]*\n/.exec(world), posYM = /\n  const bodyPosY = [^\n]*\n/.exec(world);
A.ok(easeSrc && posM && posYM, 'easeK and bodyPosX/Y are lifted from world.js');

// one camera: the lifted block with the module state it reads as closure variables
function makeCamera(withSnap) {
  const src = withSnap ? block : block.replace(/\n        const reach = [\s\S]*?panY = ly;/, '');
  A.ok(withSnap || src !== block, 'the control camera strips exactly the settle lines');
  // eslint-disable-next-line no-new-func
  return new Function('SETTLE', [
    'let scale = 2.0, panX = -1500, panY = -900, camLock = null, camLerp = null, camAnim = null, body = null;',
    'const cv = { width: 1920, height: 1080 }, CAM_SETTLE_PX = SETTLE;',
    'const bodyForAgent = () => body;',
    easeSrc, posM[0], posYM[0],
    'return {',
    '  reset(b, ts) { scale = 2.0; panX = -1500; panY = -900; body = b; camLock = { id: "a", sc: ts, source: "cine" }; },',
    '  step(dt) {', src, '  },',
    '  get: () => [scale, panX, panY],',
    '  target: () => [camLock.sc, cv.width / 2 - bodyPosX(body) * camLock.sc, cv.height * 0.56 - bodyPosY(body) * camLock.sc]',
    '};'
  ].join('\n'))(SETTLE);
}

function run(walk, withSnap, at) {
  const cam = makeCamera(withSnap), raw = makeCamera(false);
  const b = Object.assign({ px: 380, py: 300 }, at), rb = Object.assign({}, b);
  cam.reset(b, 2.4); raw.reset(rb, 2.4);
  let lastZoom = 0, lastAny = 0, prev = cam.get(), maxOff = { s: 0, x: 0, y: 0, screen: 0 };
  for (let i = 1; i <= 900; i++) {
    if (walk) { b.px += 0.5; rb.px += 0.5; }
    cam.step(1000 / 60); raw.step(1000 / 60);
    const cur = cam.get(), ref = raw.get();
    if (cur[0] !== prev[0]) lastZoom = i;
    if (cur.some((v, j) => v !== prev[j])) lastAny = i;
    /* how far the snapped camera ever stands from the un-snapped ease, in device px, measured on the pixels actually on
       screen: a screen point sx shows world (sx - pan) / scale, which the plain ease would put at world * refScale +
       refPan. The zoom part alone ((sx - pan) * Δscale / scale) and each pan are held under CAM_SETTLE_PX; the whole
       offset (both may land in one frame) under twice that. Affine in sx, so the screen corners bound it. */
    for (const [sx, sy] of [[0, 0], [1920, 0], [0, 1080], [1920, 1080]]) {
      maxOff.s = Math.max(maxOff.s, Math.abs((sx - cur[1]) * (ref[0] - cur[0]) / cur[0]), Math.abs((sy - cur[2]) * (ref[0] - cur[0]) / cur[0]));
      const wx = (sx - cur[1]) / cur[0], wy = (sy - cur[2]) / cur[0];
      maxOff.screen = Math.max(maxOff.screen, Math.abs(wx * ref[0] + ref[1] - sx), Math.abs(wy * ref[0] + ref[2] - sy));
    }
    maxOff.x = Math.max(maxOff.x, Math.abs(cur[1] - ref[1]));
    maxOff.y = Math.max(maxOff.y, Math.abs(cur[2] - ref[2]));
    prev = cur;
  }
  return { lastZoom, lastAny, end: cam.get(), target: cam.target(), maxOff };
}

const still = run(false, true), walking = run(true, true);
// a subject far from the world origin: the origin sits thousands of px off screen, so the zoom's own reach is the screen
// edge farthest from it (the case a fixed screen-size bound would under-measure by ~3x)
const far = run(false, true, { px: 2600, py: 1900 }), farWalk = run(true, true, { px: 2600, py: 1900 });
console.log('  still subject: camera changes until frame ' + still.lastAny + ' · walking subject: zoom changes until frame ' + walking.lastZoom);
A.ok(still.lastAny > 0 && still.lastAny <= 120, 'a still subject: the camera stops changing within 2 s at 60 Hz (got frame ' + still.lastAny + ')');
A.ok(walking.lastZoom > 0 && walking.lastZoom <= 120, 'a walking subject: its ZOOM still lands within 2 s although the pan keeps following (got frame ' + walking.lastZoom + ')');
A.ok(walking.lastAny === 900, '…and the pan keeps trailing the walking body every frame (no freeze)');
A.ok(still.end[0] === still.target[0] && still.end[1] === still.target[1] && still.end[2] === still.target[2], 'settled means EXACTLY on target (bit-identical), so every camera-keyed cache can hold');
A.ok(walking.end[0] === walking.target[0], 'the walking shot lands its zoom exactly too');
A.ok(far.lastAny > 0 && far.lastAny <= 150 && farWalk.lastZoom > 0 && farWalk.lastZoom <= 150, 'a subject far from the world origin settles too (' + far.lastAny + ' / ' + farWalk.lastZoom + ')');
A.ok(far.end[0] === far.target[0] && far.end[1] === far.target[1] && far.end[2] === far.target[2], '…exactly on target');
for (const r of [still, walking, far, farWalk]) {
  A.ok(r.maxOff.s < SETTLE + 1e-9 && r.maxOff.x < SETTLE + 1e-9 && r.maxOff.y < SETTLE + 1e-9 && r.maxOff.screen < 2 * SETTLE + 1e-9,
    'no on-screen pixel ever stands more than a quarter device px (per axis) from where the plain ease puts it (' + JSON.stringify(r.maxOff) + ')');
}
// the regression this locks: without the per-axis snap the same shots creep for ~400 frames
const noSnap = run(false, false), noSnapWalk = run(true, false);
A.ok(noSnap.lastAny > 300 && noSnapWalk.lastZoom > 300, 'control: the plain ease creeps for hundreds of frames (' + noSnap.lastAny + ' / ' + noSnapWalk.lastZoom + ')');

A.report('camera-settle');
