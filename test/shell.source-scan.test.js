/* node test/shell.source-scan.test.js — the shell safety floor's referenced-script scan keeps TRUNK's verdicts
   (2026-10-20, 10-21).

   commandSourceEntries queues the text of every script a command names and lexes each queued source whole, as a
   command line in the OUTER dialect, a referenced .js/.mjs/.py file included (`node sidecar/tools/builtin/browser.js`
   lexes ~5,700 fake heads out of JavaScript, ~7-10 ms of synchronous work per check). Three attempts to make that
   cheaper changed what the floor refuses: lexing code files by launch line only, then lexing shell files only in
   their own dialect, let through commands trunk refused; adding heads on top of trunk's lexing put duplicate
   entries into the 30-source queue and pushed a script trunk scanned past the cap. That work was dropped and the
   scan is trunk's again. These fixtures pin trunk's refusals for every shape the attempts lost. Temp fixtures only. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inputIsolationRisk, commandSafetyRisk } = require('../sidecar/tools/builtin/shell.js');

function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-source-scan-'));
try {
  put(root, 'second.mjs', "import puppeteer from 'puppeteer-core';\nawait puppeteer.launch({ headless: false });\n");
  put(root, 'chain.cmd', '@node second.mjs\n');
  put(root, 'gui.mjs', "require('child_process').exec('notepad.exe');\n");

  // ---- 1. a launcher INSIDE a code line is followed under cmd (a line-start-only scan allowed it) ----
  {
    put(root, 'one.mjs', "require('child_process').execSync('npm ci && node second.mjs --headed');\n");
    put(root, 'package.json', JSON.stringify({ scripts: { e2e: 'node second.mjs --headed' } }));
    put(root, 'three.mjs', "require('child_process').execSync('npm ci && npm run e2e');\n");
    for (const f of ['one.mjs', 'three.mjs']) {
      const v = inputIsolationRisk('node ' + f, { cwd: root, fs, pathMod: path, dialect: 'cmd' });
      A.ok(v && /browser automation/.test(v), f + ' under cmd: the head after && is followed into second.mjs and refused: ' + v);
      A.ok(commandSafetyRisk('node ' + f, { cwd: root, fs, pathMod: path, dialect: 'cmd', isWin: true }), f + ': the combined safety floor refuses it too');
    }
  }

  // ---- 2. a nesting launcher on a code line, an apostrophe in a shell file's comment ----
  {
    const list = (line) => "const steps = `\n" + line + "\n`;\nrequire('child_process').execSync(steps);\n";
    put(root, 'nest-cmd.mjs', list('cmd /c chain.cmd'));
    put(root, 'nest-call.mjs', list('call chain.cmd'));
    put(root, 'nest-saps.mjs', list('Start-Process chain.cmd'));
    put(root, 'nest-zsh.mjs', list('zsh -c ./chain.cmd'));
    for (const f of ['nest-cmd.mjs', 'nest-call.mjs', 'nest-saps.mjs', 'nest-zsh.mjs']) for (const dialect of ['cmd', 'posix']) {
      const v = inputIsolationRisk('node ' + f, { cwd: root, fs, pathMod: path, dialect });
      A.ok(v && /browser automation/.test(v), f + ' under ' + dialect + ': the nested script is followed into second.mjs and refused: ' + v);
      A.ok(commandSafetyRisk('node ' + f, { cwd: root, fs, pathMod: path, dialect, isWin: true }), f + ' under ' + dialect + ': the combined safety floor refuses it too');
    }
    put(root, 'note.sh', "#!/bin/bash\n# don't run this twice\nnode second.mjs\n");
    put(root, 'note.ps1', "# Don't run this twice\nnode second.mjs\n");
    for (const cmd of ['bash note.sh', 'powershell -File note.ps1']) {
      const v = inputIsolationRisk(cmd, { cwd: root, fs, pathMod: path, dialect: 'cmd' });
      A.ok(v && /browser automation/.test(v), cmd + ' under cmd: the line after the comment is still a head: ' + v);
    }
  }

  // ---- 3. the 30-source queue cap: a script trunk reached inside the cap is still scanned ----
  // main.mjs lists N scripts; s1.mjs runs evil.mjs. Trunk queues main, its N scripts, then evil.mjs at index N+1.
  // Extra heads that repeat trunk's queued each script twice, so for N = 14..27 evil.mjs fell past the cap.
  {
    const dir = path.join(root, 'cap');
    put(dir, 'evil.mjs', "import puppeteer from 'puppeteer-core';\nawait puppeteer.launch({ headless: false });\n");
    for (const N of [14, 15, 20, 27]) {
      const lines = [];
      for (let i = 1; i <= N; i++) lines.push('node s' + i + '.mjs');
      put(dir, 'main.mjs', "const steps = `\n" + lines.join('\n') + "\n`;\nrequire('child_process').execSync(steps);\n");
      for (let i = 1; i <= N; i++) put(dir, 's' + i + '.mjs', "const s = `\n" + (i === 1 ? 'node evil.mjs' : 'echo ' + i) + "\n`;\nrequire('child_process').execSync(s);\n");
      for (const dialect of ['cmd', 'posix']) {
        const v = inputIsolationRisk('node main.mjs', { cwd: dir, fs, pathMod: path, dialect });
        A.ok(v && /browser automation/.test(v), 'N=' + N + ' under ' + dialect + ': the script s1.mjs runs is inside the cap and refused: ' + v);
      }
    }
  }

  // ---- 4. shell sources are followed, code text keeps its in-text checks ----
  {
    const verdict = inputIsolationRisk('cmd /c chain.cmd', { cwd: root, fs, pathMod: path, dialect: 'cmd' });
    A.ok(verdict && /browser automation/.test(verdict), 'a .cmd file is a command list whose scripts are followed: ' + verdict);
    const gui = inputIsolationRisk('node gui.mjs', { cwd: root, fs, pathMod: path, dialect: 'cmd' });
    A.ok(gui && /GUI\/native runtime/.test(gui), 'a referenced script that launches a desktop program is refused: ' + gui);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('shell.source-scan.test');
