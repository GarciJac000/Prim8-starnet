// dev/save-restore-proof.mjs — the support report's station, after the fix: bring a preserved window save's sessions back.
//
// The station file holds 950 sessions. Beside it sits the window save that was refused (the report's 1,046): the same
// 950, one of them continued, and 96 sessions the station never got. One fresh window whose browser cache cannot hold the
// station boots, is offered the 96 + 1, restores them, and reloads onto a station holding all of it. Nothing the station
// held is lost, the station file was copied aside first, and the offer does not come back.
//
//   node dev/save-restore-proof.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, connectCDP, evalJS, capture, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, waitDevReady } from '../scripts/lib/seed.mjs';
const require = createRequire(import.meta.url);
const { SidecarFixture, allocatePort } = require('../test/helpers/sidecar-fixture.js');

const out = path.resolve('.dogfood/save-restore-proof');
fs.mkdirSync(out, { recursive: true });
const fixture = SidecarFixture.create({ timeoutMs: 30000,
  env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_DEFAULT_MODEL: 'test/model' } });
let browser, cdp;
const filler = 'the station logged this turn while the commander was away. '.repeat(10);
const session = (i, turns) => ({ id: 'ws_' + i, title: 'Session ' + i, agentId: 'agent', kind: 'chat', lane: 'active', runIds: [],
  createdAt: 1760000000000 + i * 60000, updatedAt: 1760000000000 + i * 60000,
  history: Array.from({ length: turns }, (_, t) => ({ role: t % 2 ? 'assistant' : 'user', content: 'turn ' + t + ' of ' + i + ' ' + filler })) });
try {
  materializeSeedWorkspace(fixture.workspace, 'test/model');
  const mainPath = path.join(fixture.workspace, 'agent.save.json');
  const w = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
  w.doc.workstreams = Array.from({ length: 950 }, (_, i) => session(i, 2));
  w.doc._saveRevision = 40;
  fs.writeFileSync(mainPath, JSON.stringify(w));
  const preserved = JSON.parse(JSON.stringify(w.doc));
  preserved.workstreams[7] = session(7, 4);                                       // a conversation the window continued
  for (let i = 950; i < 1046; i++) preserved.workstreams.push(session(i, 2));     // sessions the station never got
  preserved._saveRevision = 39; preserved._saveClient = 'old-window';
  fs.writeFileSync(path.join(fixture.workspace, 'agent.save-conflict-old-window.json'), JSON.stringify(preserved));
  console.log('station file', w.doc.workstreams.length, 'sessions; preserved window save', preserved.workstreams.length);

  await fixture.start();
  const listed = (await fixture.json('GET', '/api/save/conflicts')).body;
  console.log('GET /api/save/conflicts', JSON.stringify(listed));
  assert.equal(listed.conflicts[0].restorable, 97, 'the station offers the 96 new sessions and the continued one');

  const port = await allocatePort();
  const profileDir = path.join(out, 'profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  browser = launchChrome({ cdpPort: port, profileDir });
  cdp = await connectCDP(port);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'starnet.save' && String(v).length > 1000000) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return set.call(this, k, v);
    };
  })();` });
  await cdp.send('Page.navigate', { url: fixture.baseUrl });
  assert.equal(await waitDevReady(cdp, evalJS, { url: fixture.baseUrl, tries: 40, reloadEvery: 0 }), true);
  await sleep(4500);
  const offer = await evalJS(cdp, `(() => { const b = document.getElementById('save-preserved-notice');
    return b ? { text: b.querySelector('p').textContent, buttons: [...b.querySelectorAll('button')].map(x => x.textContent) } : null; })()`);
  console.log('offer', JSON.stringify(offer));
  assert.ok(offer && /holds work in 97 sessions/.test(offer.text), 'the window offers the 97 sessions');
  await capture(cdp, out, 'offer');

  await evalJS(cdp, `document.querySelector('#save-preserved-notice button').click()`);
  await sleep(3000);
  assert.equal(await waitDevReady(cdp, evalJS, { url: fixture.baseUrl, tries: 40, reloadEvery: 0 }), true);
  await sleep(4500);
  const after = await evalJS(cdp, `(() => { const s = Workstreams.serialize().workstreams;
    return { sessions: s.length, continued: (s.find(x => x.id === 'ws_7') || {}).history?.length, last: !!s.find(x => x.id === 'ws_1045'),
      offerAgain: !!document.getElementById('save-preserved-notice'), conflictBanner: !!document.getElementById('save-conflict-notice'),
      health: (h => ({ conflict: !!h.conflict, failures: h.consecutiveFailures }))(CloudSave.health()) }; })()`);
  console.log('after restore', JSON.stringify(after));
  const file = JSON.parse(fs.readFileSync(mainPath, 'utf8')).doc;
  const names = fs.readdirSync(fixture.workspace);
  console.log('station file now', file.workstreams.length, 'sessions, revision', file._saveRevision, '| files:', names.filter(n => /^agent\.save/.test(n)).join(', '));
  assert.ok(after.sessions >= 1046 && after.continued === 4 && after.last, 'the window shows every session, the continued one whole');
  assert.ok(file.workstreams.length >= 1046, 'the station file holds them');
  for (let i = 0; i < 950; i++) assert.ok(file.workstreams.find(x => x.id === 'ws_' + i), 'nothing the station held is lost');
  assert.ok(names.some(n => /^agent\.save-before-restore-\d+\.json$/.test(n)), 'the station file was copied aside first');
  assert.equal(after.offerAgain, false, 'the offer does not come back');
  assert.equal(after.conflictBanner, false);
  const relisted = (await fixture.json('GET', '/api/save/conflicts')).body.conflicts;
  assert.ok(relisted.every(c => c.restorable === 0), 'nothing is left to restore: ' + JSON.stringify(relisted));
  await capture(cdp, out, 'after');
  console.log('PASS — shots in', out);
} finally {
  try { cdp && cdp.close(); } catch (_) {}
  try { browser && browser.kill(); } catch (_) {}
  await fixture.dispose();
}
