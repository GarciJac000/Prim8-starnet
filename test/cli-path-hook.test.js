'use strict';
/* test/cli-path-hook.test.js — the Windows installer puts `starnet` on the user's PATH (src-tauri/installer/hooks.nsh,
   NSIS_HOOK_POSTINSTALL) and the uninstaller takes it off (NSIS_HOOK_POSTUNINSTALL). This runs THOSE EXACT PowerShell
   lines — read out of hooks.nsh, NSIS escapes undone the way NSIS undoes them — against a scratch registry key instead of
   HKCU\Environment, so the user's real PATH is never touched. Windows only (elsewhere it says so and passes).
   The install folder reaches PowerShell through the environment (set by the installer just before), never pasted into
   the command: a profile path with an apostrophe (C:\Users\O'Brien\...) broke a quoted PowerShell literal, the hook
   failed open, and `starnet` silently never reached PATH. So the folder here has one. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

if (process.platform !== 'win32') { console.log('cli-path-hook.test: Windows only — skipped'); process.exit(0); }
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const KEY = 'Software\\StarNetPathHookTest' + process.pid;
const DIR = 'C:\\Users\\O\'Brien\\AppData\\Local\\StarNet\\bin';
const INSTDIR = DIR.replace(/\\bin$/, '');
const nsh = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'installer', 'hooks.nsh'), 'utf8').split('\n');
/* Each hook's OWN environment: only what its macro sets (System::Call SetEnvironmentVariable) between its `!macro` line and
   the hook line. The uninstaller is a separate uninstall.exe that never inherits the installer's environment, so a hook
   that leaned on the other one's variable would find it empty, `exit`, and silently leave the PATH entry behind. */
function hookLine(tag) {
  const i = nsh.findIndex(l => l.trim() === '; ' + tag);
  A.ok(i >= 0, 'hooks.nsh carries the ' + tag + ' line');
  const m = /-Command "(.*)"'\s*$/.exec(nsh[i + 1] || '');
  A.ok(!!m, tag + ' runs one PowerShell -Command');
  const env = {};
  for (let j = i - 1; j >= 0 && !/^\s*!macro\s/.test(nsh[j]); j--) {
    const e = /SetEnvironmentVariable\(t "(\w+)", t "([^"]*)"\)/.exec(nsh[j]);
    if (e && !(e[1] in env)) env[e[1]] = e[2].replace(/\$INSTDIR/g, () => INSTDIR);
  }
  A.eq(env.STARNET_PATH_DIR, DIR, tag + ' sets its own STARNET_PATH_DIR (the bin folder) before it runs');
  // undo NSIS: $INSTDIR expands, $\' is a single quote, $$ is a dollar sign
  const ps = m[1].replace(/\$INSTDIR/g, () => INSTDIR).replace(/\$\\'/g, "'").replace(/\$\$/g, '$');
  A.ok(ps.indexOf("CreateSubKey('Environment')") >= 0, tag + ' edits HKCU\\Environment (the user PATH, never the machine one)');
  return { script: ps.replace("CreateSubKey('Environment')", "CreateSubKey('" + KEY + "')"), env };
}
const ADD = hookLine('STARNET_PATH_ADD'), REMOVE = hookLine('STARNET_PATH_REMOVE');
// a hook runs with ITS environment only (STARNET_PATH_DIR from this test's own process is cleared first)
function ps(script, hookEnv) {
  const env = Object.assign({}, process.env, { STARNET_PATH_DIR: '' }, hookEnv || {});
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error('powershell: ' + (r.stderr || r.stdout));
  return String(r.stdout || '').replace(/\r?\n$/, '');
}
const run = hook => ps(hook.script, hook.env);
const setPath = v => ps("$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('" + KEY + "'); $k.SetValue('Path', '" + v.replace(/'/g, "''") + "', [Microsoft.Win32.RegistryValueKind]::ExpandString)");
const getPath = () => ps("$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('" + KEY + "'); [string]$k.GetValueKind('Path') + '|' + $k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)");

try {
  const before = 'C:\\Tools;%USERPROFILE%\\bin';
  setPath(before);
  run(ADD);
  A.eq(getPath(), 'ExpandString|' + before + ';' + DIR, 'install: the bin folder joins the end of the user PATH, %USERPROFILE% left unexpanded, still REG_EXPAND_SZ');
  run(ADD);
  A.eq(getPath(), 'ExpandString|' + before + ';' + DIR, 'a reinstall or an update adds nothing twice');
  setPath(before + ';' + DIR.toUpperCase() + '\\');
  run(ADD);
  A.eq(getPath(), 'ExpandString|' + before + ';' + DIR.toUpperCase() + '\\', 'an entry already there in another case or with a trailing \\ counts as there');
  setPath(before + ';' + DIR);
  run(REMOVE);
  A.eq(getPath(), 'ExpandString|' + before, 'uninstall: the entry comes off, everything else stays as it was');
  run(REMOVE);
  A.eq(getPath(), 'ExpandString|' + before, 'uninstalling with nothing to remove changes nothing');
  const long = Array.from({ length: 60 }, (_, i) => 'C:\\Program Files\\Some Long Vendor Name\\Tool ' + i + '\\bin').join(';');
  setPath(long);
  run(ADD);
  A.eq(getPath(), 'ExpandString|' + long + ';' + DIR, 'a ' + long.length + '-character PATH survives whole (NSIS strings would have cut it at 1024)');
  ps("[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('" + KEY + "')");
  run(ADD);
  A.eq(getPath(), 'ExpandString|' + DIR, 'a user with no PATH value at all gets one holding just the bin folder');
} finally {
  try { ps("[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('" + KEY + "', $false)"); } catch (e) { console.warn('cleanup: ' + e.message); }
}
A.report('cli-path-hook.test');
