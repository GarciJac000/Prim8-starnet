// dev/save-unclean-exit-repro.mjs — ONE window, a station that stops saving after the app is closed mid-work.
//
// Support reports 10-15 … 10-25 (#121, #153, starnet-releases#4, Bonbony Gilo, Jordan Gust): "the station goes back to
// an older save", "Another window saved newer station changes" with one window open, conflict files piling up while the
// station file stops moving. This boots the real app in one browser profile and walks the ordinary sequence:
//
//   1. a save goes out and lands; while its acknowledgement is on its way, the next edit is saved to the browser cache
//      (an agent turn persists every few seconds; a multi-MB save takes 100-500 ms to write)
//   2. the window dies before that next edit is sent (crash, power loss, killed app, OS restart) — no unload handlers
//   3. the app opens again (a fresh station process, the same browser cache)
//   4. the Commander keeps working
//
// It prints what the window and the station file hold at each step: whether the newest edits ever reach the station
// file, and whether a conflict appears with no other window open.
//
//   node dev/save-unclean-exit-repro.mjs [--ack-delay 600] [--legacy-cache]
//   --legacy-cache: the cache entry does not name its window, as every cache written by 0.14.0 or earlier
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { SidecarFixture, allocatePort } = require('../test/helpers/sidecar-fixture.js');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const ACK_DELAY = arg('--ack-delay', 600);
const out = path.resolve('.dogfood/save-unclean-exit-repro');
fs.mkdirSync(out, { recursive: true });

const fixedPort = await allocatePort();   // one origin for both boots: the browser cache is per origin
const fixture = SidecarFixture.create({ timeoutMs: 30000, portAllocator: async () => fixedPort,
  env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
const conflicts = () => fs.readdirSync(fixture.workspace).filter(n => /\.save-conflict-/.test(n));
const fileSave = () => JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'agent.save.json'), 'utf8'));
const fileTitles = () => (fileSave().doc.workstreams || []).map(w => w.title);
const has = (title) => fileTitles().includes(title);
const probe = () => evalJS(cdp, `(() => { const h = CloudSave.health(); let cached = null;
  try { const c = JSON.parse(localStorage.getItem('starnet.save') || 'null'); cached = c && { rev: c._saveRevision, dirty: c._saveDirty, titles: (c.workstreams || []).map(w => w.title).filter(t => /^S\\d/.test(t)) }; } catch (_) {}
  return { windowRevision: CloudSave.revision(), conflict: h.conflict ? { revision: h.conflict.revision } : null,
    banner: !!document.getElementById('save-conflict-notice'), failures: h.consecutiveFailures,
    windowTitles: (Workstreams.serialize().workstreams || []).map(w => w.title).filter(t => /^S\\d/.test(t)), cached }; })()`);
const fileLine = () => 'file rev ' + fileSave().doc._saveRevision + ' holds ' + JSON.stringify(fileTitles().filter(t => /^S\d/.test(t))) + ' conflicts ' + conflicts().length;
async function boot(profileDir) {
  const port = await allocatePort();
  browser = launchChrome({ cdpPort: port, profileDir });
  cdp = await connectCDP(port);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  const ready = await waitDevReady(cdp, evalJS, { url: fixture.baseUrl, tries: 40, reloadEvery: 0 });
  if (!ready) throw new Error('the app never reached the game screen');
}
async function closeBrowser() { try { cdp && cdp.close(); } catch (_) {} try { browser && browser.proc.kill(); } catch (_) {} await sleep(800); }

try {
  materializeSeedWorkspace(fixture.workspace, 'test/model');
  await fixture.start();
  const profileDir = path.join(out, 'profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  await boot(profileDir);
  // settle: the boot saves have landed and the window knows the station file's revision
  for (let i = 0; i < 20; i++) {
    await evalJS(cdp, 'CloudSave.flush({ force: true }).then(() => true)');
    await sleep(500);
    if (await evalJS(cdp, 'CloudSave.revision()') === fileSave().doc._saveRevision) break;
  }
  console.log('boot 1        ', JSON.stringify(await probe()), '|', fileLine());

  // 1. S1 goes out and lands; its acknowledgement takes ACK_DELAY ms; S2 is saved to the cache meanwhile
  await evalJS(cdp, `(() => { const original = window.fetch;
    window.fetch = (url, opts) => { const reply = original(url, opts);
      if (String(url).startsWith('/api/save') && opts && opts.method === 'POST') return reply.then(r => new Promise(done => setTimeout(() => done(r), ${ACK_DELAY})));
      return reply; };
    Workstreams.create('S1 landed'); App.persist(); CloudSave.flush({ force: true }); return true; })()`);
  await sleep(150);
  await evalJS(cdp, `(() => { Workstreams.create('S2 saved in the window'); App.persist(); return true; })()`);
  await sleep(ACK_DELAY + 250);
  console.log('before death  ', JSON.stringify(await probe()), '|', fileLine());
  const raced = await evalJS(cdp, `JSON.parse(localStorage.getItem('starnet.save'))._saveRevision`) < fileSave().doc._saveRevision;
  if (!raced) { console.log('RESULT: the race did not happen this run (the cache is not behind the station file) — rerun'); process.exitCode = 2; }

  // --legacy-cache: a cache written by 0.14.0 or earlier, which never named the window that wrote it
  if (process.argv.includes('--legacy-cache')) {
    await evalJS(cdp, `(() => { const c = JSON.parse(localStorage.getItem('starnet.save')); delete c._saveClient; localStorage.setItem('starnet.save', JSON.stringify(c)); return true; })()`);
    console.log('legacy cache   the cached save no longer names its window');
  }
  // 2. the window dies before S2's debounced send (no pagehide, no beacon)
  try { await cdp.send('Page.crash'); } catch (_) {}
  await sleep(500);
  await closeBrowser();

  // 3. the app opens again: a fresh station process, the same browser profile
  await fixture.restart();
  await boot(profileDir);
  await sleep(3000);
  console.log('boot 2        ', JSON.stringify(await probe()), '|', fileLine());
  console.log('merge notice  ', JSON.stringify(await evalJS(cdp, `CloudSave.mergeNotice ? CloudSave.mergeNotice() : 'n/a'`)),
    '| backups', fs.readdirSync(fixture.workspace).filter(n => /\.save-before-adopt-/.test(n)).length);
  console.log('on screen     ', JSON.stringify(await evalJS(cdp, `(() => { const t = document.body.innerText || ''; const i = t.search(/newest changes from last time|station file was newer than this window/i); return i < 0 ? null : t.slice(i, i + 220); })()`)));

  // 4. the Commander keeps working
  await evalJS(cdp, `(() => { Workstreams.create('S3 made after reopening'); App.persist(); CloudSave.flush({ force: true }); return true; })()`);
  await sleep(4000);
  console.log('keeps working ', JSON.stringify(await probe()), '|', fileLine());

  const lost = ['S2 saved in the window', 'S3 made after reopening'].filter(t => !has(t));
  console.log(lost.length ? 'RESULT: the station file is MISSING ' + JSON.stringify(lost) + ' — a cache wipe or a full cache brings back the old station'
    : 'RESULT: every edit reached the station file');
  if (process.exitCode !== 2) process.exitCode = lost.length ? 1 : 0;
} finally {
  await closeBrowser();
  await fixture.dispose();
}
