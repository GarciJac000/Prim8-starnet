/* COMMUNITY MAPS (2026-10-18) — the page's side of the community gallery. Build mode's Presets sheet uses it for two
   things, and owns all of the layout around them (build.js):

   SHARE: the station's LAYOUT (BuildShare.exportBuild: no crew, step instructions, folders, connections or made
   props) and a picture of it go to the linked StarNet account for a person to review. The picture is the station
   itself (World.renderStill, layout only: no crew and none of this station's live work on the belts or desks) when
   that is exactly what the build carries; when it is not — made props the build leaves behind, or no station picture
   to be had right now — it is the floor plan drawn from the cleaned build, so the gallery never shows anything an
   importer would not get. What the page says next follows the outcome the sidecar reports (ok / refused / unknown).

   READ: the sidecar fetches the signed gallery index and every file it pins (sidecar/maps/community.js); this page
   only ever builds a map through BuildShare.readBuild and the presets' own confirm, backup and undo. Pictures load
   when their card scrolls into view, a few at a time, and are let go when the sheet closes.

     CommunityMaps.load(refresh)      -> { ok, maps, linked, error }
     CommunityMaps.stillUrl(map)      -> object URL of the map's picture (queued, cached until release())
     CommunityMaps.release()          -> forget every picture (revokes their object URLs)
     CommunityMaps.buildText(map)     -> the map's build file text
     CommunityMaps.picture(cleanDoc, dropped, drawPlan) -> { dataUrl, kind: 'station'|'plan', why }
     CommunityMaps.share(fields)      -> { ok, outcome: 'ok'|'refused'|'unknown', status, linked, code?, submission?, error? }
     CommunityMaps.live               -> COMMUNITY_LIVE, below */
'use strict';
const CommunityMaps = (() => {
  /* COMMUNITY_LIVE — is community sharing open in this app? THE ONE SWITCH for every in-app door to the community
     cloud: build mode's COMMUNITY MAPS gallery and SHARE TO COMMUNITY (build.js, Presets › SHARED BUILDS) and the
     skill card's Share to market (stationui.js, ABILITIES › AGENT SKILLS). While it is false those three are not in
     the page at all (never a disabled key with a tip), and the page never asks for the gallery. The website holds its own side
     back the same way (website/site.js COMMUNITY_LIVE); its maps page needs an app release that carries SHARE TO
     COMMUNITY, so this one flips first, in a release, once the cloud's share endpoints answer. */
  const COMMUNITY_LIVE = false;
  const api = (url, init) => (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(url, init) : fetch(url, init);
  const STILL_PX = 1280, STILL_SMALL_PX = 960, MAX_DATA_URL = 2.8 * 1024 * 1024 * 4 / 3;
  const PICTURES_AT_ONCE = 3;
  const UNREACHABLE = 'The station is not answering right now.';
  let stills = new Map(), active = 0, generation = 0;
  const waiting = [];

  async function load(refresh) {
    try {
      const r = await api('/api/community-maps' + (refresh ? '?refresh=1' : ''));
      const j = await r.json();
      return j && typeof j === 'object' ? j : { ok: false, error: 'The community gallery answered nothing readable.' };
    } catch (_) { return { ok: false, error: UNREACHABLE }; }
  }
  const fileUrl = (m, which) => '/api/community-maps/file?slug=' + encodeURIComponent(m.slug) + '&v=' + encodeURIComponent(m.version) + '&which=' + which;
  function pump() {
    while (active < PICTURES_AT_ONCE && waiting.length) {
      const job = waiting.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
  }
  function stillUrl(m) {
    const key = m.slug + '@' + m.version;
    if (stills.has(key)) return stills.get(key);
    const gen = generation;
    const p = new Promise((resolve, reject) => {
      waiting.push(async () => {
        try {
          const r = await api(fileUrl(m, 'still'));
          if (!r.ok) throw new Error('no picture');
          const url = URL.createObjectURL(await r.blob());
          if (gen !== generation) { URL.revokeObjectURL(url); throw new Error('released'); }   // the sheet closed meanwhile
          resolve(url);
        } catch (e) { reject(e); }
      });
      pump();
    });
    stills.set(key, p);
    p.catch(() => { if (stills.get(key) === p) stills.delete(key); });
    return p;
  }
  function release() {
    generation++;
    waiting.length = 0;
    const old = stills; stills = new Map();
    for (const p of old.values()) p.then(url => URL.revokeObjectURL(url), () => {});
  }
  async function buildText(m) {
    let r;
    try { r = await api(fileUrl(m, 'build')); } catch (_) { throw new Error(UNREACHABLE + ' The map was not opened.'); }
    if (!r.ok) {
      let msg = 'That map could not be opened.';
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return r.text();
  }

  /* THE STATION, NOT THE VOID AROUND IT: renderStill frames the whole floor's bounds on a flat fill, so a cross- or
     L-shaped station sits in a lot of empty dark. Crop to the pixels that differ from the corner fill, with a small
     margin, so a gallery card shows the station at a useful size. Reads only the still's OWN offscreen canvas (never
     the stage the frame loop draws). A still with nothing to trim comes back as it was. */
  function trimmed(canvas) {
    const w = canvas.width, h = canvas.height;
    let px;
    try { px = canvas.getContext('2d').getImageData(0, 0, w, h).data; } catch (_) { return canvas; }
    const r0 = px[0], g0 = px[1], b0 = px[2], near = (i) => Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) < 18;
    let x1 = w, y1 = h, x2 = -1, y2 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (near((y * w + x) * 4)) continue;
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
    if (x2 < 0) return canvas;
    const pad = Math.max(12, Math.round(Math.max(w, h) * 0.02));
    x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(w - 1, x2 + pad); y2 = Math.min(h - 1, y2 + pad);
    // never smaller than the gallery accepts (the cloud refuses a picture under 160 px): grow round the centre instead
    const grow = (a, b, min, limit) => { const need = Math.min(limit, min) - (b - a + 1); if (need <= 0) return [a, b]; a = Math.max(0, a - Math.ceil(need / 2)); b = Math.min(limit - 1, a + Math.min(limit, min) - 1); return [Math.max(0, b - Math.min(limit, min) + 1), b]; };
    [x1, x2] = grow(x1, x2, 480, w); [y1, y2] = grow(y1, y2, 300, h);
    const cw = x2 - x1 + 1, ch = y2 - y1 + 1;
    if (cw >= w * 0.95 && ch >= h * 0.95) return canvas;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, x1, y1, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /* the picture that goes with a share. drawPlan(ctx, doc, w, h) is build.js's floor-plan drawing (the preset cards'). */
  function picture(cleanDoc, dropped, drawPlan) {
    const madeLeftOut = dropped && dropped.made > 0;
    let tooBig = false;
    if (!madeLeftOut && typeof World !== 'undefined' && typeof World.renderStill === 'function') {
      for (const px of [STILL_PX, STILL_SMALL_PX]) {
        let still = null;
        try { still = World.renderStill(px, { noBodies: true, layoutOnly: true }); } catch (_) { still = null; }
        if (!still || !still.canvas) break;
        const dataUrl = trimmed(still.canvas).toDataURL('image/png');
        if (dataUrl.length <= MAX_DATA_URL) return { dataUrl, kind: 'station', why: '' };
        tooBig = true;
      }
    }
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 730;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0b0d0e'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save(); ctx.scale(cv.width / 230, cv.height / 140); drawPlan(ctx, cleanDoc, 230, 140); ctx.restore();
    return {
      dataUrl: cv.toDataURL('image/png'), kind: 'plan',
      why: madeLeftOut ? 'Its picture is the floor plan: your made props stay home, so a picture of the station would show furniture others will not get.'
        : tooBig ? 'Its picture is the floor plan: a picture of this station is too large to send.'
        : 'Its picture is the floor plan, because a picture of the station was not available just now. Unsaved build changes are the usual reason: SAVE & EXIT, then share again for a picture of the station itself.'
    };
  }

  async function share(fields) {
    try {
      const r = await api('/api/community-maps/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
      let j = null;
      try { j = await r.json(); } catch (_) { j = null; }
      return j && typeof j === 'object' ? j : { ok: false, outcome: 'unknown', status: r.status, error: 'The share got no readable answer.' };
    } catch (_) { return { ok: false, outcome: 'unknown', status: 0, error: UNREACHABLE }; }
  }

  return { live: COMMUNITY_LIVE, load, stillUrl, release, buildText, picture, share };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CommunityMaps;
