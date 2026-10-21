/* node test/fs.read-large.test.js — fs.read pages a big text file WITHOUT reading/decoding all of it, and every
   page is byte-identical to the whole-file path (2026-10-20).

   fs.read read the whole file, decoded the whole file and (numbered) split the whole file on EVERY call to return
   one ~24k page: ~90-180 ms of blocking CPU and ~240 MB of transient heap per page on a 40 MB parked output. Now a
   big UTF-8 file is indexed once (a checkpoint per 1 MiB) and each page streams from the nearest checkpoint.

   DIFFERENTIAL: tools A force the historic path (readStreamMinBytes: Infinity); tools B take the streaming path
   (64 KiB) through an fsp whose readFile THROWS for the big file, so B provably never reads it whole. Hundreds of
   probes (plain + numbered, offsets on chunk edges / EOF / past EOF / the line a checkpoint lands inside, several
   limits and context budgets) must be deep-equal. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-read-large-' + process.pid);
const MiB = 1024 * 1024;

(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(path.join(ROOT, 'ag'), { recursive: true });
  const absOf = (rel) => path.join(ROOT, 'ag', rel);

  // ~5 MiB: a BOM, LF + CRLF lines, 1/2/3/4-byte characters, blank-line runs, no trailing newline
  const parts = ['﻿'];
  let approx = 0;
  for (let i = 0; approx < 5 * MiB; i++) {
    const row = 'row ' + i + ' é ✓ 😀 ' + 'x'.repeat(i % 97) + (i % 3 ? '\n' : '\r\n');
    parts.push(row); approx += Buffer.byteLength(row);
    if (i % 5000 === 0) parts.push('\n\n');
  }
  parts.push('tail without newline 😀');
  const bigText = parts.join('');
  await fsp.writeFile(absOf('big.txt'), bigText);
  const bigBytes = Buffer.from(bigText, 'utf8');

  let bigReadFiles = 0, docReadFiles = 0;
  const guarded = new Proxy(fsp, { get(target, prop) {
    if (prop !== 'readFile') return target[prop];
    return async (p, ...rest) => {
      const name = path.basename(String(p));
      if (name === 'big.txt') { bigReadFiles++; throw Object.assign(new Error('test: the streaming path must not readFile big.txt'), { code: 'EGUARD' }); }
      if (name === 'doc.docx') docReadFiles++;
      return target.readFile(p, ...rest);
    };
  } });
  const docExtract = { sniff: (name, buf) => (/\.docx$/.test(name) && buf && buf[0] === 0x50 && buf[1] === 0x4b ? 'docx' : null), extract: () => 'DOC TEXT' };
  const histA = makeFsTools({ fsp, pathMod: path, root: ROOT, docExtract, limits: { readReturn: 24000, readStreamMinBytes: Infinity } }).readTool;
  const streamB = makeFsTools({ fsp: guarded, pathMod: path, root: ROOT, docExtract, limits: { readReturn: 24000, readStreamMinBytes: 64 * 1024 } }).readTool;

  async function both(args, outputMax) {
    const ctx = { agentId: 'ag', outputMax };
    let a, b;
    try { a = await histA.run(Object.assign({}, args), ctx); } catch (e) { a = { err: e.message }; }
    try { b = await streamB.run(Object.assign({}, args), ctx); } catch (e) { b = { err: e.message }; }
    return { a, b, same: JSON.stringify(a) === JSON.stringify(b) };
  }

  // ---- 1. the differential ----
  {
    const totalUnits = bigText.length;
    const totalLines = bigText.split('\n').length;   // no trailing newline: every split piece is a line
    // the 1-based line that each 1 MiB checkpoint byte lands INSIDE (a checkpoint is mid-line)
    const cpLines = [];
    for (let k = 1; k * MiB < bigBytes.length; k++) {
      let nl = 0;
      for (let at = bigBytes.indexOf(10); at >= 0 && at < k * MiB; at = bigBytes.indexOf(10, at + 1)) nl++;
      cpLines.push(nl + 1, nl + 2, nl);
    }
    const plainOffsets = [undefined, 0, 1, 23999, MiB - 1, MiB, MiB + 1, 2 * MiB - 2, 2500000, 4 * MiB + 3, totalUnits - 10, totalUnits, totalUnits + 5];
    const lineOffsets = [undefined, 1, 2, 4999, 5000, 25000, totalLines - 1, totalLines, totalLines + 1].concat(cpLines);
    let probes = 0, same = 0;
    const firstDiffs = [];
    for (const outputMax of [undefined, 8000, 30000]) {
      for (const offset of plainOffsets) for (const limit of [undefined, 1, 24000, 100000]) {
        const r = await both({ path: 'big.txt', offset, limit }, outputMax);
        probes++; if (r.same) same++; else if (firstDiffs.length < 3) firstDiffs.push({ offset, limit, outputMax, a: JSON.stringify(r.a).slice(-160), b: JSON.stringify(r.b).slice(-160) });
      }
      for (const offset of lineOffsets) for (const limit of [undefined, 1, 3, 400]) {
        const r = await both({ path: 'big.txt', numbered: true, offset, limit }, outputMax);
        probes++; if (r.same) same++; else if (firstDiffs.length < 3) firstDiffs.push({ numbered: true, offset, limit, outputMax, a: JSON.stringify(r.a).slice(-160), b: JSON.stringify(r.b).slice(-160) });
      }
    }
    const bad = await both({ path: 'big.txt', limit: 0 });
    probes++; if (bad.same && /limit must be a positive number/.test(bad.b.err)) same++;
    A.eq(same, probes, probes + ' probes identical between the whole-file and streaming paths' + (firstDiffs.length ? ': ' + JSON.stringify(firstDiffs) : ''));
    A.ok(probes >= 300, 'the differential is wide (' + probes + ' probes)');
    A.eq(bigReadFiles, 0, 'the streaming path never read big.txt whole (its readFile throws)');
  }

  // ---- 2. a rewrite (size + mtime change) invalidates the cached index ----
  {
    const before = await streamB.run({ path: 'big.txt', offset: 3 * MiB, limit: 50 }, { agentId: 'ag' });
    await fsp.writeFile(absOf('big.txt'), 'NEW HEAD ' + bigText.slice(0, bigText.length - 100));
    const later = new Date(Date.now() + 60000);
    await fsp.utimes(absOf('big.txt'), later, later);
    const r = await both({ path: 'big.txt', offset: 3 * MiB, limit: 50 });
    A.ok(r.same && r.b.content !== before.content, 'after a rewrite the streaming page matches the new content, not the old index');
    const n = await both({ path: 'big.txt', numbered: true, offset: 1, limit: 2 });
    A.ok(n.same && /^1\t﻿?NEW HEAD /.test(n.b.content), 'numbered page 1 shows the rewritten first line');
    A.eq(bigReadFiles, 0, 'still no whole-file read of big.txt');
  }

  // ---- 3. what the streaming path must NOT take: invalid UTF-8, documents, small files ----
  {
    const bad = Buffer.alloc(200 * 1024, 0x61);
    bad[MiB % bad.length] = 0xff; bad[150000] = 0xc3;   // invalid bytes (a stray 0xff, a lead with no continuation)
    await fsp.writeFile(absOf('bad.txt'), bad);
    const r = await both({ path: 'bad.txt', offset: 149990, limit: 30 });
    A.ok(r.same && /�/.test(r.b.content), 'an invalid-UTF-8 big file falls back to the historic decode (replacement chars identical)');
    const doc = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(100 * 1024, 0x20)]);
    await fsp.writeFile(absOf('doc.docx'), doc);
    const d = await streamB.run({ path: 'doc.docx' }, { agentId: 'ag' });
    A.ok(d.content === 'DOC TEXT' && docReadFiles === 1, 'a big document is still extracted through the historic whole-file path');
    await fsp.writeFile(absOf('small.txt'), 'small\nfile\n');
    const s = await both({ path: 'small.txt', numbered: true });
    A.ok(s.same && s.b.content === '1\tsmall\n2\tfile', 'a file under the threshold reads exactly as before');
    const missing = await both({ path: 'nope.txt' });
    A.ok(missing.same && missing.b.err === 'no such file: nope.txt', 'a missing file says "no such file" on both paths');
  }

  // ---- 4. the index pass honours ctx.signal: a cancelled run or the tool timeout stops it at the next chunk ----
  // (the registry aborts ctx.signal on timeout; the pass is the one part of a large read that scales with the file)
  {
    const size = 12 * MiB;
    await fsp.writeFile(absOf('huge.txt'), Buffer.alloc(size, 0x61));
    let reads = 0, abortAt = 0, ac = new AbortController();
    const counting = new Proxy(fsp, { get(target, prop) {
      if (prop !== 'open') return target[prop];
      return async (...a) => {
        const fh = await target.open(...a);
        return new Proxy(fh, { get(t, p) {
          if (p === 'read') return async (...args) => { reads++; const r = await t.read(...args); if (reads === abortAt) ac.abort(); return r; };
          const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
        } });
      };
    } });
    const reader = makeFsTools({ fsp: counting, pathMod: path, root: ROOT, limits: { readReturn: 24000, readStreamMinBytes: 64 * 1024 } }).readTool;
    const attempt = async (args, ctx) => { try { return { out: await reader.run(args, ctx) }; } catch (e) { return { err: e }; } };

    abortAt = 2;   // read 1 = the head sniff, read 2 = the first 1 MiB index chunk: the abort lands mid-pass
    const mid = await attempt({ path: 'huge.txt', offset: size - 5, limit: 10 }, { agentId: 'ag', signal: ac.signal });
    A.ok(mid.err && mid.err.name === 'AbortError', 'an abort during the index pass rejects with AbortError' + (mid.err ? ' (got ' + mid.err.name + ': ' + mid.err.message + ')' : ' (it ran on and returned a page)'));
    A.eq(reads, 2, 'and the pass stopped at the next chunk: ' + reads + ' reads of a 12-chunk file (it used to read all of it, then page)');

    reads = 0; abortAt = 0; ac = new AbortController(); ac.abort();
    const pre = await attempt({ path: 'huge.txt' }, { agentId: 'ag', signal: ac.signal });
    A.ok(pre.err && pre.err.name === 'AbortError' && reads === 1, 'an already-aborted signal reads no index chunk at all (' + reads + ' read: the head sniff)');

    reads = 0;
    const ok = await attempt({ path: 'huge.txt', offset: size - 5, limit: 10 }, { agentId: 'ag' });
    A.eq(ok.out && ok.out.content, 'aaaaa\n[showing characters ' + (size - 5) + '-' + size + ' of ' + size + '; end of file]', 'a later uncancelled read is whole and correct (the abort cached no half-built index)');
  }

  await fsp.rm(ROOT, { recursive: true, force: true });
  A.report('fs.read-large.test');
})().catch(async (e) => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  console.log('FAIL: fs.read-large.test threw -- ' + (e && e.stack || e));
  process.exit(1);
});
