'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app/onboarding.js'), 'utf8');
async function quickRun(answers, stopAt, wake = false, mind = null, receipts = [], extra = {}) {
  const timers = new Map(), prompts = [], stages = [], writes = [], postures = [], beliefs = [], said = [];
  let timerId = 0, done = 0, taught = 0, context;
  const storage = new Map(), calls = [];
  context = vm.createContext({
    console, Promise, Math,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { setItem(k,v) { storage.set(k,v); }, getItem(k) { return storage.get(k) || null; }, removeItem(k) { storage.delete(k); } },
    World: {},
    Chat: { typeLine(lines, cb) { cb(); }, beginInterview() {}, endInterview() {} },
    WakeMind: require('../frontend/app/wakemind.js'),
    Harness: { configured() { return !!mind; }, chat(request) { calls.push(request.messages[0].content); return Promise.resolve(mind(request.messages[0].content)); } },
    Dialogue: {
      open() {}, close() {}, isOpen() { return false; },
      setStage(title, detail) { stages.push([title, detail]); },
      say(segs) { said.push((segs || []).map(x => x && x.text).join(' ')); return Promise.resolve(); },
      node(cfg) {
        prompts.push(cfg);
        if (prompts.length === stopAt) vm.runInContext('Onboarding.stop()', context);
        return Promise.resolve(answers.shift() || { value: '', skip: true });
      }
    },
    DossierStore: { upsert(...args) { beliefs.push(args); } },
    AutonomyStore: { async applyPreset(value) { postures.push(value); return receipts.shift() || { ok: true }; } },
    opts: { name:'NOVA', wake, docs:{}, stations: extra.stations || null, commit(patch) { writes.push(patch); }, done() { done++; }, taught() { taught++; } },
    ...extra
  });
  vm.runInContext(source, context);
  vm.runInContext('Onboarding.start(opts)', context);
  for (let turn=0; turn<180; turn++) {
    const pending = [...timers]; timers.clear();
    for (const [, fn] of pending) fn();
    await Promise.resolve(); await Promise.resolve();
    if (taught || stopAt && prompts.length >= stopAt) break;
  }
  vm.runInContext('Onboarding.stop()', context);
  return { prompts, stages, writes, postures, beliefs, done, taught, storage, calls, said };
}
(async () => {
  const result = await quickRun([{value:'quick'}, {value:'Help me prepare weekly client updates.'}, {value:'wait'}]);
  assert.equal(result.prompts.length, 3, 'one pace choice followed by exactly two setup questions');
  assert.equal(result.writes[0].purpose, 'Help me prepare weekly client updates.');
  assert.deepEqual(result.postures, ['wait']);
  // quick setup never invents a profile: the ONE belief it writes is the mission they typed, in their words, as a stated
  // goal (41b2d015 review — a typed mission that only reached purpose.md stayed a seed and never grounded their posture)
  assert.deepEqual(JSON.parse(JSON.stringify(result.beliefs)), [['goals', { text: 'Help me prepare weekly client updates.', source: 'onboarding', weight: 'stated' }]], 'quick setup must not invent a personal profile; it files only the typed mission, as stated');
  const chip = await quickRun([{value:'quick'}, {value:'Help me write, debug, and ship software.', label:'Code & build'}, {value:'wait'}]);
  assert.equal(chip.writes[0].purpose, 'Help me write, debug, and ship software.');
  assert.deepEqual(chip.beliefs, [], 'a tapped purpose chip files nothing: its canned line is the station’s wording (purpose.md alone, a seed)');
  assert.equal(result.done, 1); assert.equal(result.taught, 1);
  assert(result.stages.some(([,detail]) => detail.startsWith('1 of 2')));
  assert(result.stages.some(([,detail]) => detail.startsWith('2 of 2')));
  assert(result.storage.has('starnet.interview.deferred.v1'), 'deeper profile stays available later');
  // org P31: the quick label counts what it really asks — no station pick on offer here, so two questions — and only it
  // carries a count: the talks step up (short, then in depth) instead of a second "three" that read no longer than quick
  assert.deepEqual(Array.from(result.prompts[0].options, o => o.label),
    ['Quick setup — two questions', 'A short conversation — your work and goals', 'Let’s talk it through — your goals, in depth']);
  assert(/start with two setup questions/.test(result.prompts[0].lines[0].text), 'the greeting counts the same two');
  // a fresh starter room offers the lead's station pick, so the quick path is THREE questions, numbered 1-3 of 3
  const stations = { fresh: () => true, recommend: () => 'studio', apply: () => ({ ok: true }),
    catalog: () => [{ id: 'studio', name: 'SOFTWARE STUDIO', group: 'work', pitch: 'code and build', purposeLabel: 'Code & build' }] };
  const three = await quickRun([{value:'quick'}, {value:'Help me build software.'}, {value:'wait'}, {value:'studio'}], null, false, null, [], { stations });
  assert.equal(three.prompts[0].options[0].label, 'Quick setup — three questions');
  assert(/start with three setup questions/.test(three.prompts[0].lines[0].text), 'the greeting says three');
  assert.equal(three.prompts.length, 4, 'pace choice + three setup questions');
  assert.deepEqual(three.stages.map(([, d]) => d).filter(d => / of \d/.test(d)),
    ['1 of 3 · Your direction', '2 of 3 · While you are away', '3 of 3 · Where the work happens']);
  assert.deepEqual([...new Set(three.stages.filter(([, d]) => / of \d/.test(d)).map(([t]) => t))], ['GET ACQUAINTED'],
    'all three counted questions sit under one stage name, the station pick included');
  assert(/^last question: which station/.test(three.prompts[3].lines[0].text), 'the station ask is the last question, not "one more"');
  assert.equal(three.taught, 1);
  const retried = await quickRun([{value:'quick'}, {value:'Help me build software.'}, {value:'wait'}, {value:'wait'}], null, false, null, [{ok:false,error:'Save refused'}, {ok:true}]);
  assert.equal(retried.prompts.length, 4, 'a refused posture save repeats the question before completing setup');
  assert.deepEqual(retried.postures, ['wait', 'wait'], 'retry uses the confirmed writer again');
  assert.equal(retried.done, 1, 'setup completes only after a confirmed retry');
  assert.equal(retried.taught, 1, 'a refused save does not duplicate tutorial handoff');
  const fresh = await quickRun([{value:'quick'}, {value:'Help me build software.'}, {value:'wait'}], null, true);
  assert.equal(fresh.done, 1, 'fresh awakening reaches setup completion');
  assert.equal(fresh.taught, 1, 'fresh awakening hands off once');
  const offline = await quickRun([{value:'deep'}, {value:'Help me write.'}, {value:'wait'}]);
  assert.equal(offline.prompts.length, 3, 'offline interview falls back to purpose and posture without pretending to learn');
  assert.equal(offline.taught, 1);
  const skipped = await quickRun([{value:'quick'}, {value:'Research hard questions.'}, {value:'',skip:true}]);
  assert.deepEqual(skipped.postures, [], 'decide later preserves the existing autonomy settings');
  assert.equal(skipped.taught, 1);
  const stopped = await quickRun([{value:'quick'}, {value:'Should never be written'}], 2);
  assert.equal(stopped.writes.length, 0, 'abandoning a question does not commit its late answer');
  assert.equal(stopped.taught, 0, 'abandoned setup cannot open the tutorial');
  const mind = directive => ({ text: directive.includes('THE READ')
    ? 'READ: you want help choosing the next feature.\nPURPOSE: Help choose and build useful features.\nSTACK: NONE'
    : directive.includes('THE TUESDAY')
      ? 'ACK: let’s find a useful place to start.\nASK: which project would you like to make progress on?'
      : '' });
  const live = await quickRun([
    {value:'loose'}, {value:'I want help deciding what to build.'},
    {value:'My station onboarding.'}, {value:'yes'}, {value:'wait'}
  ], null, false, mind);
  assert.equal(live.prompts[1].lines[0].text, 'what made you want to set up an agent?');
  assert.equal(live.prompts[1].customFirst, true, 'typing is available immediately');
  assert.equal(live.prompts[2].lines[0].text, 'which project would you like to make progress on?');
  assert.equal(live.prompts.filter(p => p.lines[0].text === 'which project would you like to make progress on?').length, 1, 'short path enforces budget even if model keeps asking');
  assert(live.writes.some(w => w.context && w.context.includes('My station onboarding.')), 'exact follow-up survives in context');
  assert(live.calls.some(c => c.includes('My station onboarding.')), 'next model turn sees prior answers');
  assert(!live.beliefs.some(([dim]) => dim === 'pain'), 'reason for creating an agent is not filed as pain');
  assert.equal(live.taught, 1);
  const explore = await quickRun([{value:'loose'}, {help:true}, {value:'I want to learn animation.'}, {value:'yes'}, {value:'wait'}], null, false, mind);
  assert(explore.calls.some(c => c.includes('helpRequested')), 'help action reaches model as a request for guidance');
  assert(!explore.writes.some(w => w.context === 'Help me figure that out'), 'help action is never saved as a personal fact');
  const early = await quickRun([{value:'loose'}, {value:'Just curious.'}, {value:'yes'}, {value:'wait'}], null, false,
    d => d.includes('THE TUESDAY') ? {text:'ACK: we can explore together.\nASK: NONE'} : mind(d));
  assert.equal(early.prompts.length, 4, 'ASK NONE skips unnecessary follow-ups');
  const repeated = await quickRun([{value:'deep'}, {value:'Build a game.'}, {value:'A puzzle game.'}, {value:'yes'}, {value:'wait'}], null, false, mind);
  assert.equal(repeated.prompts.filter(p => p.lines[0].text === 'which project would you like to make progress on?').length, 1, 'repeated generated questions are suppressed');
  let nextQuestion = 0;
  const deep = await quickRun([{value:'deep'}, {value:'Build a game.'}, {value:'Browser.'}, {value:'Puzzles.'}, {value:'A playable prototype.'}, {value:'yes'}, {value:'wait'}], null, false,
    d => d.includes('THE TUESDAY') ? {text:'ACK: noted.\nASK: question ' + (++nextQuestion) + '?'} : mind(d));
  assert.equal(deep.prompts.filter(p => /^question \d/.test(p.lines[0].text)).length, 3, 'deep path cannot exceed three follow-ups');
  assert(deep.calls.some(c => c.includes('A playable prototype.')), 'final answer reaches the synthesis');
  /* USER-STUDY LOOP — the confirmed mission is drafted into steps while the cadence beat is asked, then offered. */
  const pathRun = async (pathAnswer, enabled, readAnswers) => {
    const confirmed = [], declined = [], proposedFor = [];
    const mission = 'Help choose and build useful features.';
    // a REAL-shaped dossier: upsert appends + trims + caps at 280, and an OLDER identical belief already exists
    const goals = [{ id: 'cd_old', text: mission }];
    const extra = {
      Goals: require('../frontend/app/goals.js'),
      DossierStore: { upsert(dim, b) { if (dim === 'goals') goals.push({ id: 'cd_' + (goals.length + 1), text: String(b.text).trim().slice(0, 280) }); }, beliefs: dim => dim === 'goals' ? goals.slice() : [] },
      AutonomyStore: { async applyPreset() { return { ok: true }; }, summary: () => ({ enabled }) },
      GoalStore: {
        proposeDecomposition: async b => { proposedFor.push(b && b.id); return { belief: b, texts: ['Shortlist three features', 'Prototype the best one', 'Ship it to five users'] }; },
        confirm: (b, texts) => { confirmed.push([b.id, texts]); return { id: 'g1' }; },
        declineDecomposition: b => declined.push(b.id)
      }
    };
    const r = await quickRun([{value:'loose'}, {value:'I want help deciding what to build.'}, {value:'My station onboarding.'}].concat(readAnswers || [{value:'yes'}], [{value:'suggest'}, pathAnswer]), null, false, mind, [], extra);
    return Object.assign(r, { confirmed, declined, proposedFor, goals });
  };
  const yes = await pathRun({ value: 'confirm' }, true);
  assert.deepEqual(yes.proposedFor, [yes.goals[yes.goals.length - 1].id], 'the belief this meeting just wrote (not an older identical one) is drafted into steps');
  assert.notEqual(yes.proposedFor[0], 'cd_old');
  const pathPrompt = yes.prompts.find(p => p.customLabel === 'edit the steps');
  assert.ok(pathPrompt, 'the path is offered in the meeting with an edit option');
  assert.ok(yes.prompts.indexOf(pathPrompt) > yes.prompts.findIndex(p => (p.options || []).some(o => o.value === 'suggest')), 'the path comes after the cadence beat');
  assert.deepEqual(yes.confirmed, [[yes.proposedFor[0], ['Shortlist three features', 'Prototype the best one', 'Ship it to five users']]], 'confirm persists the drafted path');
  assert.ok(yes.said.some(t => /line up quests for the first step/.test(t)), 'at propose or above it says quests will be lined up');
  assert.equal(yes.taught, 1, 'the meeting still hands off to the tutorial once');
  const edited = await pathRun({ custom: true, value: 'Talk to users; Pick one feature; Ship it' }, false);
  assert.deepEqual(edited.confirmed[0][1], ['Talk to users', 'Pick one feature', 'Ship it'], 'an edited path is what gets saved');
  assert.ok(edited.said.some(t => /start the first step whenever you’re ready/.test(t)) && !edited.said.some(t => /line up quests/.test(t)), 'at wait it never promises quests it will not plan');
  const no = await pathRun({ value: 'other', skip: true }, true);
  assert.deepEqual([no.confirmed.length, no.declined], [0, [no.proposedFor[0]]], 'not now saves nothing and records the decline (re-offers only on change)');
  const longMission = 'Build and launch a local-first newsletter platform for indie game developers ' + 'with weekly issues, reader surveys, and a sponsorship pipeline '.repeat(6);
  const long = await pathRun({ value: 'confirm' }, true, [{ value: 'adjust' }, { value: longMission }]);
  assert.ok(longMission.length > 280, 'precondition: the mission is longer than a belief can hold');
  assert.equal(long.confirmed.length, 1, 'a mission longer than 280 chars (the dossier caps it) still gets its path offered and saved');
  const noGoalStore = await quickRun([{value:'loose'}, {value:'I want help deciding what to build.'}, {value:'My station onboarding.'}, {value:'yes'}, {value:'wait'}], null, false, mind);
  assert.ok(!noGoalStore.prompts.some(p => p.customLabel === 'edit the steps'), 'without a goal store the meeting is unchanged');
  console.log('onboarding-refresh: OK (quick setup, exact answers, posture, deferred profile, cancellation, first path)');
})().catch(error => { console.error(error); process.exitCode = 1; });
