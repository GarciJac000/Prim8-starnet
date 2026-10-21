/* node test/checkpoint-measure-nostat.test.js — a checkpoint snapshot sizes itself from GIT, not one statSync per file.

   The bug (perf review 10-19, #9): after every created snapshot, measure() listed the tracked files with
   `git ls-files` and then ran fs.statSync on each one, one at a time, on the sidecar's only thread. A stat is
   ~130 µs on Windows, so a mid-size project root froze every stream for 0.9-2 s per snapshot — for a byte count
   that is only cosmetic (the checkpoint.created event). repoBytes() was already moved off the sync path (#107).

   Proves through the REAL snapshot() path (real temp workspace + real git + a counting fs):
     (1) a created snapshot makes ZERO statSync calls on files inside the work tree;
     (2) files/bytes stay truthful: the tracked-file count and the summed content bytes, exactly;
     (3) a project-root (external work tree) snapshot sizes itself the same way;
     (4) the size-ceiling re-init path (the other measure() caller) records the same truthful numbers. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');

function runGit(args, opts) {
  try {
    const stdout = execFileSync('git', args, { cwd: (opts && opts.cwd) || process.cwd(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return Promise.resolve({ code: 0, stdout: String(stdout || ''), stderr: '' });
  } catch (e) {
    return Promise.resolve({ code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && e.stderr) || '') });
  }
}

// an fs that counts statSync calls landing strictly INSIDE one of the watched trees
function countingFs(watch) {
  const hits = { n: 0 };
  const inside = (p) => {
    const abs = path.resolve(String(p));
    return watch.some(function (dir) { return abs.toLowerCase().indexOf(path.resolve(dir).toLowerCase() + path.sep) === 0; });
  };
  const wrapped = Object.create(fs);
  wrapped.statSync = function (p, o) { if (inside(p)) hits.n++; return fs.statSync(p, o); };
  wrapped.lstatSync = function (p, o) { if (inside(p)) hits.n++; return fs.lstatSync(p, o); };
  return { fs: wrapped, hits: hits };
}

function fill(dir, count, prefix) {
  let bytes = 0;
  fs.mkdirSync(path.join(dir, 'nested', 'deep'), { recursive: true });
  for (let i = 0; i < count; i++) {
    const rel = i % 3 === 0 ? path.join('nested', 'deep', prefix + i + '.txt') : (i % 3 === 1 ? path.join('nested', prefix + i + '.md') : prefix + i + '.js');
    const body = 'x'.repeat(17 * (i + 1)) + '\n';
    fs.writeFileSync(path.join(dir, rel), body);
    bytes += Buffer.byteLength(body);
  }
  return bytes;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-measure-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-measure-proj-'));
  const aid = 'm1';
  const wt = path.join(root, aid);
  fs.mkdirSync(wt, { recursive: true });
  try {
    const c = countingFs([wt, project]);
    const store = makeCheckpointStore({
      fs: c.fs, pathMod: path, root, runGit, clock: makeClock(1700000000000), keep: 5,
      scopeIdOf: (w) => require('crypto').createHash('sha256').update(String(w)).digest('hex').slice(0, 24),
      allowWorkTree: () => true
    });

    // ---- (1)+(2) agent workspace ----
    const wantBytes = fill(wt, 60, 'f');
    const s1 = await store.snapshot(aid, { runId: 'r1', turn: 0, label: 'fs.write' });
    A.ok(s1 && s1.created, 'snapshot created');
    A.eq(c.hits.n, 0, 'snapshot made no statSync calls on work-tree files (was one per tracked file)');
    A.eq(s1.files, 60, 'files = the tracked-file count');
    A.eq(s1.bytes, wantBytes, 'bytes = the summed content bytes of the tracked files');

    // a changed tree: the next created snapshot measures the NEW tree
    fs.writeFileSync(path.join(wt, 'added.txt'), 'twelve bytes');
    fs.unlinkSync(path.join(wt, 'f2.js'));
    const s2 = await store.snapshot(aid, { runId: 'r1', turn: 1, label: 'fs.edit' });
    A.ok(s2 && s2.created, 'second snapshot created');
    A.eq(s2.files, 60, 'files track the add + the delete');
    A.eq(s2.bytes, wantBytes - (17 * 3 + 1) + 12, 'bytes track the add + the delete');
    A.eq(c.hits.n, 0, 'still no per-file statSync');
    const row = store.list(aid).snapshots.find(function (s) { return s.id === s2.id; });
    A.ok(row && row.files === 60 && row.bytes === s2.bytes, 'the index row carries the same truthful size');

    // ---- (3) an external project root ----
    const projBytes = fill(project, 25, 'p');
    const s3 = await store.snapshot(aid, { runId: 'r2', turn: 0, label: 'shell.exec', workTree: project });
    A.ok(s3 && s3.created, 'project-root snapshot created');
    A.eq(s3.files, 25, 'project snapshot counts its tracked files');
    A.eq(s3.bytes, projBytes, 'project snapshot sums its tracked bytes');
    A.eq(c.hits.n, 0, 'project snapshot made no statSync calls on project files');

    // ---- (4) the size-ceiling re-init path (measure()'s other caller) ----
    const tinyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-measure-tiny-'));
    const tinyWt = path.join(tinyRoot, aid);
    fs.mkdirSync(tinyWt, { recursive: true });
    const c2 = countingFs([tinyWt]);
    const tiny = makeCheckpointStore({ fs: c2.fs, pathMod: path, root: tinyRoot, runGit, clock: makeClock(1700000000000), keep: 5, maxRepoBytes: 1 });
    const tinyBytes = fill(tinyWt, 12, 't');
    await tiny.snapshot(aid, { runId: 'r3', turn: 0, label: 'fs.write' });
    fs.writeFileSync(path.join(tinyWt, 'later.js'), 'changed\n');
    await tiny.snapshot(aid, { runId: 'r3', turn: 1, label: 'fs.write' });
    const reinit = tiny.list(aid).snapshots.find(function (s) { return /re-init/.test(String(s.label || '')); });
    A.ok(reinit, 'a 1-byte ceiling forces the re-init sweep');
    A.eq(reinit && reinit.files, 12, 're-init baseline counts its tracked files');
    A.eq(reinit && reinit.bytes, tinyBytes, 're-init baseline sums its tracked bytes');
    A.eq(c2.hits.n, 0, 're-init path made no statSync calls on work-tree files');
    try { fs.rmSync(tinyRoot, { recursive: true, force: true }); } catch (_) {}

    // ---- (5) a Git older than 2.36 (no ls-tree --format) falls back to `ls-tree -l`: same numbers ----
    const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cp-measure-old-'));
    const oldWt = path.join(oldRoot, aid);
    fs.mkdirSync(oldWt, { recursive: true });
    const c3 = countingFs([oldWt]);
    let refusedFormat = 0;
    const oldGit = (args, opts) => {
      if (args.some(function (a) { return /^--format=/.test(a); })) { refusedFormat++; return Promise.resolve({ code: 129, stdout: '', stderr: "error: unknown option `format=%(objectsize)'" }); }
      return runGit(args, opts);
    };
    const old = makeCheckpointStore({ fs: c3.fs, pathMod: path, root: oldRoot, runGit: oldGit, clock: makeClock(1700000000000), keep: 5 });
    const oldBytes = fill(oldWt, 9, 'o');
    const s5 = await old.snapshot(aid, { runId: 'r5', turn: 0, label: 'fs.write' });
    A.ok(refusedFormat > 0, 'the --format form was tried first');
    A.ok(s5 && s5.files === 9 && s5.bytes === oldBytes, 'the -l fallback reports the same truthful size');
    A.eq(c3.hits.n, 0, 'the fallback makes no per-file statSync either');
    try { fs.rmSync(oldRoot, { recursive: true, force: true }); } catch (_) {}
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('checkpoint-measure-nostat.test');
})().catch(function (e) { console.error(e); process.exit(1); });
