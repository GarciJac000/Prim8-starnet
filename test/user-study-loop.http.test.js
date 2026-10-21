'use strict';
/* USER-STUDY LOOP — a real sidecar settles a plan step with no webview involved: every quest planned for the
   current step is settled (one completed, one dismissed) → the journey records the step with harness-contract
   authority → the goal mirror names the next step. A stale push can never walk the plan back, and it all
   survives a restart. */
const assert = require('node:assert/strict');
const { SidecarFixture } = require('./helpers/sidecar-fixture');

const plan = status => ({
  id: 'g_news', text: 'Launch the newsletter', done: 0, total: 3, pct: 0, next: 'Pick a niche', milestoneId: 'g_news:m1',
  milestones: [
    { id: 'g_news:m1', text: 'Pick a niche', status: status || 'open' },
    { id: 'g_news:m2', text: 'Write issue one', status: 'open' },
    { id: 'g_news:m3', text: 'Get ten subscribers', status: 'open' }
  ]
});

(async () => {
  const host = SidecarFixture.create({ env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_QUEST_REFRESH: '0' } });
  const active = async () => (await host.json('GET', '/api/journey')).body.journey.activeGoal;
  const mint = async (title, milestoneId) => {
    const r = await host.json('POST', '/api/quests/mint', { title, desc: 'a step', contract: { type: 'attest' }, kind: 'generated',
      createdBy: 'system:quest-refresh', goalId: 'g_news', milestoneId });
    assert.equal(r.body.ok, true, 'mint ' + title + ': ' + JSON.stringify(r.body));
    return r.body.id;
  };
  try {
    await host.start();
    const pushed = await host.json('POST', '/api/goals', { goal: plan() });
    assert.equal(pushed.body.goal.milestones.length, 3, 'the sidecar keeps the whole ordered plan');

    const a = await mint('Shortlist three niches', 'g_news:m1');
    const b = await mint('Ask five readers which niche', 'g_news:m1');
    await mint('Outline issue one', 'g_news:m2');

    const rep = await host.json('POST', '/api/quests/report', { id: a, evidence: 'shortlisted AI tools, indie games, and local food' });
    assert.equal(rep.body.ok, true);
    assert.equal((await active()).next, 'Pick a niche', 'one open quest in the slate keeps the step open');

    const dis = await host.json('POST', '/api/quests/dismiss', { id: b });
    assert.equal(dis.body.ok, true);
    const journey = (await host.json('GET', '/api/journey')).body.journey;
    const settled = journey.milestones.find(m => m.milestoneId === 'g_news:m1');
    assert.ok(settled, 'the settled step is recorded in the journey');
    assert.equal(settled.verifiedBy, 'commander-confirmed', 'a slate finished only by the Commander own reports is recorded as THEIR confirmation, never a harness proof');
    assert.match(settled.evidence, /Shortlist three niches/, 'citing the quest completed by its contract');
    assert.doesNotMatch(settled.evidence, /Ask five readers/, 'never citing the dismissed quest');
    assert.equal(journey.activeGoal.next, 'Write issue one', 'the mirror moved to the next step');
    assert.equal(journey.activeGoal.done, 1);

    const refresh = (await host.json('GET', '/api/quests/refresh')).body;
    const ledger = (refresh.state && refresh.state.ledger) || refresh.ledger || [];
    assert.ok(ledger.some(e => e.outcome === 'advanced' && e.title === 'Pick a niche'), 'the refresh ledger says the step finished: ' + JSON.stringify(refresh).slice(0, 400));

    const stale = await host.json('POST', '/api/goals', { goal: plan('open') });
    assert.equal(stale.body.goal.milestoneId, 'g_news:m2', 'a stale webview push can never walk the plan backwards');

    // What the station learned while the window was closed: study batches from runs the browser never watched
    // (a cron run on a crew agent, a channel run on the hero) are listed for the consent card, oldest first.
    await host.stop();
    const studyFile = require('node:path').join(host.workspace, 'study.state.json');
    const prop = (id, text) => ({ id, dim: 'goals', kind: 'add', text, evidence: 'said it in the run', source: 'study' });
    require('node:fs').writeFileSync(studyFile, JSON.stringify({ v: 1, byRun: {
      run_cron_7: { agentId: 'scout', runId: 'run_cron_7', createdAt: 2000, proposals: [prop('s1', 'Publishes every Friday')] },
      run_tg_3: { agentId: 'agent', runId: 'run_tg_3', createdAt: 1000, proposals: [prop('s2', 'Wants readers in indie games'), prop('s3', 'Writes in the mornings')] },
      run_empty: { agentId: 'agent', runId: 'run_empty', createdAt: 3000, proposals: [] }
    }, latest: {}, lastAt: {}, declined: {} }));
    // A LOST FOLD, RECOVERED; THEN AN IDLE POLL THAT WRITES NOTHING (2026-10-19). A quest completion is durable before
    // its journey fold: a done quest the journey never recorded (a crash between the two) is folded by the next
    // journey read. Once nothing is pending, the 4 s journey poll answers byte-identical bodies and never rewrites
    // the journey or its backup (the reconcile replays only quests still to fold, over cached reads).
    const fsx = require('node:fs'), px = require('node:path');
    const qFile = px.join(host.workspace, '_station.quests.json'), jFile = px.join(host.workspace, '_station.journey.json');
    const qLedger = JSON.parse(fsx.readFileSync(qFile, 'utf8'));
    qLedger.quests.push({ id: 'q:lost-fold', title: 'Draft the welcome email', contract: { type: 'run', key: 'run_lost' }, status: 'done',
      agentId: 'agent', completedBy: 'agent', domain: 'writing', createdAt: Date.now() - 5000, completedAt: Date.now() });
    fsx.writeFileSync(qFile, JSON.stringify(qLedger));
    await host.start();
    const recovered = await host.json('GET', '/api/journey');
    assert.ok(recovered.body.journey.outcomes.some(o => o.questId === 'q:lost-fold' && o.verifiedBy === 'harness-contract'),
      'the lost fold is recovered by the next journey read: ' + recovered.text.slice(0, 300));
    const stampOf = f => { try { const s = fsx.statSync(f, { bigint: true }); return s.ino + ':' + s.size + ':' + s.mtimeNs; } catch (e) { return e.code; } };
    const before = [stampOf(jFile), stampOf(jFile + '.bak')];
    const idle = [];
    for (let i = 0; i < 5; i++) idle.push((await host.json('GET', '/api/journey')).text);
    assert.ok(idle.every(t => t === recovered.text), 'idle journey polls answer the same bytes');
    assert.deepEqual([stampOf(jFile), stampOf(jFile + '.bak')], before, 'idle journey polls never rewrite the journey or its backup');
    const pending = (await host.json('GET', '/api/study/pending')).body.batches;
    assert.deepEqual(pending.map(b => [b.runId, b.agentId, b.count]), [['run_tg_3', 'agent', 2], ['run_cron_7', 'scout', 1]], 'every undecided away batch is listed, oldest first; empty batches are not');
    const perRun = (await host.json('GET', '/api/study/proposals?agent=scout&run=run_cron_7')).body.proposals;
    assert.equal(perRun[0].text, 'Publishes every Friday', 'each listed batch is fetchable for the consent card');
    await host.json('POST', '/api/study/resolve', { agentId: 'scout', runId: 'run_cron_7', id: 's1', declined: [] });
    assert.deepEqual((await host.json('GET', '/api/study/pending')).body.batches.map(b => b.runId), ['run_tg_3'], 'a decided batch leaves the list');

    const after = await active();
    assert.equal(after.next, 'Write issue one', 'the advanced plan survives a restart');
    assert.equal(after.done, 1);
    console.log('user-study-loop.http: PASS (slate settles step, stale push held, restart, away study listed, honest authority)');
  } finally { await host.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
