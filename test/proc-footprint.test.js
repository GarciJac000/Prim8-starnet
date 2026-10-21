/* node test/proc-footprint.test.js — the attribution + validity rules of the whole-app idle measurement
   (scripts/lib/proc-footprint.mjs, 2026-10-20). The process table is copied from the shapes on the box the tools were
   built on: StarNet's tree beside SearchHost's and GoogleDriveFS's own WebView2 trees, which a name filter charged to
   StarNet. Also pins the PowerShell sampler to the same thresholds/patterns (it cannot import the module). */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const F = await import('../scripts/lib/proc-footprint.mjs');
  const T0 = '2026-10-20T08:00:00.000Z', later = s => new Date(Date.parse(T0) + s * 1000).toISOString();
  const WV = 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\155.0.4283.62\\msedgewebview2.exe';
  const UDD = '--user-data-dir="C:\\Users\\u\\AppData\\Local\\ai.skynet.harness\\EBWebView"';
  const rows = [
    { pid: 100, ppid: 4, name: 'skynet-desktop.exe', cmd: '"C:\\Users\\u\\AppData\\Local\\StarNet\\skynet-desktop.exe"', created: T0 },
    { pid: 101, ppid: 100, name: 'msedgewebview2.exe', cmd: `"${WV}" --embedded-browser-webview=1 --webview-exe-name=skynet-desktop.exe ${UDD} --noerrdialogs`, created: later(1) },
    { pid: 102, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=gpu-process --noerrdialogs ${UDD} --gpu-preferences=UAAAAAAAAADgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAA`, created: later(2) },
    { pid: 103, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=renderer --noerrdialogs ${UDD} --renderer-client-id=5`, created: later(2) },
    { pid: 104, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US ${UDD}`, created: later(2) },
    { pid: 105, ppid: 101, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=crashpad-handler ${UDD} /prefetch:4`, created: later(2) },
    { pid: 110, ppid: 100, name: 'node.exe', cmd: '"C:\\Users\\u\\AppData\\Local\\StarNet\\node.exe" "C:\\Users\\u\\AppData\\Local\\StarNet\\sidecar\\index.js"', created: later(1) },
    { pid: 111, ppid: 110, name: 'node.exe', cmd: 'node.exe C:\\mcp\\server.js', created: later(5) },
    { pid: 112, ppid: 110, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c "git status"', created: later(6) },
    { pid: 200, ppid: 4, name: 'SearchHost.exe', cmd: 'SearchHost.exe -ServerName:CortanaUI.AppX', created: T0 },
    { pid: 300, ppid: 4, name: 'GoogleDriveFS.exe', cmd: '"C:\\Program Files\\Google\\Drive File Stream\\GoogleDriveFS.exe"', created: T0 },
  ];
  // the two foreign WebView2 trees, same exe name, same shapes, different user-data-dirs
  for (const [root, base, udd] of [[200, 201, 'C:\\Users\\u\\AppData\\Local\\Packages\\MicrosoftWindows.Client.CBS\\LocalState\\EBWebView'], [300, 301, 'C:\\Users\\u\\AppData\\Local\\Google\\DriveFS\\cef']]) {
    rows.push({ pid: base, ppid: root, name: 'msedgewebview2.exe', cmd: `"${WV}" --user-data-dir="${udd}"`, created: later(1) });
    ['gpu-process', 'renderer', 'renderer', 'utility --utility-sub-type=network.mojom.NetworkService', 'crashpad-handler'].forEach((t, i) =>
      rows.push({ pid: base + 1 + i, ppid: base, name: 'msedgewebview2.exe', cmd: `"${WV}" --type=${t} --user-data-dir="${udd}"`, created: later(2) }));
  }

  // 1. the walk from the app's own pid: exactly StarNet's processes, none of the 2xx / 3xx WebView2 trees
  const tree = F.walkTree(rows, [100]);
  assert.deepEqual(tree.map(r => r.pid).sort((a, b) => a - b), [100, 101, 102, 103, 104, 105, 110, 111, 112]);
  assert.ok(!tree.some(r => r.pid >= 200), 'no foreign msedgewebview2 is charged to StarNet');
  assert.equal(rows.filter(r => r.name === 'msedgewebview2.exe').length, 17, 'a name filter would have charged 17 webview processes, 5 of them StarNet\'s');
  // pid reuse: an orphan whose dead parent's pid was handed to a NEWER process is not that process's child
  const reused = rows.concat([{ pid: 500, ppid: 110, name: 'old.exe', cmd: 'old.exe', created: '2026-10-19T00:00:00.000Z' }]);
  assert.ok(!F.walkTree(reused, [100]).some(r => r.pid === 500), 'a child born before its "parent" is a pid-reuse orphan');
  assert.deepEqual(F.walkTree(rows, [999]), [], 'a root that is not running walks nothing');
  assert.deepEqual(F.walkTree(rows, [102, 110]).map(r => r.pid).sort((a, b) => a - b), [102, 110, 111, 112], 'several roots');

  // 2. roles
  const role = pid => { const r = rows.find(x => x.pid === pid); return F.roleOf(r.name, r.cmd, { root: pid === 100 }); };
  assert.deepEqual([100, 101, 102, 103, 104, 105, 110, 111, 112].map(role),
    ['host', 'web-browser', 'web-gpu', 'web-renderer', 'web-util:network', 'web-crashpad', 'sidecar', 'node-child', 'shell']);
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --type=utility --utility-sub-type=storage.mojom.StorageService'), 'web-util:storage');
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --remote-debugging-port=9 --user-data-dir=C:\\x'), 'web-browser', 'the bench\'s Edge root is a browser, not a host');
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --type=gpu-process', { root: true }), 'web-gpu', 'a web process stays a web process at the root');
  assert.equal(F.roleOf('msedge.exe', 'msedge.exe --type=ppapi'), 'web-other:ppapi');
  assert.equal(F.roleOf('node.exe', 'node /repo/sidecar/index.js --idle-ab-run=x'), 'sidecar', 'forward slashes');
  assert.equal(F.roleOf('WerFault.exe', 'WerFault.exe -u'), 'other:werfault');

  // 3. the EBWebView identity check
  assert.equal(F.webviewIdentity(rows[1]).ok, true, 'the app\'s own browser child');
  const foreign = F.webviewIdentity(rows.find(r => r.pid === 201));
  assert.equal(foreign.ok, false, 'a browser child with a foreign user-data-dir is rejected');
  assert.match(foreign.reason, /ai\.skynet\.harness/);
  assert.equal(F.webviewIdentity(rows[1], { identifier: 'ai.skynet.harness.idlebench' }).ok, false, 'an isolated idlebench build must not match Andrew\'s identifier');
  const ovr = { cmd: 'msedgewebview2.exe --user-data-dir=D:\\scratch\\wv\\EBWebView' };
  assert.equal(F.webviewIdentity(ovr, { identifier: '', userDataFolder: 'D:/scratch/wv' }).ok, true, 'WEBVIEW2_USER_DATA_FOLDER override (+EBWebView leaf)');
  assert.equal(F.webviewIdentity({ cmd: 'msedgewebview2.exe' }).ok, false, 'no user-data-dir at all');

  // 4. GPU % = Task Manager's rule: per (adapter, engine type) sum, then the busiest type
  const L = 'luid_0x00000000_0x0000d1c2_phys_0';
  const g = F.gpuPct([
    { instance: `pid_102_${L}_eng_0_engtype_3D`, value: 12.5 },
    { instance: `pid_102_${L}_eng_7_engtype_3D`, value: 3.0 },
    { instance: `pid_102_${L}_eng_3_engtype_Copy`, value: 4 },
  ]);
  assert.equal(g.pct, 15.5);
  assert.equal(g.busiest, '0x00000000_0x0000d1c2|3d');
  const twoCards = F.gpuPct([
    { instance: 'pid_102_luid_0x00000000_0x0000d1c2_phys_0_eng_0_engtype_3D', value: 10 },
    { instance: 'pid_102_luid_0x00000000_0x00012ab0_phys_0_eng_0_engtype_3D', value: 9 },
  ]);
  assert.equal(twoCards.pct, 10, 'a 3D engine on one adapter never adds to the other adapter\'s');
  const byPid = F.gpuPctByPid([{ instance: `pid_102_${L}_eng_0_engtype_3D`, value: 7 }, { instance: `pid_201_${L}_eng_0_engtype_3D`, value: 50 }]);
  assert.equal(byPid[102].pct, 7); assert.equal(byPid[201].pct, 50);
  const mem = F.gpuMemByPid([{ instance: `pid_102_${L}`, path: '\\\\box\\gpu process memory(pid_102_' + L + ')\\dedicated usage', value: 23.5 * 1048576 },
    { instance: `pid_102_${L}`, path: '\\\\box\\gpu process memory(pid_102_' + L + ')\\shared usage', value: 2 * 1048576 }]);
  assert.deepEqual(mem[102], { dedicatedMB: 23.5, sharedMB: 2 });
  assert.equal(F.parseGpuInstance('not_a_gpu_instance'), null);

  // 5. CPU of one core
  assert.equal(F.cpuPctOneCore(30000, 60000), 50);
  assert.equal(F.cpuPctOneCore(5, 0), null);

  // 6. contention: the gate's 87.7% system CPU, or 0.26 GB free, is not a measurement
  assert.equal(F.preflight({ systemCpuPct: 87.7, cores: 16, freeGB: 8 }).contended, true);
  assert.equal(F.preflight({ systemCpuPct: 3, cores: 16, freeGB: 0.26 }).contended, true);
  const calm = F.preflight({ systemCpuPct: 9, treeCpuPctOneCore: 160, cores: 16, freeGB: 9 });
  assert.equal(calm.contended, false, 'our own tree is taken back out of the system CPU');
  assert.equal(calm.outsideCpuPct, -1);
  assert.equal(F.preflight({ systemCpuPct: 30, treeCpuPctOneCore: 160, cores: 16, freeGB: 9 }).contended, false, '30% system - 10% ours = 20%: the line itself is not over it');
  assert.equal(F.preflight({ systemCpuPct: 31, treeCpuPctOneCore: 160, cores: 16, freeGB: 9 }).contended, true, '31% - 10% ours = 21% outside: contended');
  assert.equal(F.preflight({ systemCpuPct: 5, cores: 16, freeGB: 9, forced: 'test gate running' }).contended, true, 'the operator can mark a run contended');

  // 7. a phase is labelled by what the page REPORTED, never by what the bench asked for
  const ok = { hasFocus: true, visibilityState: 'visible', vsyncMs: 1000 / 239.76, cameraMode: 'manual' };
  assert.equal(F.phaseValidity({ focus: 'focused', visibility: 'visible', hz: 239.76, camera: 'manual' }, ok).valid, true);
  const lie = F.phaseValidity({ focus: 'focused' }, { ...ok, hasFocus: false });
  assert.equal(lie.valid, false, 'focused with hasFocus false is INVALID');
  assert.match(lie.reasons[0], /hasFocus\(\) is false/);
  assert.equal(F.phaseValidity({ focus: 'focused' }, { ...ok, focusEmulated: true }).label, 'focused(emulated)');
  assert.equal(F.phaseValidity({ focus: 'unfocused' }, ok).valid, false, 'unfocused with hasFocus true is INVALID');
  assert.equal(F.phaseValidity({ focus: 'focused' }, [ok, { ...ok, hasFocus: false }]).valid, false, 'every observation must pass (window start and end)');
  assert.equal(F.phaseValidity({ hz: 239.76 }, { ...ok, vsyncMs: 1000 / 144 }).valid, false, 'a 144 Hz reading on the 239 Hz pass is INVALID');
  assert.equal(F.phaseValidity({ hz: 239 }, { ...ok, vsyncMs: 1000 / 239.76 }).valid, true, 'the integer Hz Windows reports is within 3%');
  assert.equal(F.phaseValidity({ visibility: 'hidden' }, ok).valid, false, 'a minimized phase must read hidden');
  assert.equal(F.phaseValidity({ camera: 'manual' }, { ...ok, cameraMode: 'auto' }).valid, false, 'the cinecam drifted the pinned camera');

  // 8. the verdict rule
  assert.equal(F.verdict([10, 11, 12], [5, 6, 7]).verdict, 'IMPROVED');
  assert.equal(F.verdict([10, 11, 12], [5, 6, 10.5]).verdict, 'NO VERDICT', 'overlapping ranges');
  assert.equal(F.verdict([10, 11], [5, 6]).verdict, 'NO VERDICT', 'n<3');
  assert.equal(F.verdict([10, 11, 12], [5, 6, 7], { contended: true }).verdict, 'NO VERDICT', 'a contended run');
  assert.equal(F.verdict([10, 11, 12], [13, 14, 15]).verdict, 'WORSE');
  assert.equal(F.verdict([10, 11, 12], [13, 14, 15], { lowerIsBetter: false }).verdict, 'IMPROVED');
  assert.deepEqual(F.stats([3, 1, 2, 10]), { n: 4, median: 2.5, min: 1, max: 10, mean: 4, p95: 10 });
  assert.equal(F.crossCheck(50, 46).ok, true); assert.equal(F.crossCheck(50, 40).ok, false); assert.equal(F.crossCheck(0.4, 1.5).ok, true, 'noise floor');

  // 9. summarize by role
  const sum = F.summarize([{ role: 'web-renderer', cpuPctOneCore: 30, privMB: 200 }, { role: 'web-renderer', cpuPctOneCore: 1, privMB: 50 }, { role: 'sidecar', cpuPctOneCore: 4, privMB: 120 }]);
  assert.deepEqual(sum.byRole['web-renderer'], { n: 2, cpuPctOneCore: 31, privMB: 250, wsMB: 0, gpuPct: 0, gpuDedMB: 0 });
  assert.equal(sum.total.cpuPctOneCore, 35); assert.equal(sum.total.privMB, 370);

  // 10. the hermetic sidecar env never carries the real profile or a provider key
  const base = { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\andro', APPDATA: 'C:\\Users\\andro\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\andro\\AppData\\Local',
    SKYNET_OPENROUTER_KEY: 'sk-or-real', ANTHROPIC_API_KEY: 'sk-ant-real', NODE_OPTIONS: '--require evil.js', HERMES_HOME: 'C:\\Users\\andro\\.hermes' };
  const runDir = path.join('C:', 'tmp', 'run1');
  const { env, dirs } = F.hermeticEnv({ baseEnv: base, runDir, ws: path.join(runDir, 'ws'), port: 41234 });
  for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TEMP', 'TMP', 'HERMES_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SKYNET_WORKSPACES', 'STARNET_WORKSPACES'])
    assert.ok(env[k].startsWith(runDir), k + ' lives inside the run dir (' + env[k] + ')');
  for (const k of ['SKYNET_OPENROUTER_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(env[k], undefined, k + ' never reaches the bench sidecar');
  assert.equal(env.PATH, 'C:\\bin'); assert.equal(env.SKYNET_DEV, '1'); assert.equal(env.STARNET_DEV, '1');
  assert.equal(env.SKYNET_PORT, '41234'); assert.equal(env.SKYNET_LIVE_PRICES, '0'); assert.equal(env.SKYNET_OPENROUTER_BASE, 'http://127.0.0.1:9/');
  assert.equal(dirs.length, 4); assert.ok(dirs.every(d => d.startsWith(runDir)));

  // 11. the PowerShell sampler keeps the same rules (it cannot import this module)
  const ps1 = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'perf', 'app-footprint.ps1'), 'utf8');
  assert.match(ps1, /\$ContendedCpuPct\s*=\s*20\b/); assert.match(ps1, /\$ContendedFreeGB\s*=\s*4\b/);
  for (const s of ['gpu-process', 'renderer', 'crashpad-handler', 'utility-sub-type', 'sidecar[\\\\/]+index\\.js', "'host'", 'PrivateMemorySize64', 'ParentProcessId'])
    assert.ok(ps1.includes(s), 'app-footprint.ps1 still carries ' + s);
  assert.ok(!/Stop-Process|taskkill|SetForegroundWindow|SetWindowPos/i.test(ps1.replace(/^\s*#.*$/gm, '')), 'the sampler is observe-only: no kill, no focus, no resize');

  // 12. the bench never loads a real profile or kills by name
  const bench = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'perf-idle-ab.mjs'), 'utf8');
  assert.ok(bench.includes('hermeticEnv(') && !/\.\.\.process\.env/.test(bench), 'the bench sidecar env is hermetic (never spreads process.env)');
  assert.ok(!/taskkill[^\n]*\/IM/i.test(bench) && !/Stop-Process\s+-Name/i.test(bench), 'teardown is by recorded pid, never by image name');
  assert.ok(!/getImageData|captureScreenshot/.test(bench), 'no screenshot or getImageData inside the bench');

  console.log('proc-footprint: tree walk from the app pid (no foreign webview, pid reuse refused), roles, EBWebView identity, GPU% per adapter+type, contention, phase labels, verdict, hermetic env, sampler/bench locks — OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
