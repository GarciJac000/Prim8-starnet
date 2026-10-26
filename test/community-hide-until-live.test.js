/* node test/community-hide-until-live.test.js — COMMUNITY SHARING STAYS OUT OF THE APP UNTIL THE CLOUD IS LIVE (2026-10-21).

   One switch, COMMUNITY_LIVE in frontend/app/communitymaps.js (read as CommunityMaps.live), holds back every in-app
   door to the community cloud, the way website/site.js COMMUNITY_LIVE holds back the website's: build mode's COMMUNITY
   MAPS gallery, its SHARE TO COMMUNITY key, and the skill card's Share to market. Hidden means ABSENT: no element, no
   disabled key with a tip, and no request for the gallery. Switched on, all three are back and open what they open.

   Driven through the real render path: build.js's own showStationBuilds (with its wireSharedBuilds, wireCommunityMaps
   and openShareToCommunity) and stationui.js's own loadAgentSkills, renderAgentSkills and shareSkillToMarket run in a
   VM beside the real communitymaps.js, on a small real HTML tree (the markup is parsed and the page's own selectors
   are matched against it), with a real WorldModel station and the real presets. The switch is set by rewriting its
   one line, the way a go-live flip would: once as shipped, once off, once on. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fnBody } = require('./_fnbody.js');
const M = require('../frontend/app/worldmodel.js');
const Sprites = require('../frontend/app/propsprites.js');
const T = require('../frontend/app/stationtemplates.js');
const B = require('../frontend/app/buildshare.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CM_SRC = read('frontend/app/communitymaps.js'), BUILD_SRC = read('frontend/app/build.js'), UI_SRC = read('frontend/app/stationui.js');
M.setPropRules(t => { const s = Sprites.spec(t); return s ? { mount: s.mount || null, stack: !!s.stack, surface: !!s.surface, flat: !!s.flat } : null; });

/* ---- a small real HTML tree: markup is parsed into elements, selectors are matched against them ---- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const dataAttr = k => 'data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
class TextNode { constructor(t) { this.nodeType = 3; this.data = t; this.parentNode = null; } get textContent() { return this.data; } }
class El {
  constructor(tag, doc) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.ownerDocument = doc; this.listeners = {}; this.style = { setProperty() {} }; this.value = ''; this.checked = false; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
    return { contains: c => list().includes(c), add: (...c) => { el.className = [...new Set(list().concat(c))].join(' '); },
      remove: (...c) => { el.className = list().filter(x => !c.includes(x)).join(' '); },
      toggle: (c, force) => { const on = force === undefined ? !list().includes(c) : !!force; if (on) el.classList.add(c); else el.classList.remove(c); return on; } };
  }
  get dataset() { const el = this; return new Proxy({}, { get: (_, k) => { const v = el.getAttribute(dataAttr(k)); return v === null ? undefined : v; }, set: (_, k, v) => { el.setAttribute(dataAttr(k), v); return true; } }); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(t) { this.childNodes.forEach(n => { n.parentNode = null; }); this.childNodes = []; if (t != null && t !== '') this.appendChild(new TextNode(String(t))); }
  set innerHTML(html) { this.childNodes.forEach(n => { n.parentNode = null; }); this.childNodes = []; parseInto(this, String(html)); }
  get innerHTML() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : '<' + n.tagName.toLowerCase() + '>' + n.innerHTML + '</' + n.tagName.toLowerCase() + '>').join(''); }
  appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); if (n.parentNode) n.remove(); n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); return n; }
  prepend(n) { return this.insertBefore(n, this.childNodes[0] || null); }
  before(n) { this.parentNode.insertBefore(n, this); }
  remove() { const p = this.parentNode; if (!p) return; p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  focus() {} select() {} scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  getContext() { return ctx2d(); }
  toDataURL() { return 'data:image/png;base64,AAAA'; }
  querySelectorAll(sel) { const out = []; const walk = el => { for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
}
function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  let cur = parent, m;
  while ((m = re.exec(html))) {
    if (m[1]) { let n = cur; while (n !== parent && n.tagName !== m[1].toUpperCase()) n = n.parentNode; if (n !== parent) cur = n.parentNode; continue; }
    if (m[2]) {
      const el = new El(m[2], doc), ar = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a; while ((a = ar.exec(m[3]))) el.setAttribute(a[1], decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : ''));
      cur.appendChild(el);
      if (!VOID.has(el.tagName.toLowerCase()) && !m[4]) cur = el;
      continue;
    }
    if (m[5] || m[6]) cur.appendChild(new TextNode(decode(m[5] || m[6])));
  }
}
function matchesOne(el, compound) {
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m, seen = 0;
  while ((m = re.exec(compound))) {
    seen += m[0].length;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !el.classList.contains(m[3])) return false;
    if (m[4] && (!el.hasAttribute(m[4]) || (m[5] != null && el.getAttribute(m[4]) !== m[5]))) return false;
  }
  if (seen !== compound.length) throw new Error('the test DOM cannot read the selector "' + compound + '"');
  return true;
}
function matches(el, sel) {
  const parts = sel.trim().match(/(?:[^\s"[]+|\[[^\]]*\])+/g);
  if (!matchesOne(el, parts[parts.length - 1])) return false;
  let n = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (n && n.nodeType === 1 && !matchesOne(n, parts[i])) n = n.parentNode;
    if (!n || n.nodeType !== 1) return false;
    n = n.parentNode;
  }
  return true;
}
function makeDocument() {
  const doc = { createElement: tag => new El(tag, doc) };
  doc.documentElement = new El('html', doc);
  doc.body = doc.documentElement.appendChild(new El('body', doc));
  doc.querySelector = s => doc.documentElement.querySelector(s);
  doc.querySelectorAll = s => doc.documentElement.querySelectorAll(s);
  return doc;
}
// a click as the page's handlers see it (onclick and listeners); resolves when their async work has settled
const press = el => Promise.all([typeof el.onclick === 'function' ? el.onclick({ target: el, preventDefault() {} }) : null]
  .concat((el.listeners.click || []).map(fn => fn({ target: el, preventDefault() {} }))));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const texts = (el, sel) => el.querySelectorAll(sel).map(x => x.textContent.trim());

/* ---- the real code, cut at seams that exist with and without the switch ---- */
const between = (src, start, end, file) => {
  const i = src.indexOf(start), j = src.indexOf(end, i + 1);
  if (i < 0 || j < 0) throw new Error(file + ' seam moved: ' + start + ' … ' + end);
  return src.slice(i, j) + '\n';
};
const fn = (src, header, file) => {
  const b = fnBody(src, header);
  // fnBody does not parse regex literals: a body that ran long would hide a mis-scan, so bound it
  if (!b || !b.endsWith('}') || b.length > 20000) throw new Error(file + ': ' + header + ' not found whole');
  return b + '\n';
};
const line = (src, re, file) => { const m = src.match(re); if (!m) throw new Error(file + ' line moved: ' + re); return m[0] + '\n'; };
const BUILD_CODE = between(BUILD_SRC, '  const PRESET_GROUPS = [', '  /* SHARED BUILDS (community builds phase 1', 'build.js')   // presets, (communityLive), showStationBuilds
  + fn(BUILD_SRC, '  function drawPlan(', 'build.js')
  + line(BUILD_SRC, /  const MAP_CREDIT_KEY = [^\n]+/, 'build.js')
  + fn(BUILD_SRC, '  function shareOutcomeText(', 'build.js')
  + fn(BUILD_SRC, '  function openShareToCommunity(', 'build.js')
  + fn(BUILD_SRC, '  function wireCommunityMaps(', 'build.js')
  + fn(BUILD_SRC, '  function sharedBuildCopy(', 'build.js')
  + fn(BUILD_SRC, '  function wireSharedBuilds(', 'build.js');
const UI_CODE = line(UI_SRC, /  const \$ = s => document\.querySelector\(s\);/, 'stationui.js')
  + line(UI_SRC, /  const esc = s => U\.esc[^\n]+/, 'stationui.js')
  + line(UI_SRC, /  const mkEl = [^\n]+/, 'stationui.js')
  + line(UI_SRC, /  let skillPanelLoad = 0;/, 'stationui.js')
  + fn(UI_SRC, '  function loadAgentSkills(', 'stationui.js')
  + between(UI_SRC, '  const SKILL_SCOPE_LABEL = ', '  function renderAgentSkills(', 'stationui.js')        // scope labels, (communityLive)
  + fn(UI_SRC, '  function renderAgentSkills(', 'stationui.js')
  + between(UI_SRC, '  const MARKET_SHELVES = ', '  function shareSkillToMarket(', 'stationui.js')
  + fn(UI_SRC, '  function shareSkillToMarket(', 'stationui.js');

/* ---- the switch ---- */
const SWITCH = /const COMMUNITY_LIVE = (true|false);/g;
const flags = CM_SRC.match(SWITCH) || [];
A.eq(flags.length, 1, 'communitymaps.js declares the one switch exactly once, as a plain literal a go-live flip can rewrite');
const SHIPPED = flags.length === 1 && /true/.test(flags[0]);
const cmSource = live => live === 'shipped' ? CM_SRC : CM_SRC.replace(SWITCH, 'const COMMUNITY_LIVE = ' + live + ';');
const U = { esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), uiZoom: () => 1 };
const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
function page(live, extra) {
  const document = makeDocument(), requests = [];
  const ctx = Object.assign({
    document, U, console, Promise, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    localStorage: memoryStorage(), getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame: () => 0,
    CSS: { escape: s => String(s) }, StationUI: { notify() {} }, sfx() {}, notify() {},
    Harness: {
      apiFetch: async (url, init) => { requests.push({ url, method: (init && init.method) || 'GET' }); return { ok: true, status: 200, json: async () => ({ ok: true, serial: 1, maps: [], linked: true }) }; }
    }
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(cmSource(live), ctx, { filename: 'communitymaps.js' });
  return { ctx, document, requests };
}
const galleryAsks = requests => requests.filter(r => r.url.indexOf('/api/community-maps') === 0).map(r => r.url);

/* ---- 1. build mode's Presets sheet: SHARE TO COMMUNITY and the COMMUNITY MAPS gallery ---- */
async function presets(live) {
  const station = M.create(M.starterDoc()); station.ensureWorkstation('agent');
  A.ok(station.replaceLayout(T.build('software', M, Sprites, station.doc()._nid + 100)).ok, 'fixture: a Software Studio station');
  const P = page(live, {
    station, StationTemplates: T, WorldModel: M, PropSprites: Sprites, BuildShare: B, esc: U.esc,
    cardCloseAll() {}, cardRegister() {}, currentPresetExample: () => null, openPresetExample() {}, fitCamera() {}
  });
  P.ctx.root = P.document.body.appendChild(P.document.createElement('div'));
  vm.runInContext(BUILD_CODE + '\nshowStationBuilds();', P.ctx, { filename: 'build.js' });
  await settle();
  const sheet = P.ctx.root.querySelector('.refit-station-builds');
  return Object.assign(P, { sheet });
}
async function presetsCase(live, on) {
  const label = 'switch ' + (live === 'shipped' ? 'as shipped (' + (on ? 'on' : 'off') + ')' : on ? 'on' : 'off') + ': ';
  const P = await presets(live), sheet = P.sheet;
  A.ok(!!sheet, label + 'the Presets sheet opens');
  if (!sheet) return;
  A.eq(vm.runInContext('CommunityMaps.live', P.ctx), on, label + 'CommunityMaps.live reads the switch');
  A.ok(!!sheet.querySelector('[data-build-section="shared"] [data-export-build]') && !!sheet.querySelector('[data-build-section="shared"] [data-import-build]'),
    label + 'SHARED BUILDS keeps EXPORT THIS STATION and IMPORT A BUILD (files never needed the cloud)');
  A.ok(sheet.querySelectorAll('[data-station-build]').length >= T.catalog.length, label + 'every preset card is drawn');
  const share = sheet.querySelector('[data-share-community]'), gallery = sheet.querySelector('[data-build-section="community"]');
  const keys = texts(sheet, 'button'), heads = texts(sheet, 'h3');
  if (!on) {
    A.ok(share === null, label + 'no SHARE TO COMMUNITY key in the sheet');
    A.ok(!keys.some(t => /SHARE TO COMMUNITY/i.test(t)), label + 'no key reads SHARE TO COMMUNITY: ' + JSON.stringify(keys));
    A.ok(gallery === null, label + 'no COMMUNITY MAPS section in the sheet');
    A.eq(heads, ['BUILT FOR YOUR WORK', 'JUST THE LOOK', 'SHARED BUILDS'], label + 'the sheet\'s sections are the presets and SHARED BUILDS only');
    A.ok(!/COMMUNITY/i.test(sheet.textContent), label + 'nothing in the sheet says COMMUNITY');
    A.eq(galleryAsks(P.requests), [], label + 'opening PRESETS never asks for the community gallery');
    return;
  }
  A.ok(!!share && share.textContent === 'SHARE TO COMMUNITY' && !share.disabled, label + 'SHARE TO COMMUNITY is in SHARED BUILDS, a live key');
  A.ok(!!gallery && texts(gallery, 'h3')[0] === 'COMMUNITY MAPS', label + 'the COMMUNITY MAPS section is in the sheet');
  A.eq(galleryAsks(P.requests), ['/api/community-maps?refresh=1'], label + 'opening PRESETS reads the gallery fresh, once');
  A.eq(gallery && gallery.querySelector('.station-build-community-note').textContent, 'No community maps yet. Be the first: SHARE TO COMMUNITY, above.', label + 'the empty gallery says so');
  if (!share) return;
  await press(share); await settle();
  const panel = sheet.querySelector('[data-build-section="shared"] .station-build-sharepanel');
  A.ok(!!panel && !!panel.querySelector('#sbs-title') && !!panel.querySelector('[data-sbs-send]'), label + 'pressing it opens the share form in SHARED BUILDS');
  A.eq(share.getAttribute('aria-pressed'), 'true', label + 'with the key held while the form is open');
}

/* ---- 2. the skill card (ABILITIES › AGENT SKILLS): Share to market ---- */
const OWN = { id: 'meeting-recap', name: 'meeting-recap', summary: 'Recap a meeting into decisions and owners.', body: '# Recap\n1. Read it.', state: 'active', scope: 'agent', category: 'productivity', createdBy: 'agent', useCount: 2, updatedAt: 1792629276812 };
const INSTALLED = { id: 'market-brief', name: 'market-brief', summary: 'A market skill.', body: '# Brief', state: 'active', scope: 'agent', createdBy: 'community', sourceAuthor: 'Ada', updatedAt: 1792629276812 };
async function skillCards(live) {
  const P = page(live, {
    renderSkillCandidates() {}, editAgentSkill() {}, toggleSkillSharing() {}, skillReviewPost: async () => ({}),
  });
  P.ctx.Harness.agentSkills = async () => [OWN, INSTALLED];
  P.ctx.Harness.api = { get: async () => ({ candidates: [], evaluationSuites: [] }) };
  const host = P.document.body.appendChild(P.document.createElement('div')); host.setAttribute('id', 'sk-agent');
  vm.runInContext(UI_CODE + '\nloadAgentSkills("agent");', P.ctx, { filename: 'stationui.js' });
  await settle();
  return Object.assign(P, { host });
}
async function skillCase(live, on) {
  const label = 'switch ' + (live === 'shipped' ? 'as shipped (' + (on ? 'on' : 'off') + ')' : on ? 'on' : 'off') + ': ';
  const P = await skillCards(live), host = P.host;
  const own = host.querySelector('[data-agent-skill="meeting-recap"]'), installed = host.querySelector('[data-agent-skill="market-brief"]');
  A.ok(!!own && !!installed, label + 'both skill cards render');
  if (!own || !installed) return;
  A.ok(['Edit', 'Change sharing', 'Archive'].every(k => texts(own, '.consent-btns button').includes(k)), label + 'the card keeps Edit, Change sharing and Archive: ' + JSON.stringify(texts(own, '.consent-btns button')));
  A.ok(installed.querySelector('[data-ag-act="market"]') === null, label + 'a skill installed from the market never offers Share to market');
  const key = own.querySelector('[data-ag-act="market"]');
  if (!on) {
    A.ok(key === null, label + 'an own skill\'s card has no Share to market key');
    A.ok(!texts(host, 'button').some(t => /share to market/i.test(t)), label + 'no key anywhere reads Share to market');
    vm.runInContext('shareSkillToMarket(document.querySelector(\'[data-agent-skill="meeting-recap"]\'), ' + JSON.stringify(OWN) + ', "agent");', P.ctx);
    A.ok(own.querySelector('.sk-share') === null, label + 'and the share form cannot be opened on it by any other way in');
    A.eq(P.requests.filter(r => r.url === '/api/skill-market/share'), [], label + 'nothing is sent to the market');
    return;
  }
  A.ok(!!key && key.textContent === 'Share to market' && !key.disabled, label + 'an own skill\'s card offers Share to market, a live key');
  if (!key) return;
  await press(key); await settle();
  const form = own.querySelector('.sk-body .sk-share');
  A.ok(!!form && /NAME ON THE MARKET/.test(form.textContent), label + 'pressing it opens the share form in the card');
  A.ok(texts(own, '.consent-btns button').includes('Send for review'), label + 'with its Send for review key');
}

(async () => {
  for (const [live, on] of [['shipped', SHIPPED], [false, false], [true, true]]) {
    await presetsCase(live, on);
    await skillCase(live, on);
  }
  // the website's maps page tells players to SHARE TO COMMUNITY from the app: it may only go live after the app has
  const SITE_LIVE = /var COMMUNITY_LIVE = true;/.test(read('website/site.js'));
  A.ok(!SITE_LIVE || SHIPPED, 'website/site.js COMMUNITY_LIVE is on only once the app\'s switch is on (site ' + SITE_LIVE + ', app ' + SHIPPED + ')');
  A.report('community-hide-until-live.test');
})().catch(e => { console.log('FAIL: community-hide-until-live.test threw - ' + (e && e.stack || e)); process.exit(1); });
