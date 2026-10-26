'use strict';
/* test/helpers/fake-desktop-app.js — a stand-in for the StarNet desktop app, for test/cli-app-launch.e2e.test.js.

   It plays the app's part of the terminal-launch contract (src-tauri/src/terminal_session.rs) and nothing more:
   - every launch appends its argv to config.record;
   - the FIRST launch (it holds config.lockFile) brings the station up the way the app does — the REAL sidecar on
     the app's workspace, with the env the app injects from its keychain (config.keychain, never the terminal's own
     env) — and, once it answers, logs `spawn_sidecar pid=… port=… listening=true` to startup.log beside the workspace
     (unless config.logSpawn is false: then the station is one the app's log does not know);
   - a later launch while one runs hands its --terminal-pid to the first (config.joinFile — the single-instance
     plugin's job) and exits 0;
   - the first one runs while any terminal session it runs for is alive, then stops its sidecar and exits.
   Config: FAKE_APP_CONFIG names a JSON file { workspaces, record, joinFile, lockFile, keychain, logSpawn }. */
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

let first = false;
try { fs.writeFileSync(cfg.lockFile, String(process.pid), { flag: 'wx' }); first = true; } catch (_) {}
if (!first) {
  if (terminalPid) fs.appendFileSync(cfg.joinFile, terminalPid + '\n');
  process.exit(0);
}

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
    try { fs.unlinkSync(cfg.lockFile); } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  };
  sidecar.on('exit', stop);
  for (let i = 0; i < 240 && !(await healthy(port)); i++) await sleep(250);
  if (cfg.logSpawn !== false) fs.appendFileSync(path.join(path.dirname(cfg.workspaces), 'startup.log'), 'spawn_sidecar pid=' + sidecar.pid + ' port=' + port + ' listening=true\n');
  const sessions = new Set(terminalPid ? [terminalPid] : []);
  setInterval(() => {
    try { for (const l of fs.readFileSync(cfg.joinFile, 'utf8').split('\n')) if (Number(l)) sessions.add(Number(l)); } catch (_) {}
    for (const pid of Array.from(sessions)) if (!alive(pid)) sessions.delete(pid);
    if (!sessions.size) stop();
  }, 250);
})().catch(() => process.exit(1));
