/* node test/fs.read-version.test.js — THE READ-VERSION CHECK: a file that changed after this run read it is never
   mutated from the stale view (2026-10-21).

   The per-file lock + re-read (fs.concurrent-mutations.test.js) only covered a writer that landed WHILE an
   fs.edit / fs.append / fs.patch was in flight. One that landed BETWEEN this agent's fs.read and its next call
   went unnoticed: the call worked on bytes the agent had never seen, said read-back-verified, and re-stamped the
   file as observed, so the agent's next whole-file fs.write (composed from its old read) erased the other change.
   Now each run remembers the sha256 of the bytes it last read or wrote per path, and every mutation of a file it
   has seen refuses (nothing written) when the disk no longer holds those bytes. A file the run never read keeps
   the historic behaviour exactly.

   Real temp dirs, real fs, the real tools (and one call through the real registry, as the model receives it). */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-read-version-' + process.pid);
const CTX = { agentId: 'ag', emit: () => {} };
const absOf = (rel) => path.join(ROOT, 'ag', rel);
const PRECONDITION = { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' };
const patchOf = (body) => '*** Begin Patch\n' + body + '\n*** End Patch';

// another writer (a second run, the Commander's editor, a shell command) changes the file on disk
async function externalChange(rel, text) { await fsp.writeFile(absOf(rel), text, 'utf8'); }
// ...and one whose bytes carry an OLDER mtime (rsync -t, cp -p, an archive extract): an mtime clock cannot see it
async function externalChangeOldMtime(rel, text) {
  await fsp.writeFile(absOf(rel), text, 'utf8');
  const old = new Date(Date.now() - 3600 * 1000);
  await fsp.utimes(absOf(rel), old, old);
}
async function rejection(p) { try { await p; return null; } catch (e) { return e; } }
const disk = (rel) => fsp.readFile(absOf(rel), 'utf8');

(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(path.join(ROOT, 'ag'), { recursive: true });
  const { readTool, writeTool, editTool, appendTool, patchTool } = makeFsTools({ fsp, pathMod: path, root: ROOT });

  // ---- 1. fs.edit after the file changed since the read: refused, nothing written, the way out is fs.read ----
  {
    await externalChange('e.js', 'alpha beta\n');
    await readTool.run({ path: 'e.js' }, CTX);
    await externalChange('e.js', 'alpha GAMMA\n');
    const e = await rejection(editTool.run({ path: 'e.js', find: 'alpha', replace: 'omega' }, CTX));
    A.ok(e && /^edit refused: e\.js changed on disk since you last read or wrote it/.test(e.message), 'the stale edit is refused' + (e ? ' (got: ' + e.message + ')' : ' (it LANDED on bytes the agent never saw)'));
    A.ok(e && /nothing was written/.test(e.message) && /fs\.read it again/.test(e.message), 'the refusal says nothing was written and to fs.read again');
    A.eq(e && e.precondition, PRECONDITION, 'it carries the fresh-read precondition the stale-write guard uses');
    A.eq(await disk('e.js'), 'alpha GAMMA\n', "the other writer's bytes are untouched");
    const again = await rejection(editTool.run({ path: 'e.js', find: 'alpha', replace: 'omega' }, CTX));
    A.ok(again && /^edit refused: e\.js changed on disk since you last read or wrote it/.test(again.message), 'a blind retry is refused the same way (never the false "you have not read" story)' + (again ? '' : ' (it landed)'));
    // the reviewer's lost update: the agent's next whole-file write from its old view must not erase GAMMA either
    const w = await rejection(writeTool.run({ path: 'e.js', content: 'omega beta\n' }, CTX));
    A.ok(w && /^stale write refused: e\.js changed on disk after you read it/.test(w.message), 'the follow-up whole-file write from the stale view is refused' + (w ? '' : ' (it overwrote: ' + JSON.stringify(await disk('e.js')) + ')'));
    A.eq(await disk('e.js'), 'alpha GAMMA\n', "and the other writer's change survived both");
    await readTool.run({ path: 'e.js' }, CTX);
    const ok = await editTool.run({ path: 'e.js', find: 'alpha', replace: 'omega' }, CTX);
    A.ok(/^Edited e\.js \(1 replacement\)\.\n\[mutation receipt: read-back-verified;/.test(ok.content), 'after a re-read the edit lands with the historic receipt');
    A.eq(await disk('e.js'), 'omega GAMMA\n', 'on top of the current content');
  }

  // ---- 2. fs.append after the file changed since the read ----
  {
    await externalChange('log.md', '# log\n');
    await readTool.run({ path: 'log.md' }, CTX);
    await externalChange('log.md', '# log\ntheir line\n');
    const e = await rejection(appendTool.run({ path: 'log.md', content: 'my line\n' }, CTX));
    A.ok(e && /^append refused: log\.md changed on disk since you last read or wrote it/.test(e.message), 'the stale append is refused' + (e ? ' (got: ' + e.message + ')' : ' (it landed)'));
    A.eq(e && e.precondition, PRECONDITION, 'append refusal: same precondition');
    A.eq(await disk('log.md'), '# log\ntheir line\n', 'nothing was appended');
    await readTool.run({ path: 'log.md' }, CTX);
    const ok = await appendTool.run({ path: 'log.md', content: 'my line\n' }, CTX);
    A.ok(/^Appended to log\.md \(\+8 bytes, now 25\)\.\n\[mutation receipt: read-back-verified;/.test(ok.content), 'after a re-read the append lands');
    // the run's own append keeps it a run that READ the file: a change after that append is still refused
    await externalChange('log.md', '# log\ntheir line\nmy line\ntheir second line\n');
    const e2 = await rejection(appendTool.run({ path: 'log.md', content: 'my second line\n' }, CTX));
    A.ok(e2 && /^append refused: log\.md changed on disk since you last read or wrote it/.test(e2.message), 'a run that read the file and then appended still refuses an append over a later change' + (e2 ? '' : ' (it landed)'));
    A.eq(await disk('log.md'), '# log\ntheir line\nmy line\ntheir second line\n', 'nothing was appended');
  }

  // ---- 3. fs.patch after a file it touches changed since the read ----
  {
    await externalChange('p.txt', 'alpha\nbeta\n');
    await readTool.run({ path: 'p.txt' }, CTX);
    await externalChange('p.txt', 'alpha\nBETA (theirs)\n');
    const patch = patchOf('*** Update File: p.txt\n@@\n-alpha\n+ALPHA');
    const e = await rejection(patchTool.run({ patch }, CTX));
    A.ok(e && /^fs\.patch refused: p\.txt changed on disk since you last read or wrote it/.test(e.message), 'the stale patch is refused' + (e ? ' (got: ' + e.message + ')' : ' (it landed)'));
    A.eq(e && e.precondition, PRECONDITION, 'patch refusal: same precondition');
    A.eq(await disk('p.txt'), 'alpha\nBETA (theirs)\n', 'nothing was patched');
    await readTool.run({ path: 'p.txt' }, CTX);
    const ok = await patchTool.run({ patch }, CTX);
    A.ok(/^Applied patch: 1 file changed\.\n\[mutation receipt: read-back-verified;/.test(ok.content), 'after a re-read the patch lands');
    A.eq(await disk('p.txt'), 'ALPHA\nBETA (theirs)\n', 'on top of the current content');
  }

  // ---- 4. the check is by CONTENT: a change that carries an older mtime is still caught (the mtime clock missed it) ----
  {
    await externalChange('w.txt', 'v1\n');
    await readTool.run({ path: 'w.txt' }, CTX);
    await externalChangeOldMtime('w.txt', 'THEIR WORK\n');
    const e = await rejection(writeTool.run({ path: 'w.txt', content: 'v2 composed from v1\n' }, CTX));
    A.ok(e && /^stale write refused: w\.txt changed on disk after you read it/.test(e.message), 'fs.write over a read file whose bytes changed under an older mtime is refused' + (e ? '' : ' (it overwrote THEIR WORK)'));
    A.eq(await disk('w.txt'), 'THEIR WORK\n', 'their bytes survived');
    await externalChange('w2.txt', 'one\n');
    await readTool.run({ path: 'w2.txt' }, CTX);
    await externalChangeOldMtime('w2.txt', 'one two\n');
    const e2 = await rejection(editTool.run({ path: 'w2.txt', find: 'one', replace: '1' }, CTX));
    A.ok(e2 && /^edit refused: w2\.txt changed on disk/.test(e2.message), 'fs.edit likewise' + (e2 ? '' : ' (it landed)'));
    // a touch that changes no byte is not a change: nothing to lose, no refusal
    await readTool.run({ path: 'w2.txt' }, CTX);
    const later = new Date(Date.now() + 60000); await fsp.utimes(absOf('w2.txt'), later, later);
    const t = await editTool.run({ path: 'w2.txt', find: 'one', replace: '1' }, CTX);
    A.ok(/^Edited w2\.txt/.test(t.content), 'an mtime-only touch never refuses (the bytes the agent saw are still there)');
  }

  // ---- 5. a file this run never read keeps today's behaviour exactly ----
  {
    await externalChange('u1.txt', 'pre-existing\n');
    const ap = await appendTool.run({ path: 'u1.txt', content: '+mine\n' }, CTX);
    A.ok(/^Appended to u1\.txt/.test(ap.content), 'fs.append to an unread file appends');
    await externalChange('u2.txt', 'keep\nold\n');
    const pa = await patchTool.run({ patch: patchOf('*** Update File: u2.txt\n@@\n keep\n-old\n+new') }, CTX);
    A.ok(/^Applied patch: 1 file changed/.test(pa.content), 'fs.patch on an unread file applies');
    await externalChange('u3.txt', 'pre-existing\n');
    const wr = await writeTool.run({ path: 'u3.txt', content: 'fresh\n' }, CTX);
    A.ok(/^Wrote u3\.txt/.test(wr.content), 'fs.write over an unread file writes ("create it", not "clobber it")');
    await externalChange('u4.txt', 'alpha\n');
    const ed = await rejection(editTool.run({ path: 'u4.txt', find: 'alpha', replace: 'omega' }, CTX));
    A.eq(ed && ed.precondition, { code: 'read_before_edit', requiredTool: 'fs.read', requiredState: 'current_file_observed' }, 'fs.edit on an unread file keeps its read-before-edit refusal');
    A.eq(await disk('u1.txt') + await disk('u2.txt') + await disk('u3.txt'), 'pre-existing\n+mine\nkeep\nnew\nfresh\n', 'every unread-file mutation landed');
  }

  // ---- 6. the agent's OWN mutations are its new baseline: a whole sequence never self-trips ----
  {
    await externalChange('s.js', 'let a = 1;\n');
    await readTool.run({ path: 's.js' }, CTX);
    const steps = [];
    steps.push((await editTool.run({ path: 's.js', find: 'a = 1', replace: 'a = 2' }, CTX)).content);
    steps.push((await editTool.run({ path: 's.js', find: 'a = 2', replace: 'a = 3' }, CTX)).content);
    steps.push((await appendTool.run({ path: 's.js', content: 'let b = 1;\n' }, CTX)).content);
    steps.push((await patchTool.run({ patch: patchOf('*** Update File: s.js\n@@\n-let b = 1;\n+let b = 2;') }, CTX)).content);
    steps.push((await writeTool.run({ path: 's.js', content: 'let c = 1;\n' }, CTX)).content);
    steps.push((await appendTool.run({ path: 's.js', content: 'let d = 1;\n' }, CTX)).content);
    A.ok(steps.every((c) => /\[mutation receipt: read-back-verified;/.test(c)), 'read -> edit -> edit -> append -> patch -> write -> append all land: ' + JSON.stringify(steps.map((c) => c.split('\n')[0])));
    A.eq(await disk('s.js'), 'let c = 1;\nlet d = 1;\n', 'and the file is exactly the sequence');
  }

  // ---- 7. what the MODEL receives: through the real registry, an error result with the precondition frame ----
  {
    const reg = makeRegistry();
    reg.register(readTool); reg.register(editTool);
    await externalChange('r.js', 'x = 1\n');
    await reg.dispatch({ id: 'r1', name: 'fs.read', args: { path: 'r.js' } }, CTX);
    await externalChange('r.js', 'x = 1\ny = 2\n');
    const res = await reg.dispatch({ id: 'r2', name: 'fs.edit', args: { path: 'r.js', find: 'x = 1', replace: 'x = 9' } }, CTX);
    A.ok(res && res.isError === true, 'the stale edit is an error result' + (res && !res.isError ? ' (it reported success: ' + JSON.stringify(String(res.content).slice(0, 120)) + ')' : ''));
    A.ok(res && /edit refused: r\.js changed on disk since you last read or wrote it/.test(String(res.content)) && /<tool_precondition>\{"code":"fresh_read_required"/.test(String(res.content)), 'its text names the change and the fs.read precondition');
    A.ok(res && !/read-back-verified/.test(String(res.content)), 'and it never claims a verified write');
    A.eq(await disk('r.js'), 'x = 1\ny = 2\n', 'the file is the other writer\'s version');
  }

  await fsp.rm(ROOT, { recursive: true, force: true });
  A.report('fs.read-version.test');
})().catch(async (e) => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  console.log('FAIL: fs.read-version.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
