/* node test/shell.process-tree.test.js — a foreground timeout/abort kills the command's WHOLE process tree.

   Windows: the shell leader is deliberately separated from a parent Node process and its grandchild. Killing that
   leader before taskkill inspects `/T` loses the only process-tree root and leaves both Node descendants alive.

   POSIX (macOS/Linux): the shell used to be spawned in the sidecar's own process group and only the /bin/sh
   wrapper was SIGKILLed, so everything the command started (`sleep 30 &`, a dev server) was orphaned — still
   running, still holding the stdout pipe (so the call did not even settle). Now the shell leads its own group
   and the GROUP is killed. The `sleep 30 & wait` case is POSIX-only and skips on win32 with a message; the Linux
   CI fast-gate runs it.

   Every case runs through BOTH foreground primitives: shell.js runCommand (verify.run, the loop host-check) and
   environment.js runProcess via the local backend's execute (the production shell.exec path).
   This test owns and reaps only the exact PIDs its fixtures report. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runCommand } = require('../sidecar/tools/builtin/shell.js');
const { makeEnvironmentManager, runProcess } = require('../sidecar/environment.js');

const WIN = process.platform === 'win32';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid, platform = process.platform, readStat = p => fs.readFileSync(p, 'utf8')) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch (e) { return !!(e && e.code === 'EPERM'); }
  if (platform === 'linux') {
    try {
      // kill(pid, 0) also succeeds for unreaped zombies. They cannot execute or hold
      // pipes open; a container's PID 1 may leave their /proc entries around indefinitely.
      // comm may contain spaces and parentheses, so state follows the LAST closing paren.
      const stat = readStat('/proc/' + pid + '/stat');
      const end = stat.lastIndexOf(')');
      const state = end >= 0 && /^\s+([A-Za-z])(?:\s|$)/.exec(stat.slice(end + 1));
      if (state && (state[1] === 'Z' || state[1] === 'X')) return false;
    } catch (_) { /* unknown state is not evidence of termination */ }
  }
  return true;
}

function livenessCases() {
  const pid = process.pid;
  for (const state of ['Z', 'X']) {
    A.eq(alive(pid, 'linux', () => pid + ' (worker ) with spaces) ' + state + ' 1 20 20'), false,
      'Linux ' + state + ' is terminated even while signal-zero succeeds');
  }
  for (const state of ['R', 'S', 'D', 'T', 't', 'I']) {
    A.eq(alive(pid, 'linux', () => pid + ' (worker) ' + state + ' 1 20 20'), true,
      'Linux ' + state + ' remains a live process');
  }
  A.eq(alive(pid, 'linux', () => { throw new Error('unreadable proc'); }), true, 'unreadable Linux state stays alive');
  A.eq(alive(pid, 'linux', () => 'malformed stat'), true, 'malformed Linux state stays alive');
  for (const platform of ['darwin', 'win32']) {
    let read = false;
    A.eq(alive(pid, platform, () => { read = true; return pid + ' (worker) Z 1'; }), true, platform + ' keeps signal-zero semantics');
    A.eq(read, false, platform + ' never reads Linux proc state');
  }
  A.eq(alive(-1), false, 'invalid PIDs are not live');
  A.eq(alive(pid), true, 'the real running test process remains live');
}

async function waitFor(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  return read();
}

// reap ONE exact pid we were told about (never by name/pattern)
function reap(pid) {
  return new Promise(resolve => {
    if (!alive(pid)) return resolve();
    if (!WIN) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} return resolve(); }
    let killer;
    try { killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch (_) { return resolve(); }
    killer.on('error', () => resolve());
    killer.on('close', () => resolve());
  });
}

const q = (s) => '"' + s + '"';

// the two foreground primitives under test, each given the same (cmd, cwd, timeoutMs, signal)
function viaRunCommand(root) {
  return (cmd, timeoutMs, signal) => runCommand({ spawn, cmd, cwd: root, timeoutMs, maxBytes: 4096, signal, isWin: WIN });
}
function viaEnvironment(root) {
  const env = makeEnvironmentManager({ spawn, fs, pathMod: path, root: path.join(root, 'ws'), clock: { now: () => Date.now() } });
  return (cmd, timeoutMs, signal) => env.execute({ agentId: 'tree', cmd, cwd: root, timeoutMs, maxBytes: 4096, signal });
}

// node parent -> node grandchild, both PIDs written to a file the test reads (works on every OS)
async function nodeTreeCase(label, run, root, how) {
  const tag = label.replace(/\W+/g, '-') + '-' + how;
  const grandFile = path.join(root, tag + '-grand.js');
  const parentFile = path.join(root, tag + '-parent.js');
  const pidFile = path.join(root, tag + '-pids.json');
  fs.writeFileSync(grandFile, "'use strict'; setInterval(() => {}, 1000);\n");
  fs.writeFileSync(parentFile,
    "'use strict';\n" +
    "const fs = require('fs');\n" +
    "const { spawn } = require('child_process');\n" +
    'const grand = spawn(process.execPath, [' + JSON.stringify(grandFile) + "], { stdio: 'ignore' });\n" +
    'fs.writeFileSync(' + JSON.stringify(pidFile) + ", JSON.stringify({ parent: process.pid, grandchild: grand.pid }));\n" +
    'setInterval(() => {}, 1000);\n');
  let pids = null, settled = false, runPromise = null;
  try {
    const ac = new AbortController();
    const t0 = Date.now();
    runPromise = run(q(process.execPath) + ' ' + q(parentFile), how === 'timeout' ? 8000 : 60000, ac.signal);
    runPromise.then(() => { settled = true; }, () => { settled = true; });
    pids = await waitFor(() => { try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch (_) { return null; } }, 10000);
    A.ok(pids && alive(pids.parent), label + ' [' + how + ']: parent fixture is alive before the kill');
    A.ok(pids && alive(pids.grandchild), label + ' [' + how + ']: grandchild fixture is alive before the kill');
    if (how === 'abort') ac.abort();
    await waitFor(() => pids && !alive(pids.parent) && !alive(pids.grandchild) && settled, 10000);
    A.eq(alive(pids && pids.parent), false, label + ' [' + how + ']: the command parent is dead');
    A.eq(alive(pids && pids.grandchild), false, label + ' [' + how + ']: the command GRANDCHILD is dead (no orphan)');
    A.eq(settled, true, label + ' [' + how + ']: the foreground call settles after the kill');
    if (settled) {
      const res = await runPromise;
      A.eq(how === 'timeout' ? res.timedOut : res.aborted, true, label + ' [' + how + ']: the result reports the ' + how);
      A.ok(Date.now() - t0 < 30000, label + ' [' + how + ']: settled promptly (the orphan did not hold the pipe open)');
    }
  } finally {
    if (pids) { await reap(pids.grandchild); await reap(pids.parent); }
    if (runPromise) await Promise.race([runPromise.catch(() => {}), delay(1000)]);
  }
}

// POSIX-only: the literal shape from the bug report — a shell job in the background, then `wait`
async function sleepWaitCase(label, run) {
  const t0 = Date.now();
  const res = await run('sleep 30 & echo "GRAND=$!"; wait', 1500, undefined);
  const m = /GRAND=(\d+)/.exec(res.out || '');
  const grand = m ? Number(m[1]) : 0;
  A.ok(grand > 1, label + ' [sleep&wait]: the shell reported its background sleep PID');
  A.eq(res.timedOut, true, label + ' [sleep&wait]: the call timed out');
  A.ok(Date.now() - t0 < 10000, label + ' [sleep&wait]: settled promptly, not after the 30s sleep');
  try {
    await waitFor(() => !alive(grand), 5000);
    A.eq(alive(grand), false, label + ' [sleep&wait]: the backgrounded `sleep 30` grandchild is dead');
  } finally { await reap(grand); }
}

/* Wiring, on EVERY OS (so a Windows dev box exercises the POSIX branch too): process.platform is pinned to
   'linux' and process.kill is stubbed — no real signal is ever sent — and a fake spawn records its options.
   Proves: POSIX spawns detached, a timeout/abort signals the GROUP (-pid) with SIGKILL, a group that can't be
   signalled falls back to the leader, and isWin keeps the taskkill path with no detached console. */
async function posixWiringCases() {
  const realKill = process.kill;
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const FAKE_PID = 987654;
  function fakeSpawn() {
    const spawn = function (a, b, c) {
      const o = (Array.isArray(b) ? c : b) || {};
      const h = {};
      const child = { pid: FAKE_PID, opts: o, file: a, killed: 0,
        stdout: { on() {} }, stderr: { on() {} },
        on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
        kill() { child.killed++; setTimeout(() => child._close(null), 5); },
        _close(code) { (h.close || []).forEach(f => f(code)); } };
      if (a === 'taskkill') { spawn.taskkill.push(b); setTimeout(() => { (h.close || []).forEach(f => f(0)); spawn.children[0]._close(1); }, 5); }
      else spawn.children.push(child);
      return child;
    };
    spawn.children = []; spawn.taskkill = [];
    return spawn;
  }
  const primitives = [
    ['runCommand', (spawn, isWin, signal, timeoutMs) => runCommand({ spawn, cmd: 'sleep 30 & wait', cwd: '.', timeoutMs, maxBytes: 64, signal, isWin })],
    ['runProcess', (spawn, isWin, signal, timeoutMs) => runProcess({ spawn, file: 'sleep 30 & wait', args: null, spawnOptions: { shell: true, windowsHide: true }, timeoutMs, signal, isWin })]
  ];
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    for (const [label, run] of primitives) {
      for (const how of ['timeout', 'abort']) {
        const calls = [];
        // ANY kill closes the fake child, so a regression (leader-only kill) settles and FAILS loudly instead of hanging
        process.kill = (pid, sig) => { calls.push([pid, sig]); setTimeout(() => spawn.children[0]._close(null), 5); return true; };
        const spawn = fakeSpawn();
        const ac = new AbortController();
        const p = run(spawn, false, ac.signal, how === 'timeout' ? 1000 : 60000);
        if (how === 'abort') setTimeout(() => ac.abort(), 10);
        const res = await p;
        A.eq(spawn.children[0].opts.detached, true, 'wiring ' + label + ' [' + how + ']: POSIX spawns the shell detached (its own process group)');
        A.eq(calls[0], [-FAKE_PID, 'SIGKILL'], 'wiring ' + label + ' [' + how + ']: the kill SIGKILLs the whole GROUP (-pid), not just the /bin/sh wrapper');
        A.eq(spawn.children[0].killed, 0, 'wiring ' + label + ' [' + how + ']: a group kill needs no leader fallback');
        A.eq(how === 'timeout' ? res.timedOut : res.aborted, true, 'wiring ' + label + ' [' + how + ']: result reports the ' + how);
      }
      // the group cannot be signalled (ESRCH) -> the old leader kill still happens
      {
        const calls = [];
        const spawn = fakeSpawn();
        process.kill = (pid, sig) => {
          calls.push([pid, sig]);
          if (pid === -FAKE_PID) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
          setTimeout(() => spawn.children[0]._close(null), 5); return true;
        };
        const res = await run(spawn, false, undefined, 1000);
        A.eq(calls.map(c => c[0]), [-FAKE_PID, FAKE_PID], 'wiring ' + label + ' [no group]: falls back to SIGKILL on the leader pid');
        A.eq(spawn.children[0].killed, 1, 'wiring ' + label + ' [no group]: and child.kill() on the leader');
        A.eq(res.timedOut, true, 'wiring ' + label + ' [no group]: still settles as timed out');
      }
      // isWin keeps taskkill /T and never spawns detached (a detached child opens a console on Windows)
      {
        const calls = [];
        process.kill = (pid, sig) => { calls.push([pid, sig]); return true; };
        const spawn = fakeSpawn();
        await run(spawn, true, undefined, 1000);
        A.ok(!spawn.children[0].opts.detached, 'wiring ' + label + ' [win]: never detached on Windows');
        A.eq(spawn.taskkill[0], ['/pid', String(FAKE_PID), '/T', '/F'], 'wiring ' + label + ' [win]: taskkill /T /F on the shell root');
        A.ok(!calls.some(c => c[0] < 0), 'wiring ' + label + ' [win]: no negative-pid group signal on Windows');
      }
    }
  } finally {
    process.kill = realKill;
    if (platformDesc) Object.defineProperty(process, 'platform', platformDesc);
  }
  A.eq(process.platform === 'win32', WIN, 'wiring: process.platform restored');
}

// a primitive that never settles drains the event loop and exits 0 with no report — that must read as a FAILURE
let reported = false;
process.on('exit', () => { if (!reported) { console.log('FAIL: shell.process-tree.test never finished (a foreground call did not settle)'); process.exitCode = 1; } });

(async () => {
  livenessCases();
  await posixWiringCases();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-shell-tree-'));
  try {
    const cases = [['runCommand', viaRunCommand(root)], ['environment.execute', viaEnvironment(root)]];
    for (const [label, run] of cases) {
      await nodeTreeCase(label, run, root, 'abort');
      await nodeTreeCase(label, run, root, 'timeout');
    }
    if (WIN) {
      A.ok(true, 'SKIP (win32): the POSIX `sleep 30 & wait` process-group case runs only on macOS/Linux (the Linux CI fast-gate covers it)');
    } else {
      for (const [label, run] of cases) await sleepWaitCase(label, run);
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  reported = true;
  A.report('shell.process-tree.test');
})().catch(e => { console.log('FAIL: shell.process-tree.test threw — ' + (e && e.stack || e)); process.exit(1); });
