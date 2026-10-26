'use strict';
/* Real stamped JOINER floors, the real executor and the real world.js shipping functions.
   Time passing is not evidence that a join released. Exercise a slow sibling and an SSE echo. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const Conveyor = require('../frontend/app/conveyor.js');
const LineWatch = require('../frontend/app/linewatch.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const pairing = source.slice(source.indexOf('  const dockLineWork = new Map();'), source.indexOf('  // the bay an agent\'s CURRENT work'));
const shipping = source.slice(source.indexOf('  const HANDOFF_GRACE_MS = 8000;'), source.indexOf('  function enqueueSlag'));
const worked = source.slice(source.indexOf('  function runWorked(p)'), source.indexOf('  /* NEVER NEITHER'));
const ending = source.slice(source.indexOf("    U.bus.on('agent.run.end', p => {\n      if (floor)"), source.indexOf('    // Stage 2: WATCH the lead delegate.'));
assert.ok(ending.includes('runWork.delete(k)'), 'the real completion listener includes tally cleanup');

function floor(id) {
  const s = WM.create();
  assert.ok(s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 14 } }).ok);
  assert.ok(s.stampBlueprint(id, 32, 2).ok);
  s.props().filter(p => p.t === 'bay').forEach((b, i) => s.assignPropAgent(b.id, 'crew' + i));
  const plan = P.compileRoutingPlan(s.projectGeometry());
  assert.deepEqual(plan.errors, []);
  const router = makeRouter(); assert.ok(router.setPlan(plan).ok);
  return { plan, router };
}
function surface(plan) {
  const crates = [], timers = [], handlers = {};
  const context = vm.createContext({ routingPlan: plan, Pipeline: P, Conveyor, watch: LineWatch.create(), runUsdRecon: new Map(), shippedRunIds: new Set(), runWork: new Map(), runKey: p => p.runId,
    U: { bus: { on: (n, fn) => { handlers[n] = fn; }, emitEnd: p => handlers['agent.run.end'](p) } }, floor: null, slagErrText: new Map(), liveRunOrder: new Map(),
    convey: { enqueueAt: (x, y, payload) => crates.push({ x, y, payload }) },
    outboundBeltTile: (aid, dockId) => (plan.dockChains[dockId] || plan.chains[aid] || {}).tile,
    setTimeout: (fn, ms) => { const t = { fn, ms, active: true }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.active = false; },
    motionWake: () => {} });   // the still tier (10-21): a crate that starts moving wakes the pacer — a no-op here
  vm.runInContext(pairing + worked + shipping + ending + `
    globalThis.proof = {
      end(aid, dockId, lineId, runId, workitemId, usd = 0.01, productive = true) {
        runWork.set(runId, { workitemId }); runUsdRecon.set(runId, usd);
        const q = dockLineWork.get(aid) || []; q.push({ dockId, lineId }); dockLineWork.set(aid, q);
        if (productive) shipProductCrate({ agentId: aid, runId });
        else holdJoinedProduct(aid, productCrateSpec({ agentId: aid, runId }), { lineId, dockId }, false);
      },
      place(aid, dockId, lineId, workitemId, runId) {
        const p = { agentId: aid, dockId, lineId, workitemId };
        const q = dockLineWork.get(aid) || []; q.push(p); dockLineWork.set(aid, q);
        watch.onEvent('workitem.placed', p, 1);
        watch.onEvent('agent.run.start', { ...p, runId }, 2);
        runWork.set(runId, { workitemId }); runUsdRecon.set(runId, 0.01);
      },
      finish(aid, runId) {
        watch.onEvent('agent.run.end', { agentId: aid, runId, reason: 'done' }, 3);
        shipProductCrate({ agentId: aid, runId });
      },
      tally(runId, productive, usd) { const r = runWork.get(runId); r.tools = productive ? 1 : 0; r.dels = 0; runUsdRecon.set(runId, usd); },
      complete(aid, runId) {
        const p = { agentId: aid, runId, reason: 'done' };
        watch.onEvent('agent.run.end', p, 3); U.bus.emitEnd(p);
      },
      queued(aid) { return (dockLineWork.get(aid) || []).length; },
      placed(p) { if (p.kind === 'chain' && p.from) { cancelDeferredShip(p.from); } },
      release: releaseJoinedProduct,
      clear: clearDeferredShips
    };
  `, context);
  return { ...context.proof, crates, expire: () => { for (const t of timers) if (t.active) { t.active = false; t.fn(); } } };
}

(async () => {
  for (const id of ['second_opinion', 'swarm_synthesis']) {
    const { plan, router } = floor(id), ui = surface(plan), events = [], ran = [];
    const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
    const sibling = router.fanSiblingsDock(entry.dockId).at(-1);
    let unblock, started;
    const blocked = new Promise(r => { unblock = r; }), entered = new Promise(r => { started = r; });
    const chain = makeChainRunner({
      nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
      peekDock: (d, c) => router.chainPeekDock(d, c), entryDockOf: a => router.entryDockOf(a),
      fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
      emit: (name, p) => { events.push({ name, p }); if (name === 'workitem.placed') ui.placed(p); if (name === 'workitem.delivered') ui.release(p); }
    });
    ui.end(entry.agentId, entry.dockId, lineId, 'entry');
    const running = chain.advance({ ...entry, lineId, runId: 'entry', text: 'Entry evidence', originalText: 'Compare the evidence',
      runAgent: async h => {
        ran.push(h.dockId);
        if (h.dockId === sibling.dockId) { started(); await blocked; }
        ui.end(h.agentId, h.dockId, lineId, 'run-' + h.dockId, h.workitemId);
        return { text: h.agentId + ' evidence', usd: 0.01 };
      } });
    await entered;
    assert.equal(ui.crates.length, 0, id + ': no product ships before the slow sibling finishes');
    ui.expire();
    assert.equal(ui.crates.length, 0, id + ': even the old 8-second fallback cannot bypass the join');
    unblock();
    const result = await running;
    assert.equal(result.stopped, null);
    const releases = events.filter(e => e.name === 'workitem.delivered' && e.p.box === 'line-output');
    assert.equal(releases.length, 1, id + ': the actual joined release is emitted once');
    assert.equal(ui.crates.length, 1, id + ': exactly one finished result ships');
    ui.release(releases[0].p);
    assert.equal(ui.crates.length, 1, 'an SSE echo does not duplicate the merged result');
    const out = plan.outs.find(o => o.propId === releases[0].p.outboxId);
    assert.deepEqual([ui.crates[0].x, ui.crates[0].y], [out.tile.x, out.tile.y], 'result starts at the actual OUTBOX inlet');
    assert.equal(ui.crates[0].payload.weight, Conveyor.weightForUsd((ran.length + 1) * 0.01), 'merged mass uses all observed reconciled spend');
    if (id === 'swarm_synthesis') assert.ok(ran.includes(result.dockId), 'the analyst really ran after the join');
    // Another job can finish first at these exact same docks. Its terminal receipt must not
    // steal A's productive work or mint product for talk-only B.
    ui.end(entry.agentId, entry.dockId, lineId, 'overlap-A');
    const overlapBefore = ui.crates.length;
    ui.end(entry.agentId, entry.dockId, lineId, 'talk-only-B', null, 0.01, false);
    await chain.advance({ ...entry, lineId, runId: 'talk-only-B', text: 'B only talked', originalText: 'B',
      runAgent: async h => { ui.end(h.agentId, h.dockId, lineId, 'talk-B-' + h.workitemId, h.workitemId, 0.01, false); return { text: 'B only talked', usd: 0.01 }; } });
    assert.equal(ui.crates.length, overlapBefore, 'a talk-only overlapping job cannot release productive A');
    await chain.advance({ ...entry, lineId, runId: 'overlap-A', text: 'A evidence', originalText: 'A',
      runAgent: async h => { ui.end(h.agentId, h.dockId, lineId, 'talk-A-' + h.workitemId, h.workitemId, 0.01, false); return { text: 'A continuation', usd: 0.01 }; } });
    assert.equal(ui.crates.length, overlapBefore + 1, 'A keeps its own productive proof until A reaches OUTBOX');
    assert.equal(ui.crates.at(-1).payload.weight, Conveyor.weightForUsd((ran.length + 1) * 0.01), 'observed talk-only siblings add cost without supplying productivity');
    const before = ui.crates.length;
    ui.end(entry.agentId, entry.dockId, null, 'direct');
    assert.equal(ui.crates.length, before + 1, 'a direct order remains its own immediate product');
    ui.clear(); ui.release({ ...releases[0].p, workitemId: 'unobserved-after-reconnect' });
    assert.equal(ui.crates.length, before + 1, 'a release with no observed branch work invents no crate');
  }

  /* THE RELEASE FOLLOWS THE CLEAN-JOB RULE (runtime audit 2026-10-12). The line-output authority fired whenever the line ended
     unstopped at an OUTBOX — also for a job whose COPY branch failed, or whose hop ended max_iters with some text — while the
     receipt (SHIPPED), SEND TO and the sample verdict all refused it: the floor put a product at the OUTBOX that nothing else
     counted. Wired exactly as the host wires it: line-shipments.cleanJobRows over the job's own run rows. */
  {
    const { makeRunStore } = require('../sidecar/runstore.js');
    const { cleanJobRows, makeLineShipments } = require('../sidecar/routing/line-shipments.js');
    for (const id of ['second_opinion', 'swarm_synthesis']) {
      /* (runtime repair 2026-10-12) two partial jobs the run rows cannot see: a COPY branch the host refused BEFORE it ran (hub
         runAgent's roster refusal, the cron seam, 'the workflow changed' — no run row), and a branch still out when the joiner timed
         out (the entry branch parked, its sibling never came: no row either). Every row that exists ended done; the chain knows. */
      for (const [label, bad] of [['clean', null], ['a failed COPY branch', 'error'], ['a hop that ended max_iters with text', 'max_iters'],
        ['a COPY branch refused before it ran (no run row)', 'norow'], ['a branch still out at the joiner timeout', 'timeout']]) {
        const { plan, router } = floor(id), ui = surface(plan), events = [];
        let t = 1000;
        const runStore = makeRunStore({ clock: { now: () => ++t } });
        let saved = [];
        const receipts = makeLineShipments({ now: () => ++t, load: () => saved, save: v => { saved = v; }, runsFor: sid => runStore.list(null, { streamId: sid, limit: 200 }) });
        const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
        const streamId = 'chat-' + id, entryRunId = 'entry-' + id + '-' + (bad || 'clean'), shippedRecs = [];
        runStore.record({ runId: entryRunId, agentId: entry.agentId, reason: 'done', streamId, lineId, dockId: entry.dockId, toolsOk: 1 });
        ui.end(entry.agentId, entry.dockId, lineId, entryRunId);
        const chain = makeChainRunner(Object.assign({
          nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
          peekDock: (d, c) => router.chainPeekDock(d, c), entryDockOf: a => router.entryDockOf(a),
          fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
          lastStage: (a, d) => router.chainShipsToOutbox(a, d), onShipped: rec => { shippedRecs.push(rec); return receipts.record(rec); },
          cleanJob: k => !!(k && k.streamId && k.entryRunId) && !!cleanJobRows(runStore.list(null, { streamId: k.streamId, limit: 200 }), k),
          emit: (name, p) => { events.push({ name, p }); if (name === 'workitem.placed') ui.placed(p); if (name === 'workitem.delivered') ui.release(p); },
          // the joiner's timeout clock, fired at once: the sibling of a 'timeout' job is never launched in this call
          setTimer: fn => { fn(); return 0; }
        }, bad === 'timeout' ? { fanSiblingsDock: () => [] } : {}));
        let hop = 0;
        const result = await chain.advance({ ...entry, lineId, runId: entryRunId, streamId, since: 0, text: 'Entry evidence', originalText: 'Compare the evidence',
          runAgent: async h => {
            const runId = 'run-' + id + '-' + (++hop), fails = bad && hop === 1;
            if (fails && bad === 'norow') return { text: '', usd: 0, error: 'target agent ' + h.agentId + ' is not configured' };
            runStore.record({ runId, agentId: h.agentId, reason: (fails && bad !== 'timeout') ? bad : 'done', streamId, lineId: h.lineId, dockId: h.dockId, toolsOk: 1 });
            ui.end(h.agentId, h.dockId, lineId, runId, h.workitemId);
            return fails && bad === 'error' ? { error: 'boom', usd: 0.01 } : { text: h.agentId + ' evidence', usd: 0.01 };
          } });
        await new Promise(r => setImmediate(r));
        const outputs = events.filter(e => e.name === 'workitem.delivered' && e.p.box === 'line-output');
        assert.equal(result.stopped, null, id + ' / ' + label + ': the line still answers (' + result.stopped + ')');
        if (!bad) {
          assert.equal(outputs.length, 1, id + ': a clean job is released at its OUTBOX once');
          assert.equal(ui.crates.length, 1, id + ': and its product ships');
          assert.equal(saved.length, 1, id + ': SHIPPED counts it');
        } else {
          assert.equal(outputs.length, 0, id + ' / ' + label + ': no line-output for a job the receipt refuses');
          assert.equal(ui.crates.length, 0, id + ' / ' + label + ': so no product lands at the OUTBOX');
          assert.equal(saved.length, 0, id + ' / ' + label + ': exactly as SHIPPED stays 0');
          if (bad === 'norow' || bad === 'timeout') {
            // every run row that exists ended done — the rows alone would call this job clean; the chain's own mark refuses it
            assert.ok(runStore.list(null, { streamId, limit: 200 }).every(r => r.reason === 'done'), id + ' / ' + label + ': every recorded row ended done');
            assert.ok(result.partial && /PARTIAL/.test(id === 'second_opinion' ? result.text : 'PARTIAL'), id + ' / ' + label + ': the job is marked partial (' + result.partial + ')');
            assert.ok(shippedRecs.length === 1 && shippedRecs[0].partial === result.partial, id + ' / ' + label + ': SEND TO hears of it as partial, never as clean');
          }
        }
      }
    }
    // a host whose rows cannot be read (or that throws) proves nothing: nothing is released
    const { plan, router } = floor('second_opinion'), events = [];
    const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
    const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
      peekDock: (d, c) => router.chainPeekDock(d, c), fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
      cleanJob: () => { throw new Error('rows unreadable'); }, emit: (name, p) => events.push({ name, p }) });
    await chain.advance({ ...entry, lineId, runId: 'throws', streamId: 'chat-x', text: 'Entry', originalText: 'Q', runAgent: async h => ({ text: h.agentId + ' out' }) });
    assert.equal(events.filter(e => e.name === 'workitem.delivered' && e.p.box === 'line-output').length, 0, 'an unprovable job is never released');
  }

  // A real compiled FILTER chooses direct OUTBOX for general output, JOINER for code output.
  // Holding a possibly-joined line must not strand its actual direct route.
  {
    const props = [
      { id: 'i', t: 'intake', x: 0, y: 0 }, { id: 'b', t: 'bay', x: 3, y: 0, agentId: 'a' },
      { id: 'f', t: 'filter', x: 6, y: 0, routes: { code: 'S' }, def: 'E' }, { id: 'direct', t: 'outbox', x: 10, y: 0 },
      { id: 'i2', t: 'intake', x: 0, y: 4 }, { id: 'b2', t: 'bay', x: 3, y: 4, agentId: 'a2' },
      { id: 'j', t: 'joiner', x: 6, y: 4 }, { id: 'joined', t: 'outbox', x: 10, y: 4 }
    ].map(p => ({ ...p, w: 1, h: 1 }));
    const belts = [];
    for (const y of [0, 4]) for (const x of [1, 2, 4, 5, 6, 7, 8, 9]) belts.push({ x, y, dir: 'E' });
    for (const y of [1, 2, 3]) belts.push({ x: 6, y, dir: 'S' });
    const plan = P.compileRoutingPlan({ props, belts, origin: { tx: 0, ty: 0 } });
    assert.deepEqual(plan.errors, []);
    const lineId = plan.lineOfProp.b, ui = surface(plan), router = makeRouter(); router.setPlan(plan);
    assert.ok(P.chainStepDock(plan, 'b', { lineId, tag: 'code' }).join);
    ui.end('a', 'b', lineId, 'filter-general');
    ui.expire(); assert.equal(ui.crates.length, 0);
    const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
      lineOfAgent: (a, d) => router.lineOfAgent(a, d), getTag: () => 'general',
      emit: (n, p) => { if (n === 'workitem.delivered') ui.release(p); } });
    const result = await chain.advance({ agentId: 'a', dockId: 'b', lineId, runId: 'filter-general', text: 'General result', runAgent: async () => { throw Error('direct route must not run another dock'); } });
    assert.equal(result.outboxId, 'direct'); assert.equal(ui.crates.length, 1);
    assert.deepEqual([ui.crates[0].x, ui.crates[0].y], [9, 0], 'general output reaches its own direct OUTBOX despite code JOINER route');
  }
  // The same agent may run two distinct lines simultaneously, and B may finish before A.
  // Placements must happen at admission, not at completion, to reproduce the real overlap.
  {
    const geometry = (suffix, y0) => ({
      props: [['i', 'intake', 0, 0], ['b', 'bay', 3, 0], ['f', 'filter', 6, 0], ['o', 'outbox', 10, 0],
        ['i2', 'intake', 0, 4], ['b2', 'bay', 3, 4], ['j', 'joiner', 6, 4], ['o2', 'outbox', 10, 4]]
        .map(([id, t, x, y]) => ({ id: id + suffix, t, x, y: y + y0, w: 1, h: 1,
          ...(t === 'bay' ? { agentId: id === 'b' ? 'same' : 'other' + suffix } : {}),
          ...(t === 'filter' ? { routes: { code: 'S' }, def: 'E' } : {}) })),
      belts: [...[0, 4].flatMap(y => [1, 2, 4, 5, 6, 7, 8, 9].map(x => ({ x, y: y + y0, dir: 'E' }))),
        ...[1, 2, 3].map(y => ({ x: 6, y: y + y0, dir: 'S' }))]
    });
    const a = geometry('A', 0), b = geometry('B', 10), plan = P.compileRoutingPlan({ props: [...a.props, ...b.props], belts: [...a.belts, ...b.belts] });
    assert.deepEqual(plan.errors, []);
    const ui = surface(plan), router = makeRouter(); router.setPlan(plan);
    const lineA = plan.lineOfProp.bA, lineB = plan.lineOfProp.bB;
    assert.notEqual(lineA, lineB);
    ui.place('same', 'bA', lineA, 'wi-A', 'run-A');
    ui.place('same', 'bB', lineB, 'wi-B', 'run-B');
    const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
      lineOfAgent: (a, d) => router.lineOfAgent(a, d), getTag: () => 'general',
      emit: (n, p) => { if (n === 'workitem.delivered') ui.release(p); } });
    for (const suffix of ['B', 'A']) {
      ui.finish('same', 'run-' + suffix);
      assert.equal(ui.queued('same'), suffix === 'B' ? 1 : 0, 'only the ending run consumes its own placement');
      await chain.advance({ agentId: 'same', dockId: 'b' + suffix, lineId: suffix === 'A' ? lineA : lineB,
        runId: 'run-' + suffix, text: 'General result', runAgent: async () => { throw Error('unexpected hop'); } });
    }
    assert.equal(ui.crates.length, 2, 'out-of-order completion on two lines loses no productive run');
    assert.deepEqual(ui.crates.map(c => [c.x, c.y]), [[9, 10], [9, 0]], 'each run ships at its own line OUTBOX');
    ui.place('same', 'bA', lineA, 'wi-C', 'run-C');
    ui.place('same', 'bB', null, 'wi-direct', 'direct-overlap');
    ui.finish('same', 'direct-overlap');
    assert.equal(ui.crates.length, 3, 'a watched direct order keeps its explicit null line under overlap');
    assert.equal(ui.queued('same'), 1, 'the direct order cannot consume the pending line placement');
    ui.finish('same', 'run-C');
    await chain.advance({ agentId: 'same', dockId: 'bA', lineId: lineA, runId: 'run-C', text: 'C result', runAgent: async () => ({}) });
    assert.equal(ui.crates.length, 4); assert.equal(ui.queued('same'), 0);
  }
  // Local completion and its SSE echo can both arrive before the terminal receipt. Run cleanup
  // removes the original tally/cost, so an echo must not replace held evidence with a workless zero.
  {
    const { plan, router } = floor('second_opinion'), ui = surface(plan);
    const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
    ui.place(entry.agentId, entry.dockId, lineId, 'echo-entry-wi', 'echo-entry');
    ui.tally('echo-entry', true, 0.02);
    ui.complete(entry.agentId, 'echo-entry'); ui.complete(entry.agentId, 'echo-entry');
    assert.equal(ui.crates.length, 0, 'duplicate completion cannot bypass terminal authority');
    const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
      fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
      emit: (n, p) => { if (n === 'workitem.delivered') ui.release(p); } });
    await chain.advance({ ...entry, lineId, runId: 'echo-entry', text: 'Entry evidence', originalText: 'Compare', runAgent: async h => {
      ui.place(h.agentId, h.dockId, lineId, h.workitemId, 'echo-talk');
      ui.tally('echo-talk', false, 0.03);
      ui.complete(h.agentId, 'echo-talk'); ui.complete(h.agentId, 'echo-talk');
      return { text: 'Talk-only sibling', usd: 0.03 };
    } });
    assert.equal(ui.crates.length, 1, 'productive completion evidence survives its workless echo');
    assert.equal(ui.crates[0].payload.weight, Conveyor.weightForUsd(0.05), 'productive and talk-only captured spend both survive completion echoes');
  }
  // The new receipt authorizes rendering only. Existing delivery events own durable credit.
  {
    const receipt = { box: 'line-output', workitemId: 'authority', agentId: 'a' };
    const Floor = require('../frontend/app/floorstats.js'), Pride = require('../frontend/app/pride.js'), Xp = require('../frontend/app/xp.js');
    const floor = Floor.create(); floor.onEvent('workitem.delivered', {}, 1); floor.onEvent('workitem.delivered', receipt, 2);
    assert.equal(floor.snapshot().delivered, 1, 'authority cannot duplicate throughput');
    let pride = Pride.hydrate(null); pride = Pride.fold(pride, 'workitem.delivered', {}, 1); pride = Pride.fold(pride, 'workitem.delivered', receipt, 2);
    assert.equal(Pride.snapshot(pride).deliverables, 1, 'authority cannot duplicate lifetime deliveries');
    let xp = Xp.applyEvent(Xp.fresh(), { name: 'workitem.delivered', payload: {} }).stats;
    xp = Xp.applyEvent(xp, { name: 'workitem.delivered', payload: receipt }).stats;
    assert.equal(xp.counters.delivered, 1, 'authority cannot duplicate XP delivery counters');
    const handlers = {}, context = vm.createContext({ Profile: require('../frontend/app/profile.js'), U: { bus: { on: (n, fn) => { handlers[n] = fn; } } }, console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/profilestore.js'), 'utf8') + '\nglobalThis.store = ProfileStore;', context);
    context.store.init({}); handlers['workitem.delivered']({}); const before = context.store.serialize().total;
    handlers['workitem.delivered'](receipt);
    assert.equal(context.store.serialize().total, before, 'authority cannot duplicate learned interest credit');
  }
  console.log('joined-product-truth: OK — slow sequential/parallel siblings, exact job identity, terminal authority, mass, echo dedup and direct-order isolation');
})().catch(e => { console.error(e); process.exitCode = 1; });
