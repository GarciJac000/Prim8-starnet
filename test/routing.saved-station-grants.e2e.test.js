/* node test/routing.saved-station-grants.e2e.test.js — a headless run's bay room comes from the SAVED station, over the
   REAL sidecar (qa/bugs/a9a4f53c).

   A dev-channel run (the same hub, router.stationFor and runOnce a Telegram message takes) is recorded off the provider
   wire by a mock OpenRouter that keeps each request's `tools`. The routing plan a page posts says which dock work runs
   at, and may narrow what that dock's agent gets there, never widen it past the saved room or the default office:
     1. with no saved station (no save on the server, a refused or unreadable save), a plan naming a bay for the chat's
        agent hands its run that bay's room held within the default office — nothing the default office lacks, and not
        the default office's NOTEBOOK the bay does not hold — before and after the restart that re-reads
        routing.plan.json; and an UNEQUIPPED bay (the floor paints NO COMPUTE) grants no compute: no provider call;
     2. with a saved station that crews the agent in a compute-only bay, neither a plan naming another bay nor a plan
        listing a CABINET and a DISH for the real bay adds a tool — before or after a restart;
     3. a DISH saved into that room reaches the run, and the plan's CABINET still does not;
     4. a plan listing less than the saved room (a save that lags after gear came off) narrows it: no DISH, no web_search.
   fs_write comes only from a cabinet, web_search only from a dish and notebook.* only from a notebook
   (capability/registry.js), so each one is a clean reading of which room the run was handed. In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const WM = require('../frontend/app/worldmodel.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { parsed = { parseError: String(e && e.message) }; }
          requests.push(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'listed.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

const toolNamesOf = req => ((req && req.tools) || []).map(t => String((t.function && t.function.name) || t.name || ''));
const sameSet = (a, b) => a.slice().sort().join(',') === b.slice().sort().join(',');
const within = (a, b) => a.every(n => b.indexOf(n) >= 0);
const isMemory = n => /^notebook[._-]?(write|read)$/.test(n);

(async () => {
  const mock = await startMockOpenRouter();
  const fixture = SidecarFixture.create({ prefix: 'sk-saved-station-grants-', env: {
    SKYNET_DEV: '1', SKYNET_QUEST_REFRESH: '0',
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-saved-station-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
  } });
  // one dev-channel task turn -> the tools of the widest provider request it made (a turn may also make toolless aux calls)
  const turn = async (label) => {
    const before = mock.requests.length;
    const r = await fixture.json('POST', '/api/dev/inbound', { chatId: 'auth1', text: 'please run a task: list the files in the workspace' });
    A.eq(r.status, 200, label + ': the dev inbound answers (' + String(r.text).slice(0, 160) + ')');
    const reqs = mock.requests.slice(before);
    A.ok(reqs.length >= 1, label + ': the run reached the provider');
    return reqs.map(toolNamesOf).sort((a, b) => b.length - a.length)[0] || [];
  };
  // one dev-channel task turn that must NOT reach the provider with tools (a compute-less room never makes a model call)
  const toollessTurn = async (label) => {
    const before = mock.requests.length;
    const r = await fixture.json('POST', '/api/dev/inbound', { chatId: 'auth1', text: 'please run a task: list the files in the workspace' });
    A.eq(r.status, 200, label + ': the dev inbound answers (' + String(r.text).slice(0, 160) + ')');
    A.ok(r.body && r.body.isTask === true, label + ': the message ran as a task (' + String(r.text).slice(0, 160) + ')');
    return mock.requests.slice(before).filter(q => toolNamesOf(q).length > 0);
  };
  const post = async (plan, label) => {
    const r = await fixture.json('POST', '/api/routing', plan);
    A.eq(r.status, 200, label + ' is accepted for routing (' + r.text + ')');
  };
  const save = async (doc, label) => {
    const rev = ((await fixture.json('GET', '/api/save?agent=agent')).body || {}).save;
    const r = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: 5, _saveRevision: (rev && rev._saveRevision) || 0, updatedAt: Date.now(), agent: { id: 'agent' }, station: doc });
    A.ok(r.status === 200 && r.body && r.body.ok === true, label + ' saves (' + String(r.text).slice(0, 160) + ')');
  };
  const WIDE = ['computer', 'workbench', 'dish', 'cabinet', 'orchestrator', { objectType: 'connector', connectorId: 'ghost-connector' }];
  // a bay for this chat's agent that no saved station holds
  const ghostPlan = { errors: [], hash: 'ghost', sources: [], belts: [],
    bays: [{ agentId: 'dev_auth1', propId: 'ghost_bay', objects: WIDE }], dockBays: [{ agentId: 'dev_auth1', propId: 'ghost_bay', objects: WIDE }] };
  // the same bay with nothing in its room: what the floor paints NO COMPUTE
  const barePlan = { errors: [], hash: 'bare', sources: [], belts: [],
    bays: [{ agentId: 'dev_auth1', propId: 'ghost_bay', objects: [] }], dockBays: [{ agentId: 'dev_auth1', propId: 'ghost_bay', objects: [] }] };
  // the saved bay listed with its compute only (what a page shows after the dish came off, before the save lands)
  const computeOnlyPlan = { errors: [], hash: 'compute-only', sources: [], belts: [],
    bays: [{ agentId: 'dev_auth1', propId: 'bay1', objects: ['computer'] }], dockBays: [{ agentId: 'dev_auth1', propId: 'bay1', objects: ['computer'] }] };
  // the saved bay, listed with room objects the saved room does not hold
  const listedPlan = { errors: [], hash: 'listed', sources: [], belts: [],
    bays: [{ agentId: 'dev_auth1', propId: 'bay1', objects: ['computer', 'cabinet', 'dish'] }], dockBays: [{ agentId: 'dev_auth1', propId: 'bay1', objects: ['computer', 'cabinet', 'dish'] }] };
  // a compute-only bay room crewed by the chat's agent (+ a dish when asked)
  const stationDoc = (withDish) => {
    const doc = WM.defaultDoc();
    doc.props.push({ id: 'bay1', t: 'bay', x: 4, y: 1, w: 2, h: 2, agentId: 'dev_auth1' });
    doc.props.push({ id: 'pc1', t: 'console', x: 7, y: 1, w: 2, h: 1, agentId: 'dev_auth1' });
    if (withDish) doc.props.push({ id: 'dish1', t: 'comms_dish', x: 10, y: 1, w: 1, h: 1 });
    doc._nid = 4;
    return doc;
  };
  try {
    await fixture.start();

    // ---- 1. no saved station: a plan's bay room is held within the default office, live and after a restart ----
    const base = await turn('baseline');
    A.ok(base.length > 0, 'baseline: the run carries its default office (' + base.length + ' tools)');
    A.ok(base.some(isMemory), 'baseline: the default office carries the NOTEBOOK (' + base.filter(isMemory).join(',') + ')');
    await post(ghostPlan, 'a plan naming a bay no station holds');
    const ghost = await turn('ghost bay');
    A.ok(within(ghost, base), 'with no saved station, a plan\'s bay adds no tool the default office lacks (extra: ' + ghost.filter(n => base.indexOf(n) < 0).join(',') + ')');
    A.ok(ghost.indexOf('fs_write') >= 0 && ghost.indexOf('web_search') >= 0, 'the plan\'s CABINET and DISH, both in the default office, reach the run');
    A.ok(!ghost.some(isMemory), 'the default office\'s NOTEBOOK, which the bay room does not hold, is not granted: the bay is not handed the full office');
    await fixture.restart();
    const ghostReboot = await turn('ghost bay after restart');
    A.ok(sameSet(ghostReboot, ghost), 'after a restart re-reads routing.plan.json the run gets the same bounded room (' + ghostReboot.length + ' vs ' + ghost.length + ')');
    await post(barePlan, 'a plan naming an unequipped bay');
    const bare = await toollessTurn('unequipped bay, no saved station');
    A.eq(bare.length, 0, 'with no saved station, an UNEQUIPPED bay grants no compute: the run makes no tooled provider call (not the full office)');
    await post(ghostPlan, 'the ghost-bay plan again');

    // ---- 2. a saved compute-only bay: no plan widens it ----
    await save(stationDoc(false), 'a compute-only bay crewed by the chat\'s agent');
    const narrow = await turn('saved compute-only bay, ghost plan');
    A.eq(narrow.indexOf('fs_write'), -1, 'saved compute-only bay: the plan\'s CABINET on a bay the station does not hold grants no fs_write');
    A.eq(narrow.indexOf('web_search'), -1, 'saved compute-only bay: the plan\'s DISH grants no web_search');
    A.ok(narrow.length < base.length, 'the saved bay room is narrower than the default office (' + narrow.length + ' < ' + base.length + ')');
    await post(listedPlan, 'a plan listing a cabinet and a dish for the saved bay');
    const listed = await turn('saved bay, listed objects');
    A.ok(sameSet(listed, narrow), 'objects a plan lists for the saved bay add nothing (' + listed.length + ' vs ' + narrow.length + ')');
    await fixture.restart();
    const listedReboot = await turn('saved bay after restart');
    A.ok(sameSet(listedReboot, narrow), 'after a restart, before any page posts again, the run gets the same saved room');

    // ---- 3. the saved room IS the grant: a dish saved into it reaches the run, the plan's cabinet still does not ----
    await save(stationDoc(true), 'the same bay room with a dish');
    const dish = await turn('saved bay with a dish');
    A.ok(dish.indexOf('web_search') >= 0, 'the DISH saved into the bay room reaches the run (web_search offered)');
    A.eq(dish.indexOf('fs_write'), -1, 'the plan\'s CABINET, which the saved room does not hold, still grants no fs_write');

    // ---- 4. a plan may narrow the saved room: a lagging save after the dish came off hands no dish back ----
    await post(computeOnlyPlan, 'a plan listing the saved bay with its compute only');
    const lag = await turn('saved bay with a dish, plan without it');
    A.eq(lag.indexOf('web_search'), -1, 'the saved DISH the plan no longer lists is not granted (the grant is never wider than the plan)');
    A.ok(sameSet(lag, narrow), 'the run gets the compute-only room both agree on (' + lag.length + ' vs ' + narrow.length + ')');
  } finally {
    await fixture.dispose();
    mock.server.close();
  }
  A.report('routing.saved-station-grants.e2e');
})().catch(e => { console.error(e); process.exitCode = 1; });
