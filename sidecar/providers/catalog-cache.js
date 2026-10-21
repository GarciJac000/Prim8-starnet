/* sidecar/providers/catalog-cache.js - ONE model-catalog cache for the whole process (attached at boot through
   factory.attachCatalogCache, the way ratelimits.js is).

   WHY. A run builds a fresh adapter (index.js runOnceCore), and every adapter except OpenRouter kept its /models
   catalog on that instance. The run's context manager is built synchronously before the first request, so it always
   saw a COLD catalog: Gemini and the OpenAI-compatible family answered 0 and the run assumed 131072 (Gemini folds
   at ~85k of a 1M window), native Ollama assumed 131072 against a 65536 window (the fold point sat ABOVE the window,
   so proactive compaction could never fire), and each fresh adapter re-fetched /models on its first stream only to
   throw the answer away when the run ended. OpenRouter's module-level CATALOG is the precedent: a key-independent
   list warmed once and read by every instance. This generalizes it with a TTL and per-credential scoping.

   TWO LAYERS.
   - LIST, per scope = provider id | base URL | fingerprint(credential). A model list can differ per key (org access,
     plan), so one key's list never answers for another. The fingerprint is the first 16 hex chars of a sha256 and
     lives only in this process's memory: no key or token is ever stored, logged or persisted here. Only a NON-EMPTY
     list replaces an entry; an empty or failed load keeps the old entry and starts a back-off. Past the TTL an
     entry still answers (stale-while-revalidate) while ONE background refresh is kicked.
   - FACTS, per endpoint (key-independent, like openai-compatible's declaredByEndpoint): model id -> the window the
     endpoint REPORTED, plus small per-model facts an adapter reads from the server (Ollama /api/show). Written by
     every successful live load from any instance or key. A window is only ever a number the endpoint reported:
     nothing here invents or defaults one. A live list is the endpoint's CURRENT answer for every id it lists, so an id
     it lists without a window loses the one an earlier list reported (LM Studio ejected the model; the port now serves
     llama.cpp), and a window reported longer ago than the TTL answers nothing (nothing may revalidate it: an OAuth
     adapter lists nothing of its own).

   Determinism law: wall time arrives via the injected clock; with no clock nothing ages (no expiry, no automatic
   retry after a failure) and every direct load still runs. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('../failopen.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.catalogCache = factory(null); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (failopen) {
  'use strict';

  const failNote = (failopen && failopen.note) || function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); };
  const TTL_MS = 10 * 60 * 1000;
  const FAIL_BACKOFF_MS = 60 * 1000;
  const LOAD_TIMEOUT_MS = 15 * 1000;   // a shared load that has not answered by then is a failure (see load)
  const MAX_SCOPES = 64;          // list entries (keys x endpoints a Commander actually uses); the oldest go first
  const MAX_ENDPOINTS = 64;       // fact maps
  const MAX_IDS = 4096;           // models remembered per endpoint (OpenRouter publishes ~400)
  // How long a run's setup waits for a cold catalog before building its context on the 131072 assumption. Only a
  // window nobody in this process has seen reported inside the TTL waits; after that answer it replies synchronously.
  const RUN_WINDOW_WAIT_MS = 1500;

  let nodeCrypto = null;
  try { nodeCrypto = (typeof require === 'function') ? require('crypto') : null; } catch (_) { nodeCrypto = null; }

  function cleanUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
  function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
  function windowOf(m) { const n = Math.floor(Number(m && m.context_length) || 0); return n > 0 ? n : 0; }

  // The credential's fingerprint: enough to tell two keys apart, useless as a key. '' for no credential.
  function fingerprint(credential) {
    const s = credential == null ? '' : String(credential);
    if (!s) return '';
    if (nodeCrypto && typeof nodeCrypto.createHash === 'function') return nodeCrypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
    let a = 0x811c9dc5, b = 0x01000193;   // no node crypto (browser bundle): FNV-1a twice, never the raw value
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0; b = Math.imul(b ^ s.charCodeAt(s.length - 1 - i), 0x811c9dc5) >>> 0; }
    return ('00000000' + a.toString(16)).slice(-8) + ('00000000' + b.toString(16)).slice(-8);
  }

  function makeCatalogCache(opts) {
    opts = opts || {};
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;
    const ttlMs = positive(opts.ttlMs, TTL_MS);
    const failBackoffMs = positive(opts.failBackoffMs, FAIL_BACKOFF_MS);
    const loadTimeoutMs = positive(opts.loadTimeoutMs, LOAD_TIMEOUT_MS);
    const lists = new Map();      // scope -> { models, at, version, failAt, fails, missAt, missGap, inflight }
    const facts = new Map();      // ns + '\n' + endpoint -> Map(id -> { value, at })
    const seen = new Map();       // endpoint -> when a live list from it last landed
    let version = 0;

    function now() {
      if (!clock) return 0;
      try { const t = Number(clock.now()); return Number.isFinite(t) ? t : 0; }
      catch (e) { failNote('providers.catalog_cache.clock', e); return 0; }
    }
    function aged(at, span) { return !!clock && now() - at >= span; }
    function isStale(at) { return aged(at, ttlMs); }
    function trim(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

    function scopeOf(kind, baseUrl, credential) { return String(kind || '') + '|' + cleanUrl(baseUrl) + '|' + fingerprint(credential); }

    function slot(scope) {
      let s = lists.get(scope);
      if (!s) {
        s = { models: null, at: 0, version: 0, failAt: null, fails: 0, missAt: 0, missGap: failBackoffMs, inflight: null };
        lists.set(scope, s); trim(lists, MAX_SCOPES);
      }
      return s;
    }
    // The wait after a failed load doubles with each consecutive failure, up to the TTL: an endpoint with no usable
    // /models is asked about once a TTL, not once a minute for as long as runs keep streaming.
    function backoffOf(s) { return Math.min(ttlMs, failBackoffMs * Math.pow(2, Math.max(0, (s.fails || 1) - 1))); }
    // { models, at, version, stale } or null. Synchronous: what this scope last loaded, however old.
    function peek(scope) {
      const s = scope ? lists.get(scope) : null;
      if (!s || !s.models) return null;
      return { models: s.models, at: s.at, version: s.version, stale: isStale(s.at) };
    }
    // A live list this scope just loaded. Empty never replaces anything. Returns the entry's version (0 = not kept).
    function put(scope, models) {
      if (!scope || !Array.isArray(models) || !models.length) return 0;
      const s = slot(scope);
      s.models = models.slice(); s.at = now(); s.version = ++version; s.failAt = null; s.fails = 0;
      return s.version;
    }
    function inBackoff(scope) {
      const s = scope ? lists.get(scope) : null;
      if (!s || s.failAt == null) return false;
      return !clock || now() - s.failAt < backoffOf(s);
    }
    /* One load per scope at a time; resolves to what the fetch returned ([] on failure) and never rejects. A load
       that has not answered within loadTimeoutMs counts as a failure (back-off), so an endpoint that never answers
       its /models cannot pin the scope, or hold every later run's setup on its wait. Its late answer is still kept. */
    function load(scope, fetchList) {
      if (!scope || typeof fetchList !== 'function') return Promise.resolve([]);
      const s = slot(scope);
      if (s.inflight) return s.inflight;
      const fail = () => { s.failAt = now(); s.fails++; };
      let settled = false, timer = null;
      const flight = new Promise(resolve => {
        const finish = (list, failed) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (failed) fail();
          resolve(list);
        };
        timer = setTimeout(() => finish([], true), loadTimeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        Promise.resolve().then(fetchList).then(list => {
          const ok = Array.isArray(list) ? list : [];
          if (ok.length) put(scope, ok);   // a late answer is still a live list
          finish(ok, !ok.length);
        }, e => { failNote('providers.catalog_cache.load', e); finish([], true); });
      });
      s.inflight = flight;
      flight.then(() => { if (s.inflight === flight) s.inflight = null; });
      return flight;
    }
    /* Non-blocking: kick ONE background load when this scope has no list or an aged one, nothing is in flight, and
       the last failure is past its back-off. `miss` (a warm list that lacks the asked id: a model released after the
       list loaded) refreshes once the list and the last miss refresh are older than a gap that starts at the failure
       back-off and doubles each time up to the TTL, so an id the endpoint never lists cannot keep re-fetching it.
       Returns whether a load was kicked. */
    function ensure(scope, fetchList, o) {
      if (!scope) return false;
      const s = lists.get(scope);
      if (s && s.inflight) return false;
      if (inBackoff(scope)) return false;
      let want = !s || !s.models || isStale(s.at);
      if (!want && o && o.miss && aged(Math.max(s.at, s.missAt), s.missGap)) {
        want = true;
        s.missAt = now(); s.missGap = Math.min(ttlMs, s.missGap * 2);
      }
      if (!want) return false;
      load(scope, fetchList);
      return true;
    }
    function invalidate(prefix) {
      const p = String(prefix || '');
      for (const scope of Array.from(lists.keys())) if (scope.indexOf(p) === 0) lists.delete(scope);
    }

    function factMap(ns, endpoint, create) {
      const k = String(ns || '') + '\n' + cleanUrl(endpoint);
      let m = facts.get(k);
      if (!m && create) { m = new Map(); facts.set(k, m); trim(facts, MAX_ENDPOINTS * 2); }
      return m || null;
    }
    function noteFact(ns, endpoint, id, value) {
      const sid = String(id || '');
      if (!sid || value == null) return;
      const m = factMap(ns, endpoint, true);
      m.delete(sid);   // re-insert: the newest fact is the last one evicted
      m.set(sid, { value, at: now() });
      trim(m, MAX_IDS);
    }
    // { value, stale } or null.
    function factOf(ns, endpoint, id) {
      const m = factMap(ns, endpoint, false);
      const hit = m && m.get(String(id || ''));
      return hit ? { value: hit.value, stale: isStale(hit.at) } : null;
    }
    /* A live list is the endpoint's current answer for every id it lists: each window it REPORTS is noted, and an id it
       lists without one loses any window an earlier list reported (only a reported number may stand). Also records
       that the endpoint answered at all. */
    function noteWindows(endpoint, models) {
      if (!Array.isArray(models)) return;
      const ep = cleanUrl(endpoint);
      if (!ep) return;
      const listed = new Map();   // id -> the window this list reports for it (0 = none; a duplicate row never erases one)
      for (const m of models) {
        const id = (m && m.id) ? String(m.id) : '';
        if (!id) continue;
        const n = windowOf(m);
        if (n || !listed.has(id)) listed.set(id, n);
      }
      const known = factMap('window', ep, false);
      for (const [id, n] of listed) {
        if (n) noteFact('window', ep, id, n);
        else if (known) known.delete(id);
      }
      seen.delete(ep); seen.set(ep, now()); trim(seen, MAX_ENDPOINTS);
    }
    // The window this endpoint last reported for id, while that report is inside the TTL. 0 = unknown.
    function windowFact(endpoint, id) { const hit = factOf('window', endpoint, id); return (hit && !hit.stale) ? Number(hit.value) || 0 : 0; }
    // A live list from this endpoint landed inside the TTL, so every window it publishes is already noted (one it does
    // not report is one it does not publish). Past the TTL a warm reads the endpoint again.
    function endpointSeen(endpoint) { const ep = cleanUrl(endpoint); return seen.has(ep) && !isStale(seen.get(ep)); }

    /* One adapter instance's handle: its scope (null = no shared list, e.g. an OAuth token that rotates, so accounts
       never share a list; the facts layer still applies), its endpoint, and its own fetch of the endpoint's list.
       Every background load notes the windows it saw. */
    function bind(spec) {
      spec = spec || {};
      const scope = typeof spec.scope === 'string' && spec.scope ? spec.scope : null;
      const endpoint = cleanUrl(spec.endpoint);
      const fetchList = typeof spec.fetchList === 'function' ? spec.fetchList : null;
      const fetchShared = () => Promise.resolve().then(fetchList).then(list => {
        if (Array.isArray(list) && list.length) noteWindows(endpoint, list);
        return Array.isArray(list) ? list : [];
      });
      return {
        shared: !!scope,
        peek: () => peek(scope),
        // a list this instance loaded itself (live): kept for the scope and its windows noted
        share(list) { if (Array.isArray(list) && list.length) noteWindows(endpoint, list); return put(scope, list); },
        ensure: (o) => (scope && fetchList) ? ensure(scope, fetchShared, o) : false,
        load: () => (scope && fetchList) ? load(scope, fetchShared) : Promise.resolve([]),
        inBackoff: () => inBackoff(scope),
        windowFact: (id) => windowFact(endpoint, id),
        seen: () => endpointSeen(endpoint),
        noteWindows: (list) => noteWindows(endpoint, list)
      };
    }

    return { scopeOf, peek, put, load, ensure, inBackoff, invalidate, noteFact, factOf, noteWindows, windowFact, endpointSeen, bind,
      now, isStale, ttlMs, failBackoffMs };
  }

  /* The window a run is built with (index.js runOnceCore), or 0 = unknown. A known window answers at once. An unknown
     one gives the adapter's warmCatalog(model) at most `waitMs` to learn it (a shared list, one deduped load, one
     /api/show), then reads again. The timer is always cleared, so a run never lingers on it. */
  async function runWindow(provider, model, o) {
    o = o || {};
    const read = () => {
      try { const n = Math.floor(Number(provider && provider.contextLimit(model)) || 0); return n > 0 ? n : 0; }
      catch (e) { failNote('providers.catalog_cache.run_window', e); return 0; }
    };
    const known = read();
    if (known || !provider || typeof provider.warmCatalog !== 'function') return known;
    const waitMs = positive(o.waitMs, RUN_WINDOW_WAIT_MS);
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => provider.warmCatalog(model)).catch(e => failNote('providers.catalog_cache.run_window_warm', e)),
        new Promise(resolve => { timer = setTimeout(resolve, waitMs); if (timer && typeof timer.unref === 'function') timer.unref(); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
    return read();
  }

  return { makeCatalogCache, runWindow, fingerprint, TTL_MS, FAIL_BACKOFF_MS, RUN_WINDOW_WAIT_MS };
});
