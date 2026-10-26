/* node test/connectors-tool.test.js — the `connectors.list` builtin (sidecar/tools/builtin/connectors.js).

   The tool exists because an agent could not tell "StarNet cannot reach GitHub" apart from "GitHub is one
   click away and nobody clicked it". So the assertions that matter are about HONESTY, not formatting:
     • an INSTALLED connector never re-appears in AVAILABLE (no nagging to add what you have);
     • a connected KEY never re-appears in AVAILABLE either;
     • NO KEY VALUE can reach the output on any path (the tool is fed a live-looking secret and the whole
       rendered string is searched for it);
     • a live connector's state is the MANAGER's state, never the catalog's optimism;
     • a missing/throwing dep degrades that section to silence rather than to a confident empty answer;
     • it is wired into CAP_REGISTRY under `dish` with capId 'web', consent-free, non-network, NOT deferred
       (a discovery tool that must itself be discovered would be useless). */
'use strict';
const A = require('./_assert.js');
const { makeConnectorTools } = require('../sidecar/tools/builtin/connectors.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const SECRET = 'sk-live-7f3ac0PRINTIFYSECRETVALUE';

// --- fakes: shaped exactly like the real deps (mcp/manager.list, the KEYS list, both catalogs) ---
const fakeManager = (rows) => ({ list: () => rows });
const fakeKeys = (rows) => () => rows;
const fakeMcpCatalog = (entries) => ({
  browse: (installed) => {
    const ids = new Set((installed || []).map(x => x && x.id));
    return { connectors: entries.map(e => Object.assign({}, e, { installed: ids.has(e.id) })) };
  }
});
const fakeKeysCatalog = (platforms) => ({ PLATFORMS: platforms });

const CONNECTORS = [
  { id: 'notion', label: 'Notion', state: 'up', enabled: true, toolCount: 14, hasToken: true, oauth: true },
  { id: 'stripe', label: 'Stripe', state: 'error', enabled: true, toolCount: 0, detail: '401 unauthorized', hasToken: true }
];
const KEYS = [
  { id: 'k1', name: 'Printify', envVar: 'PRINTIFY_API_KEY', key: SECRET, enabled: true, autonomous: false, docsUrl: 'https://developers.printify.com/' },
  { id: 'k2', name: 'Disabled One', envVar: 'DISABLED_API_KEY', key: SECRET, enabled: false, autonomous: true }
];
const MCP_ENTRIES = [
  { id: 'notion', name: 'Notion', category: 'Productivity', authType: 'oauth', blurb: 'Notion pages.' },
  { id: 'github', name: 'GitHub', category: 'Developer Tools', authType: 'apikey', blurb: 'Issues, pull requests, code search, and Actions.' },
  { id: 'stripe', name: 'Stripe', category: 'Payments & Finance', authType: 'apikey', blurb: 'Payments.' }
];
const KEY_PLATFORMS = [
  { id: 'printify', name: 'Printify', category: 'Commerce & Print-on-Demand', envVar: 'PRINTIFY_API_KEY', docsUrl: 'https://developers.printify.com/' },
  { id: 'etsy', name: 'Etsy', category: 'Commerce & Print-on-Demand', envVar: 'ETSY_API_KEY', docsUrl: 'https://developers.etsy.com/' }
];

function toolWith(over) {
  const d = Object.assign({
    connectors: fakeManager(CONNECTORS),
    serviceKeys: fakeKeys(KEYS),
    connectorCatalog: fakeMcpCatalog(MCP_ENTRIES),
    keysCatalog: fakeKeysCatalog(KEY_PLATFORMS)
  }, over || {});
  return makeConnectorTools(d).listTool;
}

(async () => {
  const tool = toolWith();
  const all = await tool.run({});
  const text = all.content;

  /* ---- CONNECTED: the manager's truth, including an unhappy one ---- */
  A.ok(/CONNECTED \(2\)/.test(text), 'reports both configured connectors');
  A.ok(/notion.*14 tools/.test(text), 'a live connector reports its real tool count');
  A.ok(/stripe.*error.*401 unauthorized/.test(text), 'a broken connector reports the manager error, not a rosy catalog blurb');

  /* ---- KEYS: enabled-with-a-key only, by NAME ---- */
  A.ok(/KEYS \(1\)/.test(text), 'only the enabled key with a value is counted');
  A.ok(/\$\{PRINTIFY_API_KEY\}/.test(text), 'the key is referenced as an env-var placeholder');
  A.ok(/watched sessions only/.test(text), 'a non-autonomous key says so — the agent must not plan an unattended spend');
  A.ok(text.indexOf('DISABLED_API_KEY') < 0, 'a disabled key is not advertised as spendable');

  /* ---- THE LAW: no key value on any path ---- */
  A.ok(text.indexOf(SECRET) < 0, 'NO key value appears in the readout');
  A.ok(JSON.stringify(all).indexOf(SECRET) < 0, 'NO key value appears anywhere in the tool result, summary included');

  /* ---- AVAILABLE: only what is genuinely missing ---- */
  A.ok(/AVAILABLE \(2\)/.test(text), 'available = the 1 uninstalled connector + the 1 unconnected key platform, and nothing already wired');
  A.ok(/GitHub .*Developer Tools.*connector, api key/.test(text), 'an uninstalled connector is offered with its auth tier');
  A.ok(/Etsy .*API key \(ETSY_API_KEY\)/.test(text), 'an unconnected platform key is offered with its env var');
  const availableBlock = text.slice(text.indexOf('AVAILABLE'));
  A.ok(availableBlock.indexOf('Notion') < 0, 'an INSTALLED connector is never offered again');
  A.ok(availableBlock.indexOf('Stripe') < 0, 'an installed-but-erroring connector is still installed — not re-offered');
  A.ok(availableBlock.indexOf('Printify') < 0, 'a CONNECTED key platform is never offered again');
  // ONE FLAT LIST (UX night 2026-10-26): the catalog is APPS, the first item of CONNECT › ABILITIES' one list
  A.ok(/CONNECT . ABILITIES . APPS/.test(text) && !/DISCOVER|CATALOG:/.test(text), 'the readout names where the Commander actually adds one (the section the window draws)');
  A.ok(/cannot add these yourself/.test(text), 'the agent is told to offer, not to assume it can install');

  /* ---- the floor summary counts ENTRIES, not rendered lines ---- */
  A.eq(all.summary, 'connected:2 keys:1 available:2', 'the summary counts real entries');
  const emptySummary = await makeConnectorTools({
    connectors: fakeManager([]), serviceKeys: fakeKeys([]),
    connectorCatalog: fakeMcpCatalog(MCP_ENTRIES), keysCatalog: fakeKeysCatalog(KEY_PLATFORMS)
  }).listTool.run({});
  A.eq(emptySummary.summary, 'connected:0 keys:0 available:5', 'an empty station summarises as ZERO, never as the one "(none yet)" line it printed');

  /* ---- scope + query narrowing ---- */
  const onlyAvail = await tool.run({ scope: 'available' });
  A.ok(onlyAvail.content.indexOf('CONNECTED') < 0 && /AVAILABLE/.test(onlyAvail.content), 'scope:available drops the connected sections');
  const onlyConn = await tool.run({ scope: 'connected' });
  A.ok(/CONNECTED/.test(onlyConn.content) && onlyConn.content.indexOf('AVAILABLE') < 0, 'scope:connected drops the offer section');
  const q = await tool.run({ query: 'github' });
  A.ok(/GitHub/.test(q.content) && q.content.indexOf('Etsy') < 0, 'query filters the catalogs');
  const qcat = await tool.run({ query: 'commerce' });
  A.ok(/Etsy/.test(qcat.content) && qcat.content.indexOf('GitHub') < 0, 'query matches on category too');
  const bogus = await tool.run({ scope: 'nonsense' });
  A.ok(/CONNECTED/.test(bogus.content), 'an unknown scope falls back to all rather than erroring');

  /* ---- degradation: a missing or throwing dep goes SILENT, never confidently empty ---- */
  const bare = await makeConnectorTools({}).listTool.run({});
  A.ok(/No integration state is readable/.test(bare.content), 'with no deps at all it says it cannot see, not "you have nothing"');
  const thrower = await toolWith({ connectors: { list() { throw new Error('manager down'); } } }).run({ scope: 'connected' });
  A.ok(thrower.content.indexOf('CONNECTED') < 0, 'a throwing manager drops its section instead of claiming zero connectors');
  A.ok(/KEYS \(1\)/.test(thrower.content), 'a sibling section still renders when one dep fails');
  const noKeys = await toolWith({ serviceKeys: fakeKeys([]) }).run({});
  A.ok(/KEYS \(0\)/.test(noKeys.content) && /no platform API keys connected yet/.test(noKeys.content), 'an empty KEYS list is stated honestly');
  A.ok(/Printify/.test(noKeys.content.slice(noKeys.content.indexOf('AVAILABLE'))), 'with the key gone, its platform returns to the offer list');

  /* ---- the thunk seam: the tool must read the CURRENT list, not a boot-time snapshot ---- */
  let live = [];
  const liveTool = toolWith({ serviceKeys: () => live });
  A.ok(/KEYS \(0\)/.test((await liveTool.run({ scope: 'connected' })).content), 'starts with no keys');
  live = KEYS;
  A.ok(/KEYS \(1\)/.test((await liveTool.run({ scope: 'connected' })).content), 'a key added mid-process is visible on the next call');

  /* ---- CAP_REGISTRY wiring ---- */
  const grant = (CAP_REGISTRY.dish || []).find(g => g.tool === 'connectors.list');
  A.ok(!!grant, 'connectors.list is granted by the dish object');
  A.eq(grant.capId, 'web', 'it rides the web capId, alongside web_request');
  A.eq(grant.scope, 'read', 'it is a read');
  A.eq(grant.requiresConsent, false, 'a local read of our own config needs no consent');
  A.eq(grant.network, false, 'it touches no network');
  A.ok(!grant.deferred, 'NOT deferred — a tool that cures not-knowing-what-exists cannot require being found first');

  /* ---- tool def shape ---- */
  A.eq(tool.name, 'connectors.list', 'tool name');
  A.eq(tool.capability, 'web', 'tool def capability matches the grant capId');
  A.ok(tool.schema && tool.schema.type === 'object', 'has an object schema');
  A.ok(!tool.schema.required, 'every argument is optional — a bare call is the common case');

  A.report('connectors-tool');
})();
