/* node test/keys-save.test.js — keys.save: a key the Commander pastes into chat becomes a KEYS entry (2026-10-25).

   User report: "I gave him the api key for saleshandy and nothing works … it says he got it and then nothing sent".
   A pasted key was never usable: web_request only spends KEYS entries, by name. This locks the seam that fixes it:

     • the HOST finds the key in the Commander's own turns — the model names the service, never writes the value
     • a run the Commander did not start (ownerTexts null) can save nothing; a tainted run may add, never replace
     • the saved key is spent by NAME: web_request ${SALESHANDY_API_KEY} sends the exact pasted value
     • the paste is replaced by a placeholder, and the known-value redaction scrubs the value everywhere after
     • key-shaped detection refuses URLs, emails, paths, timestamps, card numbers and plain words */
'use strict';
const A = require('./_assert.js');
const KT = require('../sidecar/tools/builtin/keys.js');
const K = require('../sidecar/servicekeys.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { redact, setKnownSecretSource } = require('../sidecar/context.js');

const PASTE = '9c2f41d7a8e04b6f93a1c5d27e8b0f4a6d3c19e2';   // shapeless, like a Saleshandy key: redact() alone misses it
const OTHER = 'b7e1c0a9d4f2e6b8a3c5d7f9e1a2b4c6';

(async () => {
  // ---- A. what counts as a pasted key ----
  {
    const f = KT.findKeyCandidates;
    A.eq(f('here is my saleshandy api key ' + PASTE), [PASTE], 'a bare key in prose');
    A.eq(f('api_key=' + PASTE), [PASTE], 'a labelled key (=)');
    A.eq(f('SALESHANDY_API_KEY: ' + PASTE), [PASTE], 'a label then the key');
    A.eq(f('use `' + PASTE + '` please'), [PASTE], 'a key in backticks');
    A.eq(f('"' + PASTE + '".'), [PASTE], 'a quoted key with closing punctuation');
    A.eq(f('key 550e8400-e29b-41d4-a716-446655440000'), ['550e8400-e29b-41d4-a716-446655440000'], 'a UUID-shaped key');
    A.eq(f(('sk_' + 'live_51HqT2xKZ8bQ9mN3pL7vR4wY6')), [('sk_' + 'live_51HqT2xKZ8bQ9mN3pL7vR4wY6')], 'a vendor-prefixed key');
    A.eq(f(PASTE + ' and again ' + PASTE), [PASTE], 'the same key twice is one candidate');
    for (const not of [
      'https://open-api.saleshandy.com/v1/sequences/' + PASTE,   // a URL is never lifted out as a key
      'mail me at andrew.sims2026@example.com',
      'C:\\Users\\andro\\Desktop\\gen\\notes2026.txt',
      'see docs/2026-10-25/notes.md',
      'at 2026-10-25T12:30:00Z it broke',
      'card 4111111111111111',                                   // all digits: never stored as a key
      'supercalifragilisticexpialidocious',
      'version2-release-candidate-build',
      'aaaa1111aaaa1111aaaa',                                    // low entropy
      'short a1b2c3d4'
    ]) A.eq(f(not), [], 'not a key: ' + not);
    A.ok(KT.hasKeyCandidate(['no key here', 'earlier: ' + PASTE]), 'a paste in a recent turn counts');
    A.ok(!KT.hasKeyCandidate(['tell me a joke', 'thanks']), 'no paste, no offer');
    A.ok(!KT.hasKeyCandidate(['1', '2', '3', '4', '5', '6', 'old: ' + PASTE]), 'a paste older than OWNER_TURNS is not "just given"');
  }

  // ---- B. which candidate the model meant ----
  {
    const tool = KT.makeKeyTools({ ownerTexts: () => [], save: () => ({ ok: false }) });
    const pick = tool._internals.pickKey;
    A.eq(pick(['my key ' + PASTE]).key, PASTE, 'one candidate is picked');
    const two = pick(['saleshandy ' + PASTE + ' and etsy ' + OTHER]);
    A.ok(two.error && /2 key-like strings/.test(two.error) && two.error.indexOf('"9c2f…"') >= 0 && two.error.indexOf('"b7e1…"') >= 0, 'two candidates: asks for starts_with, naming only their first 4 chars: ' + two.error);
    A.ok(two.error.indexOf(PASTE) < 0 && two.error.indexOf(OTHER) < 0, 'the refusal never repeats a whole key');
    A.eq(pick(['saleshandy ' + PASTE + ' and etsy ' + OTHER], 'b7e1').key, OTHER, 'starts_with picks the one meant');
    A.eq(pick(['ok, it is for saleshandy', 'here: ' + PASTE]).key, PASTE, 'the newest turn with a key wins (the paste came one turn earlier)');
    A.ok(/paste the key into this chat again/.test(pick(['hello', 'my key is [redacted-secret]']).error), 'nothing to find: ask for the paste again');
    A.ok(/no key starting "zzz"/.test(pick(['my key ' + PASTE], 'zzz').error), 'a wrong hint is said plainly');
  }

  // ---- C. the tool: owner-only, value never in args, event names the key not the value ----
  {
    const saves = [];
    const events = [];
    const ctx = { runId: 'run-1', emit: (n, p) => events.push({ n, p }) };
    const okSave = (input) => { saves.push(input); return { ok: true, record: { name: 'Saleshandy', envVar: 'SALESHANDY_API_KEY', autonomous: false, unattendedSupported: true }, existed: false, sameValue: false, saved: true }; };

    const stranger = KT.makeKeyTools({ ownerTexts: () => null, save: okSave }).saveTool;
    const refused = await stranger.run({ service: 'Saleshandy' }, ctx);
    A.ok(refused.isError && /was not started by them/.test(refused.content), 'a run the Commander did not start saves nothing: ' + refused.content);
    A.eq(saves.length, 0, '...and never reaches the store');

    const t = KT.makeKeyTools({ ownerTexts: () => ['here is my saleshandy api key ' + PASTE], save: okSave, tainted: () => false }).saveTool;
    A.eq(t.name, 'keys.save', 'tool name');
    A.ok(!('key' in (t.schema.properties || {})) && !('value' in (t.schema.properties || {})), 'the schema has no slot for the key value');
    const out = await t.run({ service: 'Saleshandy' }, ctx);
    A.ok(!out.isError, 'saved: ' + out.content);
    A.eq(saves[0].key, PASTE, 'the host-found value is what gets stored');
    A.eq(saves[0].name, 'Saleshandy', 'under the service the model named');
    A.eq(saves[0].refuseReplace, false, 'a clean run may replace a saved key');
    A.ok(/\$\{SALESHANDY_API_KEY\}/.test(out.content), 'the result teaches the ${NAME} header form');
    A.ok(/unattended switch/.test(out.content), 'and says routines need the unattended switch');
    A.ok(out.content.indexOf(PASTE) < 0, 'the result never repeats the key');
    A.ok(!/placeholder|replaces the key|chat now shows/.test(out.content), 'it claims nothing about the page (the tool cannot see it)');
    A.eq(out.summary, 'saved SALESHANDY_API_KEY', 'floor summary names the key');
    A.eq(events.length, 0, 'no event of its own: COMMS keys off the contract\'s tool_call/tool_result');

    const tainted = KT.makeKeyTools({ ownerTexts: () => ['key ' + PASTE], save: okSave, tainted: () => true }).saveTool;
    await tainted.run({ service: 'Saleshandy' }, ctx);
    A.eq(saves[1].refuseReplace, true, 'a tainted run asks the store to refuse a replace');

    A.ok((await t.run({}, ctx)).isError, 'service is required');
    A.ok(/at least 3/.test((await t.run({ service: 'X', starts_with: 'ab' }, ctx)).content), 'a 2-char hint is refused');

    const failing = KT.makeKeyTools({ ownerTexts: () => ['key ' + PASTE], save: () => ({ ok: false, error: 'OpenAI would be saved as OPENAI_API_KEY, which is reserved' }) }).saveTool;
    const fr = await failing.run({ service: 'OpenAI' }, ctx);
    A.ok(fr.isError && /reserved/.test(fr.content), 'a store refusal is passed through: ' + fr.content);
  }

  // ---- D. the whole chain: paste -> KEYS -> web_request ${NAME} sends the exact value -> placeholder -> redaction ----
  {
    let keys = [];
    const save = (input) => {
      const r = K.upsert(keys, { name: input.name, key: input.key }, 1);
      if (r.error) return { ok: false, error: r.error };
      keys = r.list;
      return { ok: true, record: r.record, existed: false, sameValue: false, saved: true };
    };
    const message = 'hey here is my saleshandy api key ' + PASTE + ' — send the campaign';
    const saveTool = KT.makeKeyTools({ ownerTexts: () => [message], save }).saveTool;
    const saved = await saveTool.run({ service: 'Saleshandy' }, { runId: 'r', emit: () => {} });
    A.ok(!saved.isError, 'chain: saved');
    A.eq(keys.length, 1, 'chain: one KEYS row');
    A.eq(keys[0].envVar, 'SALESHANDY_API_KEY', 'chain: env var derived from the service name');

    const sent = [];
    const fetchImpl = async (url, opts) => { sent.push({ url, opts }); return { status: 200, headers: { get: () => 'application/json' }, text: async () => '{"sequences":[]}' }; };
    const web = makeWebTools({ fetchImpl, lookup: null, surface: 'interactive', redact: s => s, resolveServiceKey: (n, sfc) => K.resolveForRequest(keys, n, sfc) }).requestTool;
    const res = await web.run({ url: 'https://open-api.saleshandy.com/v1/sequences', headers: { 'x-api-key': '${SALESHANDY_API_KEY}' } }, { agentId: 'a', runId: 'r', callId: 'c', emit: () => {} });
    A.eq(sent[0].opts.headers['x-api-key'], PASTE, 'chain: web_request sent the EXACT pasted value');
    A.ok(res.content.indexOf(PASTE) < 0, 'chain: the value never comes back in the result');

    A.eq(KT.nameSavedKeys(message, keys), 'hey here is my saleshandy api key [SALESHANDY_API_KEY saved in KEYS] — send the campaign', 'chain: the paste becomes the placeholder');
    setKnownSecretSource(() => keys.map(k => k.key));
    A.eq(redact('echo ' + PASTE), 'echo [redacted-secret]', 'chain: once saved, the known-value redaction scrubs it everywhere');
    setKnownSecretSource(null);
    A.eq(redact('echo ' + PASTE), 'echo ' + PASTE, 'chain: (control) the shapeless key was NOT scrubbed before it was saved');

    // a missing key tells the agent about the chat route, not just "add it in KEYS"
    let msg = '';
    try { await web.run({ url: 'https://api.example.com/x', headers: { 'x-api-key': '${NOPE_API_KEY}' } }, { agentId: 'a', runId: 'r', callId: 'c2', emit: () => {} }); }
    catch (e) { msg = e.message; }
    if (!msg) msg = 'no error';
    A.ok(/keys\.save/.test(msg) && /KEYS/.test(msg), 'missing key: the fix names keys.save and KEYS: ' + msg);
  }

  // ---- E. nameSavedKeys ----
  {
    const ks = [{ key: 'abcd1234efgh5678ijkl', envVar: 'SHORT_API_KEY' }, { key: 'abcd1234efgh5678ijkl9999', envVar: 'LONG_API_KEY' }, { key: 'tiny123', envVar: 'TINY_API_KEY' }];
    A.eq(KT.nameSavedKeys('a abcd1234efgh5678ijkl9999 b', ks), 'a [LONG_API_KEY saved in KEYS] b', 'longest key first: a key containing another is replaced whole');
    A.eq(KT.nameSavedKeys('tiny123 stays', ks), 'tiny123 stays', 'values shorter than KEY_MIN are never touched');
    A.eq(KT.nameSavedKeys('', ks), '', 'empty text');
  }

  A.report('keys-save');
})().catch(e => { console.error(e); process.exit(1); });
