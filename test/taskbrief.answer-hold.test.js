/* node test/taskbrief.answer-hold.test.js — ANSWER HOLD (store half). prepare()'s answer branch says WHAT it
   consumed (inputAction 'answer' + answered {index, at, prevInput}) on the returned copy only, and
   reopenAnswer() puts the brief back exactly as it was before the answer — so a run refused or failed before
   the model read the answer leaves the next reply resuming the ORIGINAL task instead of minting a new brief
   whose ORIGINAL REQUEST is the one-word answer. Every stale case refuses and leaves the record untouched.
   Offline + deterministic (fake disk). The wired run-path half lives in taskbrief.refused-answer.http.test.js. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');

function fakeDisk() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(f); },
    writeFileSync(f, d) { files.set(f, d); }, renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    existsSync(f) { return files.has(f); }, mkdirSync() {}, unlinkSync(f) { files.delete(f); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}, _files: files
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const makeStore = () => makeTaskBriefStore({ fs: fakeDisk(), path, workspaces: '/ws', writeDurable });
const MARKER_Q = { text: 'Include the budget figures?', options: ['yes', 'no'] };

// one asked-and-answered brief: run 1 asked via the marker path, run 2 carried the answer
async function answered(store, key) {
  await store.prepare({ id: 'tb_r1', key, runId: 'r1', text: 'Write notes.txt about the launch' }, 100);
  await store.ask('tb_r1', MARKER_Q, 110, { source: 'marker' });
  return store.prepare({ id: 'tb_r2', key, runId: 'r2', text: 'yes' }, 200);
}
const snap = (store, key) => JSON.stringify(store.list({ key }));

(async () => {
  // ---- A. prepare names what it consumed; reopen restores the pre-answer brief; the retry resumes it ----
  {
    const store = makeStore(); const key = 'stream:a';
    const b = await answered(store, key);
    A.eq(b.id, 'tb_r1', 'the answer lands on the asking brief');
    A.eq(b.inputAction, 'answer', 'prepare says this input ANSWERED an open question');
    A.eq(b.answered, { index: 0, at: 200, prevInput: 'Write notes.txt about the launch' }, 'and exactly which question, when, and the input it replaced');
    A.eq(store.active(key).status, 'ready', 'the persisted brief is ready (the answer is stamped)');
    A.eq(store.active(key).inputAction, undefined, 'the hold fields ride the returned copy only, never the persisted record');
    A.eq(store.active(key).answered, undefined, 'no answered marker is persisted');

    const reopened = await store.reopenAnswer(b.id, b.answered, 300);
    A.ok(reopened, 'an untouched answered brief reopens');
    const live = store.active(key);
    A.eq(live.status, 'clarifying', 'the question is open again');
    A.eq(live.questions[0].answer, '', 'its answer is cleared');
    A.eq(live.questions[0].answeredAt, 0, 'its answeredAt is cleared');
    A.eq(live.currentInput, 'Write notes.txt about the launch', 'currentInput is the pre-answer input');
    A.eq(live.updatedAt, 300, 'updatedAt moves forward to the reopen');

    const retry = await store.prepare({ id: 'tb_r3', key, runId: 'r3', text: 'yes' }, 400);
    A.eq(retry.id, 'tb_r1', 'the re-sent answer lands on the SAME brief (no new brief minted)');
    A.eq(retry.originalDirective, 'Write notes.txt about the launch', 'the ORIGINAL REQUEST survives the refused run');
    A.eq(retry.questions[0].answer, 'yes', 'the decision is recorded once more');
    A.eq(store.list({ key }).length, 1, 'still exactly one brief on the conversation');
  }

  // ---- B. stale guards: anything that moved since the answer refuses, record untouched ----
  {
    // B1. the model settled the brief (brief_proceed) before the run died
    const store = makeStore(); const key = 'stream:b1';
    const b = await answered(store, key);
    await store.proceed(b.id, { objective: 'Write launch notes to notes.txt', deliverable: 'notes.txt', audience: 'team', success: 'file exists with the budget figures' }, 250);
    A.eq(store.active(key).status, 'executing', 'precondition: proceed settled the brief');
    const before = snap(store, key);
    A.eq(await store.reopenAnswer(b.id, b.answered, 300), null, 'an executing brief never reopens');
    A.eq(snap(store, key), before, 'and the record is untouched');
  }
  {
    // B2. a newer brief exists on the same conversation
    const store = makeStore(); const key = 'stream:b2';
    const b = await answered(store, key);
    await store.complete(b.id, 'r2', 210);
    await store.prepare({ id: 'tb_r9', key, runId: 'r9', text: 'Now draft the press release' }, 220);
    const before = snap(store, key);
    A.eq(await store.reopenAnswer(b.id, b.answered, 300), null, 'a completed brief with a newer sibling never reopens');
    A.eq(snap(store, key), before, 'record untouched');
  }
  {
    // B3. a newer brief on the key while the answered brief is still 'ready' (a concurrent run minted one)
    const store = makeStore(); const key = 'stream:b3';
    const b = await answered(store, key);
    await store._durable.update('task-briefs', cur => {
      cur.briefs.push({ id: 'tb_x', key, originalDirective: 'other', currentInput: 'other', status: 'ready', createdAt: 250, updatedAt: 250 });
      return cur;
    });
    const before = snap(store, key);
    A.eq(await store.reopenAnswer(b.id, b.answered, 300), null, 'a newer brief on the conversation wins');
    A.eq(snap(store, key), before, 'record untouched');
  }
  {
    // B4. a wrong/forged hold: different timestamp, different index, missing fields
    const store = makeStore(); const key = 'stream:b4';
    const b = await answered(store, key);
    const before = snap(store, key);
    A.eq(await store.reopenAnswer(b.id, Object.assign({}, b.answered, { at: 199 }), 300), null, 'a wrong answeredAt refuses');
    A.eq(await store.reopenAnswer(b.id, Object.assign({}, b.answered, { index: 1 }), 300), null, 'a wrong question index refuses');
    A.eq(await store.reopenAnswer(b.id, null, 300), null, 'no hold refuses');
    A.eq(await store.reopenAnswer('tb_nope', b.answered, 300), null, 'an unknown brief refuses');
    A.eq(snap(store, key), before, 'record untouched by every refused reopen');
  }
  {
    // B5. the brief was touched after the answer (updateContext / ask moved updatedAt)
    const store = makeStore(); const key = 'stream:b5';
    const b = await answered(store, key);
    await store._durable.update('task-briefs', cur => { cur.briefs[0].updatedAt = 260; return cur; });
    const before = snap(store, key);
    A.eq(await store.reopenAnswer(b.id, b.answered, 300), null, 'a brief updated after the answer refuses');
    A.eq(snap(store, key), before, 'record untouched');
  }

  // ---- C. non-answer inputs carry no hold ----
  {
    const store = makeStore(); const key = 'stream:c';
    const fresh = await store.prepare({ id: 'tb_c1', key, runId: 'c1', text: 'Write notes.txt about the launch' }, 100);
    A.eq(fresh.inputAction, undefined, 'a fresh directive is not an answer');
    A.eq(fresh.answered, undefined, 'and carries no hold');
    await store.ask('tb_c1', MARKER_Q, 110, { source: 'marker' });
    const resumed = await store.prepare({ id: 'tb_c2', key, runId: 'c2', text: 'yes', resumeOnly: true }, 120);
    A.eq(resumed.answered, undefined, 'a recovery continuation never consumes (or holds) an answer');
    const cancelled = await store.prepare({ id: 'tb_c3', key, runId: 'c3', text: 'cancel' }, 130);
    A.eq(cancelled.inputAction, 'cancel', 'a cancel stays a cancel');
    A.eq(cancelled.answered, undefined, 'and carries no hold');
  }

  A.report('taskbrief.answer-hold.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
