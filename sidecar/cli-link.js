/* sidecar/cli-link.js — TERMINAL MODE on macOS: put `starnet` where a terminal finds it.

   On Windows the installer's hooks put the app's bin folder on the user PATH (src-tauri/installer/hooks.nsh). A Mac app
   is dragged into Applications — there is no installer to touch PATH — so the PACKAGED app does it when it starts, the
   way Hermes's own installer does on macOS:
     ~/.local/bin/starnet  →  StarNet.app/Contents/Resources/bin/starnet         (a symlink)
     export PATH="$HOME/.local/bin:$PATH"  appended to ~/.zprofile               (only when no profile mentions it)
   Rules: a no-op off macOS and outside an app bundle (a checkout, a test sidecar, a CLI-spawned station); idempotent (a
   correct link and a profile that already has ~/.local/bin mean nothing to do); it never replaces a file it did not make
   (an existing ~/.local/bin/starnet that is not a StarNet.app link is left alone, and said so); a moved app's old link is
   re-pointed. STARNET_NO_CLI_LINK=1 turns it off. planCliLink is pure (the test drives it with a fake file system). */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARK = '# added by StarNet: the `starnet` terminal command';
const OURS = /StarNet[^/]*\.app\/Contents\/Resources\/bin\/starnet$/;
const PROFILES = ['.zprofile', '.zshrc', '.zlogin', '.bash_profile', '.bashrc', '.profile'];

/* o: { platform, execPath, home, env, exists(p) → bool, readlink(p) → string|null, readText(p) → string|null }
   → { skip } or { actions: [{ do: 'link'|'relink'|'profile', … }], said } */
function planCliLink(o) {
  if (o.platform !== 'darwin') return { skip: 'not macOS' };
  if (o.env && o.env.STARNET_NO_CLI_LINK === '1') return { skip: 'turned off (STARNET_NO_CLI_LINK=1)' };
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(o.execPath || ''));
  if (!m) return { skip: 'not running from an app bundle' };
  const target = m[1] + '/Contents/Resources/bin/starnet';
  if (!o.exists(target)) return { skip: 'this app carries no starnet command' };
  if (!o.home) return { skip: 'no home folder' };
  const dir = path.posix.join(o.home, '.local', 'bin'), link = path.posix.join(dir, 'starnet');
  const actions = [];
  const cur = o.readlink(link);
  if (cur === target) { /* already ours, and current */ }
  else if (cur !== null && OURS.test(cur)) actions.push({ do: 'relink', dir, link, target, was: cur });   // the app moved
  else if (cur !== null || o.exists(link)) return { skip: link + ' already exists and is not StarNet\'s — left alone' };
  else actions.push({ do: 'link', dir, link, target });
  // the folder on PATH: a login shell that reads any profile mentioning ~/.local/bin already has it
  const mentions = PROFILES.some(f => { const t = o.readText(path.posix.join(o.home, f)); return t !== null && /\.local\/bin/.test(t); });
  if (!mentions) actions.push({ do: 'profile', file: path.posix.join(o.home, '.zprofile'), text: '\n' + MARK + '\nexport PATH="$HOME/.local/bin:$PATH"\n' });
  if (!actions.length) return { actions, said: '' };
  return { actions, said: 'terminal mode: `starnet` ' + (actions.some(a => a.do === 'relink') ? 're-linked' : actions.some(a => a.do === 'link') ? 'linked' : 'kept') + ' in ~/.local/bin' + (actions.some(a => a.do === 'profile') ? ', and ~/.local/bin added to PATH in ~/.zprofile (new terminals)' : '') };
}

function applyCliLink(plan, f) {
  const fsx = f || fs;
  for (const a of plan.actions || []) {
    if (a.do === 'link' || a.do === 'relink') {
      fsx.mkdirSync(a.dir, { recursive: true });
      if (a.do === 'relink') fsx.unlinkSync(a.link);
      fsx.symlinkSync(a.target, a.link);
    } else if (a.do === 'profile') fsx.appendFileSync(a.file, a.text);
  }
  return plan;
}

// the real thing, at boot: plan against this machine and apply. Returns the plan (its `said` is the one boot line).
function ensureCliLink(env) {
  const plan = planCliLink({
    platform: process.platform, execPath: process.execPath, home: os.homedir(), env: env || process.env,
    exists: p => fs.existsSync(p),
    readlink: p => { try { return fs.readlinkSync(p); } catch (_) { return null; } },   // no link (or not a link) → null
    readText: p => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }   // no profile → null
  });
  if (plan.skip) return plan;
  return applyCliLink(plan);
}

module.exports = { planCliLink, applyCliLink, ensureCliLink, MARK };
