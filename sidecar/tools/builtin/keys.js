/* sidecar/tools/builtin/keys.js — `keys.save`: a key the Commander pastes into chat becomes a KEYS entry.

   WHY THIS EXISTS (user report 2026-10-25, Saleshandy + Etsy). Every other harness lets an agent spend an API key the
   user pastes into the conversation. StarNet's only route was TOOLSETS & CONNECTORS → KEYS, and three of its own rules
   stacked against a paste: web_request told the model a key is never to be taken from the user, redact() scrubbed a
   vendor-SHAPED key out of the saved chat (so the next turn read `[redacted-secret]`), and a SHAPELESS key (a 40-char
   Saleshandy key) was not scrubbed at all, so it sat in plaintext in the desk save while the agent refused to use it.
   The user saw "got it" and then nothing happened.

   This tool closes that seam the way KEYS already works: the pasted value is STORED as a service key (servicekeys.js,
   via the host's own save), so it is spent by NAME through web_request `${NAME}` / the shell env exactly like a key
   added in the panel, and from that moment the known-value redaction scrubs it out of every transcript, stream line
   and save. COMMS swaps the paste in the Commander's bubble and saved history for keyPlaceholder(envVar) when it sees
   this tool's ok result (agent.tool_call + agent.tool_result — no new event; POST /api/servicekeys/scrub does the swap).

   THE KEY NEVER RIDES THE TOOL CALL. The model names the service (and, only when a message holds two key-like
   strings, the first characters of the one it means); the HOST finds the value in the Commander's own recent
   messages. So the raw key is never in the call's args (which stream to the page and wait on approval cards), and —
   the injection guard — a value can only ever come from text the Commander typed: a web page or a connector result
   is not a user turn, and a run that did not come from the Commander (a routine, a group member, a forwarded
   message, a delegated worker) gets no owner texts at all (ownerTexts() returns null).

   makeKeyTools({ ownerTexts, save, tainted? }) -> { saveTool, register(reg), _internals }
     ownerTexts : () -> string[] newest-first | null   — the Commander's own recent user turns; null = this run was
                                                         not started by the Commander, so nothing can be saved
     save       : ({ name, key, docsUrl }) -> { ok, record:{name,envVar,autonomous,unattendedSupported}, existed,
                                               sameValue, saved } | { ok:false, error }
                                               — the host's KEYS upsert (verified persist, env apply, catalog policy)
     tainted    : () -> bool — the run has read content the Commander did not author; it may add a key but never
                               REPLACE a saved one (an injected page must not swap a working key for another string)
     onSaved    : (envVar) -> void — after a successful save (the host releases the run's transcript hold) */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).keys = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY_MIN = 16;          // shorter than any real API key we know of; keeps ids, SHAs-as-typed and words out
  const KEY_MAX = 512;
  const OWNER_TURNS = 6;       // how far back a paste is still "the one the Commander just gave you"
  const HINT_MIN = 3;

  const str = v => String(v == null ? '' : v).trim();

  // Edge characters a paste picks up from prose and markdown: quotes, backticks, brackets, closing punctuation.
  const EDGE = /^["'`<>()[\]{}*,;!?]+|["'`<>()[\]{}*,;!?.:]+$/g;
  const KEY_CHARS = /^[A-Za-z0-9_\-.~+/=]+$/;
  // `api_key=…`, `token:…`, `SALESHANDY_API_KEY=…` — the value is the part after the label
  const LABELLED = /^[A-Za-z][A-Za-z0-9_.-]{0,48}[=:](.+)$/;

  function keyish(t) {
    if (t.length < KEY_MIN || t.length > KEY_MAX || !KEY_CHARS.test(t)) return false;
    // a path or a dotted file name is not a key (docs/2026-10-25/notes.md, frontend/app/chat.js)
    if (t.indexOf('/') >= 0 && t.indexOf('.') >= 0) return false;
    if (/^[0-9]+$/.test(t)) return false;   // all digits: an order id, a phone, a card number — never a key to store
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    const digits = (t.match(/[0-9]/g) || []).length;
    if (letters < 4 || digits < 2) return false;   // words-with-a-number, timestamps (2026-10-25T12:30:00Z) and slugs
    return new Set(t).size >= 10;                  // a real key is high-entropy; "aaaa1111aaaa1111" is not
  }

  // Every distinct key-like string in one message, in order of appearance. Pure.
  function findKeyCandidates(text) {
    const out = [];
    for (const raw of String(text == null ? '' : text).split(/\s+/)) {
      let t = raw.replace(EDGE, '');
      if (!t || t.indexOf('://') >= 0 || t.indexOf('@') >= 0 || t.indexOf('\\') >= 0 || /^[.~]?\//.test(t)) continue;
      const m = LABELLED.exec(t);
      if (m) t = m[1].replace(EDGE, '');
      if (keyish(t) && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  function hasKeyCandidate(texts) {
    return (Array.isArray(texts) ? texts : []).slice(0, OWNER_TURNS).some(t => findKeyCandidates(t).length > 0);
  }

  // What the Commander's bubble (and the saved chat) shows where the pasted key was. One ASCII form everywhere.
  function keyPlaceholder(envVar) { return '[' + str(envVar) + ' saved in KEYS]'; }

  // Replace every saved key value in `text` with its placeholder. keys = [{ key, envVar }]; longest value first, so a
  // key that contains another is replaced whole. Values shorter than KEY_MIN are ignored (never chew ordinary words).
  function nameSavedKeys(text, keys) {
    let s = String(text == null ? '' : text);
    const list = (Array.isArray(keys) ? keys : [])
      .filter(k => k && typeof k.key === 'string' && k.key.trim().length >= KEY_MIN && k.envVar)
      .map(k => ({ key: k.key.trim(), envVar: String(k.envVar) }))
      .sort((a, b) => b.key.length - a.key.length);
    for (const k of list) if (s.indexOf(k.key) >= 0) s = s.split(k.key).join(keyPlaceholder(k.envVar));
    return s;
  }

  // The one the model meant, from the Commander's turns (newest first). -> { key } | { error }
  function pickKey(texts, hint) {
    const want = str(hint);
    let crowded = null;
    for (const text of (Array.isArray(texts) ? texts : []).slice(0, OWNER_TURNS)) {
      const found = findKeyCandidates(text).filter(k => !want || k.indexOf(want) === 0);
      if (found.length === 1) return { key: found[0] };
      if (found.length > 1 && !crowded) crowded = found;
    }
    if (crowded) {
      return { error: 'the Commander\'s message holds ' + crowded.length + ' key-like strings (starting '
        + crowded.slice(0, 5).map(k => '"' + k.slice(0, 4) + '…"').join(', ') + '). Call keys.save again with starts_with set to the first few characters of the key for this service.' };
    }
    return { error: want
      ? 'no key starting "' + want + '" is in the Commander\'s recent messages. Check the characters, or leave starts_with out.'
      : 'no API key is in the Commander\'s recent messages (a key-shaped one may already show as [redacted-…] there). Ask the Commander to paste the key into this chat again, then call keys.save.' };
  }

  function makeKeyTools(deps) {
    const d = deps || {};

    const saveTool = {
      name: 'keys.save', capability: 'web', scope: 'write', requiresConsent: false, network: false, timeoutMs: 15000,
      description: 'The Commander pasted an API key into this chat: save it to KEYS so you can use it. Name the service; '
        + 'the station finds the key in the Commander\'s own recent message, stores it, and replaces it in the chat with '
        + 'a placeholder. Then call the API with web_request using the key\'s NAME in a header, e.g. '
        + '{"x-api-key": "${SALESHANDY_API_KEY}"}. Never write the raw key in a tool call.',
      schema: {
        type: 'object', required: ['service'],
        properties: {
          service: { type: 'string', description: 'The service the key is for, as the Commander would name it, e.g. "Saleshandy". It becomes the env var name (SALESHANDY_API_KEY).' },
          starts_with: { type: 'string', description: 'Only when the message holds more than one key: the first few characters of the one for this service.' },
          docs_url: { type: 'string', description: 'Optional: the service\'s API reference URL, kept with the key.' }
        }
      },
      run: async (args) => {
        args = args || {};
        const service = str(args.service).slice(0, 64);
        if (!service) return { isError: true, content: 'service is required — the name of the platform the key is for, e.g. "Saleshandy".', summary: 'no service' };
        let texts = null;
        try { texts = typeof d.ownerTexts === 'function' ? d.ownerTexts() : null; } catch (_) { texts = null; }
        if (!Array.isArray(texts)) {
          return { isError: true, summary: 'not the Commander\'s run',
            content: 'keys.save only takes a key the Commander typed into this conversation, and this run was not started by them '
              + '(a routine, a group member, a forwarded message or a delegated worker). Ask the Commander to paste it in their own chat with you, or add it in TOOLSETS & CONNECTORS → KEYS.' };
        }
        const hint = str(args.starts_with);
        if (hint && hint.length < HINT_MIN) return { isError: true, content: 'starts_with needs at least ' + HINT_MIN + ' characters.', summary: 'hint too short' };
        const picked = pickKey(texts, hint);
        if (picked.error) return { isError: true, content: picked.error, summary: 'no key found' };
        const docsUrl = /^https:\/\/\S+$/i.test(str(args.docs_url)) ? str(args.docs_url).slice(0, 512) : '';
        let r;
        try { r = d.save({ name: service, key: picked.key, docsUrl: docsUrl, refuseReplace: !!(typeof d.tainted === 'function' && d.tainted()) }); }
        catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
        if (!r || !r.record) return { isError: true, content: 'could not save the key: ' + String((r && r.error) || 'unknown error'), summary: 'not saved' };
        const rec = r.record;
        const envVar = String(rec.envVar);
        if (typeof d.onSaved === 'function') d.onSaved(envVar);   // the run's transcript hold lets go (the host flips a flag)
        const lines = [
          (r.sameValue ? 'This key was already saved in KEYS as ' : (r.existed ? 'Replaced the saved key for ' + rec.name + ' — it is now in KEYS as ' : 'Saved ' + rec.name + '\'s key in KEYS as ')) + envVar + '.'
            + (r.saved === false ? ' WARNING: it works for this session but could not be verified on disk — tell the Commander it may not survive a restart.' : ''),
          'Use it with web_request by its NAME in a header, never the value: e.g. {"Authorization": "Bearer ${' + envVar + '}"} or {"x-api-key": "${' + envVar + '}"} — check the service\'s API docs for the header it wants. In the shell it is the env var ' + envVar + '.',
          rec.unattendedSupported === false
            ? 'It works only while the Commander is watching or messaging you directly; this service does not support unattended use.'
            : (rec.autonomous === true ? '' : 'It works while the Commander is watching or messaging you directly. For routines and Night Shift, the Commander turns on its unattended switch in TOOLSETS & CONNECTORS → KEYS.'),
          'Do not repeat the key.'
        ].filter(Boolean);
        return { content: lines.join('\n'), summary: 'saved ' + envVar };
      }
    };

    return {
      saveTool: saveTool,
      register(reg) { reg.register(saveTool); return reg; },
      _internals: { keyish, pickKey, KEY_MIN, OWNER_TURNS }
    };
  }

  return { makeKeyTools, findKeyCandidates, hasKeyCandidate, keyPlaceholder, nameSavedKeys, OWNER_TURNS };
});
