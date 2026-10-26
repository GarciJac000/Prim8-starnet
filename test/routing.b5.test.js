/* node test/routing.b5.test.js — Phase B5: per-bay capability isolation. The router builds a resolveTools
   station from the posted plan's bay objects, so a bay-routed agent's tools are EXACTLY what the floor placed
   in that bay's room. Proves the router→resolveTools wiring; the projection itself is covered by capgate.test. */
'use strict';
const A = require('./_assert.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const WM = require('../frontend/app/worldmodel.js');

// a deployable intake -> belt -> bay floor (so setPlan accepts it), with the bay enriched as world.js does
function planWith(objects) {
  const geo = {
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }],
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'coder' }]
  };
  const plan = Pipeline.compileRoutingPlan(geo);
  plan.bays[0].objects = objects;   // the capability objectTypes world.js attaches from station.bayObjects
  return plan;
}

// a workstation + a cabinet in the bay room -> compute + fs.*
{
  const r = makeRouter();
  A.ok(r.setPlan(planWith(['computer', 'cabinet'])).ok, 'a deployable plan with bay caps is stored');
  const st = r.stationFor('coder');
  A.ok(st && st.rooms.bay.objects.length === 2, 'stationFor builds the bay station from the plan objects');
  A.eq(st.agents.coder.room, 'bay', 'the agent is assigned to its bay room');
  const res = resolveTools('coder', st);
  A.ok(res.hasCompute, 'a computer in the bay room grants compute');
  A.ok(res.tools.indexOf('fs.read') >= 0 && res.tools.indexOf('fs.write') >= 0, 'a cabinet grants fs.*');
}

/* CAPABILITY SURVIVES A BROKEN BELT GRAPH (2026-07-26 audit). A blocking routing error used to null the stored
   plan outright, so stationFor() returned null and the caller fell back to the DEFAULT OFFICE — quietly WIDENING
   a bay-bound agent's reach while the world still painted "NO COMPUTE" over its bay. Routing must still refuse;
   the bay's room objects are a fact about the placed floor and must not move. */
{
  const r = makeRouter();
  r.setPlan(planWith(['computer', 'cabinet']));
  A.ok(r.stationFor('coder'), 'baseline: a deployable plan isolates the bay');

  const broken = planWith([]);                                        // an UNEQUIPPED bay...
  broken.errors.push({ code: 'CYCLE', tile: { x: 9, y: 9 } });        // ...on a floor with a real blocker
  const res = r.setPlan(broken);
  A.ok(!res.ok && res.codes.indexOf('CYCLE') >= 0, 'a cyclic plan is still REFUSED for routing');
  A.eq(r.resolveTarget({ tag: 'anything' }), null, '...and dispatch falls back (no routed target)');

  const st = r.stationFor('coder');
  A.ok(st, 'but the bay still projects a station — capability does not ride on belt validity');
  A.eq(st.rooms.bay.objects.length, 0, 'the unequipped bay stays unequipped');
  A.ok(!resolveTools('coder', st).hasCompute, 'a broken floor can never UPGRADE an agent to the default office');

  r.clearPlan();
  A.eq(r.stationFor('coder'), null, 'clearing the floor clears the capability view too');
}

// a workstation but NO cabinet -> compute, but no fs
{
  const r = makeRouter();
  r.setPlan(planWith(['computer']));
  const res = resolveTools('coder', r.stationFor('coder'));
  A.ok(res.hasCompute, 'compute present');
  A.eq(res.tools.filter(t => t.indexOf('fs.') === 0).length, 0, 'no cabinet in the bay room -> no fs tools');
}

// an UNEQUIPPED bay -> no compute, no tools (the compute gate stays shut; the agent cannot spend — cost-safe)
{
  const r = makeRouter();
  r.setPlan(planWith([]));
  const res = resolveTools('coder', r.stationFor('coder'));
  A.ok(!res.hasCompute, 'an unequipped bay grants NO compute');
  A.eq(res.tools.length, 0, 'an unequipped bay grants no tools');
}

// isolation boundary: an agent with NO bay -> null, so the caller uses its own default office (never starved)
{
  const r = makeRouter();
  r.setPlan(planWith(['computer']));
  A.eq(r.stationFor('someone-else'), null, 'stationFor for a non-bay agent is null (office default applies)');
  A.ok(r.stationFor('coder') !== null, 'stationFor for the bay-bound agent is non-null');
}

// no posted plan -> null (routed-mode off; the office default applies everywhere)
A.eq(makeRouter().stationFor('coder'), null, 'no posted plan -> stationFor null');

// sidecar station authority: when the router has accepted a Station document, bay grants are derived from
// that document and forged capability objects embedded in a legacy posted RoutingPlan are ignored.
{
  const stDoc = WM.defaultDoc();
  stDoc.props.push({ id: 'bay1', t: 'bay', x: 4, y: 1, w: 2, h: 2, agentId: 'coder' });
  stDoc.props.push({ id: 'pc1', t: 'console', x: 7, y: 1, w: 2, h: 1, agentId: 'coder' });
  stDoc.props.push({ id: 'dish1', t: 'comms_dish', x: 10, y: 1, w: 1, h: 1 });
  stDoc.props.push({ id: 'conn1', t: 'connector_portal', x: 12, y: 1, w: 1, h: 1, connectorId: 'github' });
  stDoc._nid = 4;
  const r = makeRouter();
  A.ok(r.setStation(stDoc).ok, 'a valid Station document is accepted by the sidecar router');
  A.ok(r.setPlan(planWith(['computer', 'cabinet', 'workbench'])).ok, 'legacy routing plan with forged grants is still deployable');
  const resolved = resolveTools('coder', r.stationFor('coder'));
  A.ok(resolved.hasCompute, 'sidecar-derived station grants the real dedicated workstation');
  A.ok(resolved.tools.indexOf('web_search') >= 0, 'sidecar-derived station grants the real room dish');
  A.eq(resolved.tools.filter(t => t.indexOf('fs.') === 0).length, 0, 'forged plan cabinet grants no fs tools');
  A.eq(resolved.tools.indexOf('shell.exec'), -1, 'forged plan workbench grants no shell tool');
  const conn = r.stationFor('coder').rooms.bay.objects.find(o => o.objectType === 'connector');
  A.ok(conn && conn.connectorId === 'github', 'sidecar-derived station preserves bound connector portal identity');
}

// setStation is transactional: an invalid Station update is refused and leaves the last-good station active.
{
  const stDoc = WM.defaultDoc();
  stDoc.props.push({ id: 'bay1', t: 'bay', x: 4, y: 1, w: 2, h: 2, agentId: 'coder' });
  stDoc.props.push({ id: 'pc1', t: 'console', x: 7, y: 1, w: 2, h: 1, agentId: 'coder' });
  const r = makeRouter();
  A.ok(r.setStation(stDoc).ok, 'valid Station document installs as last-good');
  A.ok(!r.setStation({ schema: 'starnet.station', version: 1, rooms: {}, order: [], props: [] }).ok, 'invalid empty Station document is refused');
  r.setPlan(planWith(['cabinet']));
  A.ok(resolveTools('coder', r.stationFor('coder')).hasCompute, 'last-good station stays active after invalid update');
}

// sidecar station authority also owns routing: once a Station document is installed, resolveTarget follows the
// server-derived Station geometry instead of a forged legacy RoutingPlan posted by the renderer.
{
  const stDoc = WM.defaultDoc();
  stDoc.props.push({ id: 'intake1', t: 'intake', x: 0, y: 0, w: 1, h: 1 });
  stDoc.props.push({ id: 'bay-real', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'real' });
  stDoc.belts = { '1,0': 'E', '2,0': 'E', '3,0': 'E' };
  stDoc._nid = 4;
  const forged = Pipeline.compileRoutingPlan({
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }],
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'fake' }]
  });
  const r = makeRouter();
  A.ok(r.setStation(stDoc).ok, 'authoritative Station with deployable routing is accepted');
  A.ok(r.setPlan(forged).ok, 'forged legacy RoutingPlan is still syntactically deployable');
  A.eq(r.resolveTarget({}), 'real', 'server-derived Station routing overrides the forged legacy RoutingPlan');
}

// non-deployable Station routing updates are transactional: the last-good Station-derived routing plan stays active.
{
  const good = WM.defaultDoc();
  good.props.push({ id: 'intake1', t: 'intake', x: 0, y: 0, w: 1, h: 1 });
  good.props.push({ id: 'bay-real', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'real' });
  good.belts = { '1,0': 'E', '2,0': 'E', '3,0': 'E' };
  good._nid = 4;
  // genuinely non-deployable = a belt CYCLE (an infinite paid runOnce). NOTE: this used to be an intake with
  // no belt, which stopped being a blocker on 2026-07-26 — an unbelted intake contributes no source, so it can
  // neither loop nor route into a void. Pin the transaction to a REAL blocker so the test can't pass by accident.
  const bad = WM.defaultDoc();
  bad.props.push({ id: 'intake2', t: 'intake', x: 0, y: 0, w: 1, h: 1 });
  bad.props.push({ id: 'bay-fake', t: 'bay', x: 4, y: 0, w: 2, h: 2, agentId: 'fake' });
  bad.belts = { '1,0': 'E', '2,0': 'S', '2,1': 'W', '1,1': 'N' };   // a closed loop
  bad._nid = 4;
  A.ok(Pipeline.compileRoutingPlan(WM.deserialize(bad).projectGeometry()).errors.some(e => e.code === 'CYCLE'),
    'the bad fixture is non-deployable for a REAL reason (CYCLE)');
  const r = makeRouter();
  A.ok(r.setStation(good).ok, 'good Station routing installs first');
  A.ok(!r.setStation(bad).ok, 'non-deployable Station routing update is refused');
  A.eq(r.resolveTarget({}), 'real', 'last-good Station routing survives the refused update');

  /* refusal must NOT depend on install order (latent bug, fixed 2026-08-04): the old guard was
     `!v.routingOk && stationPlan`, so the SAME cyclic doc refused above was ACCEPTED when it was the
     FIRST install (no stationPlan yet) — claiming ok while arming no routing. A fresh router must
     refuse it identically. */
  const first = makeRouter();
  const res = first.setStation(bad);
  A.ok(!res.ok, 'a non-deployable Station is refused on FIRST install too (no prior station required)');
  A.ok(Array.isArray(res.codes) && res.codes.indexOf('CYCLE') >= 0, 'the first-install refusal names the real blocker (CYCLE)');
  A.eq(first.getStation(), null, 'the refused first install stores no station document');
  A.eq(first.resolveTarget({}), null, '...and arms no routing (dispatch falls back)');
}

// a connector portal carries a per-instance binding: stationFor passes the rich object through verbatim, so the
// connector manager can project THAT server's tools. resolveTools yields no STATIC grant for it (dynamic at run).
{
  const r = makeRouter();
  r.setPlan(planWith(['computer', { objectType: 'connector', connectorId: 'github' }]));
  const st = r.stationFor('coder');
  const objs = st.rooms.bay.objects;
  A.eq(objs.length, 2, 'stationFor keeps both the string cap and the connector object');
  const conn = objs.find(o => o.objectType === 'connector');
  A.ok(conn && conn.connectorId === 'github', 'the connector object passes through with its connectorId intact');
  A.ok(!!conn.instanceId, 'every room object still gets an instanceId');
  const res = resolveTools('coder', st);
  A.ok(res.hasCompute, 'the workstation still grants compute alongside the connector');
  // the computer contributes the quest.update freebie (QUEST V2 §B) and the todo taskplan freebie (2026-08-17);
  // the CONNECTOR itself adds no static tool (its MCP tools are projected dynamically at run time).
  A.eq(res.tools.slice().sort(), ['app.check', 'app.create', 'app.publish', 'app.read', 'app.schedule', 'app.write', 'code.run', 'deliverable_note', 'manual.read', 'quest.update', 'routine.notepad', 'station.inspect', 'station.show', 'todo', 'tool.search'], 'a connector adds NO static tool beyond the computer primitives (its MCP tools project dynamically at run time)');
}

// the router round-robins SPLITTER dispatch across both bound agents (stateful, matches the engine's spread)
{
  const plan = Pipeline.compileRoutingPlan({
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' },
            { x: 2, y: 1, dir: 'S' }, { x: 2, y: 2, dir: 'S' }, { x: 2, y: 3, dir: 'S' }],
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
            { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
            { id: 'br', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'researcher' }]
  });
  const r = makeRouter();
  A.ok(r.setPlan(plan).ok, 'a splitter floor with two bound bays is deployable');
  const seq = [r.resolveTarget({}), r.resolveTarget({}), r.resolveTarget({}), r.resolveTarget({})];
  A.eq(seq.join(','), 'coder,researcher,coder,researcher', 'the router spreads splitter dispatch across both agents (' + seq.join(',') + ')');

  /* ---- A NO-OP RE-POST KEEPS THE BALANCE (2026-08-07) ----
     `rr` used to reset on EVERY accepted plan, so any re-post restarted every splitter at lane 0 — and
     re-posts are cheap to provoke (they happen on each floor change, and until today a job-brief edit moved
     the hash too). plan.hash IS the dispatch topology, so an identical hash guarantees the same splitter
     tiles with the same lane counts and the counters stay meaningful. */
  r.resolveTarget({});                                   // 5 dispatches so far -> the next lane owed is researcher
  A.ok(r.setPlan(plan).ok, 'the same floor is re-posted');
  A.eq(r.resolveTarget({}), 'researcher', 'an identical re-post KEEPS splitter balance — the next lane owed is still owed');

  // a real topology change is a new floor and DOES start fresh
  const moved = Pipeline.compileRoutingPlan({
    belts: [{ x: 1, y: 0, dir: 'E' }, { x: 2, y: 0, dir: 'E' }, { x: 3, y: 0, dir: 'E' }, { x: 4, y: 0, dir: 'E' },
            { x: 2, y: 1, dir: 'S' }, { x: 2, y: 2, dir: 'S' }, { x: 2, y: 3, dir: 'S' }, { x: 5, y: 1, dir: 'E' }],
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'sp', t: 'splitter', x: 2, y: 0, w: 1, h: 1 },
            { id: 'bc', t: 'bay', x: 5, y: 0, w: 2, h: 2, agentId: 'coder' },
            { id: 'br', t: 'bay', x: 1, y: 4, w: 2, h: 2, agentId: 'researcher' }]
  });
  A.ok(moved.hash !== plan.hash, 'laying one more belt really is a different floor');
  A.ok(r.setPlan(moved).ok, 'the edited floor deploys');
  A.eq(r.resolveTarget({}), 'coder', 'a CHANGED floor resets the round-robin to the first lane');
}

/* THE SAVED STATION GRANTS (qa/bugs/a9a4f53c, 2026-10-21). The sidecar builds its router with savedStation (the saved
   floor, validated); from then on a bay's room is NEVER WIDER than both the saved room and the posted plan's room, and with
   no saved room for the agent, never wider than the plan's room and the default office (fullOffice + connectors) — and
   never null, which would hand the caller's FULL default office to a bay the floor paints as restricted.
   The real-sidecar proof is test/routing.saved-station-grants.e2e.test.js; this pins the router's reading of it. */
{
  const { checkedStation } = require('../sidecar/capability/saved-placement.js');
  // two desk-less bays for the writer in two rooms: A holds a dish, B a cabinet
  const doc = WM.defaultDoc();
  doc.rooms.r2 = Object.assign({}, doc.rooms.r1, { id: 'r2', name: 'HAB-02', rects: [{ x1: 20, y1: 0, x2: 37, y2: 10 }] });
  doc.order.push('r2');
  doc.props.push({ id: 'bA', t: 'bay', x: 4, y: 1, w: 2, h: 2, agentId: 'writer' }, { id: 'dishA', t: 'comms_dish', x: 10, y: 1, w: 1, h: 1 },
    { id: 'bB', t: 'bay', x: 24, y: 1, w: 2, h: 2, agentId: 'writer' }, { id: 'cabB', t: 'war_intelcab', x: 30, y: 1, w: 1, h: 2 });
  doc._nid = 5;
  let saved = checkedStation({ station: doc });
  A.ok(saved, 'fixture: the two-room station validates');
  const types = st => st ? st.rooms.bay.objects.map(o => o.objectType).sort() : null;
  const listed = (agentId, propId, objects) => ({ agentId, propId, objects });
  const plan = (bays) => ({ errors: [], hash: 'h-' + bays.map(b => b.propId).join('-'), sources: [], belts: [], bays: [], dockBays: bays });
  const r = makeRouter({ savedStation: () => saved });

  const WIDE = ['computer', 'workbench', 'dish', 'cabinet', 'orchestrator', 'builder', { objectType: 'plugin', pluginId: 'px' }, { objectType: 'connector', connectorId: 'cx' }];
  const FULL = ['cabinet', 'computer', 'dish', 'jukebox', 'notebook', 'studio'];   // capability/office.js fullOffice

  // ---- the saved floor crews the agent: saved room ∩ the plan's room ----
  r.setPlan(plan([listed('writer', 'bA', WIDE), listed('writer', 'bB', ['computer', 'cabinet'])]));
  A.eq(types(r.stationFor('writer')), ['dish'], 'objects the plan lists beyond the saved bay\'s room are not granted');
  A.eq(r.stationFor('writer').floor.dockId, 'bA', 'the routed room names the dock it resolved');
  A.eq(types(r.stationFor('writer', 'bB')), ['cabinet'], 'a dock the saved floor gives the agent is the room this run gets (multi-bay)');
  A.eq(types(r.stationFor('writer', 'nope')), ['dish'], 'a dock the saved floor does not know falls back to the plan\'s dock for this agent');
  r.setPlan(plan([listed('writer', 'bA', ['computer']), listed('writer', 'bB', [])]));
  A.eq(types(r.stationFor('writer')), [], 'a plan listing less than the saved room narrows it (a save lagging after gear came off)');
  A.eq(types(r.stationFor('writer', 'bB')), [], 'an unequipped plan bay grants nothing from the saved room');
  r.setPlan(plan([listed('writer', 'ghost', ['computer', 'cabinet'])]));
  A.eq(types(r.stationFor('writer')), [], 'a plan naming a ghost bay for a crewed agent: its first saved bay\'s room, cut to the plan\'s room');
  A.eq(r.stationFor('writer').floor.dockId, 'bA', 'the ghost-plan room is the agent\'s saved bay, never the ghost');
  r.clearPlan();
  A.eq(types(r.stationFor('writer')), ['dish'], 'with no plan at all, a crewed agent still runs in its saved room (no wider office)');

  // ---- the saved floor crews the agent in no bay: the plan's room ∩ the default office, never null ----
  A.ok(r.setPlan(plan([listed('coder', 'ghost', WIDE)])).ok, 'a plan naming a bay no saved station holds is stored');
  A.eq(types(r.stationFor('coder')), ['cabinet', 'computer', 'connector', 'dish'], 'an agent the saved floor does not crew: the plan\'s room within the default office (no workbench, plugin, orchestrator, builder)');
  r.setPlan(plan([listed('coder', 'ghost', [])]));
  A.eq(types(r.stationFor('coder')), [], 'an unequipped plan bay for an agent the saved floor does not crew grants nothing (not the full office)');
  r.clearPlan();
  A.eq(r.stationFor('coder'), null, 'with no plan and no saved bay the agent is not bay-bound (its own office, as before)');

  // ---- no saved station, an unreadable one, an invalid one: the same bound, never null ----
  saved = null;
  r.setPlan(plan([listed('writer', 'bA', WIDE)]));
  A.eq(types(r.stationFor('writer')), ['cabinet', 'computer', 'connector', 'dish'], 'no saved station: the plan\'s room within the default office');
  A.ok((types(r.stationFor('writer')) || [null]).every(t => t === 'connector' || FULL.indexOf(t) >= 0), 'no saved station: nothing outside the default office');
  r.setPlan(plan([listed('writer', 'bA', [])]));
  A.eq(types(r.stationFor('writer')), [], 'no saved station: an unequipped bay still grants no compute (the floor\'s NO COMPUTE holds)');
  const thrower = makeRouter({ savedStation: () => { throw new Error('unreadable'); } });
  thrower.setPlan(plan([listed('writer', 'bA', ['computer', 'workbench'])]));
  A.eq(types(thrower.stationFor('writer')), ['computer'], 'an unreadable saved station: the plan\'s room within the default office');
  thrower.setPlan(plan([listed('writer', 'bA', [])]));
  A.eq(types(thrower.stationFor('writer')), [], 'an unreadable saved station: an unequipped bay grants nothing');
  const junk = makeRouter({ savedStation: () => ({ props: 'not a function' }) });
  junk.setPlan(plan([listed('writer', 'bA', [])]));
  A.eq(types(junk.stationFor('writer')), [], 'a saved station that is not a station model: an unequipped bay grants nothing');
  A.eq(junk.stationFor('nobody'), null, 'an agent no plan and no saved floor crews is not bay-bound');
}

A.report('routing.b5');
