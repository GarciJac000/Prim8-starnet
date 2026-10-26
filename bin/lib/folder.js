/* bin/lib/folder.js — the folder `starnet` was started in, as the station's trust sees it.

   A terminal session works where the person typed `starnet`: that folder's project (the nearest git root above it,
   else the folder itself, the same root the station's own path trust proposes) is the working folder of every
   message sent from it — once the station TRUSTS that project. Trust is the station's, never the CLI's: a project
   is trusted when GET /api/projects lists it blessed, and the person grants it with the same doorway the app's
   PROJECTS rail uses (POST /api/projects/bless — the key they press is the consent, as the rail's click is).

   locate() answers, for one folder:
     folder   the folder, its real path
     root     the project root the station would trust for it
     trusted  the station's own string for the trusted project root that holds it ('' when none does) — sent as the
              run's projectRoot, so it matches the grant exactly
     skip     why this folder is never offered for trust unasked: 'home' (your home folder), 'root' (a drive or
              filesystem root), 'system' (the OS's own folders), 'station' (inside StarNet's own workspaces) — a shell
              opens in these, and trusting one would hand the crew far more than a project. '' for a real project.
   Nothing here writes or grants anything. Pure apart from the fs reads it is handed. */
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

const MAX_WALK = 40;

function realOrSelf(p, fs) { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch (_) { return p; } }
function key(p, platform) { const s = String(p || '').replace(/[\\/]+$/, ''); return platform === 'win32' ? s.toLowerCase() : s; }
// is `child` the folder `parent` or inside it
function inside(child, parent, P, platform) {
  const c = key(child, platform), r = key(parent, platform);
  if (!r) return false;
  if (c === r) return true;
  const rel = P.relative(r, c);
  return !!rel && !rel.startsWith('..') && !P.isAbsolute(rel);
}

// the nearest folder at or above `dir` holding a .git (a file in a worktree, a folder elsewhere); else `dir`
function projectRoot(dir, deps) {
  const fs = (deps && deps.fs) || nodeFs, P = (deps && deps.path) || nodePath;
  let cur = dir;
  for (let i = 0; i < MAX_WALK; i++) {
    if (fs.existsSync(P.join(cur, '.git'))) return cur;
    const up = P.dirname(cur);
    if (!up || up === cur) break;
    cur = up;
  }
  return dir;
}

function skipReason(root, deps) {
  const d = deps || {};
  const P = d.path || nodePath, platform = d.platform || process.platform, env = d.env || process.env;
  const home = d.home != null ? d.home : os.homedir();
  if (P.parse(root).root && key(P.parse(root).root, platform) === key(root, platform)) return 'root';
  if (home && key(root, platform) === key(home, platform)) return 'home';
  const sys = platform === 'win32' ? [env.SystemRoot || env.windir || 'C:\\Windows', env.ProgramFiles, env['ProgramFiles(x86)']]
    : platform === 'darwin' ? ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc']
      : ['/usr', '/bin', '/sbin', '/etc', '/proc', '/sys', '/dev', '/boot', '/lib'];
  if (sys.some(s => s && inside(root, s, P, platform))) return 'system';
  if ((d.stationDirs || []).some(s => s && (inside(root, s, P, platform) || inside(s, root, P, platform)))) return 'station';
  return '';
}

// the deepest trusted project that holds `folder`, as the station spells it
function trustedRoot(folder, projects, deps) {
  const P = (deps && deps.path) || nodePath, platform = (deps && deps.platform) || process.platform;
  let best = '';
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || !p.blessed || typeof p.root !== 'string' || !p.root) continue;
    if (inside(folder, p.root, P, platform) && p.root.length > best.length) best = p.root;
  }
  return best;
}

/* locate({ cwd, projects, stationDirs }, deps) → { folder, root, trusted, skip } */
function locate(input, deps) {
  const i = input || {}, d = deps || {};
  const P = d.path || nodePath, fs = d.fs || nodeFs;
  const folder = realOrSelf(P.resolve(String(i.cwd || process.cwd())), fs);
  const root = projectRoot(folder, { fs, path: P });
  const trusted = trustedRoot(folder, i.projects, d);
  const skip = trusted ? '' : skipReason(root, Object.assign({}, d, { stationDirs: i.stationDirs || [] }));
  return { folder, root, trusted, skip };
}

// a folder in a few words: ~ for your home, the far end kept when it is long
function shortPath(p, max, deps) {
  const P = (deps && deps.path) || nodePath, platform = (deps && deps.platform) || process.platform;
  const home = deps && deps.home != null ? deps.home : os.homedir();
  let s = String(p || '');
  if (home && inside(s, home, P, platform)) s = '~' + s.slice(String(home).replace(/[\\/]+$/, '').length);
  const n = max || 48;
  if ([...s].length > n) s = '…' + [...s].slice(-(n - 1)).join('');
  return s;
}

// the station's trusted projects (an older station without the list → none)
async function trustedProjects(client) {
  const r = await client.request('GET', '/api/projects', null, { timeoutMs: 8000 });
  return (r.ok && r.status === 200 && r.json && Array.isArray(r.json.projects)) ? r.json.projects : [];
}
// a station on this machine: only there does a folder here mean the same folder to it
function isLocalHost(h) { return ['127.0.0.1', 'localhost', '::1', '[::1]'].indexOf(String(h || '').toLowerCase()) >= 0; }

module.exports = { locate, projectRoot, skipReason, trustedRoot, shortPath, trustedProjects, isLocalHost };
