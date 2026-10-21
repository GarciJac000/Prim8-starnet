/* node test/ssh-bg-read-remote.test.js — shell.bg.read on the SSH backend counts, greps and pages ON THE REMOTE HOST.

   Before: readBackground `cat`-ed the whole remote log into one string and paged it here. That was unbounded RAM
   (a huge log could take the station down), and once command captures became bounded (output-capture.js keeps
   head + tail) a grep could no longer see the dropped middle: an error at line 50,000 of a 12M-char log was
   reported as "(no lines match)", and the line numbers past the cut pointed at the wrong lines.

   The generated script runs here through a REAL `sh -s` + awk (the remote side of `ssh … sh -s`), against a real
   job directory. Laws under test:
     • grep sees the WHOLE log, case-insensitively (like the local backend), and numbers matches with the file's
       own line numbers; totalLines is the file's line count, matchedLines the match count;
     • no grep, no offset = the last `limit` lines; a positive offset pages from there; a negative one from the end;
     • out + err are read in that order; a line longer than 4000 characters is cut, visibly;
     • a missing job is "no such background process", not an empty page. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { makeEnvironmentManager } = require('../sidecar/environment.js');

const isWin = process.platform === 'win32';
const GIT_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const SH = isWin ? path.join(GIT_BIN, 'sh.exe') : 'sh';
if (isWin && !fs.existsSync(SH)) {
  console.log('ssh-bg-read-remote.test: SKIPPED — no POSIX sh at ' + SH + ' (Git for Windows) to play the remote host');
  A.ok(true, 'skipped');
  A.report('ssh-bg-read-remote.test');
}
const posix = (p) => isWin ? '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/') : p;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-sshbg-'));
const BG = 'sshbg_0123456789abcdef';
const jobDir = path.join(tmp, '.starnet', 'jobs', BG);
fs.mkdirSync(jobDir, { recursive: true });

// 200,000 lines (~12M chars — past the 8 Mi-char bounded capture), a FATAL at line 50,000, a lower-case one at
// 150,000, then 2 stderr lines. One 9000-char line at 199,990.
const N = 200000;
const parts = [];
for (let i = 1; i <= N; i++) {
  if (i === 50000) parts.push('step ' + i + ' FATAL ERROR: disk full');
  else if (i === 150000) parts.push('step ' + i + ' fatal: retry budget exhausted');
  else if (i === 199990) parts.push('L'.repeat(9000));
  else parts.push('step ' + i + ' ok ' + 'x'.repeat(40));
}
fs.writeFileSync(path.join(jobDir, 'out'), parts.join('\n') + '\n');
fs.writeFileSync(path.join(jobDir, 'err'), 'warn: stderr one\nwarn: stderr two\n');

// The "ssh" spawn: run the script on a real local sh (the remote host's side of `ssh … sh -s`).
const calls = [];
const spawn = function (file, args, opts) {
  calls.push({ file, args });
  const env = Object.assign({}, process.env);
  if (isWin) env.PATH = GIT_BIN + ';' + (env.PATH || '');
  return cp.spawn(SH, ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
};
const env = makeEnvironmentManager({
  spawn, fs, pathMod: path, root: tmp, env: {}, config: { backend: 'ssh', sshBin: 'ssh' },
  sshConfig: () => ({ configured: true, host: 'box', user: 'u', port: 22, remoteRoot: posix(tmp) })
});

(async () => {
  try {
    // ---- 1. grep sees the whole log, case-insensitively, with the file's own line numbers ----
    {
      const r = await env.readBackground('agent', BG, { grep: 'FATAL' });
      A.ok(r.ok, 'grep read ok: ' + (r.error || ''));
      A.eq(r.matchedLines, 2, 'grep finds BOTH matches across the whole 12M-char log (case-insensitive)');
      A.eq(r.lineNos, [50000, 150000], 'matches carry the file\'s real line numbers');
      A.eq(r.lines[0], 'step 50000 FATAL ERROR: disk full', 'the matched line text is exact');
      A.eq(r.totalLines, N + 2, 'totalLines is the whole file (out + err)');
      A.eq(r.offset, 0, 'grep without an offset starts at the first match');
      A.ok(calls[calls.length - 1].file === 'ssh' && calls[calls.length - 1].args.slice(-2).join(' ') === 'sh -s', 'it runs over ssh … sh -s');
    }
    // ---- 2. no grep, no offset = the last `limit` lines (out then err) ----
    {
      const r = await env.readBackground('agent', BG, { limit: 5 });
      A.eq(r.lineNos, [N - 2, N - 1, N, N + 1, N + 2], 'the tail page is the last 5 lines');
      A.eq(r.lines.slice(-2), ['warn: stderr one', 'warn: stderr two'], 'err follows out');
      A.eq(r.firstLineNo, N - 2, 'firstLineNo is the real first line of the page');
    }
    // ---- 3. explicit offsets ----
    {
      const r = await env.readBackground('agent', BG, { offset: 49999, limit: 3 });
      A.eq(r.lineNos, [50000, 50001, 50002], 'a positive offset pages from that line');
      A.eq(r.lines[0], 'step 50000 FATAL ERROR: disk full', 'and the text is the file\'s line 50,000');
      const neg = await env.readBackground('agent', BG, { offset: -2, limit: 10 });
      A.eq(neg.lineNos, [N + 1, N + 2], 'a negative offset counts from the end');
      const past = await env.readBackground('agent', BG, { offset: 10 * N, limit: 10 });
      A.eq(past.returned, 0, 'an offset past the end is an empty page, not an error');
    }
    // ---- 4. a huge line is cut, visibly ----
    {
      const r = await env.readBackground('agent', BG, { offset: 199989, limit: 1 });
      A.eq(r.lineNos, [199990], 'the long line is addressed by its real number');
      A.ok(r.lines[0].length < 4100 && /line cut at 4000 characters/.test(r.lines[0]), 'a 9000-char line is cut at 4000 with a visible note');
    }
    // ---- 5. a missing job ----
    {
      const r = await env.readBackground('agent', 'sshbg_ffffffffffffffff', {});
      A.eq(r.ok, false, 'a missing job is not ok');
      A.eq(r.error, 'no such background process', 'and says so');
    }
    // ---- 6. a fractional limit pages like the local backend (it enters shell arithmetic as an integer) ----
    {
      const r = await env.readBackground('agent', BG, { limit: 2.5 });
      A.ok(r.ok, 'a fractional limit still reads: ' + (r.error || ''));
      A.eq(r.lineNos, [N + 1, N + 2], 'limit 2.5 pages 2 lines, like slice()');
    }
    // ---- 7. a failed remote scan (or an ssh drop after the header) is an ERROR, never an ok empty page ----
    {
      const scripted = (stdout, code) => function () {
        const h = {}, child = { pid: 9, stdin: { write() {}, end() {} }, stdout: { on: (ev, fn) => { if (ev === 'data') child._o = fn; } }, stderr: { on() {} },
          on: (ev, fn) => { (h[ev] = h[ev] || []).push(fn); }, kill() {}, unref() {} };
        setImmediate(() => { child._o(Buffer.from(stdout)); (h.exit || []).forEach(f => f(code)); (h.close || []).forEach(f => f(code)); });
        return child;
      };
      const mk = (spawn) => makeEnvironmentManager({ spawn, fs, pathMod: path, root: tmp, env: {}, config: { backend: 'ssh', sshBin: 'ssh' },
        sshConfig: () => ({ configured: true, host: 'box', user: 'u', port: 22, remoteRoot: '/r' }) });
      const awkDied = await mk(scripted('starnet-page 500 0 300\n', 46)).readBackground('agent', BG, {});
      A.eq(awkDied.ok, false, 'an awk failure after the header is not ok');
      A.ok(/awk failed, exit 46/.test(awkDied.error), 'and names the failed scan: ' + awkDied.error);
      const dropped = await mk(scripted('starnet-page 500 0 300\n301\tpartial\n', 255)).readBackground('agent', BG, {});
      A.eq(dropped.ok, false, 'an ssh drop after the header is not ok');
      A.ok(/ssh exit 255/.test(dropped.error), 'and names the ssh exit: ' + dropped.error);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('ssh-bg-read-remote.test');
})().catch(e => { console.error(e); process.exit(1); });
