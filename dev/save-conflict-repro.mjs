// dev/save-conflict-repro.mjs — a single window on a station too big for the browser cache.
//
// The 2026-10-21 support report: a 950-workstream station (about 2.5M characters) could not be stored in the
// browser cache. 0.13.5 resumed it from the station file, then showed "Another window saved newer station
// changes" with no other window open. This boots exactly that: a seeded sidecar whose station file holds a large
// station, and ONE fresh browser profile whose cache refuses any `starnet.save` write over CACHE_CAP characters.
// It prints what the window and the station file each hold, and whether a conflict file appeared.
//
//   node dev/save-conflict-repro.mjs [--workstreams 950] [--cap 1500000]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { SidecarFixture, allocatePort } = require('../test/helpers/sidecar-fixture.js');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const COUNT = arg('--workstreams', 950);
const CACHE_CAP = arg('--cap', 1500000);
const out = path.resolve('.dogfood/save-conflict-repro');
fs.mkdirSync(out, { recursive: true });

const fixture = SidecarFixture.create({ timeoutMs: 30000,
  env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
const conflicts = () => fs.readdirSync(fixture.workspace).filter(n => /\.save-conflict-/.test(n));
const fileSave = () => JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'agent.save.json'), 'utf8'));
try {
  materializeSeedWorkspace(fixture.workspace, 'test/model');
  // grow the station file to a large station: COUNT sessions, each with a few turns of text
  const p = path.join(fixture.workspace, 'agent.save.json');
  const w = JSON.parse(fs.readFileSync(p, 'utf8'));
  const filler = 'the station logged this turn while the commander was away. '.repeat(10);
  const t0 = Date.now() - COUNT * 60000;
  w.doc.workstreams = Array.from({ length: COUNT }, (_, i) => ({ agentId: 'agent', runIds: [], createdAt: t0 + i * 60000, updatedAt: t0 + i * 60000,
    id: 'ws_repro_' + i, title: 'Session ' + i, kind: 'chat', lane: 'active',
    history: [{ role: 'user', content: 'turn ' + i + ' ' + filler }, { role: 'assistant', content: 'reply ' + i + ' ' + filler }]
  }));
  w.doc._saveRevision = 40;
  fs.writeFileSync(p, JSON.stringify(w));
  console.log('station file', JSON.stringify(w.doc).length, 'chars,', COUNT, 'workstreams, revision 40');

  await fixture.start();
  const port = await allocatePort();
  const profileDir = path.join(out, 'profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  browser = launchChrome({ cdpPort: port, profileDir });
  cdp = await connectCDP(port);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const diagnostics = collectDiagnostics(cdp);
  // the browser cache's per-site cap, in place before any app script runs
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'starnet.save' && String(v).length > ${CACHE_CAP}) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return set.call(this, k, v);
    };
  })();` });
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  const ready = await waitDevReady(cdp, evalJS, { url: fixture.baseUrl, tries: 40, reloadEvery: 0 });
  console.log('in game:', ready);
  const probe = () => evalJS(cdp, `(() => { const h = CloudSave.health(); return {
    clientRevision: CloudSave.revision(), cacheFailed: h.cacheFailed, confirmed: h.cacheFailedConfirmed, failures: h.consecutiveFailures,
    conflict: h.conflict ? { revision: h.conflict.revision } : null, banner: !!document.getElementById('save-conflict-notice'),
    windowWorkstreams: (Workstreams.serialize().workstreams || []).length, cached: !!localStorage.getItem('starnet.save') }; })()`);
  console.log('after boot   ', JSON.stringify(await probe()), 'file rev', fileSave().doc._saveRevision, 'conflicts', conflicts());
  for (let i = 1; i <= 3; i++) {
    await evalJS(cdp, 'App.persist(); CloudSave.flush({ force: true })');
    await sleep(2500);
    console.log('persist #' + i + '   ', JSON.stringify(await probe()), 'file rev', fileSave().doc._saveRevision, 'conflicts', conflicts());
  }
  if (process.argv.includes('--late-ack')) {
    // A busy station writes the save but answers after the window's 15 s acknowledgement deadline. The window
    // counts that save as failed while the station holds it; the next save carries the old revision.
    await evalJS(cdp, `(() => { const original = window.fetch; let first = true;
      window.fetch = (url, opts) => { const reply = original(url, opts);
        if (first && String(url).startsWith('/api/save') && opts && opts.method === 'POST') { first = false; return reply.then(r => new Promise(done => setTimeout(() => done(r), 17000))); }
        return reply; };
      App.persist(); CloudSave.flush({ force: true }); })()`);
    await sleep(1500);
    console.log('late write  ', 'file rev', fileSave().doc._saveRevision, 'by this window:', fileSave().doc._saveClient === await evalJS(cdp, 'CloudSave.localSnapshot()._saveClient'));
    await sleep(15000);
    await evalJS(cdp, `Workstreams.create('made after the late write'); App.persist(); CloudSave.flush({ force: true })`);
    await sleep(6000);
    console.log('next save   ', JSON.stringify(await probe()), 'file rev', fileSave().doc._saveRevision, 'conflicts', conflicts());
  }
  const errors = diagnostics.errors ? diagnostics.errors() : diagnostics;
  fs.writeFileSync(path.join(out, 'diagnostics.json'), JSON.stringify(errors, null, 2));
} finally {
  try { cdp && cdp.close(); } catch (_) {}
  try { browser && browser.kill(); } catch (_) {}
  await fixture.dispose();
}
