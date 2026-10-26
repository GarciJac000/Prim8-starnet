/* node test/cli-app-launch.e2e.test.js — `starnet` with the StarNet app CLOSED starts it in the background and
   attaches to the station it brings up, end to end against a REAL sidecar.

   The app keeps the station's keys in the OS keychain and hands them only to the sidecar it spawns, so the terminal
   never boots that station itself: it launches the app (`--background --terminal-pid <its pid>`, window parked) and
   attaches. The app here is a stand-in (test/helpers/fake-desktop-app.js) playing exactly the app's part of that
   contract (src-tauri/src/terminal_session.rs): the REAL sidecar on the app's workspace with the keychain env the app
   injects, `spawn_sidecar pid=… port=…` in startup.log, a second launch handing its pid to the first. The terminal's
   env carries NO key — the mock model seeing the app's key on every call is the proof the station runs on the app's.
   Hermetic profile throughout (APPDATA / XDG_DATA_HOME / HOME → a temp dir); a content-driven mock model, ZERO spend.

   Locks:
     1. LAUNCH: app closed → `starnet -p` launches the app with --background --terminal-pid <its own pid>, says so,
        attaches to the station it brings up, and the answer streams to stdout (exit 0). The terminal boots nothing.
     2. the app is not the terminal's child: the CLI exits at once after its run (detached, unref'd) and the app is
        left to see the terminal gone — the stand-in then stops, as the real app's watch_terminal_sessions does;
     3. JOIN: a second terminal attaching to the app's running station sends the same launch with ITS pid (so the
        first session ending never closes the station under it), and starts nothing;
     4. a station some other terminal booted on that workspace (the app's startup.log does not know its pid) is
        never joined — launching an app there would fight that station for its workspace.
   Part of test:http (it boots sidecars). */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const core = require('../bin/lib/cli-core.js');
const { discoverDesktop } = require('../bin/starnet.js');

const BIN = path.resolve(__dirname, '..', 'bin', 'starnet.js');
const FAKE_APP = path.resolve(__dirname, 'helpers', 'fake-desktop-app.js');
const APP_KEY = 'sk-or-v1-from-the-app-keychain';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function portAnswers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
// a content-driven mock OpenRouter (test/cli.e2e.test.js's shape) that also records the key every call carried
function startMockModel() {
  const auths = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        auths.push(String(req.headers.authorization || ''));
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let msgs = []; try { msgs = JSON.parse(body).messages || []; } catch (_) {}
          const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
          const text = /say hello/i.test(String((lastUser && lastUser.content) || '')) ? 'Hello from the app\'s station.' : 'nothing to do';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, auths, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}
function cli(args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.on('exit', code => { clearTimeout(t); resolve({ code, out, err, pid: child.pid }); });
  });
}
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return !!fn(); }
function healthy(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
const tail = s => s.trim().split('\n').slice(-4).join(' | ');

(async () => {
  if (await portAnswers(core.DEFAULT_PORT)) { console.log('cli-app-launch.e2e.test: something answers on 127.0.0.1:' + core.DEFAULT_PORT + ' (it would be attached first) — skipped'); process.exit(0); }
  const mock = await startMockModel();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-app-launch-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-app-launch-run-'));
  const appData = process.platform === 'darwin' ? path.join(profile, 'Library', 'Application Support', 'ai.skynet.harness') : path.join(profile, 'ai.skynet.harness');
  const ws = path.join(appData, 'workspaces');
  const cfgFile = path.join(scratch, 'app.json');
  const record = path.join(scratch, 'launches.ndjson');
  const joinFile = path.join(scratch, 'joins.txt');
  const lockFile = path.join(scratch, 'app.lock');
  const stateFile = path.join(scratch, 'app.state');
  const terminals = [];
  const writeCfg = extra => fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({
    workspaces: ws, record, joinFile, lockFile, stateFile, logSpawn: true, closeMs: 0,
    // what the app injects from its keychain: the terminal's own env below carries none of it
    keychain: { SKYNET_OPENROUTER_KEY: APP_KEY, STARNET_OPENROUTER_KEY: APP_KEY, SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base, SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model' }
  }, extra || {})));
  const launches = () => { try { return fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  const ownerPid = () => { try { return Number(JSON.parse(fs.readFileSync(path.join(ws, '.starnet-workspace-owner.json'), 'utf8')).pid) || 0; } catch (_) { return 0; } };
  const appRunning = () => fs.existsSync(lockFile);
  // a terminal session the test holds open (the one that "started" the app in 3 and 4)
  const terminal = () => { const t = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); terminals.push(t); return t; };
  const startApp = forPid => { const c = spawn(process.execPath, [FAKE_APP, '--background', '--terminal-pid', String(forPid)], { env, detached: true, stdio: 'ignore' }); c.unref(); };
  // the app's station answering on the port the OS names for its owner (and, `logged`, in the app's startup.log)
  async function stationUp(logged) {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const d = discoverDesktop(ws);
      if (d.ownerAlive && d.port && await healthy(d.port)) {
        if (!logged) return true;
        const rec = core.parseStartupLog(fs.readFileSync(path.join(appData, 'startup.log'), 'utf8'));
        if (rec && rec.pid === d.ownerPid) return true;
      }
      await sleep(250);
    }
    return false;
  }
  const env = Object.assign({}, process.env, {
    APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile,
    STARNET_PORT: '', SKYNET_PORT: '', STARNET_WORKSPACES: '', SKYNET_WORKSPACES: '', STARNET_TOKEN: '', STARNET_API_TOKEN: '', SKYNET_API_TOKEN: '',
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    STARNET_APP_EXE: FAKE_APP, FAKE_APP_CONFIG: cfgFile
  });
  if (process.platform !== 'win32') env.HOME = profile;
  try {
    // the app's station: one agent on the mock model, and the log of an app that has run here (and is closed now)
    fs.mkdirSync(ws, { recursive: true });
    const docs = core.bootstrapDocs({ name: 'ULTRON', model: 'test/model', provider: 'openrouter', now: Date.now() });
    fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify(docs.roster, null, 2));
    fs.writeFileSync(path.join(ws, 'agent.save.json'), JSON.stringify(docs.save, null, 2));
    fs.writeFileSync(path.join(appData, 'startup.log'), 'startup exe=Ok("' + path.join(profile, 'old', 'skynet-desktop.exe').replace(/\\/g, '\\\\') + '") port=1\n');
    writeCfg();

    /* ---- 1 + 2. LAUNCH: the app is closed ---------------------------------------------------------------- */
    const r = await cli(['-p', 'say hello'], env, 150000);
    A.eq(r.code, 0, 'app closed: `starnet -p` still runs, exit 0 (stderr: ' + tail(r.err) + ')');
    A.ok(r.out.indexOf('Hello from the app\'s station.') >= 0, 'the answer streamed to stdout: ' + JSON.stringify(r.out));
    A.ok(/StarNet isn't running — starting it in the background/.test(r.err), 'it says it is starting StarNet in the background');
    A.ok(!/booting a station/.test(r.err) && !/open the StarNet app/i.test(r.err), 'the terminal booted no station of its own, and never said to open the app');
    A.ok(/▸ .*attached http:\/\/127\.0\.0\.1:/.test(r.err), 'it attached to the station the app brought up');
    const first = launches();
    A.eq(first.length, 1, 'the app was launched once');
    A.eq(JSON.stringify(first[0]), JSON.stringify(['--background', '--terminal-pid', String(r.pid)]), 'with --background and the terminal\'s own pid: ' + JSON.stringify(first[0]));
    A.ok(mock.auths.length > 0 && mock.auths.every(a => a === 'Bearer ' + APP_KEY), 'every model call carried the APP\'s key (the terminal had none): ' + JSON.stringify(Array.from(new Set(mock.auths))));
    A.ok(await waitFor(() => !appRunning(), 20000), 'the CLI left the app to itself: with the terminal gone, the app stopped its station');
    A.ok(await waitFor(() => !alive(ownerPid()), 10000), '…and that station is down, nothing left running');

    /* ---- 3. JOIN: the app is running for another terminal session --------------------------------------- */
    fs.writeFileSync(joinFile, '');
    const t1 = terminal();
    startApp(t1.pid);
    A.ok(await stationUp(true), 'the app (started for another terminal) brought its station up');
    const before = launches().length;
    const j = await cli(['-p', 'say hello'], env, 120000);
    A.eq(j.code, 0, 'a second terminal attaches and runs, exit 0 (stderr: ' + tail(j.err) + ')');
    A.ok(j.out.indexOf('Hello from the app\'s station.') >= 0, 'its answer streamed');
    A.ok(!/starting it in the background/.test(j.err), 'it started nothing: StarNet was already running');
    const joined = launches().slice(before);
    A.eq(joined.length, 1, 'it told the app once that this terminal uses it too');
    A.eq(JSON.stringify(joined[0]), JSON.stringify(['--background', '--terminal-pid', String(j.pid)]), '…with its own pid: ' + JSON.stringify(joined[0]));
    A.ok(await waitFor(() => fs.readFileSync(joinFile, 'utf8').split('\n').indexOf(String(j.pid)) >= 0, 5000), '…and that reached the running app');
    t1.kill();
    A.ok(await waitFor(() => !appRunning(), 20000), 'every terminal gone: the app stood down');

    /* ---- 4. a station the app's log does not know is never joined ---------------------------------------- */
    fs.writeFileSync(joinFile, '');
    writeCfg({ logSpawn: false });
    const t2 = terminal();
    startApp(t2.pid);
    A.ok(await stationUp(false), 'a station is up on the app\'s workspace');
    const before4 = launches().length;
    const k = await cli(['-p', 'say hello'], env, 120000);
    A.eq(k.code, 0, 'the terminal attaches to it and runs (stderr: ' + tail(k.err) + ')');
    A.eq(launches().length, before4, 'but launches no app: the app\'s startup.log does not know that station\'s pid');
    t2.kill();
    A.ok(await waitFor(() => !appRunning(), 20000), 'cleanup: that station stood down too');

    /* ---- 5. CLOSING: a terminal that attaches while the app closes (its last session just ended) starts it again --- */
    fs.writeFileSync(joinFile, '');
    writeCfg({ closeMs: 6000 });
    const t3 = terminal();
    startApp(t3.pid);
    A.ok(await stationUp(true), 'the app (started for another terminal) brought its station up');
    const oldOwner = ownerPid();
    t3.kill();
    A.ok(await waitFor(() => { try { return fs.readFileSync(stateFile, 'utf8').trim() === 'closing'; } catch (_) { return false; } }, 10000), 'that terminal left: the app is closing (its station still up for a moment)');
    const before5 = launches().length;
    const z = await cli(['-p', 'say hello'], env, 150000);
    A.eq(z.code, 0, 'a terminal arriving while it closes still runs, exit 0 (stderr: ' + tail(z.err) + ')');
    A.ok(z.out.indexOf('Hello from the app\'s station.') >= 0, 'its answer streamed');
    A.ok(/StarNet is closing \(its last starnet session just ended\) — starting it again/.test(z.err), 'it was told StarNet was closing and said it starts it again');
    const mine = launches().slice(before5).filter(l => l[2] === String(z.pid));
    A.ok(mine.length >= 2, 'it joined, then launched StarNet again (' + mine.length + ' launches with its pid)');
    A.ok(ownerPid() !== oldOwner, 'and ran on a NEW station, never the closing one');
    A.ok(await waitFor(() => !appRunning(), 20000), 'cleanup: with that terminal gone too, the new StarNet stood down');
  } catch (e) {
    A.ok(false, 'threw: ' + ((e && e.stack) || e));
  } finally {
    for (const t of terminals) { try { t.kill(); } catch (_) {} }
    try { const p = Number(fs.readFileSync(lockFile, 'utf8')); if (p) process.kill(p); } catch (_) {}
    try { const p = ownerPid(); if (p && alive(p)) process.kill(p); } catch (_) {}
    await sleep(800);
    try { mock.server.close(); } catch (_) {}
    for (const d of [profile, scratch]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
  A.report('cli-app-launch.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
