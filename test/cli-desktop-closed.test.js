'use strict';
/* test/cli-desktop-closed.test.js — `starnet` with the desktop app CLOSED never boots the app's station without it.

   The desktop app keeps a user's provider keys, key pools, bot tokens and StarNet credits token in the OS keychain and
   hands them only to the sidecar IT spawns. A station the terminal boots on the app's workspace would be a keyless
   second copy of the real one: every BYOK agent fails, bots stay offline, routines fire and fail. So when the app's
   workspace holds a station the app has run (its startup.log is beside it) and no live owner holds it, `starnet`
   refuses — exit 3, "open the StarNet app" — and writes nothing there. This runs the REAL bin/starnet.js as a shell
   would, against a scratch profile (APPDATA / XDG_DATA_HOME / HOME → a temp dir), so no real station is ever seen.
   A terminal-only station (no desktop app ever ran there) and an operator-named --workspace still boot: covered by
   test/cli.test.js (chooseStation) and test/cli.e2e.test.js (--spawn --workspace). */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const A = require('./_assert.js');

const BIN = path.resolve(__dirname, '..', 'bin', 'starnet.js');

function portAnswers(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
function cli(args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.on('exit', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

(async () => {
  if (await portAnswers(8787)) { console.log('cli-desktop-closed.test: something answers on 127.0.0.1:8787 (a running `npm start` would be attached first) — skipped'); process.exit(0); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-closed-app-'));
  try {
    const env = Object.assign({}, process.env, {
      APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile,
      STARNET_PORT: '', SKYNET_PORT: '', STARNET_WORKSPACES: '', SKYNET_WORKSPACES: '', STARNET_TOKEN: '', STARNET_API_TOKEN: '', SKYNET_API_TOKEN: ''
    });
    if (process.platform !== 'win32') env.HOME = profile;
    const appData = process.platform === 'darwin' ? path.join(profile, 'Library', 'Application Support', 'ai.skynet.harness')
      : path.join(profile, 'ai.skynet.harness');
    const ws = path.join(appData, 'workspaces');
    fs.mkdirSync(ws, { recursive: true });
    const save = JSON.stringify({ version: 1, agents: [{ agentId: 'agent', name: 'ULTRON' }] });
    fs.writeFileSync(path.join(ws, 'agent.save.json'), save);
    fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify({ agents: [{ agentId: 'agent', name: 'ULTRON' }] }));
    fs.writeFileSync(path.join(appData, 'startup.log'), 'spawn_sidecar pid=999999 port=1 listening=true\n');
    // the owner claim of an app that has quit: a pid that is not alive
    fs.writeFileSync(path.join(ws, '.starnet-workspace-owner.json'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    const before = fs.readdirSync(ws).sort().join(',');

    const r = await cli(['-p', 'say hello', '--timeout', '5'], env, 60000);
    A.eq(r.code, 3, 'exit 3 (no station): the terminal does not boot the app\'s station while the app is closed (stderr: ' + r.err.trim().split('\n').slice(-3).join(' | ') + ')');
    A.ok(/open the StarNet app/i.test(r.err) && /keys/i.test(r.err), 'it says to open the StarNet app, which holds the keys');
    A.ok(!/booting a station/.test(r.err), 'no station was booted');
    A.eq(r.out, '', 'nothing on stdout');
    A.eq(fs.readdirSync(ws).sort().join(','), before, 'nothing was written into the app\'s workspace');
    A.eq(fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8'), save, 'the save is untouched');

    // --spawn alone boots the DEFAULT workspace — which is this same station — so it is refused too, naming --workspace
    const f = await cli(['--spawn', '-p', 'say hello', '--timeout', '5'], env, 60000);
    A.eq(f.code, 3, '--spawn: exit 3, the app\'s station is not booted keyless either (stderr: ' + f.err.trim().split('\n').slice(-3).join(' | ') + ')');
    A.ok(/open the StarNet app/i.test(f.err) && /--workspace <dir>/.test(f.err), '--spawn: it says to open the app, or to name a separate --workspace');
    A.ok(!/booting a station/.test(f.err), '--spawn: no station was booted');
    A.eq(fs.readdirSync(ws).sort().join(','), before, '--spawn: nothing was written into the app\'s workspace');

    const d = await cli(['status'], env, 30000);
    A.eq(d.code, 3, 'status: exit 3, no station reachable');
    A.ok(/open the StarNet app/i.test(d.err) && !/to boot one/.test(d.err), 'status says to open the app, never to boot the station from the terminal (' + d.err.trim() + ')');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  A.report('cli-desktop-closed.test');
})().catch(e => { console.error(e); process.exit(1); });
