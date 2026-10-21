/* sidecar/maps/community.js — the station's side of the community maps gallery (2026-10-18).

   READ: the gallery index on starnetos.com is fetched through the Skill Market's SSRF-guarded document fetcher and
   believed only when its detached Ed25519 signature verifies with a key the app trusts (sidecar/skills/market-
   signing.js) and its serial is not lower than one this station has ever read (kept on disk, like the Skill
   Market's, so a replayed older gallery is refused after a restart too). A map's build file and picture are
   believed only when they hash to the sha256 the signed index pins. The page then builds a map through BuildShare.
   readBuild (layout only) and the presets' own confirm, backup and undo; nothing here touches the floor.

   SHARE: build mode hands over a cleaned build (BuildShare.exportBuild) and a still of the station; a skill card
   hands over one of the agent's skills. This forwards them to the linked StarNet account (starnet-cloud POST
   /v1/maps/submit or /v1/skills/submit, the device token) and reports what happened as exactly as it is known:
     ok          the cloud took it (the submission it returned)
     refused     the cloud answered no (its sentence; nothing was stored)
     unknown     no readable answer (a timeout, a dropped connection): it may have arrived, so the page must say
                 to check before sending again — never "nothing was shared"
   An unlinked station is told to link; a linked station whose link the cloud no longer accepts is told THAT.

   Pure factory (lint-determinism): every IO is injected. index.js composes it.

   makeCommunityMaps({ fetchDocument, signing, trustedKeys, catalogUrl: () => url|'', cloud: () => ({ url, token }),
                       fetch, now, loadState?: () => obj|null, saveState?: (obj) => void })
     -> { catalog({ refresh }), file(slug, version, which), share(body), mine(), shareSkill(body), linked() } */
'use strict';

const fmt = require('./maps-format.js');
const { note } = require('../failopen.js');   // a swallowed error stays visible (tagged warn + counter)

const INDEX_MAX = 2 * 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;
const SHARE_TIMEOUT_MS = 60000;
const MINE_TIMEOUT_MS = 15000;
const SKILL_REFS_MAX = 5;   // what the market accepts (starnet-cloud src/skillsubs.js LIMITS.refFiles)
// the guarded fetcher ends a body that goes silent (no bytes for its request timeout) and caps each whole read, every
// redirect hop included, at its own 60 s; every gallery read races this shorter deadline on top, so the page answers at
// 45 s and the fetcher still closes the abandoned read at its 60 s
const READ_DEADLINE_MS = 45000;

function makeCommunityMaps(deps) {
  const { fetchDocument, signing, trustedKeys, catalogUrl, cloud, fetch, now } = deps;
  const loadState = deps.loadState || (() => null);
  const saveState = deps.saveState || (() => {});
  let cached = null, cachedAt = 0, inflight = null;
  const seen = (() => { const s = loadState(); return s && typeof s.serials === 'object' && s.serials ? Object.assign({}, s.serials) : {}; })();

  function withDeadline(p, what) {
    let timer;
    return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' took too long to download')), READ_DEADLINE_MS); })]).finally(() => clearTimeout(timer));
  }
  function indexUrl() { return String((catalogUrl && catalogUrl()) || '').trim(); }
  function fileUrl(base, path) { return new URL('/' + String(path).replace(/^\/+/, ''), base).href; }

  async function readIndex(url) {
    const [doc, sig] = await withDeadline(Promise.all([
      fetchDocument(url, { maxBytes: INDEX_MAX, label: 'the community gallery' }),
      fetchDocument(signing.sigUrl(url), { maxBytes: 8192, label: 'the gallery signature' })
    ]), 'the community gallery');
    signing.verify(doc.bytes, sig.text, trustedKeys);   // throws a sentence on a forged or unsigned gallery
    let parsed;
    try { parsed = JSON.parse(doc.text); } catch (_) { throw new Error('the community gallery is not readable'); }
    const out = fmt.readCatalog(parsed);
    // a signed but OLDER gallery (a replayed copy, a stale cache) is refused: this station has read a newer one
    const highest = Number(seen[url]) || 0;
    if (out.serial < highest) throw new Error('the community gallery is older than one this station already read');
    if (out.serial > highest) { seen[url] = out.serial; try { saveState({ serials: seen }); } catch (e) { note('community-maps.serial-save', e); } }   // a failed save: the in-memory floor still holds
    return { ok: true, serial: out.serial, maps: out.maps, base: url };
  }
  async function catalog(opts) {
    const url = indexUrl();
    if (!url) return { ok: false, off: true, error: 'The community gallery is switched off on this station.' };
    if (cached && cached.base === url && !(opts && opts.refresh) && now() - cachedAt < CACHE_MS) return cached;
    // one read at a time: every card and every caller waits on the same fetch
    if (!inflight) inflight = readIndex(url).then(c => { cached = c; cachedAt = now(); return c; }).finally(() => { inflight = null; });
    return inflight;
  }

  /* file(slug, version, 'build'|'still') -> { bytes, type } — only the exact bytes the signed index pins */
  async function file(slug, version, which) {
    const c = await catalog({});
    if (!c.ok) throw new Error(c.error);
    const entry = c.maps.find(m => m.slug === String(slug) && m.version === Number(version));
    if (!entry) throw new Error('That map is not in the community gallery.');
    const f = which === 'still' ? entry.still : entry.build;
    const label = which === 'still' ? 'the map picture' : 'the map';
    const got = await withDeadline(fetchDocument(fileUrl(c.base, f.path), { maxBytes: which === 'still' ? fmt.MAX_STILL_BYTES : fmt.MAX_BUILD_BYTES, label }), label);
    if (fmt.sha256hex(got.bytes) !== f.sha256) throw new Error(which === 'still' ? 'The map picture does not match the gallery.' : 'The map file does not match the gallery, so it was not opened.');
    return { bytes: got.bytes, type: which === 'still' ? 'image/png' : 'application/json' };
  }

  function linked() {
    const c = (cloud && cloud()) || {};
    return c.url && c.token ? { url: String(c.url).replace(/\/+$/, ''), token: String(c.token) } : null;
  }
  async function call(method, path, body, timeoutMs, what) {
    const c = linked();
    if (!c) return { ok: false, outcome: 'refused', status: 401, linked: false, error: 'Link this station to a StarNet account to share ' + what + '.' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text = '';
    try {
      res = await fetch(c.url + path, {
        method, signal: ctrl.signal,
        headers: Object.assign({ authorization: 'Bearer ' + c.token }, body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      text = await res.text();
    } catch (e) {
      // the request may have reached StarNet before the answer was lost: nobody here knows, so say so
      return { ok: false, outcome: 'unknown', status: 0, linked: true, error: ctrl.signal.aborted ? 'StarNet did not answer in time.' : 'The connection to StarNet dropped.' };
    } finally { clearTimeout(timer); }
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    if (res.ok && json && json.ok) return Object.assign({ ok: true, outcome: 'ok', status: res.status, linked: true }, json);
    if (res.ok || res.status >= 500 && !json) return { ok: false, outcome: 'unknown', status: res.status, linked: true, error: 'StarNet gave no readable answer.' };
    if (res.status === 401) return { ok: false, outcome: 'refused', status: 401, linked: true, code: 'token_rejected', error: 'StarNet no longer accepts this station\'s link. Link it again in STORE › LINK STATION.' };
    const msg = json && json.error && (json.error.message || json.error);
    return { ok: false, outcome: 'refused', status: res.status, linked: true, code: json && json.error && json.error.code, error: typeof msg === 'string' && msg ? msg : 'StarNet refused it (HTTP ' + res.status + ').' };
  }

  /* share({ title, description, credit, agree, build, still }) -> the outcome above */
  async function share(b) {
    const body = {
      title: String(b && b.title || ''), description: String(b && b.description || ''), credit: String(b && b.credit || ''),
      agree: !!(b && b.agree === true), build: String(b && b.build || ''), still: String(b && b.still || '')
    };
    return call('POST', '/v1/maps/submit', body, SHARE_TIMEOUT_MS, 'maps');
  }
  function mine() { return call('GET', '/v1/maps/mine', null, MINE_TIMEOUT_MS, 'maps'); }

  /* shareSkill({ title, description, category, license, credit, agree, skillText, refs }) — SHARE TO MARKET on a skill
     card: the same linked-account door, starnet-cloud POST /v1/skills/submit (the upload form's rules, unchanged) */
  async function shareSkill(b) {
    const refs = Array.isArray(b && b.refs) ? b.refs.slice(0, SKILL_REFS_MAX).map(r => ({ name: String(r && r.name || ''), content: String(r && r.content || '') })) : [];
    const body = {
      title: String(b && b.title || ''), description: String(b && b.description || ''), category: String(b && b.category || ''),
      license: String(b && b.license || ''), credit: String(b && b.credit || ''), agree: !!(b && b.agree === true),
      skillText: String(b && b.skillText || ''), refs
    };
    return call('POST', '/v1/skills/submit', body, SHARE_TIMEOUT_MS, 'skills');
  }

  return { catalog, file, share, mine, shareSkill, linked: () => !!linked(), SKILL_REFS_MAX };
}

module.exports = { makeCommunityMaps };
