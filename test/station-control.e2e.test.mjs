/* node test/station-control.e2e.test.mjs — station.settings / station.control / station.power END TO END, in real
   Chromium (2026-10-02, "the agent can do anything the Commander asks, safely").

   The unit suite proves the tools against stubs. Only this proves the chain the lead actually uses: a MOCK model finds
   the deferred tools with tool_search, reads the settings, and changes them → the REAL sidecar tools → page actions over
   the REAL station bridge (stationcommands.js → the Dossier/rail/LOOK setters → the save read-back) and server actions
   through the sidecar's OWN route table in-process (callOwnRoute) → the results the model receives. Then it holds every
   change to what the station really shows: the page's live state, the server's own GET routes, and — after a RELOAD —
   the saved station, so nothing "worked until refresh".

   Isolated exactly like station-layout.e2e: fresh seeded workspace, APPDATA/LOCALAPPDATA/USERPROFILE/HOME/HERMES_HOME
   in scratch, a fresh Chrome profile, OS-picked ports, a local mock model. Skips LOUDLY with no Chromium. In test:http. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { bootToken } = require('./_httpToken.js');

let chromePath = null;
try { chromePath = findChrome(); } catch (_) { chromePath = null; }
if (!chromePath) { console.log('station-control.e2e: SKIPPED — no Chromium installed (this box cannot run the live bridge)'); process.exit(0); }

const failures = [];
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); if (!ok) failures.push(name); };
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const a = server.address(); server.close(e => e ? reject(e) : resolve(a.port)); });
});
const stopChild = (child) => new Promise(resolve => {
  if (!child || child.exitCode != null) { resolve(); return; }
  const timer = setTimeout(resolve, 6000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { child.kill('SIGKILL'); } catch {} });
    else child.kill('SIGKILL');
  } catch (_) { clearTimeout(timer); resolve(); }
});

const MARK = 'STATION-CONTROL-E2E';
// the mock model: a request carrying MARK plays mock.script one call per turn (call i = the i-th tool result so far),
// then answers in words; anything else (background propose-level work) gets plain text and no tool call
function startMock() {
  const mock = { requests: [], script: [], results: [] };
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }, { id: 'test/model2', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch (_) {}
      mock.requests.push(p);
      const mine = JSON.stringify(p.messages || []).indexOf(MARK) >= 0 && (p.tools || []).length > 0;
      const answered = (p.messages || []).filter(m => m && m.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (mine && answered.length < mock.script.length) {
        const c = mock.script[answered.length];
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + answered.length, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] });
        send({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      } else {
        if (mine) mock.results = answered.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        send({ choices: [{ delta: { content: 'Done.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      }
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { mock.server = server; mock.base = 'http://127.0.0.1:' + server.address().port + '/api/v1'; r(mock); }));
}
// answer(prompt) -> decision: every permission.prompt on the run's own stream is answered through /api/consent, the way the desk card does
async function leadRun(base, token, prompt, answer) {
  const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base };
  const res = await fetch(base + '/api/run', { method: 'POST', headers,
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: MARK + ' ' + prompt }] }) });
  const events = [], prompts = [];
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', runId = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let ev = null; try { ev = JSON.parse(line); } catch (_) {}
      if (!ev) continue;
      events.push(ev);
      if (ev.name === 'agent.run.start') runId = ev.payload.runId;
      if (ev.name === 'permission.prompt') {
        prompts.push(ev.payload);
        const decision = answer ? answer(ev.payload) : 'deny';
        fetch(base + '/api/consent', { method: 'POST', headers, body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) }).catch(() => {});
      }
    }
  }
  return { status: res.status, events, prompts };
}
const api = async (base, token, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, json: j };
};

const root = mkdtempSync(join(tmpdir(), 'starnet-control-e2e-'));
const iso = {};
for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home'], ['HERMES_HOME', 'hermes']]) { iso[k] = join(root, 'iso', d); mkdirSync(iso[k], { recursive: true }); }
const workspace = join(root, 'workspace'), profile = join(root, 'profile');
const mock = await startMock();
const appPort = await freePort(), cdpPort = await freePort();
const base = 'http://127.0.0.1:' + appPort;
materializeSeedWorkspace(workspace, 'test/model');
const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace, model: 'test/model', key: 'sk-or-v1-fake', env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base }, iso) });
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--remote-debugging-port=' + cdpPort, '--window-size=1440,900', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

let cdp = null, sidecar2 = null;
try {
  check('isolated seeded sidecar starts', await waitUp(base + '/'));
  const token = await bootToken(base, base);
  cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 45000;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the real page reaches the live station', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));

  // two sessions and a specialist to change, made the way the UI makes them, then saved
  const setup = await evalJS(cdp, `(async () => {
    Workstreams.create('Research notes', { activate: false }); Workstreams.create('Scratch', { activate: false });
    if (!App.agents().some(a => a.id === 'researcher')) App.summonAgent(Specialties.get('researcher'), { activate: false });
    App.persist(); await CloudSave.flush({ force: true });
    return { sessions: Workstreams.list().map(w => w.title), crew: App.agents().map(a => a.id + ':' + a.name), hero: App.agents().find(a => a.id === 'agent') };
  })()`);
  check('setup: two sessions and a researcher on the crew', !!setup && setup.sessions.indexOf('Research notes') >= 0 && setup.crew.some(c => /^researcher:/.test(c)), JSON.stringify(setup && { s: setup.sessions, c: setup.crew }));
  const researcherName = ((setup && setup.crew) || []).find(c => /^researcher:/.test(c)).split(':')[1];

  // ---- ONE lead run: find the tools, read, then change the station the way a Commander would ask ----
  mock.script = [
    { name: 'tool_search', args: { query: 'station settings' } },                                                              // 0
    { name: 'station_settings', args: {} },                                                                                       // 1
    { name: 'station_control', args: { action: 'agent.rename', args: { agent: 'agent', name: 'Atlas' } } },                       // 2
    { name: 'station_control', args: { action: 'agent.personality', args: { agent: 'ATLAS', personality: 'composed' } } },         // 3
    { name: 'station_control', args: { action: 'session.rename', args: { session: 'Research notes', title: 'Mars research' } } },  // 4
    { name: 'station_control', args: { action: 'session.pin', args: { session: 'Mars research' } } },                             // 5
    { name: 'station_control', args: { action: 'session.archive', args: { session: 'Scratch' } } },                               // 6
    { name: 'station_control', args: { action: 'look.set', args: { look: { theme: 'green', textScale: 115 } } } },                 // 7
    { name: 'station_control', args: { action: 'learning.set', args: { on: false } } },                                           // 8
    { name: 'station_power', args: { action: 'budget.set', args: { perDay: 7 } } },                                               // 9
    { name: 'station_settings', args: { section: 'spending' } },                                                                  // 10
    { name: 'station_control', args: { action: 'fullpower.set', args: { on: true } } },                                           // 11 (refused: an escalation)
    { name: 'station_control', args: { action: 'agent.delete', args: { agent: researcherName } } },                               // 12
    { name: 'station_control', args: { action: 'session.delete', args: { session: 'Scratch' } } },                                // 13
    { name: 'station_control', args: { action: 'look.set', args: { look: { theme: 'chartreuse' } } } },                           // 14 (refused: not a theme)
    { name: 'station_control', args: { action: 'agent.model', args: { agent: 'agent', model: 'test/model2', provider: 'openrouter' } } } // 15
  ];
  const run = await leadRun(base, token, 'rename yourself Atlas, tidy my sessions, go green and bigger text, pause learning, cap spending at $7 a day, remove the researcher');
  // Full Access is the Commander's zero-prompt posture: the untainted run (the $7 cap included) raised no card
  check('Full Access: no approval card on an untainted run', run.prompts.length === 0, JSON.stringify(run.prompts.map(x => x.tool)));
  const end = run.events.filter(e => e.name === 'agent.run.end').pop();
  check('the lead run completes', run.status === 200 && !!end && end.payload.reason === 'done', JSON.stringify(end && end.payload && end.payload.reason));
  const R = mock.results;
  check('the model received every result', R.length === mock.script.length, R.length + ' of ' + mock.script.length);
  const ok = i => typeof R[i] === 'string' && /^{"done":|^{"crew"|^{"budget/.test(R[i]);
  check('tool_search reveals the three tools', /station\.settings|station_settings/.test(R[0] || '') && /station[._]control/.test(R[0] || '') && /station[._]power/.test(R[0] || ''), (R[0] || '').slice(0, 300));
  check('station_settings reads the crew, sessions and look', ok(1) && /"crew"/.test(R[1]) && /Research notes/.test(R[1]) && /"look"/.test(R[1]) && /"options"/.test(R[1]), (R[1] || '').slice(0, 200));
  for (const [i, what] of [[2, 'rename the hero'], [3, 'personality'], [4, 'rename a session'], [5, 'pin it'], [6, 'archive one'], [7, 'the look'], [8, 'pause learning'], [9, 'cap spending (station_power)'], [12, 'delete the researcher'], [13, 'delete a session'], [15, 'pin the hero\'s model']])
    check('changed: ' + what, ok(i), (R[i] || '').slice(0, 240));
  check('spending read shows the new $7 cap', ok(10) && /"perDay":7/.test(R[10]), (R[10] || '').slice(0, 240));
  check('⛔ station_control refuses Full Power on (an escalation)', /^REFUSED: .*station\.power/.test(R[11] || ''), (R[11] || '').slice(0, 200));
  check('a bad value is refused with the real choices', /^REFUSED: .*theme must be one of/.test(R[14] || ''), (R[14] || '').slice(0, 200));

  // ---- the station really shows it: page state + the server's own reads ----
  const live = await evalJS(cdp, `(() => {
    const hero = App.agents().find(a => a.id === 'agent');
    const all = Workstreams.list({ includeArchived: true });
    const mars = all.find(w => w.title === 'Mars research');
    return { name: hero && hero.name, persona: hero && hero.personaId, model: hero && hero.model, crew: App.agents().map(a => a.id),
      mars: mars && { pinned: !!mars.pinned, archived: !!mars.archived }, scratch: !!all.find(w => w.title === 'Scratch'),
      theme: StationUI.getTheme(), text: StationUI.lookNow().textScale, bodyGreen: document.body.classList.contains('theme-green') };
  })()`);
  check('page: the hero is ATLAS, composed', live && live.name === 'ATLAS' && live.persona === 'composed', JSON.stringify(live));
  check('page: Mars research is pinned, Scratch is gone', live && live.mars && live.mars.pinned && !live.mars.archived && !live.scratch);
  check('page: the researcher left the crew', live && live.crew.indexOf('researcher') < 0);
  check('page: green theme on screen at 115% text', live && live.theme === 'green' && live.bodyGreen && live.text === 115);
  check('page: the hero runs test/model2', live && live.model === 'test/model2');
  const budget = await api(base, token, 'GET', '/api/budget/status');
  check('server: the per-day cap is $7', budget.json && budget.json.caps && budget.json.caps.perDay === 7, JSON.stringify(budget.json && budget.json.caps));
  const pers = await api(base, token, 'GET', '/api/personalization');
  check('server: learning is paused', pers.json && pers.json.enabled === false, JSON.stringify(pers.json && pers.json.enabled));
  const perms = await api(base, token, 'GET', '/api/permissions');
  check('server: Full Power was NOT turned on', perms.json && perms.json.masterBypass === false, JSON.stringify(perms.json && perms.json.masterBypass));

  // ---- survives a reload (the save, not the page's memory) ----
  await cdp.send('Page.navigate', { url: base + '/' });
  check('the page reloads', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));
  const after = await evalJS(cdp, `(() => {
    const hero = App.agents().find(a => a.id === 'agent');
    const mars = Workstreams.list({ includeArchived: true }).find(w => w.title === 'Mars research');
    return { name: hero && hero.name, model: hero && hero.model, crew: App.agents().map(a => a.id), pinned: !!(mars && mars.pinned), scratch: !!Workstreams.list({ includeArchived: true }).find(w => w.title === 'Scratch'), theme: StationUI.getTheme(), text: StationUI.lookNow().textScale };
  })()`);
  check('after reload: every change is still there', after && after.name === 'ATLAS' && after.model === 'test/model2' && after.crew.indexOf('researcher') < 0 && after.pinned && !after.scratch && after.theme === 'green' && after.text === 115, JSON.stringify(after));

  const errs = (diagnostics.exceptions || []).filter(e => !/favicon|ERR_ABORTED|net::ERR/i.test(String(e)));
  check('no uncaught page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));

  /* ---- PHASE 2: ASK MODE, the way a Commander meets it. A second station with Full Access OFF; the Commander TYPES
     the request into COMMS; every change raises the real approval card, whose words come from the catalog. Approve the
     look and the cap; DENY Full Power — the deny must leave it off. ---- */
  const workspace2 = join(root, 'workspace2'), appPort2 = await freePort(), base2 = 'http://127.0.0.1:' + appPort2;
  materializeSeedWorkspace(workspace2, 'test/model');
  sidecar2 = bootSeededSidecar({ port: appPort2, scratchDir: workspace2, model: 'test/model', key: 'sk-or-v1-fake', fullAccess: false, env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base }, iso) });
  check('ASK station starts (Full Access off)', await waitUp(base2 + '/'));
  const token2 = await bootToken(base2, base2);
  await cdp.send('Page.navigate', { url: base2 + '/' });
  check('ASK station page is live', await waitDevReady(cdp, evalJS, { url: base2 + '/', tries: 60 }));
  mock.results = [];
  mock.script = [
    { name: 'tool_search', args: { query: 'station settings' } },
    // a COMMS-typed task settles its Task Brief before consequential tools (a real model does exactly this)
    { name: 'brief_proceed', args: { objective: 'change the station settings the Commander asked for', deliverable: 'the settings changed' } },
    { name: 'station_control', args: { action: 'look.set', args: { look: { theme: 'blue' } } } },
    { name: 'station_power', args: { action: 'budget.set', args: { perDay: 9 } } },
    { name: 'station_power', args: { action: 'fullpower.set', args: { on: true } } }
  ];
  await evalJS(cdp, `(() => { const t = document.getElementById('chat-input'); t.value = ${JSON.stringify(MARK + ' please make my station blue, set my daily spending cap to $9 and turn on full power')}; t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return true; })()`);
  const cards = [], keys = [];
  const answers = ['Approve once', 'Approve once', 'Deny'];
  for (let i = 0; i < 240 && cards.length < answers.length; i++) {
    // the live approval card: a COMMS row marked .consent whose Approve/Deny buttons are still enabled
    const pick = answers[cards.length];
    // the keys are read by their own labels (textContent): the Pip-Boy pass sets the card keys in caps
    // (text-transform: uppercase), so innerText says "ALWAYS" / "FULL ACCESS" — a case-sensitive read of it saw no keys at all
    const seen = await evalJS(cdp, `(() => { const live = [...document.querySelectorAll('.consent')].filter(r => [...r.querySelectorAll('.consent-btns button')].some(b => !b.disabled));
      if (!live.length) return null; const r = live[live.length - 1]; const all = [...r.querySelectorAll('.consent-btns button')]; const b = all.find(x => x.textContent.trim() === ${JSON.stringify(pick)});
      const text = r.innerText.slice(0, 600), labels = all.map(x => x.textContent.trim()); if (b) b.click(); return { text, labels }; })()`);
    if (seen) { cards.push(seen.text); keys.push(seen.labels); }
    await sleep(500);
  }
  check('three approval cards appeared in COMMS', cards.length === 3, cards.length + ' cards');
  check('card 1 names the look change in the station\'s own words', /NOVA wants to change the station's look/.test(cards[0] || ''), (cards[0] || '').slice(0, 300));
  check('card 2 names the new $9 daily cap', /wants to set your spending limits: perDay \$9/.test(cards[1] || ''), (cards[1] || '').slice(0, 300));
  check('⛔ an escalation card offers Approve once / Deny only (no Always, no Full access)', [1, 2].every(i => JSON.stringify(keys[i] || []) === JSON.stringify(['Approve once', 'Deny'])) && (keys[0] || []).indexOf('Always') >= 0 && (keys[0] || []).indexOf('Full access') >= 0, JSON.stringify(keys));
  check('card 3 names Full Power for what it is', /FULL POWER: every agent acts on this computer without asking/.test(cards[2] || ''), (cards[2] || '').slice(0, 300));
  for (let i = 0; i < 60 && mock.results.length < mock.script.length; i++) await sleep(500);
  check('the approved look landed', await evalJS(cdp, 'StationUI.getTheme()') === 'blue');
  const b2 = await api(base2, token2, 'GET', '/api/budget/status');
  check('the approved $9 cap landed', b2.json && b2.json.caps && b2.json.caps.perDay === 9, JSON.stringify(b2.json && b2.json.caps));
  const p2 = await api(base2, token2, 'GET', '/api/permissions');
  check('⛔ the DENIED Full Power stayed off', p2.json && p2.json.masterBypass === false, JSON.stringify(p2.json && p2.json.masterBypass));
  check('the model was told Full Power was denied', /denied/i.test(mock.results[4] || ''), (mock.results[4] || '').slice(0, 200));
} catch (e) {
  check('the e2e ran to the end', false, (e && e.stack) || String(e));
} finally {
  try { if (cdp) cdp.close(); } catch (_) {}
  await stopChild(chrome); await stopChild(sidecar); await stopChild(sidecar2);
  try { mock.server.close(); } catch (_) {}
  try { rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
if (failures.length) { console.log('station-control.e2e: ' + failures.length + ' FAILED'); process.exit(1); }
console.log('station-control.e2e: ALL PASS');
