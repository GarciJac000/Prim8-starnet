/* node test/fs.search-budget.test.js — fs.search's walk is budgeted, stoppable and cheap (2026-10-20).

   The pure-JS walker awaited one fsp.stat per file, in sequence, while it built the list (2.7-9.7 s for 6,000
   files, against 21-67 ms for the readdir-only walk), and the 8 s budget timer was armed only AFTER the walk
   returned, so a 20k-file tree reached the 20 s tool timeout. Nothing but the rg path checked ctx.signal: a
   search with an ALREADY-aborted signal still ran ~15 s and answered "(no matches)" — a false negative, since
   the text existed. Every assertion here COUNTS calls through an fsp proxy (no timing assertions), with
   rg:false so the guaranteed walker path is the one under test. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-search-budget-' + process.pid);
const WS = path.join(ROOT, 'ag');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fsp with per-method call counters (and an optional per-call delay), every call still real
function counted(opts) {
  opts = opts || {};
  const calls = { readFile: [], stat: [], readdir: [] };
  const proxy = new Proxy(fsp, { get(target, prop) {
    if (prop === 'readFile' || prop === 'stat' || prop === 'readdir') {
      return async (...args) => {
        calls[prop].push(String(args[0]));
        if (opts.delay && opts.delay[prop]) await sleep(opts.delay[prop]);
        return target[prop](...args);
      };
    }
    return target[prop];
  } });
  return { fsp: proxy, calls };
}
const tools = (c, limits) => makeFsTools({ fsp: c.fsp, pathMod: path, root: ROOT, rg: false, limits });
async function rejection(p) { try { await p; return null; } catch (e) { return e; } }

(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(WS, { recursive: true });

  // ---- tree A: 200 files in 10 dirs, the needle in the LAST one ----
  for (let d = 0; d < 10; d++) {
    await fsp.mkdir(path.join(WS, 'a', 'd' + d), { recursive: true });
    for (let f = 0; f < 20; f++) await fsp.writeFile(path.join(WS, 'a', 'd' + d, 'f' + f + '.txt'), 'hello ' + d + ' ' + f + '\n');
  }

  // ---- 1. an already-aborted signal: AbortError, and not one file is read ----
  {
    const c = counted();
    const ac = new AbortController(); ac.abort();
    const e = await rejection(tools(c).searchTool.run({ query: 'hello 9 19', path: 'a' }, { agentId: 'ag', signal: ac.signal }));
    A.ok(e && e.name === 'AbortError', 'a search whose run was already cancelled rejects with AbortError (trunk walked, scanned and answered)' + (e ? '' : ' (it resolved)'));
    A.eq(c.calls.readFile.filter((p) => /\.txt$/.test(p)).length, 0, 'no file content is read for a cancelled search');
  }

  // ---- 2. abort DURING the scan: it stops reading ----
  {
    const ac = new AbortController();
    const c = counted({ delay: { readFile: 5 } });
    const pending = rejection(tools(c).searchTool.run({ query: 'hello 9 19', path: 'a' }, { agentId: 'ag', signal: ac.signal }));
    while (c.calls.readFile.filter((p) => /\.txt$/.test(p)).length < 20) await sleep(5);
    ac.abort();
    const e = await pending;
    const readsAtAbort = c.calls.readFile.filter((p) => /\.txt$/.test(p)).length;
    await sleep(50);
    A.ok(e && e.name === 'AbortError', 'a search cancelled mid-scan rejects with AbortError');
    A.ok(readsAtAbort < 200 && c.calls.readFile.filter((p) => /\.txt$/.test(p)).length === readsAtAbort, 'and launches no further reads (' + readsAtAbort + ' of 200 read)');
  }

  // ---- 2b. abort while window jobs are mid-stat: not one read starts after the abort ----
  // (a job that was awaiting its stat when the abort hit still called readFile once the stat answered)
  {
    const ac = new AbortController();
    const c = counted();
    let n = 0;
    const jittered = new Proxy(c.fsp, { get(target, prop) {
      if (prop === 'stat') return async (...args) => { if (/\.txt$/.test(String(args[0]))) await sleep(5 + ((++n * 37) % 60)); return target.stat(...args); };
      return target[prop];
    } });
    const pending = rejection(makeFsTools({ fsp: jittered, pathMod: path, root: ROOT, rg: false }).searchTool.run({ query: 'hello 9 19', path: 'a' }, { agentId: 'ag', signal: ac.signal }));
    const txtReads = () => c.calls.readFile.filter((p) => /\.txt$/.test(p)).length;
    while (txtReads() < 20) await sleep(2);
    ac.abort();
    const atAbort = txtReads();
    const e = await pending;
    await sleep(200);   // past every jittered stat still in flight
    A.ok(e && e.name === 'AbortError', 'a search cancelled while stats are in flight rejects with AbortError');
    A.eq(txtReads(), atAbort, 'no file read starts after the abort (' + atAbort + ' read before it)');
  }

  // ---- 3. the budget covers the WALK: a slow tree stops at the budget and says so ----
  {
    for (let d = 0; d < 30; d++) {
      await fsp.mkdir(path.join(WS, 'slow', 'd' + String(d).padStart(2, '0')), { recursive: true });
      await fsp.writeFile(path.join(WS, 'slow', 'd' + String(d).padStart(2, '0'), 'x.txt'), 'needle-' + d + '\n');
    }
    const c = counted({ delay: { readdir: 40 } });
    const r = await tools(c, { searchBudgetMs: 100 }).searchTool.run({ query: 'needle-29', path: 'slow' }, { agentId: 'ag' });
    const walked = c.calls.readdir.length;
    A.ok(/\[search stopped at the 0s budget — these are the matches found so far; narrow with file_glob or a more specific query\]/.test(r.content), 'a walk cut by the budget answers with the budget note, never a bare "(no matches)": ' + JSON.stringify(r.content.slice(0, 120)));
    A.ok(walked < 31, 'the walk stopped at the budget (' + walked + ' of 31 directories listed; trunk lists all of them before it even arms the timer)');
  }

  // ---- 4. a plain file costs no stat in the walk: a *.md glob over 300 .txt files stats only what it reads ----
  {
    await fsp.mkdir(path.join(WS, 'many'), { recursive: true });
    for (let f = 0; f < 300; f++) await fsp.writeFile(path.join(WS, 'many', 'n' + String(f).padStart(3, '0') + '.txt'), 'nothing\n');
    await fsp.writeFile(path.join(WS, 'many', 'readme.md'), 'the one doc\n');
    const c = counted();
    const r = await tools(c).searchTool.run({ query: 'one doc', path: 'many', file_glob: '*.md' }, { agentId: 'ag' });
    A.eq(r.content, 'many/readme.md:1: the one doc', 'the glob-filtered search finds the doc');
    A.ok(c.calls.stat.length <= 3, 'stat calls: ' + c.calls.stat.length + ' (trunk: one per file, 301+)');
    const c2 = counted();
    const f = await tools(c2).searchTool.run({ query: '*.md', target: 'files', path: 'many' }, { agentId: 'ag' });
    A.eq(f.content, 'many/readme.md', 'target:"files" finds the one hit');
    A.ok(c2.calls.stat.length <= 3, 'target:"files" stats only the glob hits: ' + c2.calls.stat.length + ' stat calls (trunk 301+)');
  }

  // ---- 5. results are unchanged: path order, context, counts, newest-first files, oversized files named ----
  {
    await fsp.mkdir(path.join(WS, 'same', 'b'), { recursive: true });
    await fsp.writeFile(path.join(WS, 'same', 'b', 'two.txt'), 'x\nalpha 2\ny\n');
    await fsp.writeFile(path.join(WS, 'same', 'a.txt'), 'alpha 1\nzzz\n');
    await fsp.writeFile(path.join(WS, 'same', 'c.txt'), 'no\n');
    const old = new Date(Date.now() - 3600000);
    await fsp.utimes(path.join(WS, 'same', 'a.txt'), old, old);
    const t = tools(counted());
    A.eq((await t.searchTool.run({ query: 'alpha', path: 'same' }, { agentId: 'ag' })).content, 'same/a.txt:1: alpha 1\nsame/b/two.txt:2: alpha 2', 'content hits in path order');
    A.eq((await t.searchTool.run({ query: 'alpha', path: 'same', output_mode: 'count' }, { agentId: 'ag' })).content, 'same/a.txt: 1\nsame/b/two.txt: 1', 'count mode');
    A.eq((await t.searchTool.run({ query: 'alpha', path: 'same', context: 1 }, { agentId: 'ag' })).content, 'same/a.txt\n  1: alpha 1\n  2- zzz\nsame/b/two.txt\n  1- x\n  2: alpha 2\n  3- y', 'context rows');
    A.eq((await t.searchTool.run({ query: '*.txt', target: 'files', path: 'same' }, { agentId: 'ag' })).content.split('\n').pop(), 'same/a.txt', 'target:"files" is still newest first (the old file sorts last)');
    await fsp.writeFile(path.join(WS, 'same', 'big.txt'), Buffer.alloc(8 * 1024 * 1024 + 10, 0x61));
    const big = await t.searchTool.run({ query: 'never-there', path: 'same' }, { agentId: 'ag' });
    A.ok(/\[NOT searched — over the 8 MB per-file search limit: same\/big\.txt\. Name one as "path" to search it \(up to 64 MB\)\.\]/.test(big.content), 'an oversized file is still named, now from the scan-time stat');
  }

  // ---- 6. a consent card (pathTrust waiting on the Commander) does not spend the search budget ----
  {
    const proj = path.join(ROOT, 'proj-consent');
    await fsp.mkdir(path.join(proj, 'src'), { recursive: true });
    await fsp.writeFile(path.join(proj, 'src', 'a.txt'), 'the needle is here\n');
    await fsp.writeFile(path.join(proj, 'src', 'readme.md'), 'doc\n');
    const pathTrust = async (abs) => { await sleep(300); return { base: proj, abs: path.resolve(abs) }; };
    const t = makeFsTools({ fsp, pathMod: path, root: ROOT, rg: false, pathTrust, limits: { searchBudgetMs: 200 } });
    const c = await t.searchTool.run({ query: 'needle', path: proj }, { agentId: 'ag' });
    A.eq(c.content, 'src/a.txt:1: the needle is here', 'a content search answered after a 300 ms consent wait still finds the text (it answered "(no matches)" + the budget note)');
    const f = await t.searchTool.run({ query: '*.md', target: 'files', path: proj }, { agentId: 'ag' });
    A.eq(f.content, 'src/readme.md', 'a files search answered after the same wait still lists the file');
  }

  // ---- 7. target:"files" cut by the budget lists the names the walk DID find, with the budget note ----
  {
    for (let d = 0; d < 30; d++) {
      await fsp.mkdir(path.join(WS, 'cutf', 'd' + String(d).padStart(2, '0')), { recursive: true });
      await fsp.writeFile(path.join(WS, 'cutf', 'd' + String(d).padStart(2, '0'), 'notes' + d + '.md'), 'x\n');
    }
    const c = counted({ delay: { readdir: 40 } });
    const r = await tools(c, { searchBudgetMs: 300 }).searchTool.run({ query: '*.md', target: 'files', path: 'cutf' }, { agentId: 'ag' });
    const names = r.content.split('\n\n')[0].split('\n').filter((l) => /^cutf\/d\d\d\/notes\d+\.md$/.test(l));
    const reached = Array.from({ length: names.length }, (_, d) => 'cutf/d' + String(d).padStart(2, '0') + '/notes' + d + '.md');
    A.ok(c.calls.readdir.length < 31, 'the walk was cut by the budget (' + c.calls.readdir.length + ' of 31 directories listed)');
    A.ok(names.length >= 1, 'the names found before the cut are listed (' + names.length + '), never "(no files matching *.md)": ' + JSON.stringify(r.content.slice(0, 160)));
    A.eq(names.slice().sort(), reached, 'exactly the files the walk reached, in its path order');
    A.ok(/\[search stopped at the 0s budget — these are the matches found so far; narrow with file_glob or a more specific query\]/.test(r.content), 'and the listing says the walk was cut');
  }

  // ---- 7b. a content search whose WALK spent the budget still searches the files the walk found ----
  // (the scan launched nothing once the clock had expired: 0 reads, "(no matches for needle-0)" with the text in
  // the first file found, and a summary of "0 matches in 5 file(s) scanned"; trunk found it)
  {
    const c = counted({ delay: { readdir: 40 } });
    const r = await tools(c, { searchBudgetMs: 300 }).searchTool.run({ query: 'needle-0', path: 'slow' }, { agentId: 'ag' });
    const reads = c.calls.readFile.filter((p) => /x\.txt$/.test(p)).length;
    A.ok(c.calls.readdir.length < 31, 'the walk was cut by the budget (' + c.calls.readdir.length + ' of 31 directories listed)');
    A.ok(reads >= 1, 'the scan read the files the cut walk found (' + reads + ' read)');
    A.eq(r.content.split('\n\n')[0], 'slow/d00/x.txt:1: needle-0', 'and finds the text in them: ' + JSON.stringify(r.content.slice(0, 120)));
    A.ok(/\[search stopped at the 0s budget/.test(r.content), 'still saying the search was cut');
  }

  // ---- 7c. a scan the budget cut says how many files it searched, never the walk's count ----
  {
    await fsp.mkdir(path.join(WS, 'cutc'), { recursive: true });
    for (let f = 0; f < 100; f++) await fsp.writeFile(path.join(WS, 'cutc', 'f' + String(f).padStart(3, '0') + '.txt'), 'plain\n');
    const c = counted({ delay: { readFile: 100 } });
    const r = await tools(c, { searchBudgetMs: 150 }).searchTool.run({ query: 'never-there', path: 'cutc' }, { agentId: 'ag' });
    const reads = c.calls.readFile.filter((p) => /cutc[\\/]f\d+\.txt$/.test(p)).length;
    const m = /^0 matches in (\d+) of 100 file\(s\) scanned$/.exec(r.summary || '');
    A.ok(m, 'a cut scan\'s summary is "0 matches in N of 100 file(s) scanned": ' + JSON.stringify(r.summary));
    A.ok(m && Number(m[1]) >= 16 && Number(m[1]) < 100 && Number(m[1]) <= reads, 'N is the files actually searched (' + (m && m[1]) + '; ' + reads + ' reads started, at least the 16-file floor)');
    A.ok(/^\(no matches for never-there\)\n\n\[search stopped at the 0s budget/.test(r.content), 'and the miss carries the budget note');
  }

  // ---- 8. the ripgrep path honours abort: a cancelled run spawns nothing, a cancel mid-listing rejects ----
  {
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    await fsp.mkdir(path.join(WS, 'rgp'), { recursive: true });
    await fsp.writeFile(path.join(WS, 'rgp', 'one.md'), 'x\n');
    await fsp.writeFile(path.join(WS, 'rgp', 'two.md'), 'x\n');
    // a stand-in rg: prints `lines` and then hangs until killed (a big tree), closing when killed
    const fakeRg = (lines) => {
      const spawned = [];
      const spawn = (bin, argv) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const alive = setInterval(() => {}, 1000);   // a real child process holds the event loop open the same way
        child.kill = () => { clearInterval(alive); setImmediate(() => child.emit('close', null)); return true; };
        spawned.push(argv.join(' '));
        if (lines) setImmediate(() => child.stdout.write(lines));
        return child;
      };
      return { spawn, spawned };
    };
    const rgTools = (f, limits) => makeFsTools({ fsp, pathMod: path, root: ROOT, rg: 'rg', spawn: f.spawn, limits });
    for (const q of [{ query: 'zzzz-not-present', path: 'rgp' }, { query: 'zzzz-not-present*', target: 'files', path: 'rgp' }]) {
      const f = fakeRg(null), ac = new AbortController(); ac.abort();
      const e = await rejection(rgTools(f).searchTool.run(q, { agentId: 'ag', signal: ac.signal }));
      A.ok(e && e.name === 'AbortError', 'rg path, already-cancelled ' + (q.target || 'content') + ' search rejects with AbortError' + (e ? '' : ' (it resolved)'));
      A.eq(f.spawned.length, 0, 'and spawns no rg (a content search once ran rg for the full budget)');
    }
    {
      const f = fakeRg(null), ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      const e = await rejection(rgTools(f).searchTool.run({ query: 'zzzz-not-present*', target: 'files', path: 'rgp' }, { agentId: 'ag', signal: ac.signal }));
      A.ok(e && e.name === 'AbortError', 'a files search cancelled while rg lists rejects with AbortError, never "(no files matching …)"' + (e ? '' : ' (it resolved)'));
    }
    {
      const f = fakeRg('one.md\ntwo.md\n');
      const r = await rgTools(f, { searchBudgetMs: 100 }).searchTool.run({ query: '*.md', target: 'files', path: 'rgp' }, { agentId: 'ag' });
      A.eq(r.content.split('\n\n')[0].split('\n').sort(), ['rgp/one.md', 'rgp/two.md'], 'rg --files killed at the budget still lists what it printed (they were all dropped): ' + JSON.stringify(r.content.slice(0, 120)));
      A.ok(/\[search stopped at the 0s budget/.test(r.content), 'and says the listing was cut at the budget');
    }
  }

  await fsp.rm(ROOT, { recursive: true, force: true });
  A.report('fs.search-budget.test');
})().catch(async (e) => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  console.log('FAIL: fs.search-budget.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
