'use strict';
/* test/cli-bootstrap-lineage.test.js — a headless `starnet -p` / `starnet init` never sets a new station up over a prior one.

   On an empty station the CLI writes a one-agent save + roster so a headless run has an agent (bootstrapWorkspace). The
   app shows Recovery Mode (PRIOR STATION DATA FOUND) only while there is NO save — so a CLI save written into the app's
   workspace while the user's real station sat in a legacy root, an update snapshot or a pending migration made the app
   resume the CLI's empty station and never offer the prior one. The dashboard already refused that case; the headless
   bootstrap now reads the SAME lineage evidence the sidecar's gate reads (sidecar/workspace-lineage.js) and refuses with
   the dashboard's words, writing nothing. A workspace the operator NAMED (--workspace) is a separate station by choice
   and still boots. Scratch dirs only: the profile roots (APPDATA / LOCALAPPDATA / XDG / home) all point into a temp dir. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cli-lineage-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
// os.homedir() reads these: the legacy-root scan must never see the real profile
process.env.HOME = home; process.env.USERPROFILE = home;
const { bootstrapWorkspace, desktopWorkspaces } = require('../bin/starnet.js');

let n = 0;
function scratch() {
  const p = path.join(root, 'p' + (++n));
  const env = { LOCALAPPDATA: path.join(p, 'local'), APPDATA: path.join(p, 'roaming'), XDG_DATA_HOME: path.join(p, 'xdg') };
  const ws = path.join(env.APPDATA, 'ai.skynet.harness', 'workspaces');
  fs.mkdirSync(ws, { recursive: true });
  return { env, ws };
}
const opts = { name: 'OVERSEER', model: 'test/model', provider: 'openrouter' };
const wrote = ws => ['agent.save.json', 'agent.roster.json'].filter(f => fs.existsSync(path.join(ws, f)));

try {
  {
    const s = scratch();
    const r = bootstrapWorkspace(s.ws, opts, s.env);
    A.ok(r.wrote, 'a clean machine: the headless bootstrap writes its one-agent station');
    A.eq(wrote(s.ws).length, 2, '…save and roster');
  }
  {
    const s = scratch();
    const snaps = path.join(path.dirname(s.ws), 'update-snapshots');
    fs.mkdirSync(snaps, { recursive: true });
    fs.writeFileSync(path.join(snaps, '20261001.starnet-backup.json'), '{}');
    const r = bootstrapWorkspace(s.ws, opts, s.env);
    A.ok(!r.wrote && r.refused, 'an update snapshot of a prior station: refused');
    A.ok(/open the StarNet app to recover it/.test(r.reason || ''), 'with the dashboard\'s words: ' + r.reason);
    A.eq(wrote(s.ws), [], 'and nothing written into the app\'s workspace');
  }
  {
    const s = scratch();
    const legacy = path.join(s.env.LOCALAPPDATA, 'Skynet', 'workspaces');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'agent.save.json'), '{}');
    const r = bootstrapWorkspace(s.ws, opts, s.env);
    A.ok(!r.wrote && r.refused, 'a station in a legacy root (pre-rebrand Skynet folder): refused');
    A.eq(wrote(s.ws), [], 'nothing written');
  }
  {
    const s = scratch();
    fs.writeFileSync(path.join(s.ws, '.migration-pending'), '');
    const r = bootstrapWorkspace(s.ws, opts, s.env);
    A.ok(!r.wrote && r.refused, 'a migration still pending in the app\'s workspace: refused');
    A.eq(wrote(s.ws), [], 'nothing written');
  }
  {
    const s = scratch();
    fs.writeFileSync(path.join(s.ws, 'transcript.jsonl'), '{}\n');
    const r = bootstrapWorkspace(s.ws, opts, s.env);
    A.ok(!r.wrote && r.refused, 'station state with its save gone (a transcript, no save): refused — the app\'s gate owns that');
  }
  {
    const s = scratch();
    const snaps = path.join(path.dirname(s.ws), 'update-snapshots');
    fs.mkdirSync(snaps, { recursive: true });
    fs.writeFileSync(path.join(snaps, '20261001.starnet-backup.json'), '{}');
    const named = path.join(root, 'named-ws');
    const r = bootstrapWorkspace(named, Object.assign({ workspace: named }, opts), s.env);
    A.ok(r.wrote, 'a workspace the operator named (--workspace) is a separate station by choice: it still boots');
  }
  // the real command, as a shell runs it: `starnet init` on a machine whose prior station sits in an update snapshot.
  // The snapshot goes beside the workspace the CLI itself picks on THIS OS (APPDATA on Windows, XDG_DATA_HOME on Linux,
  // ~/Library/Application Support on macOS) — the release gate runs this on Linux.
  {
    const s = scratch();
    const cliWs = desktopWorkspaces(s.env);
    const snaps = path.join(path.dirname(cliWs), 'update-snapshots');
    fs.mkdirSync(snaps, { recursive: true });
    fs.writeFileSync(path.join(snaps, '20261001.starnet-backup.json'), '{}');
    const env = Object.assign({}, process.env, s.env, { HOME: home, USERPROFILE: home, STARNET_WORKSPACES: '', SKYNET_WORKSPACES: '', STARNET_DEV: '', SKYNET_DEV: '' });
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'starnet.js'), 'init', '--model', 'test/model'], { env, encoding: 'utf8', timeout: 60000 });
    A.eq(r.status, 3, '`starnet init` over a prior station exits 3 (' + String(r.stderr).trim() + ')');
    A.ok(/open the StarNet app to recover it/.test(r.stderr), 'and says to open the app to recover it');
    A.ok(String(r.stderr).indexOf(cliWs) >= 0, 'about the workspace the app uses on this OS: ' + cliWs);
    A.eq(wrote(cliWs), [], 'nothing written');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('cli-bootstrap-lineage.test');
