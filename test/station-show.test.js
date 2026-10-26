// station.show — the agent opens a StarNet window for the Commander (2026-10-04, "so it can basically use itself").
// The REAL tool (sidecar/tools/builtin/station-show.js) through the REAL page verb (frontend/app/stationcommands.js
// station.show) over a recorded StationUI, plus drift checks that every place names a window/section that exists.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Places = require('../frontend/app/places.js');
const { makeStationShowTool } = require('../sidecar/tools/builtin/station-show.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const commands = read('frontend/app/stationcommands.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ---- A. the catalog ----
const ids = Places.ids();
eq(new Set(ids).size, ids.length, 'place ids are unique');
for (const p of Places.PLACES) {
  ok(/^[a-z][a-z-]*$/.test(p.id) && p.words && p.about && p.open && Object.keys(p.open).length, p.id + ': id, words, about and a door');
  ok(Object.isFrozen(p) && Object.isFrozen(p.open), p.id + ': frozen');
}
eq(Places.get('DELIVERABLES ').id, 'deliverables', 'lookup trims and ignores case');
eq(Places.get('nope'), null, 'an unknown place is null, never a guess');

// ---- B. drift: every door names a window and section the UI really has ----
const ui = read('frontend/app/stationui.js');
const builders = ui.slice(ui.indexOf('const BUILDERS = {'), ui.indexOf('function registerWindow'));
const windows = new Set([...builders.matchAll(/^\s{4}([a-z]+):\s*\[/gm)].map(m => m[1]));
for (const f of fs.readdirSync(path.join(__dirname, '..', 'frontend', 'app')).concat(fs.readdirSync(path.join(__dirname, '..', 'frontend', 'app', 'windows')).map(x => 'windows/' + x))) {
  if (!/\.js$/.test(f)) continue;
  for (const m of read('frontend/app/' + f).matchAll(/registerWindow\('([a-z]+)'/g)) windows.add(m[1]);
}
const aliases = new Set([...ui.slice(ui.indexOf('const TERM_ALIAS = {'), ui.indexOf('function openTerm(')).matchAll(/^\s{4}([a-z]+):\s*\{ term:/gm)].map(m => m[1]));
const sectionIds = src => new Set([...src.matchAll(/\{ id: '([a-z-]+)', label:/g)].map(m => m[1]));
const sections = {
  settings: sectionIds(ui.slice(ui.indexOf("{ id: 'providers', label: 'AI & MODELS'"), ui.indexOf("mountConsole(body, 'settings'"))),
  connectors: new Set([...sectionIds(read('frontend/app/windows/connectors.js')), ...sectionIds(ui.slice(ui.indexOf("{ id: 'market', label: 'SKILL MARKET'") - 10, ui.indexOf("{ id: 'exchange', label: 'SKILL EXCHANGE'") + 60))]),
  automation: new Set(['routines', 'routines-create', 'loops', 'loops-start', 'away']),
  quests: new Set(['progress'])
};
const autoSrc = read('frontend/app/windows/automation.js');
for (const s of sections.automation) ok(autoSrc.indexOf("'" + s + "'") >= 0, 'the AUTOMATION console still has section ' + s);
ok(/openTerm\('quests', 'progress'\)/.test(ui), 'QUESTS still opens on PROGRESS');
for (const p of Places.PLACES) {
  const o = p.open;
  if (o.term) {
    ok(windows.has(o.term) || aliases.has(o.term), p.id + ': window "' + o.term + '" exists (a builder, a registered window or an alias)');
    if (o.section) ok(sections[o.term] && sections[o.term].has(o.section), p.id + ': ' + o.term + ' has section "' + o.section + '"');
  }
  if (o.agent) ok(sectionIds(ui.slice(ui.indexOf("mountConsole(body, 'agents', ["), ui.indexOf("mountConsole(body, 'agents', [") + 4000)).has(o.agent), p.id + ': the dossier has tab ' + o.agent);
  if (o.fn) ok(['build', 'recruit', 'recipes', 'needs-you'].indexOf(o.fn) >= 0, p.id + ': a known door');
}
// every dock window a Commander can open is a place (a new window must be added here, or the agent cannot show it)
for (const k of ['tasks', 'deliverables', 'settings', 'notifs', 'manual', 'quests', 'updates', 'commander', 'workflows', 'automation', 'connectors', 'messaging', 'trophies', 'apps', 'browser', 'stepin']) {
  ok(Places.PLACES.some(p => p.open.term === k), 'window ' + k + ' is reachable as a place');
}

// ---- C. the grant: always-present, consent-free, deferred (no prompt bytes) ----
const grant = Object.values(CAP_REGISTRY).flat().find(g => g.tool === 'station.show');
eq(grant && [grant.capId, grant.scope, grant.requiresConsent, grant.deferred, grant.network], ['stationinfo', 'read', false, true, false], 'station.show: stationinfo, read (no Task Brief gate), no consent, deferred, local');
ok(require('../sidecar/taskbrief-policy.js').canMutate({ status: 'draft' }, boot().tool).ok, 'an unsettled Task Brief never stands between "show me" and the window');

// ---- D. the tool over the real page verb ----
function boot(opts) {
  opts = opts || {};
  const calls = [], acks = [];
  const open = new Set(opts.open || []);
  const crew = [{ id: 'agent', name: 'NOVA' }, { id: 'w1', name: 'REX' }, { id: 'w2', name: 'Rex2' }];
  // opts.unconfirmed: the watched run's send is in flight but its agent.run.start has not reached the page yet (it rides
  // the run's own stream, the command the event stream); opts.confirm then lands that run.start 30ms later, in
  // harness.js order: the bus hears it first, then the run's onRunId stamps the channel
  let pageRunId = opts.unconfirmed ? null : 'run1';
  const handlers = {};
  const bus = { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, off: (ev, fn) => { const a = handlers[ev] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    emit: (ev, p) => (handlers[ev] || []).slice().forEach(fn => fn(p)), count: ev => (handlers[ev] || []).length };
  if (opts.unconfirmed && opts.confirm) setTimeout(() => { bus.emit('agent.run.start', { runId: opts.confirm }); pageRunId = opts.confirm; }, 30);
  const shown = key => open.has(key) ? { open: true, key, title: key.toUpperCase(), section: null } : { open: false, key };
  const context = {
    Places, console, setTimeout, clearTimeout,
    document: { addEventListener: () => {} },
    fetch: async (url, init) => { acks.push(JSON.parse(init.body)); return { ok: true }; },
    Workstreams: { activeId: () => opts.active || 'ws1' },
    Channels: { isBusy: id => id === 'ws1' && !opts.idle, runIdOf: id => id === 'ws1' ? pageRunId : null },
    App: { agents: () => crew, openSummonBay: () => { calls.push('summon'); setTimeout(() => open.add('marketplace'), 250); }, openRecipes: () => { calls.push('recipes'); open.add('marketplace'); },
      showNeedsYou: () => { calls.push('needs-you'); return { open: !opts.railHidden, key: 'needs-you', waiting: 2 }; } },
    Marketplace: { currentTab: () => opts.tab || null },
    Build: { open: () => { calls.push('build'); open.add('build'); }, isOpen: () => open.has('build') },
    StationUI: {
      showTerm: (key, section) => { calls.push(['term', key, section]); if (opts.refuse !== key && key !== 'marketplace') open.add(key); const r = shown(key); if (r.open) r.section = section || null; return r; },
      showAgent: (id, section, desk) => { calls.push(['agent', id, section, desk]); return { open: true, key: desk ? 'desk' : 'agents', agent: id, section }; }
    }
  };
  if (opts.unconfirmed) context.U = { bus };
  vm.createContext(context);
  const S = vm.runInContext(commands + '\nStationCommands;', context);
  const station = { request: async (verb, args) => { await S.run('r' + acks.length, verb, args); return acks.at(-1); } };
  const { tool } = makeStationShowTool({ station: opts.noPage ? null : station });
  const ctx = opts.ctx === undefined ? { streamId: 'ws1', runId: 'run1' } : opts.ctx;
  return { run: args => tool.run(args, ctx), calls, tool, bus };
}

(async () => {
  const t = boot().tool;
  eq(t.schema.properties.place.enum, ids, 'the schema offers exactly the catalog');
  for (const p of Places.PLACES) ok(t.description.indexOf(p.id + ' (' + p.words + ')') >= 0, 'the description names ' + p.id + ' in the UI\'s words');

  let env = boot(), r = await env.run({ place: 'deliverables' });
  ok(/^OPEN on the Commander's screen: MY WORK › DELIVERABLES/.test(r.content), 'a window opens and the answer names it in UI words');
  eq(env.calls, [['term', 'deliverables', undefined]], 'through showTerm, once');

  env = boot(); r = await env.run({ place: 'settings-spending' });
  eq(env.calls, [['term', 'settings', 'budget']], 'a settings section lands on its console section');
  env = boot(); await env.run({ place: 'new-schedule' });
  eq(env.calls, [['term', 'automation', 'routines-create']], 'a form opens on its own section');
  env = boot(); await env.run({ place: 'to-review' });
  eq(env.calls, [['term', 'outbox', undefined]], 'the old OUTBOX door (an alias) is how TO REVIEW opens');

  env = boot(); r = await env.run({ place: 'agent-config', agent: 'rex' });
  eq(env.calls, [['agent', 'w1', 'config', false]], 'an agent by name (case-insensitive) opens its dossier tab');
  ok(/for REX/.test(r.content), 'the answer names the agent');
  env = boot(); await env.run({ place: 'agent-desk', agent: 'agent' });
  eq(env.calls, [['agent', 'agent', null, true]], 'an agent by id opens its desk');
  ok(/^REFUSED:.*needs the agent/.test((await boot().run({ place: 'agent' })).content), 'an agent place without an agent refuses before the page');
  r = await boot().run({ place: 'agent', agent: 'zed' });
  ok(/^REFUSED: no agent called "zed" \(crew: NOVA, REX, Rex2\)/.test(r.content), 'an unknown agent refuses with the real roster');

  // org P01: NEEDS YOU heads the SESSIONS rail (not a window): App.showNeedsYou puts it in front, and a hidden rail is never reported open
  env = boot(); r = await env.run({ place: 'needs-you' });
  eq(env.calls, ['needs-you'], 'NEEDS YOU opens through App.showNeedsYou');
  ok(/^OPEN on the Commander's screen: SESSIONS › NEEDS YOU/.test(r.content), 'and the answer names it in UI words');
  r = await boot({ railHidden: true }).run({ place: 'needs-you' });
  ok(/^REFUSED: SESSIONS › NEEDS YOU did not open/.test(r.content), 'a hidden rail (BUILD MODE) is never reported open');
  env = boot(); await env.run({ place: 'build-mode' });
  eq(env.calls, ['build'], 'BUILD MODE opens through Build.open');
  env = boot(); r = await env.run({ place: 'recruit' });
  ok(/Recruitment Bay/.test(r.content) && env.calls.indexOf('summon') >= 0, 'the recruit bay opens (and the verb waits for its window)');
  env = boot({ open: ['marketplace'], tab: 'agents' }); await env.run({ place: 'recruit' });
  ok(env.calls.indexOf('summon') < 0, 'a recruit bay already showing is RAISED, not re-opened (a half-built class survives)');
  env = boot({ open: ['marketplace'], tab: 'agents' }); await env.run({ place: 'recipes' });
  ok(env.calls.indexOf('recipes') >= 0, 'the bay showing the other tab is switched to RECIPES');

  // only the run the Commander is watching may move their eyes
  for (const [why, o] of [['another session is focused', { active: 'ws2' }], ['the run is over', { idle: true }],
    ['a run with no origin (a routine, a phone turn)', { ctx: null }], ['a stale run id', { ctx: { streamId: 'ws1', runId: 'old' } }]]) {
    env = boot(o); r = await env.run({ place: 'settings' });
    ok(/^REFUSED: the Commander is not looking at this conversation/.test(r.content) && !env.calls.length, 'refused, nothing opened: ' + why);
  }
  // a watched run's FIRST call can overtake its own agent.run.start (two connections, no order): the page waits for
  // that confirmation instead of refusing the Commander's own run (station-show.e2e failed 1 in 10 on this, 2026-10-22)
  env = boot({ unconfirmed: true, confirm: 'run1' }); r = await env.run({ place: 'deliverables' });
  ok(/^OPEN on the Commander's screen: MY WORK › DELIVERABLES/.test(r.content), 'a first call that beats its run.start still opens: ' + r.content.slice(0, 90));
  eq([env.calls, env.bus.count('agent.run.start')], [[['term', 'deliverables', undefined]], 0], 'opened once, and the wait left no listener behind');
  env = boot({ unconfirmed: true, confirm: 'someone-else' }); r = await env.run({ place: 'settings' });
  ok(/^REFUSED: the Commander is not looking at this conversation/.test(r.content) && !env.calls.length, 'the run that confirms is another run: still refused, nothing opened');
  const t0 = Date.now(); env = boot({ unconfirmed: true }); r = await env.run({ place: 'settings' });
  ok(/^REFUSED: the Commander is not looking at this conversation/.test(r.content) && !env.calls.length && env.bus.count('agent.run.start') === 0, 'a run that never confirms is refused, nothing opened, no listener left');
  ok(Date.now() - t0 < 5000, 'and the wait is bounded inside the bridge deadline (' + (Date.now() - t0) + 'ms)');
  r = await boot({ noPage: true }).run({ place: 'settings' });
  ok(/^REFUSED: this run has no StarNet page attached/.test(r.content), 'no page attached: an honest refusal');
  r = await boot({ refuse: 'apps' }).run({ place: 'apps' });
  ok(/^REFUSED: APPS did not open .*no app exists yet/.test(r.content), 'a window that did not open is never reported open');
  r = await boot().run({ place: 'the moon' });
  ok(/^REFUSED: there is no StarNet place/.test(r.content), 'an unknown place refuses');

  console.log('station-show: OK (' + n + ' assertions)');
})().catch(e => { console.error(e); process.exit(1); });
