/* node test/fs.concurrent-mutations.test.js — TWO RUNS, ONE FILE: no edit is ever lost (2026-10-20).

   makeFsTools is built PER RUN, and team.dispatch runs its workers with Promise.all. Every fs mutation was
   read -> await the LSP baseline -> writeFile of a whole file composed from that read, so two runs editing one
   project file interleaved and the later writer erased the other's change. Both receipts still said
   read-back-verified (each read back its OWN bytes), so the lead told the Commander the work was done. Reproduced
   20/20 with a slow baseline, 5/5 without one; concurrent fs.append lost a line 9-10 runs out of 10.

   Real temp dirs, real fs, two real makeFsTools instances sharing one project (the shape index.js builds for a
   lead and its worker). The LSP stub only controls WHEN the baseline answers. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-concurrent-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LSP_OK = { status: 'available', added: [], removed: [], addedCount: 0, removedCount: 0 };

// one "run": its own makeFsTools instance, an LSP stub whose baseline waits `beginEdit` (ms or a function)
function run(proj, beginEdit) {
  const pathTrust = async (abs) => ({ base: proj, abs });
  const editDiagnostics = beginEdit == null ? undefined : {
    beginEdit: async () => { if (typeof beginEdit === 'function') await beginEdit(); else await sleep(beginEdit); return { items: [] }; },
    finishEdit: async () => LSP_OK
  };
  return makeFsTools({ fsp, pathMod: path, root: ROOT, pathTrust, editDiagnostics });
}
// a baseline that parks until the test releases it, and says when it has been reached
function heldBaseline() {
  let reach, release;
  const reached = new Promise((r) => { reach = r; });
  const released = new Promise((r) => { release = r; });
  return { reached, release, wait: async () => { reach(); await released; } };
}
async function rejection(p) {
  try { await p; return null; } catch (e) { return e; }
}

(async () => {
  await fsp.mkdir(ROOT, { recursive: true });
  let n = 0;
  async function project(files) {
    const proj = path.join(ROOT, 'proj' + (n++));
    await fsp.mkdir(proj, { recursive: true });
    for (const [rel, text] of Object.entries(files)) await fsp.writeFile(path.join(proj, rel), text);
    return proj;
  }

  // ---- 1. two runs, concurrent fs.edit on different lines, a fast and a slow language server ----
  {
    let bothKept = 0, bothVerified = 0, driftNamed = 0;
    for (let i = 0; i < 10; i++) {
      const proj = await project({ 'a.js': 'const A = 1;\nconst B = 2;\n' });
      const lead = run(proj, 5), worker = run(proj, 60);
      const c1 = { agentId: 'lead', projectRoot: proj }, c2 = { agentId: 'worker', projectRoot: proj };
      await lead.readTool.run({ path: 'a.js' }, c1);
      await worker.readTool.run({ path: 'a.js' }, c2);
      const [x, y] = await Promise.allSettled([
        lead.editTool.run({ path: 'a.js', find: 'const A = 1;', replace: 'const A = 100;' }, c1),
        worker.editTool.run({ path: 'a.js', find: 'const B = 2;', replace: 'const B = 200;' }, c2)]);
      const final = await fsp.readFile(path.join(proj, 'a.js'), 'utf8');
      if (final === 'const A = 100;\nconst B = 200;\n') bothKept++;
      if (x.status === 'fulfilled' && y.status === 'fulfilled' && x.value.mutationReceipt.state === 'read-back-verified'
        && y.value.mutationReceipt.state === 'read-back-verified') bothVerified++;
      if (y.status === 'fulfilled' && /\[LSP unavailable: the file changed on disk while this edit was in flight/.test(y.value.content)) driftNamed++;
    }
    A.eq(bothKept, 10, 'concurrent fs.edit from two runs keeps BOTH edits every time (trunk lost one 20/20)');
    A.eq(bothVerified, 10, 'both receipts are read-back-verified, and now that is true of the file on disk');
    A.eq(driftNamed, 10, "the edit that landed on the other run's bytes says its LSP before/after comparison is unavailable, never 'no new diagnostics'");
  }

  // ---- 2. concurrent fs.append with no language server: no line is lost ----
  {
    let bothLines = 0;
    for (let i = 0; i < 10; i++) {
      const proj = await project({ 'log.md': '# log\n' });
      const a = run(proj), b = run(proj);
      const ctx = { agentId: 'ag', projectRoot: proj };
      const rs = await Promise.allSettled([
        a.appendTool.run({ path: 'log.md', content: 'worker A line\n' }, ctx),
        b.appendTool.run({ path: 'log.md', content: 'worker B line\n' }, ctx)]);
      const final = await fsp.readFile(path.join(proj, 'log.md'), 'utf8');
      if (rs.every((r) => r.status === 'fulfilled') && /worker A line\n/.test(final) && /worker B line\n/.test(final) && final.length === '# log\n'.length + 28) bothLines++;
    }
    A.eq(bothLines, 10, 'concurrent fs.append from two runs keeps both lines every time (trunk lost one 9-10/10)');
  }

  // ---- 2b. two runs that never READ the file take turns appending: A, B, A, B all land ----
  // Each run's append stamped the merged file as bytes it had seen, so its next append (after the other run's line)
  // was refused by the read-version check as "changed since you last read or wrote it": a run that never read the
  // file could not keep appending to a shared log. Only a run that READ the file is refused; the rest append onto the
  // current bytes as trunk did, and their whole-file guards still hold.
  for (const start of ['existing', 'missing']) {
    const proj = await project(start === 'existing' ? { 'log.md': '# log\n' } : {});
    const a = run(proj), b = run(proj);
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    const outcome = [];
    for (const [t, c, line] of [[a, ca, 'A1\n'], [b, cb, 'B1\n'], [a, ca, 'A2\n'], [b, cb, 'B2\n'], [a, ca, 'A3\n'], [b, cb, 'B3\n']]) {
      try { outcome.push((await t.appendTool.run({ path: 'log.md', content: line }, c)).mutationReceipt.state); }
      catch (e) { outcome.push('refused: ' + e.message); }
    }
    const want = (start === 'existing' ? '# log\n' : '') + 'A1\nB1\nA2\nB2\nA3\nB3\n';
    A.eq(outcome, Array(6).fill('read-back-verified'), start + ' file: two rounds of alternating appends from two runs that never read it all land verified');
    A.eq(await fsp.readFile(path.join(proj, 'log.md'), 'utf8'), want, start + ' file: every line, in order');
    // the lost-update guards are kept: the file holds the other run's lines, which run A has never seen
    const ed = await rejection(a.editTool.run({ path: 'log.md', find: 'A1\n', replace: 'A1 (edited)\n' }, ca));
    A.eq(ed && ed.message, "edit refused: log.md holds another writer's changes that you have not read: they landed before an earlier fs.append of yours on it, and that fs.append went on after them — nothing was written. fs.read it again and redo your change against the current content.",
      start + ' file: an fs.edit from the appending run is refused, and says truthfully why (it did write the file last)');
    const wr = await rejection(a.writeTool.run({ path: 'log.md', content: 'A1\nA2\nA3\n' }, ca));
    A.eq(wr && wr.message, "stale write refused: log.md holds another writer's changes that you have not read: they landed before an earlier fs.append of yours on it, and that fs.append went on after them. This write would erase them, so nothing was written. fs.read it again and re-apply your change on top of the current content.",
      start + " file: a whole-file fs.write from the appending run would erase the other run's lines and is refused");
    A.eq(await fsp.readFile(path.join(proj, 'log.md'), 'utf8'), want, start + " file: the other run's lines survived both");
  }

  // ---- 3. fs.write over a file this run READ refuses when another run wrote it during the baseline ----
  {
    const proj = await project({ 'c.js': 'v1\n' });
    const held = heldBaseline();
    const a = run(proj, held.wait), b = run(proj);
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    await a.readTool.run({ path: 'c.js' }, ca);
    await b.readTool.run({ path: 'c.js' }, cb);
    const pending = rejection(a.writeTool.run({ path: 'c.js', content: 'A rewrite from a stale read\n' }, ca));
    await held.reached;
    await b.editTool.run({ path: 'c.js', find: 'v1', replace: 'B edit' }, cb);
    held.release();
    const e = await pending;
    A.ok(e && /^stale write refused: c\.js changed on disk after you read it/.test(e.message), 'the stale whole-file write is refused with the existing stale-write error' + (e ? '' : ' (it was NOT refused)'));
    A.eq(e && e.precondition, { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' }, 'same machine-readable precondition as the stale-write guard');
    A.eq(await fsp.readFile(path.join(proj, 'c.js'), 'utf8'), 'B edit\n', "the other run's edit survived");
    await a.readTool.run({ path: 'c.js' }, ca);
    const again = await a.writeTool.run({ path: 'c.js', content: 'merged\n' }, ca);
    A.ok(/^Wrote c\.js \(7 bytes\)\.\n\[mutation receipt: read-back-verified;/.test(again.content), 'one refusal per drift: the re-read re-arms it and the write lands');
  }

  // ---- 3b. fs.write arriving while another run is INSIDE its locked write: the stamp check waits for it ----
  {
    const proj = await project({ 'c.js': 'v1\n' });
    const old = new Date(Date.now() - 60000); await fsp.utimes(path.join(proj, 'c.js'), old, old);
    const slowFsp = new Proxy(fsp, { get(tg, p) {   // run B's disk: its writeFile takes 50 ms to land
      if (p === 'writeFile') return async (...a) => { await sleep(50); return tg.writeFile(...a); };
      return tg[p];
    } });
    const pathTrust = async (abs) => ({ base: proj, abs });
    const a = run(proj), b = makeFsTools({ fsp: slowFsp, pathMod: path, root: ROOT, pathTrust });
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    await a.readTool.run({ path: 'c.js' }, ca);
    await b.readTool.run({ path: 'c.js' }, cb);
    const pb = b.editTool.run({ path: 'c.js', find: 'v1', replace: 'B edit' }, cb);
    await sleep(15);                                  // B holds the lock, its bytes not landed yet
    const ea = await rejection(a.writeTool.run({ path: 'c.js', content: 'A rewrite composed from v1\n' }, ca));
    const rb = await pb;
    A.eq(rb.mutationReceipt.state, 'read-back-verified', "the other run's edit is verified");
    A.ok(ea && /^stale write refused: c\.js changed on disk after you read it/.test(ea.message), 'the whole-file write composed from the older read is refused' + (ea ? '' : ' (it was NOT refused: it overwrote the edit)'));
    A.eq(await fsp.readFile(path.join(proj, 'c.js'), 'utf8'), 'B edit\n', "and the other run's verified edit survived");
  }

  // ---- 3c. an fs.edit / fs.append that landed on another run's bytes does NOT mark them as seen ----
  // The drift path re-applied the change onto the other writer's text and then stamped the merged file as what this
  // agent observed, so its next fs.write, composed from its own stale view, passed the guard and erased that edit.
  for (const tool of ['edit', 'append']) {
    const proj = await project({ 'a.js': 'const A = 1;\nconst B = 2;\n' });
    const old = new Date(Date.now() - 60000);
    await fsp.utimes(path.join(proj, 'a.js'), old, old);   // the stamps below must predate the writes that follow
    const held = heldBaseline();
    const lead = run(proj, held.wait), worker = run(proj);
    const c1 = { agentId: 'lead', projectRoot: proj }, c2 = { agentId: 'worker', projectRoot: proj };
    await lead.readTool.run({ path: 'a.js' }, c1);
    await worker.readTool.run({ path: 'a.js' }, c2);
    const pending = tool === 'edit'
      ? lead.editTool.run({ path: 'a.js', find: 'const A = 1;', replace: 'const A = 100;' }, c1)
      : lead.appendTool.run({ path: 'a.js', content: 'const A2 = 100;\n' }, c1);
    await held.reached;
    await worker.editTool.run({ path: 'a.js', find: 'const B = 2;', replace: 'const B = 200;' }, c2);
    held.release();
    const r = await pending;
    A.ok(/\[mutation receipt: read-back-verified;/.test(r.content), tool + ': the drifted change itself lands verified');
    const merged = await fsp.readFile(path.join(proj, 'a.js'), 'utf8');
    A.ok(/const B = 200;/.test(merged), tool + ": it landed on top of the worker's edit: " + JSON.stringify(merged));
    const e = await rejection(lead.writeTool.run({ path: 'a.js', content: 'const A = 100;\nconst B = 2;\nconst C = 3;\n' }, c1));
    A.ok(e && /^stale write refused: a\.js holds another writer's changes that you have not read: they landed while an earlier fs\.(edit|append) of yours on it was in flight/.test(e.message), tool + ": the lead's next whole-file write from its stale view is refused, naming the in-flight drift" + (e ? ' (got: ' + e.message + ')' : ' (it was NOT refused: ' + JSON.stringify(await fsp.readFile(path.join(proj, 'a.js'), 'utf8')) + ')'));
    A.eq(await fsp.readFile(path.join(proj, 'a.js'), 'utf8'), merged, tool + ": the worker's B = 200 survived");
    await lead.readTool.run({ path: 'a.js' }, c1);
    const again = await lead.writeTool.run({ path: 'a.js', content: merged + 'const C = 3;\n' }, c1);
    A.ok(/^Wrote a\.js /.test(again.content), tool + ': after a re-read the write lands');
  }

  // ---- 3d. an in-flight drift with NO language server: the drifted call says so, and so does the next refusal ----
  // The drift was reported only through the LSP line, so without a language server the drifted receipt read as an
  // ordinary edit; and the next refusal said the file "changed on disk since you last read or wrote it", which was
  // false: this run's own edit/append was the last write. Another writer (a shell command, say) lands right after
  // the call's first read of the file, while the call is in flight.
  for (const tool of ['edit', 'append']) {
    const proj = await project({ 'n.txt': 'one\ntwo\n' });
    const target = path.resolve(proj, 'n.txt').toLowerCase();
    let theirs = null;   // when set: written to disk right after this run's next read of the file returns
    const raceFsp = new Proxy(fsp, { get(tg, p) {
      if (p === 'readFile') return async (...args) => {
        const out = await tg.readFile(...args);
        if (theirs != null && path.resolve(String(args[0])).toLowerCase() === target) { const t = theirs; theirs = null; await tg.writeFile(args[0], t); }
        return out;
      };
      return tg[p];
    } });
    const t = makeFsTools({ fsp: raceFsp, pathMod: path, root: ROOT, pathTrust: async (abs) => ({ base: proj, abs }) });
    const c = { agentId: 'lead', projectRoot: proj };
    await t.readTool.run({ path: 'n.txt' }, c);
    theirs = 'one\ntwo\nTHEIRS\n';
    const r = tool === 'edit'
      ? await t.editTool.run({ path: 'n.txt', find: 'one', replace: 'ONE' }, c)
      : await t.appendTool.run({ path: 'n.txt', content: 'mine\n' }, c);
    const merged = await fsp.readFile(path.join(proj, 'n.txt'), 'utf8');
    A.eq(merged, tool === 'edit' ? 'ONE\ntwo\nTHEIRS\n' : 'one\ntwo\nTHEIRS\nmine\n', tool + ": the drifted change landed on the other writer's bytes");
    const note = tool === 'edit'
      ? '\n[another writer changed n.txt while this fs.edit was in flight: your replacement was applied to their version, which you have not read. fs.read it before you rewrite or edit it.]'
      : '\n[another writer changed n.txt while this fs.append was in flight: your text went on after their changes, which you have not read. fs.read it before you rewrite or edit it.]';
    A.ok(r.content.endsWith(note) && /\[mutation receipt: read-back-verified;/.test(r.content) && !/LSP/.test(r.content), tool + ': with no language server the drifted result itself names the drift: ' + JSON.stringify(r.content));
    const when = "n.txt holds another writer's changes that you have not read: they landed while an earlier fs." + tool + ' of yours on it was in flight, and that fs.' + tool + ' was applied on top of them';
    const again = await rejection(tool === 'edit'
      ? t.editTool.run({ path: 'n.txt', find: 'two', replace: 'TWO' }, c)
      : t.appendTool.run({ path: 'n.txt', content: 'more\n' }, c));
    A.eq(again && again.message, tool + ' refused: ' + when + ' — nothing was written. fs.read it again and redo your change against the current content.', tool + ': the next ' + tool + ' is refused and says what really happened');
    const p = await rejection(t.patchTool.run({ patch: '*** Begin Patch\n*** Update File: n.txt\n@@\n-two\n+TWO\n*** End Patch' }, c));
    A.eq(p && p.message, 'fs.patch refused: ' + when + ' — nothing was written. fs.read it again and redo your change against the current content.', tool + ': so is an fs.patch');
    const w = await rejection(t.writeTool.run({ path: 'n.txt', content: 'composed from the old read\n' }, c));
    A.eq(w && w.message, 'stale write refused: ' + when + '. This write would erase them, so nothing was written. fs.read it again and re-apply your change on top of the current content.', tool + ': and a whole-file fs.write');
    A.eq(await fsp.readFile(path.join(proj, 'n.txt'), 'utf8'), merged, tool + ': nothing was written by any of them');
    await t.readTool.run({ path: 'n.txt' }, c);
    const ok = await t.editTool.run({ path: 'n.txt', find: 'two', replace: 'TWO' }, c);
    A.ok(/^Edited n\.txt \(1 replacement\)\.\n\[mutation receipt: read-back-verified;[^\]]*\]$/.test(ok.content), tool + ': after a re-read the edit lands with the ordinary receipt: ' + JSON.stringify(ok.content));
  }

  // ---- 4. fs.patch whose source moved during the baseline refuses before writing anything ----
  {
    const proj = await project({ 'p.txt': 'alpha\nbeta\n' });
    const held = heldBaseline();
    const a = run(proj, held.wait), b = run(proj);
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    await b.readTool.run({ path: 'p.txt' }, cb);
    const patch = '*** Begin Patch\n*** Update File: p.txt\n@@\n-alpha\n+ALPHA\n beta\n*** End Patch';
    const pending = rejection(a.patchTool.run({ patch }, ca));
    await held.reached;
    await b.editTool.run({ path: 'p.txt', find: 'beta', replace: 'BETA (worker)' }, cb);
    held.release();
    const e = await pending;
    A.ok(e && /^fs\.patch refused: p\.txt changed on disk while this patch was being prepared \(another agent or process wrote it\) — nothing was written\./.test(e.message), 'a patch built from a moved file refuses' + (e ? '' : ' (it was NOT refused)'));
    A.ok(e && / nothing was written\. Re-run the same fs\.patch; its hunks match by context\.$/.test(e.message), 'a run that never read the file is told to re-run the same patch: ' + (e && e.message));
    A.eq(await fsp.readFile(path.join(proj, 'p.txt'), 'utf8'), 'alpha\nBETA (worker)\n', "the file is exactly the other run's version");
  }

  // ---- 4b. the same race when the patching run HAD read the file: its advice must be one that works ----
  // (it said "Re-run the same fs.patch", and that re-run was refused by the read-version check: the run's read
  // stamp still held the pre-drift bytes)
  {
    const proj = await project({ 'q.txt': 'line1\nline2\nline3\nline4\nline5\n' });
    const held = heldBaseline();
    const a = run(proj, held.wait), b = run(proj);
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    await a.readTool.run({ path: 'q.txt' }, ca);
    await b.readTool.run({ path: 'q.txt' }, cb);
    const patch = '*** Begin Patch\n*** Update File: q.txt\n@@\n line1\n-line2\n+LINE2\n line3\n*** End Patch';
    const pending = rejection(a.patchTool.run({ patch }, ca));
    await held.reached;
    await b.editTool.run({ path: 'q.txt', find: 'line5', replace: 'LINE5' }, cb);
    held.release();
    const e = await pending;
    A.eq(e && e.message, 'fs.patch refused: q.txt changed on disk while this patch was being prepared (another agent or process wrote it) — nothing was written. fs.read q.txt again, then re-run the fs.patch; its hunks match by context.',
      'a run that read the file is told to fs.read it before the re-run');
    const blind = await rejection(a.patchTool.run({ patch }, ca));
    A.ok(blind && /^fs\.patch refused: q\.txt changed on disk since you last read or wrote it/.test(blind.message), 'why: a blind re-run IS refused by the read-version check' + (blind ? '' : ' (it applied)'));
    await a.readTool.run({ path: 'q.txt' }, ca);
    const landed = await a.patchTool.run({ patch }, ca);
    A.ok(/^Applied patch: 1 file changed\./.test(landed.content), 'the advised re-run applies: ' + JSON.stringify(landed.content.split('\n')[0]));
    A.eq(await fsp.readFile(path.join(proj, 'q.txt'), 'utf8'), 'line1\nLINE2\nline3\nline4\nLINE5\n', 'following the advice (fs.read, then the same fs.patch) lands the patch on top of the other run\'s edit');
  }
  // two files moved in flight, only one of them read by the patching run: both named, the read one is the one to re-read
  {
    const proj = await project({ 'm1.txt': 'a1\nb1\nc1\n', 'm2.txt': 'a2\nb2\nc2\n' });
    const held = heldBaseline();
    const a = run(proj, held.wait), b = run(proj);
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    await a.readTool.run({ path: 'm1.txt' }, ca);
    const patch = '*** Begin Patch\n*** Update File: m1.txt\n@@\n-a1\n+A1\n b1\n*** Update File: m2.txt\n@@\n-a2\n+A2\n b2\n*** End Patch';
    const pending = rejection(a.patchTool.run({ patch }, ca));
    await held.reached;
    await b.appendTool.run({ path: 'm1.txt', content: 'd1\n' }, cb);
    await b.appendTool.run({ path: 'm2.txt', content: 'd2\n' }, cb);
    held.release();
    const e = await pending;
    A.eq(e && e.message, 'fs.patch refused: m1.txt, m2.txt changed on disk while this patch was being prepared (another agent or process wrote them) — nothing was written. fs.read m1.txt again, then re-run the fs.patch; its hunks match by context.',
      'every moved file is named, and the advice re-reads the one this run has a read stamp for');
    await a.readTool.run({ path: 'm1.txt' }, ca);
    const landed = await a.patchTool.run({ patch }, ca);
    A.ok(/^Applied patch: 2 files changed\./.test(landed.content), 'the advised re-run applies: ' + JSON.stringify(landed.content.split('\n')[0]));
    A.eq([await fsp.readFile(path.join(proj, 'm1.txt'), 'utf8'), await fsp.readFile(path.join(proj, 'm2.txt'), 'utf8')], ['A1\nb1\nc1\nd1\n', 'A2\nb2\nc2\nd2\n'], 'on top of both of the other run\'s appends');
  }

  // ---- 5. an edit whose "find" the other run removed refuses honestly instead of resurrecting the old text ----
  {
    const proj = await project({ 'r.js': 'let x = 1;\n' });
    const held = heldBaseline();
    const a = run(proj, held.wait), b = run(proj);
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'worker', projectRoot: proj };
    await a.readTool.run({ path: 'r.js' }, ca);
    await b.readTool.run({ path: 'r.js' }, cb);
    const pending = rejection(a.editTool.run({ path: 'r.js', find: 'let x = 1;', replace: 'let x = 2;' }, ca));
    await held.reached;
    await b.writeTool.run({ path: 'r.js', content: 'const y = 3;\n' }, cb);
    held.release();
    const e = await pending;
    A.ok(e && /^"find" text not found in r\.js/.test(e.message), 'the drifted edit re-plans on the current bytes and refuses with the ordinary not-found error');
    A.eq(await fsp.readFile(path.join(proj, 'r.js'), 'utf8'), 'const y = 3;\n', "the other run's write survived");
  }

  // ---- 6. abort while queued behind another writer: AbortError, file untouched, the lock is not left stuck ----
  {
    const proj = await project({ 'q.js': 'one\n' });
    const t = run(proj);
    const ctx0 = { agentId: 'ag', projectRoot: proj };
    await t.readTool.run({ path: 'q.js' }, ctx0);
    const { withFileLocks, lockKey } = t._internals;
    let releaseHold;
    const hold = withFileLocks([lockKey(path.join(proj, 'q.js'))], null, () => new Promise((r) => { releaseHold = r; }));
    const ac = new AbortController();
    const pending = rejection(t.editTool.run({ path: 'q.js', find: 'one', replace: 'two' }, Object.assign({ signal: ac.signal }, ctx0)));
    await sleep(30);
    ac.abort();
    const e = await pending;
    A.ok(e && e.name === 'AbortError', 'an edit cancelled while it waits for the file rejects with AbortError' + (e ? ' (got ' + e.name + ': ' + e.message + ')' : ' (it resolved)'));
    releaseHold();
    await hold;
    await sleep(10);
    A.eq(await fsp.readFile(path.join(proj, 'q.js'), 'utf8'), 'one\n', 'the cancelled edit never wrote, not even after the holder let go');
    const ok = await t.editTool.run({ path: 'q.js', find: 'one', replace: 'three' }, ctx0);
    A.ok(/^Edited q\.js \(1 replacement\)/.test(ok.content), 'the next writer gets the file: an aborted waiter leaves no stuck lock');
  }

  // ---- 6b. a waiter aborted while queued must NOT open the lock: a third writer still waits for the holder ----
  {
    // the primitive: H holds, W queues and aborts, N arrives while H is still inside
    const t0 = run(await project({}));
    const { withFileLocks } = t0._internals;
    let inside = 0, maxInside = 0, releaseH;
    const enter = async (wait) => { inside++; maxInside = Math.max(maxInside, inside); await wait(); inside--; };
    const h = withFileLocks(['k6b'], null, () => enter(() => new Promise((r) => { releaseH = r; })));
    await sleep(5);
    const ac = new AbortController();
    const w = rejection(withFileLocks(['k6b'], ac.signal, () => enter(() => sleep(1))));
    await sleep(5); ac.abort();
    const we = await w;
    const nn = withFileLocks(['k6b'], null, () => enter(() => sleep(1)));
    await sleep(20);
    const overlapped = maxInside;
    releaseH(); await h; await nn;
    A.ok(we && we.name === 'AbortError', 'the queued waiter rejects with AbortError');
    A.eq(overlapped, 1, 'a newcomer after an aborted waiter waits for the live holder (it once ran beside it: 2 inside at once)');

    // end to end: run A's slow writeFile holds the lock, run W's append is cancelled while queued, run N appends
    const proj = await project({ 'log.txt': 'start\n' });
    let slowNext = false;
    const slowFsp = new Proxy(fsp, { get(tg, p) {
      if (p === 'writeFile') return async (...a) => { if (slowNext) { slowNext = false; await sleep(150); } return tg.writeFile(...a); };
      return tg[p];
    } });
    const pathTrust = async (abs) => ({ base: proj, abs });
    const A_ = makeFsTools({ fsp: slowFsp, pathMod: path, root: ROOT, pathTrust }), W_ = run(proj), N_ = run(proj);
    const ctx = { agentId: 'ag', projectRoot: proj };
    slowNext = true;
    const pa = A_.appendTool.run({ path: 'log.txt', content: 'A\n' }, ctx);
    await sleep(30);                                      // A is inside its locked, slow writeFile
    const ac2 = new AbortController();
    const pw = rejection(W_.appendTool.run({ path: 'log.txt', content: 'W\n' }, Object.assign({ signal: ac2.signal }, ctx)));
    await sleep(10); ac2.abort();
    const ew = await pw;
    const pn = N_.appendTool.run({ path: 'log.txt', content: 'N\n' }, ctx);
    const [ra, rn] = await Promise.all([pa, pn]);
    A.ok(ew && ew.name === 'AbortError', 'the cancelled append rejects with AbortError');
    A.eq([ra.mutationReceipt.state, rn.mutationReceipt.state], ['read-back-verified', 'read-back-verified'], 'both landed appends are verified');
    A.eq(await fsp.readFile(path.join(proj, 'log.txt'), 'utf8'), 'start\nA\nN\n', "the third writer's line survives (it was lost: \"start\\nA\\n\")");
  }

  // ---- 7. a multi-file patch racing one-file edits on both of its files: no deadlock, nothing lost ----
  {
    const proj = await project({ 'm1.txt': 'm1\nkeep1\n', 'm2.txt': 'm2\nkeep2\n' });
    const a = run(proj, 1), b = run(proj, 40), c = run(proj, 40);   // the patch locks both files while the edits wait on their baselines
    const ca = { agentId: 'lead', projectRoot: proj }, cb = { agentId: 'w1', projectRoot: proj }, cc = { agentId: 'w2', projectRoot: proj };
    await b.readTool.run({ path: 'm1.txt' }, cb);
    await c.readTool.run({ path: 'm2.txt' }, cc);
    const patch = '*** Begin Patch\n*** Update File: m2.txt\n@@\n-keep2\n+KEEP2\n*** Update File: m1.txt\n@@\n-keep1\n+KEEP1\n*** End Patch';
    const settled = await Promise.race([
      Promise.allSettled([a.patchTool.run({ patch }, ca),
        b.editTool.run({ path: 'm1.txt', find: 'm1\n', replace: 'M1\n' }, cb),
        c.editTool.run({ path: 'm2.txt', find: 'm2\n', replace: 'M2\n' }, cc)]),
      sleep(5000).then(() => 'deadlock')]);
    A.ok(Array.isArray(settled) && settled.every((r) => r.status === 'fulfilled'), 'a two-file patch + an edit on each file all complete (no deadlock): ' + JSON.stringify(Array.isArray(settled) ? settled.map((r) => r.status === 'fulfilled' ? 'ok' : r.reason.message) : settled));
    A.eq([await fsp.readFile(path.join(proj, 'm1.txt'), 'utf8'), await fsp.readFile(path.join(proj, 'm2.txt'), 'utf8')], ['M1\nKEEP1\n', 'M2\nKEEP2\n'], 'every mutation landed on both files');
  }

  // ---- 8. NO DRIFT, NO CHANGE: the ordinary single-writer receipt is byte-identical to trunk ----
  {
    const proj = await project({ 'x.js': 'hello world\n' });
    const t = run(proj), lsp = run(proj, 1);
    const ctx = { agentId: 'ag', projectRoot: proj };
    await t.readTool.run({ path: 'x.js' }, ctx);
    const r = await t.editTool.run({ path: 'x.js', find: 'world', replace: 'there' }, ctx);
    const sha = crypto.createHash('sha256').update('hello there\n').digest('hex');
    A.eq(r.content, 'Edited x.js (1 replacement).\n[mutation receipt: read-back-verified; attempted 12 bytes; written 12; verified 12; sha256 ' + sha + ']', 'single fs.edit content is exactly the historic receipt');
    await lsp.readTool.run({ path: 'x.js' }, ctx);
    const r2 = await lsp.editTool.run({ path: 'x.js', find: 'there', replace: 'world' }, ctx);
    A.ok(/\n\n\[LSP: no new diagnostics\]$/.test(r2.content), 'an undisturbed edit keeps its real LSP comparison');
    await t.readTool.run({ path: 'x.js' }, ctx);   // the other instance's edit moved the file past t's stamp
    const w = await t.writeTool.run({ path: 'x.js', content: 'abc' }, ctx);
    A.ok(/^Wrote x\.js \(3 bytes\)\.\n\[mutation receipt: read-back-verified; attempted 3 bytes; written 3; verified 3;/.test(w.content), 'single fs.write receipt unchanged');
    const ap = await t.appendTool.run({ path: 'x.js', content: 'd' }, ctx);
    A.ok(/^Appended to x\.js \(\+1 bytes, now 4\)\.\n\[mutation receipt: read-back-verified;/.test(ap.content), 'single fs.append receipt unchanged');
  }

  await fsp.rm(ROOT, { recursive: true, force: true });
  A.report('fs.concurrent-mutations.test');
})().catch(async (e) => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  console.log('FAIL: fs.concurrent-mutations.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
