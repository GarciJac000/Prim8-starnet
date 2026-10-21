/* node test/scene-index.test.js — who lies in / sits on each prop, found in ONE walk (perf, 2026-10-20).

   The prop pass asked, for every prop, `(agent && lyingBed(agent) === p) ? agent : crew.find(b => lyingBed(b) === p)` and
   the same shape for a sitter, and each lyingBed was a geo.props.find: O(props² × bodies) per frame (1.5 ms on a furnished
   300-prop station with sleepers, 12 ms at 600). world.js now reads props through an id index (propById) and builds both
   answers once per frame (bodyPropIndex). This lifts the real functions and checks them against the old expressions on
   seeded random floors: the same body for every prop — including WHICH body when several claim one (hero first, then the
   crew in order) — and zero props.find calls. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const world = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const lying = A.fnBody(world, '  function lyingBed(b) {');
const byId = A.fnBody(world, '  function propById(id) {');
const index = A.fnBody(world, '  function bodyPropIndex() {');
const idxLet = /\n  let propIndexOf = null, propIndexLen = -1, propIndex = null;\n/.exec(world);
A.ok(lying && byId && index && idxLet, 'world.js carries lyingBed, propById, bodyPropIndex and the index state');
A.ok(lying.length < 600 && byId.length < 800 && index.length < 900, '(each lifted body is just that function)');
// the prop pass reads the index, never a per-prop find
A.ok(/const occupants = bodyPropIndex\(\);[^\n]*\n\s*for \(const p of geo\.props\) \{/.test(world), 'the prop pass builds the index once, right before its loop');
A.ok(world.includes('const sleeper = occupants.sleeper.get(p) || null;') && world.includes('const sitter = occupants.sitter.get(p.id);'), 'sleeper + sitter are index lookups');
A.ok(!/crew\.find\(b => lyingBed\(b\) === p\)/.test(world) && !/crew\.find\(b => b\.seated && !b\.lying && b\.usingProp === p\.id\)/.test(world), 'no per-prop crew.find is left in the pass');

const USE = { bed: { kind: 'bed' }, bunk: { kind: 'bed' }, stool: { kind: 'seat' }, couch: { kind: 'couch' } };
// eslint-disable-next-line no-new-func
const make = new Function('USE', [
  'let geo = null, agent = null, crew = [];',
  'const propUse = p => USE[p.t] || null;',
  idxLet[0], lying, byId, index,
  'return { set(g, a, c) { geo = g; agent = a; crew = c; }, lyingBed, bodyPropIndex };'
].join('\n'));

// the OLD per-prop expressions, verbatim, as the oracle
function oldAnswers(geo, agent, crew) {
  const propUse = p => USE[p.t] || null;
  function lyingBed(b) {
    if (!b || !b.lying || b.goal !== 'sleep' || !b.usingProp || !geo || !geo.props) return null;
    const p = geo.props.find(q => q.id === b.usingProp);
    return (p && (propUse(p) || {}).kind === 'bed') ? p : null;
  }
  return geo.props.map(p => {
    const sleeper = ((agent && lyingBed(agent) === p) ? agent : crew.find(b => lyingBed(b) === p)) || null;
    const sitter = (agent && agent.seated && !agent.lying && agent.usingProp === p.id) ? agent
      : crew.find(b => b.seated && !b.lying && b.usingProp === p.id);
    return { sleeper, sitter, bodyBed: null };
  });
}

let seed = 20261020;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const api = make(USE);
let cases = 0, finds = 0, mismatches = 0;
for (let trial = 0; trial < 400; trial++) {
  const nProps = 1 + Math.floor(rnd() * 40), ids = [];
  const props = [];
  for (let i = 0; i < nProps; i++) {
    // ~1 in 12 reuses an earlier id: the FIRST prop with an id is the one a body's usingProp names (props.find)
    const id = (ids.length && rnd() < 0.08) ? pick(ids) : 'p' + i;
    ids.push(id);
    props.push({ id, t: pick(['bed', 'bunk', 'stool', 'couch', 'crate', 'desk']), x: i, y: 0 });
  }
  const body = name => {
    const lyingNow = rnd() < 0.4;
    return { name, lying: lyingNow, goal: rnd() < 0.8 ? (lyingNow ? 'sleep' : pick(['lounge', 'sleep', 'work'])) : null,
      usingProp: rnd() < 0.85 ? pick(ids.concat(['gone'])) : null, seated: rnd() < 0.6 };
  };
  const agent = rnd() < 0.85 ? body('hero') : null;
  const crew = Array.from({ length: Math.floor(rnd() * 12) }, (_, i) => body('crew' + i));
  if (agent && rnd() < 0.1) crew.splice(Math.floor(rnd() * (crew.length + 1)), 0, agent);   // the hero also listed in crew: still first
  const geo = { props };
  const want = oldAnswers(geo, agent, crew);
  // the new path, with props.find counted
  let calls = 0;
  const counted = new Proxy(props, { get(t, k, r) { if (k === 'find') calls++; return Reflect.get(t, k, r); } });
  api.set({ props: counted }, agent, crew);
  const occ = api.bodyPropIndex();
  props.forEach((p, i) => {
    cases++;
    const got = { sleeper: occ.sleeper.get(p) || null, sitter: occ.sitter.get(p.id) };
    if (got.sleeper !== want[i].sleeper || got.sitter !== want[i].sitter) mismatches++;
  });
  // lyingBed(b) itself answers the same bed (drawn bodies ask it per body)
  for (const b of [agent].concat(crew)) {
    if (!b) continue;
    const oldBed = (() => { if (!b.lying || b.goal !== 'sleep' || !b.usingProp) return null; const p = props.find(q => q.id === b.usingProp); return p && USE[p.t] && USE[p.t].kind === 'bed' ? p : null; })();
    if (api.lyingBed(b) !== oldBed) mismatches++;
  }
  finds += calls;
}
A.ok(cases > 4000, 'compared ' + cases + ' prop answers on 400 seeded floors');
A.eq(mismatches, 0, 'every sleeper, sitter and body bed matches the old per-prop finds (same body, same tie order)');
A.eq(finds, 0, 'the new path calls geo.props.find 0 times');

// the id index follows a replaced or resized prop list (rederive hands over a fresh array on every edit)
{
  const a = { id: 'b1', t: 'bed' }, sleeperBody = { lying: true, goal: 'sleep', usingProp: 'b1', seated: true };
  const g1 = { props: [a] };
  api.set(g1, sleeperBody, []);
  A.ok(api.lyingBed(sleeperBody) === a, 'a body lies in its bed');
  const a2 = { id: 'b1', t: 'bed' };
  api.set({ props: [a2] }, sleeperBody, []);
  A.ok(api.lyingBed(sleeperBody) === a2, 'a re-projected floor (new array) answers its own bed object');
  api.set({ props: [] }, sleeperBody, []);
  A.ok(api.lyingBed(sleeperBody) === null, 'a reclaimed bed answers none');
}

A.report('scene-index');
