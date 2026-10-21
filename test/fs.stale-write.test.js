/* node test/fs.stale-write.test.js — THE STALE-WRITE GUARD.

   A delegated worker, a second agent, or the Commander's own editor can change a file between the moment this
   agent read it and the moment it writes back. Nothing noticed, so the write silently reverted the other
   change — the classic lost update, and the harder kind to spot because both sides believe they succeeded.

   The read STAMP was once scoped to fs.write alone, on the theory that fs.edit / fs.append / fs.patch apply to
   what is on disk when they write. They then landed on bytes the agent never saw and re-stamped the file as
   observed, so the agent's next fs.write erased the other change: since 2026-10-21 they refuse too (block 6;
   test/fs.read-version.test.js covers the check, test/fs.concurrent-mutations.test.js the in-flight re-read).
   Uses a real temp dir with explicitly stamped mtimes so the drift is genuine, not simulated. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-stale-' + process.pid);
const { writeTool, readTool, editTool, appendTool } = makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { writeBytes: 1 << 20, readReturn: 100000 } });
const CTX = { agentId: 'ag', emit: () => {} };
const absOf = (rel) => path.join(ROOT, 'ag', rel);

// Simulate an EXTERNAL writer (another agent / the Commander's editor): change the bytes AND push mtime
// forward explicitly, so the test never races the filesystem's timestamp granularity.
async function externalChange(rel, text) {
  const abs = absOf(rel);
  await fsp.writeFile(abs, text, 'utf8');
  const future = new Date(Date.now() + 60000);
  await fsp.utimes(abs, future, future);
}
async function rejects(p, re, msg) {
  try { await p; A.ok(false, msg + ' — did NOT reject'); }
  catch (e) { A.ok(re.test(String(e && e.message)), msg + (re.test(String(e && e.message)) ? '' : ' (wrong error: ' + (e && e.message) + ')')); }
}

(async () => {
  await fsp.mkdir(path.join(ROOT, 'ag'), { recursive: true });

  // ---- 1. THE LOST UPDATE: read, someone else edits, blind overwrite is refused ----
  {
    await writeTool.run({ path: 'a.js', content: 'v1' }, CTX);
    await readTool.run({ path: 'a.js' }, CTX);
    await externalChange('a.js', 'THEIR WORK');
    let staleError = null;
    try { await writeTool.run({ path: 'a.js', content: 'v2-from-stale-read' }, CTX); } catch (e) { staleError = e; }
    A.ok(staleError && /stale write refused/.test(staleError.message), 'an overwrite based on a stale read is refused');
    A.eq(staleError && staleError.precondition, { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' }, 'stale-write refusal declares the exact read-before-retry precondition');
    A.eq(await fsp.readFile(absOf('a.js'), 'utf8'), 'THEIR WORK', "the other writer's content survived");
  }

  // ---- 2. THE WAY OUT IS ALWAYS OPEN: re-read, then the write lands. Never a loop with no exit. ----
  {
    await readTool.run({ path: 'a.js' }, CTX);
    const r = await writeTool.run({ path: 'a.js', content: 'merged' }, CTX);
    A.ok(/Wrote a\.js/.test(r.content), 'a re-read re-arms the stamp and the write succeeds');
    A.eq(await fsp.readFile(absOf('a.js'), 'utf8'), 'merged', 'the merged content landed');
  }

  // ---- 3. NO DRIFT, NO REFUSAL — the ordinary read-then-write path is untouched ----
  {
    await writeTool.run({ path: 'b.js', content: 'x' }, CTX);
    await readTool.run({ path: 'b.js' }, CTX);
    const r = await writeTool.run({ path: 'b.js', content: 'y' }, CTX);
    A.ok(/Wrote b\.js/.test(r.content), 'read then write with nothing else touching the file is allowed');
  }

  // ---- 4. WRITING A FILE YOU NEVER READ IS "CREATE", NOT "CLOBBER" ----
  {
    await externalChange('c.js', 'pre-existing');   // exists, but this agent has never read it
    const r = await writeTool.run({ path: 'c.js', content: 'fresh' }, CTX);
    A.ok(/Wrote c\.js/.test(r.content), 'an unread file has no stamp and is never refused');
  }

  // ---- 5. OUR OWN WRITE RE-BASELINES: consecutive writes never self-trip ----
  {
    await writeTool.run({ path: 'd.js', content: '1' }, CTX);
    await writeTool.run({ path: 'd.js', content: '2' }, CTX);
    const r = await writeTool.run({ path: 'd.js', content: '3' }, CTX);
    A.ok(/Wrote d\.js/.test(r.content), 'three writes in a row all succeed (the guard is not a rate limit)');
  }

  // ---- 6. the merging writers refuse too (2026-10-21 read-version check): they used to land on bytes the agent never
  // saw and re-stamp the file as observed, so the agent's next fs.write erased the other change. Full coverage lives in
  // test/fs.read-version.test.js; this pins that the old "never refused" promise is gone and the way out still works.
  {
    await writeTool.run({ path: 'e.js', content: 'alpha beta' }, CTX);
    await readTool.run({ path: 'e.js' }, CTX);
    await externalChange('e.js', 'alpha GAMMA');
    await rejects(editTool.run({ path: 'e.js', find: 'alpha', replace: 'omega' }, CTX), /^edit refused: e\.js changed on disk since you last read or wrote it/, 'fs.edit over a file that changed since the read is refused');
    A.eq(await fsp.readFile(absOf('e.js'), 'utf8'), 'alpha GAMMA', "the external writer's change is untouched");
    await readTool.run({ path: 'e.js' }, CTX);
    const r = await editTool.run({ path: 'e.js', find: 'alpha', replace: 'omega' }, CTX);
    A.ok(/Edited e\.js/.test(r.content), 'after a re-read the edit lands');
    A.eq(await fsp.readFile(absOf('e.js'), 'utf8'), 'omega GAMMA', 'on the current text');

    await readTool.run({ path: 'e.js' }, CTX);
    await externalChange('e.js', 'THEIRS');
    await rejects(appendTool.run({ path: 'e.js', content: '+mine' }, CTX), /^append refused: e\.js changed on disk since you last read or wrote it/, 'fs.append likewise');
    await readTool.run({ path: 'e.js' }, CTX);
    const ap = await appendTool.run({ path: 'e.js', content: '+mine' }, CTX);
    A.ok(/Appended to e\.js/.test(ap.content), 'after a re-read the append lands');
    A.eq(await fsp.readFile(absOf('e.js'), 'utf8'), 'THEIRS+mine', 'the append preserved the other content');
  }

  // ---- 7. PER AGENT: one agent's read must not arm a refusal for another ----
  {
    await writeTool.run({ path: 'f.js', content: '1' }, CTX);
    await readTool.run({ path: 'f.js' }, CTX);
    await externalChange('f.js', 'drifted');
    const other = { agentId: 'other', emit: () => {} };
    await fsp.mkdir(path.join(ROOT, 'other'), { recursive: true });
    const r = await writeTool.run({ path: 'f.js', content: 'ok' }, other);
    A.ok(/Wrote f\.js/.test(r.content), "another agent's own workspace is unaffected by this agent's stamps");
  }

  // ---- our OWN edit/append re-arm the baseline: read -> edit -> write never fabricates a race ----
  // stampSeen used to be called only by fs.read and fs.write, so the agent's own fs.edit/fs.append moved
  // the mtime past its stamp and the NEXT fs.write refused with "someone else edited it" — one spurious
  // refusal plus one fabricated concurrency story per edit-then-write sequence.
  {
    await writeTool.run({ path: 'g.js', content: 'base' }, CTX);
    await readTool.run({ path: 'g.js' }, CTX);
    await new Promise(r => setTimeout(r, 20));   // guarantee the edit lands on a later mtime tick
    await editTool.run({ path: 'g.js', find: 'base', replace: 'edited' }, CTX);
    const r = await writeTool.run({ path: 'g.js', content: 'final rewrite' }, CTX);
    A.ok(/Wrote g\.js/.test(r.content), 'read -> fs.edit -> fs.write is our own sequence — no stale-write refusal');
    await readTool.run({ path: 'g.js' }, CTX);
    await new Promise(r => setTimeout(r, 20));
    await appendTool.run({ path: 'g.js', content: '+tail' }, CTX);
    const r2 = await writeTool.run({ path: 'g.js', content: 'after append' }, CTX);
    A.ok(/Wrote g\.js/.test(r2.content), 'read -> fs.append -> fs.write likewise');
  }

  await fsp.rm(ROOT, { recursive: true, force: true });
  A.report('fs.stale-write.test');
})().catch(async (e) => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log('FAIL: fs.stale-write.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
