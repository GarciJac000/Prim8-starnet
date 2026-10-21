/* node test/loopgit.test.js — the PURE git decision half of the LOOP harvest (S3).

   The hole this closes: approve/reject used to be pure bookkeeping. The driver's defaultHarvest returned
   commit:null, no harvest was injected, and the verdict route ran no git — so REJECT marked a row rejected
   while the agent's code sat untouched in the Commander's project. loopgit.js decides what a pass may commit
   and what a rejection must undo; index.js runs the git.

   What is actually proven here:
     1. A LOOP NEVER COMMITS ONTO A PROTECTED REF — not on its first pass, and not from a hand-edited record.
     2. AN ITERATION STAGES ONLY ITS OWN PATHS — no `add -A`, so the Commander's own uncommitted work is
        never swept into a commit that a later rejection reverts.
     3. UNDO MIRRORS THE STACKING LAW AND RUNS NEWEST FIRST — rejecting #3 undoes #5, #4, #3 in that order,
        skips anything already approved, and never touches iterations below n.
     4. WHAT CANNOT BE UNDONE SAYS SO — a non-git project and an unreadable sha both return 'blocked' with a
        reason, so the route can refuse instead of reporting a clean rejection over work still in the tree.

   Pure: no clock, no fs, no spawn. Loops are built through the real store so the record shapes are the ones
   production actually persists. */
'use strict';
const A = require('./_assert.js');
const G = require('../sidecar/loopgit.js');
const S = require('../sidecar/loopjob-store.js');

const T0 = 1700006400000;          // fixed epoch, UTC midnight (same discipline as loopjob.test.js)
const MIN = 60000;

const mk = (spec) => S.createLoop([], Object.assign({ id: 'l1', name: 'fix the tests', objective: 'go', workdir: '/proj' }, spec), { now: T0 });
const one = (loops) => S.getLoop(loops, 'l1');

// one full iteration: claim -> start -> settle, with whatever the harvest reported.
function cycle(loops, res, at) {
  const t = at == null ? T0 : at;
  loops = S.claimFire(loops, 'l1', { now: t });
  loops = S.startIteration(loops, 'l1', { runId: res.runId, now: t });
  return S.settleIteration(loops, 'l1', res, { now: t + MIN });
}
// build a loop with N committed candidates, sha'd 'aaaa001'.. so order is readable in failures.
function withCandidates(n, spec) {
  let L = mk(spec);
  for (let i = 1; i <= n; i++) {
    L = cycle(L, { runId: 'r' + i, status: 'ok', text: 'did work ' + i, title: 'work ' + i, commit: 'aaaa00' + i }, T0 + i * MIN * 10);
  }
  return L;
}

// ---- 1. protected refs: the loop's work never lands on the Commander's main ----
{
  A.ok(G.isProtectedRef('main'), 'main is protected');
  A.ok(G.isProtectedRef('MASTER'), 'protection is case-insensitive');
  A.ok(G.isProtectedRef('  trunk  '), 'surrounding whitespace does not defeat protection');
  A.ok(G.isProtectedRef('refs/heads/main'), 'the fully qualified form is protected too — rev-parse is not the only source');
  A.ok(!G.isProtectedRef('loop/20231115-fix-the-tests-l1'), 'a loop branch is not protected');
  // the allowlist is a Set, not an object literal: ({main:1}).constructor is truthy and would falsely
  // protect (and therefore refuse) an ordinary branch called 'constructor'.
  A.ok(!G.isProtectedRef('constructor'), 'an Object.prototype key is not mistaken for a protected ref');
  A.ok(!G.isProtectedRef('__proto__'), '__proto__ is not mistaken for a protected ref');
}

// ---- 2. branch naming: unique per loop, never protected, never empty ----
{
  const b = G.branchName('2023-11-15', 'fix the tests', 'l1');
  A.eq(b, 'loop/20231115-fix-the-tests-l1', 'branch is loop/<date>-<slug>-<id>');
  A.ok(!G.isProtectedRef(b), 'a generated branch is never protected');
  A.eq(G.branchName('20231115', '', 'l1'), 'loop/20231115-objective-l1', 'a nameless loop still gets a branch');
  A.eq(G.branchName('', '!!!', ''), 'loop/x-objective-loop', 'every segment has a fallback — the name can never collapse to "loop/"');
  // TWO loops, same repo, same name, same day: the id keeps their branches apart. Sharing one branch would
  // make each loop's rejection revert the other loop's commits.
  A.ok(G.branchName('20231115', 'sweep', 'l1') !== G.branchName('20231115', 'sweep', 'l2'), 'same name + same day + different loop = different branch');
}

// ---- 3. commit subject: bounded, and it always says which iteration it was ----
{
  const s = G.commitSubject({ name: 'fix the tests' }, 4, 'stop double-counting cents');
  A.ok(s.indexOf('#4') > 0, 'the subject names the iteration');
  A.ok(s.indexOf('stop double-counting cents') > 0, 'the subject carries the reported title');
  A.ok(G.commitSubject({ name: 'x' }, 2, '').indexOf('#2') > 0, 'a titleless pass still identifies itself');
  A.ok(G.commitSubject({ name: 'x'.repeat(200) }, 1, 'y'.repeat(200)).length <= G.SUBJECT_CAP, 'the subject is capped');
  A.eq(G.commitSubject({ name: 'a' }, 3, ' multi \n line ').indexOf('\n'), -1, 'newlines never reach the subject line');
}

// ---- 4. pathspec: an iteration stages ONLY its own paths, and only safe ones ----
{
  A.eq(G.commitPaths(['src/a.js', 'src/b.js']), ['src/a.js', 'src/b.js'], 'plain strings pass through in order');
  A.eq(G.commitPaths([{ path: 'src/a.js' }, { path: 'src/b.js' }]), ['src/a.js', 'src/b.js'], 'iteration files[] records are accepted too');
  A.eq(G.commitPaths(['a.js', 'a.js']), ['a.js'], 'duplicates are collapsed');
  A.eq(G.commitPaths(['/etc/passwd']), [], 'an absolute path is refused');
  A.eq(G.commitPaths(['C:\\Windows\\notepad.exe']), [], 'a drive-absolute path is refused');
  A.eq(G.commitPaths(['../../outside.js']), [], 'traversal is refused');
  A.eq(G.commitPaths(['src/../../out.js']), [], 'traversal is refused mid-path too');
  A.eq(G.commitPaths(['ok.js\u0000evil']), [], 'a NUL byte is refused');
  A.eq(G.commitPaths(null), [], 'a missing file list is an empty pathspec, never a whole-tree stage');
  A.eq(G.commitPaths([]), [], 'an empty file list stages nothing');
  const many = [];
  for (let i = 0; i < 500; i++) many.push('f' + i + '.js');
  A.eq(G.commitPaths(many).length, G.PATHS_CAP, 'the pathspec is capped');
  A.eq(G.harvestDelta(null, { gitProven: true, files: ['MY-NOTES.txt'] }).ok, false, 'missing pre-iteration proof fails closed instead of claiming every dirty file');
  A.eq(G.harvestDelta({ gitProven: false, files: [] }, { gitProven: true, files: ['MY-NOTES.txt'] }).ok, false, 'an unproven pre-iteration snapshot never aliases to a clean tree');
  A.eq(G.harvestDelta({ gitProven: true, files: ['MY-NOTES.txt'] }, { gitProven: true, files: ['MY-NOTES.txt', 'src/new.js'] }),
    { ok: true, paths: ['src/new.js'] }, 'a proven delta excludes Commander-owned files that were already dirty');
}

// ---- 5. undoPlan: THE STACKING LAW, in git ----
{
  // #1..#5 all committed; reject #3 -> undo 5, 4, 3 (newest first), leave 1 and 2 alone.
  const L = one(withCandidates(5, { queueCap: 9 }));
  const plan = G.undoPlan(L, 3);
  A.eq(plan.mode, 'revert', 'a stack of real commits is revertable');
  A.eq(plan.commits.map(c => c.n), [5, 4, 3], 'NEWEST FIRST — reverting the oldest first conflicts on any file a later pass touched again');
  A.eq(plan.commits.map(c => c.sha), ['aaaa005', 'aaaa004', 'aaaa003'], 'each entry carries its own sha');
  A.ok(plan.commits.every(c => c.n >= 3), 'nothing below the rejected iteration is ever touched');

  // approvals are FIFO (sweep/autonomy 2026-10-20): #5 was built on unreviewed #1..#4, so approving it first is
  // refused by the store — otherwise rejecting #3 later could not reach it and approved work built on a rejected pass
  // would survive. The undo plan still never reverts an approval a pre-FIFO record already holds above n.
  let L2 = withCandidates(5, { queueCap: 9 });
  A.eq(one(S.recordVerdict(L2, 'l1', 5, 'approved', { now: T0 + MIN * 100 })).iterations.find(it => it.n === 5).verdict, null, 'approving #5 over unreviewed #1..#4 is a no-op');
  L2 = L2.map(l => Object.assign({}, l, { iterations: l.iterations.map(it => (it.n === 5 ? Object.assign({}, it, { verdict: 'approved' }) : it)) }));
  A.eq(G.undoPlan(one(L2), 3).commits.map(c => c.n), [4, 3], 'an approved iteration above the rejected one (a pre-FIFO record) is not reverted');

  // rejecting the newest candidate undoes exactly one commit
  A.eq(G.undoPlan(one(withCandidates(3, { queueCap: 9 })), 3).commits.map(c => c.n), [3], 'the top of the stack undoes only itself');
}

// ---- 6. iterations that produced no commit ----
{
  // a research pass that changed no file has commit:null. It is not revertable and it does not need to be —
  // but it must be reported, not silently dropped from the story.
  let L = mk({ queueCap: 9 });
  L = cycle(L, { runId: 'r1', status: 'ok', text: 'read things', title: 'read', commit: null }, T0);
  L = cycle(L, { runId: 'r2', status: 'ok', text: 'edited', title: 'edit', commit: 'bbbb002' }, T0 + MIN * 10);
  const plan = G.undoPlan(one(L), 1);
  A.eq(plan.mode, 'revert', 'the stack is still revertable when only some passes committed');
  A.eq(plan.commits.map(c => c.n), [2], 'only the passes that really committed are reverted');
  A.eq(plan.commitless, [1], 'a pass that committed nothing is reported as commitless, not hidden');

  // nothing at all committed, but the loop DID get a branch -> genuinely nothing to undo.
  let R = mk({ queueCap: 9, branch: 'loop/20231115-x-l1' });
  R = cycle(R, { runId: 'q1', status: 'ok', text: 'nothing', title: 'nothing', commit: null }, T0);
  A.eq(G.undoPlan(one(R), 1).mode, 'none', 'a git loop whose pass committed nothing has genuinely nothing to undo');
}

// ---- 7. what CANNOT be undone must say so (truthful telemetry, not a clean-looking rejection) ----
{
  /* A non-git PROJECT FOLDER: the edits are real, on disk, and unrevertable. The rejection still goes
     through — refusing would strand a candidate nobody could ever rule on — but it must not read as a clean
     undo. 'unrevertable' is what carries that sentence to the panel. */
  let N = mk({ queueCap: 9 });                       // no branch is ever set for a non-git loop
  N = cycle(N, { runId: 'n1', status: 'ok', text: 'edited files', title: 'edit', commit: null }, T0);
  const np = G.undoPlan(one(N), 1);
  A.eq(np.mode, 'unrevertable', 'a non-git loop cannot undo its own file edits, but does not block the verdict');
  A.ok(/not a git repo/.test(np.reason || ''), 'and it says exactly why: ' + np.reason);
  A.eq(np.commits, [], 'with nothing for the host to run');

  /* A loop with NO project folder at all worked only inside the agent's own jail, so a rejection costs the
     Commander's disk nothing. This is the ordinary shape of a research loop and it must never be blocked —
     blocking it would make REJECT unusable for every loop that does not touch a project. */
  let J = S.createLoop([], { id: 'l1', name: 'research', objective: 'read things' }, { now: T0 });
  J = cycle(J, { runId: 'j1', status: 'ok', text: 'read things', title: 'read', commit: null }, T0);
  A.eq(G.undoPlan(one(J), 1).mode, 'none', 'a loop with no project folder has genuinely nothing to undo');
  A.eq(G.undoPlan(one(J), 1).reason, null, 'and invents no warning about files it never touched');

  // a hand-edited sha is untrusted input; refuse the whole plan rather than undo a subset and claim the lot.
  let B = withCandidates(2, { queueCap: 9 });
  B = S.updateLoop(B, 'l1', { branch: 'loop/20231115-x-l1' }, { now: T0 });
  const loopB = one(B);
  loopB.iterations[1].commit = '--force';            // simulates a tampered/garbage persisted record
  const bp = G.undoPlan(loopB, 1);
  A.eq(bp.mode, 'blocked', 'an unreadable commit id blocks the undo');
  A.ok(/#2/.test(bp.reason || ''), 'the reason names the offending iteration: ' + bp.reason);
  A.eq(bp.commits, [], 'a blocked plan hands the host nothing to run');

  A.eq(G.undoPlan(one(mk()), 99).mode, 'blocked', 'an iteration that does not exist is blocked, not silently empty');
  A.eq(G.undoPlan(null, 1).mode, 'blocked', 'a missing loop is blocked');
}

// ---- 8. sha shape guard (these strings reach an argv) ----
{
  A.ok(G.isSha('aaaa001'), 'a short sha is accepted');
  A.ok(G.isSha('0123456789abcdef0123456789abcdef01234567'), 'a full sha is accepted');
  A.ok(!G.isSha('--force'), 'a flag-shaped string is not a sha');
  A.ok(!G.isSha('HEAD~1'), 'a revision expression is not a sha');
  A.ok(!G.isSha('aaa'), 'too short is not a sha');
  A.ok(!G.isSha(''), 'empty is not a sha');
  A.ok(!G.isSha(null), 'null is not a sha');
}

// ---- 9. harvestTarget: where a pass is allowed to commit ----
{
  const L = one(mk());
  A.eq(G.harvestTarget(L, { blessed: false, isRepo: true, dateStr: '20231115' }).ok, false, 'an unapproved folder cannot be committed to');
  A.ok(/no longer approved/.test(G.harvestTarget(L, { blessed: false, isRepo: true }).reason), 'and it names the revoked approval');
  A.eq(G.harvestTarget(L, { blessed: true, isRepo: false, dateStr: '20231115' }).ok, false, 'a non-repo has no harvest target');

  const t = G.harvestTarget(L, { blessed: true, isRepo: true, dateStr: '20231115', headBranch: 'main' });
  A.eq(t.ok, true, 'a blessed repo gets a target');
  A.eq(t.create, true, 'the first pass creates the loop branch');
  A.eq(t.branch, 'loop/20231115-fix-the-tests-l1', 'off whatever HEAD it found');
  A.ok(!G.isProtectedRef(t.branch), 'the created branch is never protected — main is only ever branched FROM');

  const L2 = one(S.updateLoop(mk(), 'l1', { branch: 'loop/20231115-fix-the-tests-l1' }, { now: T0 }));
  const t2 = G.harvestTarget(L2, { blessed: true, isRepo: true, dateStr: '20231116' });
  A.eq(t2.create, false, 'a loop that already has a branch never re-creates one');
  A.eq(t2.branch, 'loop/20231115-fix-the-tests-l1', 'and it keeps committing to the same branch tomorrow');

  // a record naming a protected branch can only come from a hand-edited file — honouring it would commit
  // the agent's work straight onto the Commander's main.
  const L3 = one(S.updateLoop(mk(), 'l1', { branch: 'main' }, { now: T0 }));
  const t3 = G.harvestTarget(L3, { blessed: true, isRepo: true, dateStr: '20231115' });
  A.eq(t3.ok, false, 'a recorded protected branch is refused');
  A.ok(/refusing to commit onto main/.test(t3.reason), 'and the refusal names it: ' + t3.reason);

  A.eq(G.harvestTarget(null, { blessed: true, isRepo: true }).ok, false, 'no loop, no target');
  A.eq(G.harvestTarget({ id: 'x', name: 'y' }, { blessed: true, isRepo: true }).ok, false, 'a loop with no project folder has no target');
}

A.report('loopgit (the LOOP git harvest decision)');
