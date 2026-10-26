/* node test/desktop-endpoint-handover.e2e.test.js — the desktop app hands the station its saved endpoints (GitHub #137).

   #137: on the desktop app the OS keychain holds provider KEYS only; a CUSTOM base URL lived in the window's storage
   and the sidecar's memory. After any app restart (an update included) or a sidecar respawn the station had no
   endpoint, so chat worked (each run carries its baseUrl) while a scheduled routine / Run Now failed "no CUSTOM base
   URL is saved on this station for this scheduled routine".

   A REAL hermetic sidecar plus the REAL harness.js hand-over functions (lifted by source into a sandbox whose
   `invoke` does what the Rust shell's harness_store_provider_key does: the keychain only when a key is given, then
   POST /api/key with the per-launch IPC token):
     · before the hand-over a CUSTOM routine's Run Now is refused with the #137 sentence (the reproduction)
     · the boot hand-over pushes each endpoint slot WITHOUT a key (the keychain is never touched; a cleared slot goes
       as a clear) and the routine runs
     · the station KEEPS what it was handed (.secrets/provider-endpoints.json, main + .bak): a sidecar respawn runs the
       routine with no page at all, and a routine that came due while the app was closed runs in the launch catch-up,
       before any window could hand anything over
     · the page's "no answer, then an answer" re-syncs once; a cleared endpoint stays cleared across a restart and
       leaves no copy on disk
     · a browser page never uses this path (its endpoint rides the engine-key copy, #89) */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const IPC = 'desktop-endpoint-handover-ipc-token-1234567890';
const harness = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const slice = (from, to) => {
  const a = harness.indexOf(from), b = harness.indexOf(to, a + 1);
  A.ok(a >= 0 && b > a, 'harness.js still has ' + from.trim().slice(0, 48));
  return harness.slice(a, b);
};
const helpers = slice('  function normalizeProviderId(provider) {', '  function providerNeedsKey(provider) {');
const handOver = slice('  /* #137 DESKTOP ENDPOINT HAND-OVER', '  // #62: no provider key contains whitespace');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function page(opts) {
  const store = new Map(Object.entries(opts.storage || {}));
  const invokes = [], warns = [];
  let settled = 0;
  const scope = {
    JSON, Promise, Map, Set, Array, String, Number, Object,
    DESKTOP: !!opts.desktop,
    LS: { key: 'starnet.byok.key', keyPool: 'starnet.byok.keyPool', baseUrl: 'starnet.byok.baseUrl', prov: 'starnet.byok.prov' },
    _configured: false, _configuredByProvider: {},
    getProv: () => 'custom',
    localStorage: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
      key: i => Array.from(store.keys())[i] || null,
      get length() { return store.size; }
    },
    invoke: async (cmd, args) => {
      invokes.push({ cmd, args: Object.assign({}, args) });
      try { return await opts.shell(cmd, args); } finally { settled++; }
    },
    console: { warn: m => warns.push(String(m)), log() {} }
  };
  const api = vm.runInNewContext(helpers + handOver + '\n({ pushDesktopEndpoints, noteStationReply, desktopEndpointsHeld })', scope);
  return { api, invokes, warns, settled: () => settled };
}

async function waitFor(fn, label) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(25); }
  A.ok(false, 'timed out waiting: ' + label);
}

(async () => {
  // a strict loopback OpenAI-compatible upstream (the user's CUSTOM endpoint)
  const chats = [];
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      if (req.url.indexOf('/v1/models') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'local/model', context_length: 8000 }] })); }
      if (req.url.indexOf('/v1/chat/completions') !== 0) { res.writeHead(404); return res.end(); }
      chats.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ROUTINE DONE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + upstream.address().port + '/v1';

  const env = { STARNET_IPC_TOKEN: IPC, STARNET_FULL_ACCESS: '1', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '' };
  // no ambient CUSTOM endpoint or key may stand in for the hand-over
  for (const name of ['CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY']) {
    env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = '';
  }
  const fixture = SidecarFixture.create({ prefix: 'desktop-endpoint-handover-', env });
  // the Rust shell's harness_store_provider_key (main.rs): the keychain only when a key is given; then push_provider_config
  // posts { provider, key? , baseUrl? } to /api/key with the per-launch IPC token
  const keychainWrites = [];
  const shell = async (cmd, args) => {
    if (cmd !== 'harness_store_provider_key') throw new Error('unexpected ' + cmd);
    const payload = { provider: args.provider };
    if (args.key != null) { keychainWrites.push(args.provider); payload.key = args.key; }
    if (args.baseUrl != null) payload.baseUrl = args.baseUrl;
    const r = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify(payload) });
    if (r.status !== 200) throw new Error('sidecar refused the push (HTTP ' + r.status + ')');
    return null;
  };
  try {
    await fixture.start();
    const agentId = 'routine-custom';
    A.eq((await fixture.json('POST', '/api/roster', { agents: [{ agentId, name: 'Custom', system: 'Answer briefly.', provider: 'custom', model: 'local/model' }], updatedAt: Date.now() })).status, 200, 'roster saved');
    await fixture.json('POST', '/api/cron/arm', { enabled: false });
    const made = await fixture.json('POST', '/api/cron', { name: 'Custom routine', prompt: 'Say the routine is done', schedule: 'every 1h', agentId, provider: 'custom', model: 'local/model', runsLine: false });
    A.eq(made.status, 200, 'routine created: ' + made.text);
    const jobId = made.body && made.body.job && made.body.job.id;
    const runNow = () => fixture.json('POST', '/api/cron/run', { id: jobId });
    const ranDone = r => r.status === 200 && /"name":"agent\.run\.end"[^\n]*"reason":"done"/.test(r.text);

    // the reproduction: the desktop station holds no endpoint after a launch
    const before = await runNow();
    A.eq(before.status, 400, 'a fresh desktop launch: Run Now is refused before the hand-over');
    A.ok(/no CUSTOM base URL is saved on this station/.test(String(before.body && before.body.error)), 'the refusal is the #137 sentence: ' + before.text);

    const storage = {
      'starnet.byok.prov': 'custom',
      'starnet.byok.baseUrl.custom': endpoint,
      'starnet.byok.baseUrl.ollama': 'http://192.168.1.50:11434',
      'starnet.byok.baseUrl.openai': '',              // an emptied endpoint is handed over as a clear
      'starnet.byok.baseUrl.anthropic': 'https://proxy.invalid/v1',   // a cloud provider's override: handed over, kept for this session only
      'starnet.byok.baseUrl.starnet': 'http://cloud.invalid'   // the linked account's endpoint is the sidecar's own
    };
    const desk = page({ desktop: true, storage, shell });

    // boot hand-over
    const out = await desk.api.pushDesktopEndpoints();
    A.eq(out.map(o => o.provider).sort(), ['anthropic', 'custom', 'ollama', 'openai'], 'the boot hand-over pushes every endpoint slot this window holds (never starnet)');
    A.ok(out.every(o => o.ok), 'every push landed');
    A.ok(desk.invokes.every(c => c.cmd === 'harness_store_provider_key' && !Object.prototype.hasOwnProperty.call(c.args, 'key')), 'no push carries a key');
    A.eq(keychainWrites.length, 0, 'the keychain is never touched by the hand-over');
    A.eq(desk.invokes.find(c => c.args.provider === 'custom').args.baseUrl, endpoint, 'the CUSTOM push carries the saved endpoint');
    A.eq((desk.invokes.find(c => c.args.provider === 'openai') || { args: {} }).args.baseUrl, '', 'a cleared slot is handed over as a clear');

    const after = await runNow();
    A.ok(ranDone(after), 'after the boot hand-over the CUSTOM routine runs to done: ' + after.text.slice(0, 400));
    A.ok(chats.length > 0, 'the routine reached the saved CUSTOM endpoint');

    // the station keeps what it was handed: URLs only, main AND .bak
    const endpointsFile = path.join(fixture.workspace, '.secrets', 'provider-endpoints.json');
    const onDisk = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
    for (const f of [endpointsFile, endpointsFile + '.bak']) {
      const saved = (() => { try { return JSON.parse(onDisk(f)); } catch (_) { return null; } })();
      A.eq(saved && saved.baseUrls, { custom: endpoint, ollama: 'http://192.168.1.50:11434' }, path.basename(f) + ' holds the CUSTOM and Ollama endpoints (no cleared one, no cloud override)');
    }

    // #137 respawn: the respawned sidecar reads its copy back — no page, no refused fetch, no hand-over needed
    const pushesBeforeRespawn = desk.invokes.length;
    await fixture.restart();
    const respawned = await runNow();
    A.ok(ranDone(respawned), 'a respawned sidecar still has the endpoint: the CUSTOM routine runs to done: ' + respawned.text.slice(0, 300));
    A.eq(desk.invokes.length, pushesBeforeRespawn, 'with no push from any page');

    // #137 launch catch-up: a routine that came due while the app was closed fires in the sidecar's boot reconcile,
    // before any window exists — it must run on the kept endpoint, never stop "no CUSTOM base URL is saved"
    A.eq((await fixture.json('POST', '/api/cron/arm', { enabled: true })).status, 200, 'the scheduler is armed');
    await fixture.stop();
    const cronFile = path.join(fixture.workspace, 'cron.jobs.json');
    const doc = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
    const job = (Array.isArray(doc.jobs) ? doc.jobs : (Array.isArray(doc) ? doc : [])).find(j => j && j.id === jobId);
    A.ok(job, 'the routine is in cron.jobs.json');
    job.nextRunAt = new Date(Date.now() - 3 * 3600e3).toISOString();   // the app was closed past the due time
    fs.writeFileSync(cronFile, JSON.stringify(doc));
    try { fs.unlinkSync(cronFile + '.bak'); } catch (_) {}
    const chatsBeforeLaunch = chats.length;
    const launchAt = Date.now();
    await fixture.start();
    let launched = null;
    for (let i = 0; i < 200; i++) {
      const list = await fixture.json('GET', '/api/cron');
      launched = ((list.body && list.body.jobs) || []).find(j => j.id === jobId) || null;
      if (launched && launched.state === 'blocked_config') break;
      if (launched && launched.lastStatus && Date.parse(launched.lastRunAt || 0) >= launchAt - 1000 && launched.state !== 'running') break;
      await sleep(100);
    }
    A.ok(launched && launched.state !== 'blocked_config', 'the launch catch-up is not blocked: ' + JSON.stringify(launched && { state: launched.state, lastError: launched.lastError }));
    A.eq(launched && launched.lastStatus, 'ok', 'the launch catch-up ran to ok on the kept endpoint');
    A.ok(chats.length > chatsBeforeLaunch, 'and reached the CUSTOM endpoint with no page pushing anything');
    A.eq((await fixture.json('POST', '/api/cron/arm', { enabled: false })).status, 200, 'the scheduler is disarmed again');

    // ... an answer with no silence before it does not push; a silence then an answer re-syncs once
    const pushes = desk.invokes.length;
    desk.api.noteStationReply(true);
    await sleep(50);
    A.eq(desk.invokes.length, pushes, 'an ordinary answer re-pushes nothing');
    desk.api.noteStationReply(false);
    desk.api.noteStationReply(false);
    A.eq(desk.invokes.length, pushes, 'nothing is pushed while the station is silent');
    desk.api.noteStationReply(true);
    await waitFor(() => desk.settled() === pushes + 4, 'the come-back hand-over');
    A.eq(desk.invokes.length, pushes + 4, 'the first answer after a silence re-syncs each endpoint slot once');
    desk.api.noteStationReply(true);
    await sleep(50);
    A.eq(desk.invokes.length, pushes + 4, 'later answers do not push again');
    const back = await runNow();
    A.ok(ranDone(back), 'after the come-back re-sync the CUSTOM routine runs to done again');
    A.eq(keychainWrites.length, 0, 'the keychain is still untouched');

    // a window that CLEARED its endpoints: the station forgets them, across a restart, in both copies on disk
    const cleared = page({ desktop: true, storage: { 'starnet.byok.baseUrl.custom': '', 'starnet.byok.baseUrl.ollama': '' }, shell });
    A.ok((await cleared.api.pushDesktopEndpoints()).every(o => o.ok), 'the clears landed');
    await fixture.restart();
    const gone = await runNow();
    A.eq(gone.status, 400, 'a cleared CUSTOM endpoint stays cleared after a restart');
    A.ok(/no CUSTOM base URL is saved on this station/.test(String(gone.body && gone.body.error)), 'and the refusal says so: ' + gone.text);
    for (const f of [endpointsFile, endpointsFile + '.bak']) {
      A.ok(!onDisk(f).includes(endpoint) && !onDisk(f).includes('192.168.1.50'), path.basename(f) + ' keeps no cleared endpoint');
    }
    A.eq(keychainWrites.length, 0, 'the keychain is never touched');

    // a failed push never rejects; it says what failed
    const broken = page({ desktop: true, storage: { 'starnet.byok.baseUrl.custom': endpoint }, shell: async () => { throw new Error('sidecar not up'); } });
    const failed = await broken.api.pushDesktopEndpoints();
    A.eq(failed, [{ provider: 'custom', ok: false }], 'a failed push resolves its failure');
    A.ok(broken.warns.some(w => /custom: could not hand the station its endpoint: sidecar not up/.test(w)), 'and is logged');

    // a browser page never takes this path
    const browser = page({ desktop: false, storage, shell });
    A.eq(await browser.api.pushDesktopEndpoints(), [], 'a browser page hands over nothing here (its copy rides /api/providers/engine-key)');
    browser.api.noteStationReply(false); browser.api.noteStationReply(true);
    await sleep(50);
    A.eq(browser.invokes.length, 0, 'a browser page never invokes the shell');
  } finally {
    await fixture.dispose();
    await new Promise(r => upstream.close(r));
  }

  // ---- wiring the sandbox can't see ----
  const initBody = harness.slice(harness.indexOf('  async function init() {'), harness.indexOf('  /* whether a key is set'));
  A.ok(/if \(!DESKTOP\) \{ syncEngineKeysOnBoot\(\); return; \}[^\n]*\n\s*pushDesktopEndpoints\(\);/.test(initBody), 'a desktop boot hands its endpoints over (not awaited)');
  A.ok(/rawFetch\(u, withApiToken\(init, t\)\)\.then\(res => \{\s*\n\s*noteStationReply\(true\);[\s\S]{0,400}if \(!\(e && e\.name === 'AbortError'\)\) noteStationReply\(false\);[^\n]*\n\s*throw e;/.test(harness),
    'the /api fetch wrapper reports each answer and each refused connection (never a caller abort), and still rethrows');
  A.ok(/\.then\(up => \{ if \(up\) pushDesktopEndpoints\(\); return up; \}\)/.test(harness), 'ENGINE RESTART re-hands the endpoints once the sidecar is back');
  A.report('desktop-endpoint-handover.e2e.test');
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
