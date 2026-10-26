'use strict';
/* test/helpers/fake-desktop-app.js — a stand-in for the StarNet desktop app, for test/cli-app-launch.e2e.test.js.

   It plays the app's part of the terminal-launch contract (src-tauri/src/terminal_session.rs + main.rs) and nothing
   more:
   - every launch appends its argv to config.record;
   - the FIRST launch (it holds config.lockFile) brings the station up the way the app does — the REAL sidecar on
     the app's workspace, with the env the app injects from its keychain (config.keychain, never the terminal's own
     env) — logs `startup: started by starnet (--background, terminal pid N)` and, once the station answers,
     `spawn_sidecar pid=… port=… listening=true` to startup.log beside the workspace (unless config.logSpawn is
     false: then the station is one the app's log does not know);
   - a later launch while one runs hands its --terminal-pid to the first (config.joinFile — the single-instance
     plugin's job) and logs the app's join line for that pid: it joins, or, while the first one is closing, it was
     told StarNet is closing (start it again once it has quit). Then it exits 0;
   - the first one runs while any terminal session it runs for is alive. When none is left it is CLOSING for
     config.closeMs (default 0: at once) — its station still up, joins told so — then stops its sidecar and exits.
   Config: FAKE_APP_CONFIG names a JSON file { workspaces, record, joinFile, lockFile, stateFile, keychain, logSpawn,
   closeMs }. */
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_APP_CONFIG, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(cfg.record, JSON.stringify(args) + '\n');
const at = args.indexOf('--terminal-pid');
const terminalPid = at >= 0 ? Number(args[at + 1]) || 0 : 0;
const startupLog = path.join(path.dirname(cfg.workspaces), 'startup.log');
const logLine = s => fs.appendFileSync(startupLog, s + '\n');
const state = () => { try { return fs.readFileSync(cfg.stateFile, 'utf8').trim(); } catch (_) { return ''; } };

let first = false;
try { fs.writeFileSync(cfg.lockFile, String(process.pid), { flag: 'wx' }); first = true; } catch (_) {}
if (!first) {
  if (terminalPid && state() === 'closing') {
    logLine('second-launch --background: starnet session pid ' + terminalPid + ' arrived while StarNet is closing (its starnet sessions ended); start StarNet again once it has quit');
  } else if (terminalPid) {
    fs.appendFileSync(cfg.joinFile, terminalPid + '\n');
    logLine('second-launch --background: starnet session pid ' + terminalPid + ' joins the station the terminal started');
  }
  process.exit(0);
}
fs.writeFileSync(cfg.stateFile, 'starting');
if (terminalPid) logLine('startup: started by starnet (--background, terminal pid ' + terminalPid + ') — the station runs with the app\'s keys; the window stays parked until someone opens StarNet');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function healthy(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  const port = await freePort();
  const sidecar = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'sidecar', 'index.js')], {
    env: Object.assign({}, process.env, cfg.keychain || {}, {
      SKYNET_PORT: String(port), STARNET_PORT: String(port),
      SKYNET_WORKSPACES: cfg.workspaces, STARNET_WORKSPACES: cfg.workspaces
    }),
    stdio: 'ignore'
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { sidecar.kill(); } catch (_) {}
    try { fs.unlinkSync(cfg.stateFile); } catch (_) {}
    try { fs.unlinkSync(cfg.lockFile); } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  };
  sidecar.on('exit', stop);
  for (let i = 0; i < 240 && !(await healthy(port)); i++) await sleep(250);
  if (cfg.logSpawn !== false) logLine('spawn_sidecar pid=' + sidecar.pid + ' port=' + port + ' listening=true');
  fs.writeFileSync(cfg.stateFile, 'running');
  const sessions = new Set(terminalPid ? [terminalPid] : []);
  let closingSince = 0;
  setInterval(() => {
    if (closingSince) { if (Date.now() - closingSince >= (Number(cfg.closeMs) || 0)) stop(); return; }
    try { for (const l of fs.readFileSync(cfg.joinFile, 'utf8').split('\n')) if (Number(l)) sessions.add(Number(l)); } catch (_) {}
    for (const pid of Array.from(sessions)) if (!alive(pid)) sessions.delete(pid);
    if (!sessions.size) {
      closingSince = Date.now();
      fs.writeFileSync(cfg.stateFile, 'closing');
      logLine('terminal-done: every starnet session it ran for has ended; deciding as a window close');
      if (!(Number(cfg.closeMs) > 0)) stop();
    }
  }, 250);
})().catch(() => process.exit(1));
