'use strict';
/* test/cli-link.test.js — sidecar/cli-link.js: on macOS the PACKAGED app puts `starnet` in ~/.local/bin and that folder
   on PATH (a dragged-in app has no installer). Pure planning against a fake file system: every case that must do nothing,
   the first launch, a moved app, a file the user owns, and what applying does. */
const A = require('./_assert.js');
const { planCliLink, applyCliLink, MARK } = require('../sidecar/cli-link.js');

const APP = '/Applications/StarNet.app';
const BIN = APP + '/Contents/Resources/bin/starnet';
const HOME = '/Users/ada';
function machine(files, links) {
  const f = Object.assign({}, files || {}), l = Object.assign({}, links || {});
  return {
    platform: 'darwin', execPath: APP + '/Contents/MacOS/node', home: HOME, env: {},
    exists: p => p in f || (p in l && l[p] in f),
    readlink: p => (p in l ? l[p] : null),
    readText: p => (p in f ? f[p] : null)
  };
}
const withBin = Object.assign.bind(null, { [BIN]: '#!/bin/sh' });

A.eq(planCliLink(Object.assign(machine(withBin()), { platform: 'win32' })).skip, 'not macOS', 'Windows: the installer owns PATH, nothing here');
A.eq(planCliLink(Object.assign(machine(withBin()), { execPath: '/usr/local/bin/node' })).skip, 'not running from an app bundle', 'a checkout, a test sidecar or a CLI-spawned station never touches the home folder');
A.eq(planCliLink(machine({})).skip, 'this app carries no starnet command', 'an app without the command links nothing');
A.eq(planCliLink(Object.assign(machine(withBin()), { env: { STARNET_NO_CLI_LINK: '1' } })).skip, 'turned off (STARNET_NO_CLI_LINK=1)', 'STARNET_NO_CLI_LINK=1 turns it off');

const first = planCliLink(machine(withBin()));
A.eq(first.actions.map(a => a.do), ['link', 'profile'], 'first launch: link the command, put ~/.local/bin on PATH');
A.eq([first.actions[0].link, first.actions[0].target], [HOME + '/.local/bin/starnet', BIN], 'the link points at the app\'s own command');
A.ok(first.actions[1].file === HOME + '/.zprofile' && first.actions[1].text.indexOf(MARK) >= 0 && /export PATH="\$HOME\/\.local\/bin:\$PATH"/.test(first.actions[1].text), 'the profile line is marked as StarNet\'s and adds ~/.local/bin to the front of PATH');
A.ok(/linked in ~\/\.local\/bin, and ~\/\.local\/bin added to PATH/.test(first.said), 'the boot line says what it did: ' + first.said);

const done = planCliLink(machine(withBin({ [HOME + '/.zshrc']: 'export PATH="$HOME/.local/bin:$PATH"\n' }), { [HOME + '/.local/bin/starnet']: BIN }));
A.eq([done.actions.length, done.said], [0, ''], 'already linked and on PATH: nothing to do, nothing said');

const mine = planCliLink(machine(withBin(), { [HOME + '/.local/bin/starnet']: '/opt/homebrew/bin/starnet-dev' }));
A.ok(/already exists and is not StarNet's/.test(mine.skip), 'a starnet the user put there is left alone');
const file = planCliLink(machine(withBin({ [HOME + '/.local/bin/starnet']: 'echo mine' })));
A.ok(/already exists/.test(file.skip || ''), 'a plain file of that name is left alone too');

const moved = planCliLink(machine(withBin({ [HOME + '/.profile']: 'PATH=~/.local/bin:$PATH' }), { [HOME + '/.local/bin/starnet']: '/Users/ada/Downloads/StarNet.app/Contents/Resources/bin/starnet' }));
A.eq(moved.actions.map(a => a.do), ['relink'], 'the app moved: its old link is re-pointed, the profile already has the folder');

const calls = [];
const fake = { mkdirSync: (p, o) => calls.push(['mkdir', p, !!(o && o.recursive)]), unlinkSync: p => calls.push(['unlink', p]), symlinkSync: (t, p) => calls.push(['symlink', t, p]), appendFileSync: (p, t) => calls.push(['append', p, t.length > 0]) };
applyCliLink(first, fake);
A.eq(calls, [['mkdir', HOME + '/.local/bin', true], ['symlink', BIN, HOME + '/.local/bin/starnet'], ['append', HOME + '/.zprofile', true]], 'applying: make the folder, link, append the profile line');
calls.length = 0;
applyCliLink(moved, fake);
A.eq(calls.map(c => c[0]), ['mkdir', 'unlink', 'symlink'], 'a re-link removes only the old StarNet link before linking');

A.report('cli-link.test');
