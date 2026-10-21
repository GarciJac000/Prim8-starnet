/* node test/browser.refs-retire.test.js — the browser session's ref table stays bounded (memory lane 2026-10-20).

   The session's `refs` Map kept EVERY ref it ever minted, each holding its snapshot node and a tab mark that held the
   driver object itself, so a long-lived station browser grew without bound and kept every replaced driver (and
   everything that driver held) alive. Refs of an earlier document now collapse into seq ranges per tab mark, and a
   tab mark names its driver by id. What an old ref ANSWERS must not change: the agent still gets the same refusal
   (page navigated / tab closed / unknown) byte for byte, and same-document recovery still works.

   Real session code over fake drivers; the driver-retention check uses a real GC. */
'use strict';
const A = require('./_assert.js');
const v8 = require('node:v8');
const vm = require('node:vm');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const turn = () => new Promise(r => setImmediate(r));

function fakeDriver(state) {
  state = state || {};
  const clicked = [];
  return {
    clicked,
    navigate: async url => url,
    snapshot: async () => [
      { role: 'button', text: 'Search', x: 10, y: 20, w: 80, h: 30 },
      { role: 'textbox', text: 'Query', x: 10, y: 60, w: 200, h: 24 }
    ],
    click: async node => { clicked.push(node.text); return 'clicked ' + node.text; },
    tabEpoch: () => state.tab || 0,
    close: async () => {}
  };
}
async function message(p) { try { await p; return 'resolved'; } catch (e) { return { message: String(e && e.message), code: e && e.code }; } }

(async () => {
  // ---- 1. many documents: the table holds the current document's refs only ----
  {
    const drv = fakeDriver();
    const s = T.makeBrowserSession({ makeDriver: () => drv, lookup: null, env: {} });
    await s.navigate('https://example.com/0');
    const first = (await s.snapshot())[0].ref;
    for (let i = 1; i <= 50; i++) { await s.navigate('https://example.com/' + i); await s.snapshot(); }
    A.eq(s._internals.refs.size, 2, 'after 51 documents the table holds the 2 current refs (it held all 102 before)');
    const now = (await s.snapshot())[0];
    A.eq(s._internals.refs.size, 4, 'two snapshots of the SAME document keep both, so a renumbered ref can still be recovered');

    const old = await message(s.click(first));
    A.ok(/^stale browser ref: b1 - the page navigated since that snapshot, so it points at the previous page\. Take a fresh browser\.snapshot\.$/.test(old.message),
      'a ref from 50 documents ago gets the SAME refusal as before: ' + old.message);
    A.ok(/^unknown browser ref: b99999 \(take a fresh browser\.snapshot\)$/.test((await message(s.click('b99999'))).message), 'a ref never minted is still unknown');
    A.ok(/^unknown browser ref: b01 /.test((await message(s.click('b01'))).message), 'a non-canonical spelling of a minted ref is unknown, as before');
    A.eq(await s.click(now.ref), 'clicked Search', 'a current ref still acts');
    const renumbered = (await s.snapshot()) && now.ref;   // a re-snapshot of the same page renumbers every ref
    const recovered = await message(s.click(renumbered));
    A.ok(recovered === 'resolved', 'a same-document stale ref is still recovered by role+text: ' + JSON.stringify(recovered));
    A.eq(drv.clicked, ['Search', 'Search'], 'and it clicked the same control');
  }

  // ---- 1b. a CLICK-driven session stays bounded too (review 2026-10-21) ----
  // A click that navigates moves no navEpoch, so snapshot-click-snapshot never changed "document" and every read's
  // refs (and nodes) stayed in the table: 2000 pages = 160 000 entries. Refs older than the last few reads of the
  // same document now retire into ranges and get the plain stale refusal; recent ones are still recovered.
  {
    const drv = fakeDriver();
    const s = T.makeBrowserSession({ makeDriver: () => drv, lookup: null, env: {} });
    await s.navigate('https://example.com/');
    const first = (await s.snapshot())[0].ref;
    let threeAgo = null;
    for (let i = 1; i <= 200; i++) {
      const snap = await s.snapshot();
      if (i === 197) threeAgo = snap[0].ref;
      await s.click(snap[0].ref);   // a link click: the page may change, navEpoch does not
    }
    A.ok(s._internals.refs.size <= 16, 'after 201 reads of one document the table holds only its last 8 reads (' + s._internals.refs.size + ' refs; it held 402 before)');
    const clicks = drv.clicked.length;
    const old = await message(s.click(first));
    A.eq(old.message, 'stale browser ref: ' + first + ' (refs expire after each browser.snapshot)', 'a ref from 200 reads ago gets the plain stale refusal');
    A.eq(drv.clicked.length, clicks, 'and is never re-aimed by role+text');
    A.eq(await message(s.click(threeAgo)), 'resolved', 'a ref from 3 reads ago is still recovered by role+text');
    A.eq(drv.clicked.length, clicks + 1, 'and clicked the same control');
    await s.navigate('https://example.com/next');
    await s.snapshot();
    const left = await message(s.click(first));
    A.ok(/^stale browser ref: b1 - the page navigated since that snapshot/.test(left.message), 'once the session navigates, the same retired ref says the page navigated: ' + left.message);
    A.ok(/^unknown browser ref: b99999 /.test((await message(s.click('b99999'))).message), 'a ref never minted is still unknown');
  }

  // ---- 1c. recovery's own re-read is not one of the agent's reads (review 2026-10-21) ----
  // Every recovered action re-reads the page, and that read's refs are never handed to the agent. Counted in the
  // 8-read window, they pushed the agent's own refs out: snapshot a 12-field form, find once, then fill each field with
  // the snapshot's refs - fields 0-6 recovered, 7-11 were refused as stale and nothing was clicked.
  {
    const fields = Array.from({ length: 12 }, (_, i) => ({ role: 'textbox', text: 'Field ' + i, x: 10, y: 20 * i, w: 100, h: 18 }));
    const clicked = [];
    const drv = {
      navigate: async u => u,
      snapshot: async () => fields.map(f => Object.assign({}, f)),
      click: async n => { clicked.push(n.text); return 'clicked ' + n.text; },
      tabEpoch: () => 0, close: async () => {}
    };
    const s = T.makeBrowserSession({ makeDriver: () => drv, lookup: null, env: {} });
    await s.navigate('https://example.com/form');
    const snap = await s.snapshot();
    await s.find({ text: 'field 3' });   // one intervening read: every snapshot ref is now stale but recoverable
    const outcomes = [];
    for (const n of snap) {
      const r = await message(s.click(n.ref));
      outcomes.push(r === 'resolved' ? 'recovered' : r.message);
    }
    A.eq(outcomes, fields.map(() => 'recovered'), 'all 12 old refs are recovered (7-11 were refused as stale before)');
    A.eq(clicked, fields.map(f => f.text), 'and each click landed on its own field');
    // a long recover-every-step session stays bounded: recovery's own re-reads mint no refs
    for (let i = 0; i < 200; i++) {
      const fresh = await s.snapshot();
      await s.find({ text: 'field 1' });
      await s.click(fresh[i % 12].ref);   // stale since the find: recovered every time
    }
    A.eq(clicked.length, 12 + 200, 'every one of the 200 stale clicks was recovered');
    // the last 8 agent reads = 4 cycles of snapshot (12) + find (3 hits)
    A.ok(s._internals.refs.size <= 4 * (12 + 3), 'and the table stays bounded (' + s._internals.refs.size + ' refs after 600 reads; ~5400 kept on trunk)');
  }

  // ---- 1d. a session that recovers on EVERY click, with no read in between, stays bounded (review 2026-10-21) ----
  // Recovery's re-read minted a whole read of refs uncounted, and only the agent's own reads retired them: snapshot,
  // find once, then click the same "Next" ref page after page - every click recovered and added 80 refs that nothing
  // ever retired (2000 clicks = 160 091 entries). The re-read now mints nothing and acts on the re-found node; only an
  // ambiguity refusal mints the candidates it names, and those are a read the agent sees.
  {
    const nodes = Array.from({ length: 80 }, (_, i) => i === 0 ? { role: 'button', text: 'Next' }
      : i < 3 ? { role: 'button', text: 'Delete' } : { role: 'link', text: 'Item ' + i });
    nodes.forEach((n, i) => Object.assign(n, { x: 1, y: i, w: 1, h: 1 }));
    const clicked = [];
    const drv = {
      navigate: async u => u,
      snapshot: async () => nodes.map(n => Object.assign({}, n)),
      click: async n => { clicked.push(n.text + '@' + n.y); return 'clicked ' + n.text; },
      tabEpoch: () => 0, close: async () => {}
    };
    const s = T.makeBrowserSession({ makeDriver: () => drv, lookup: null, env: {} });
    await s.navigate('https://example.com/list');
    const snap = await s.snapshot();
    const next = snap[0].ref, del = snap[1].ref;
    await s.find({ text: 'Item 3' });   // one intervening read: `next` is stale but recoverable
    const answers = new Set();
    for (let page = 0; page < 2000; page++) answers.add(await s.click(next));
    A.eq(clicked.length, 2000, 'every one of the 2000 clicks on the same stale ref was recovered');
    A.ok(clicked.every(c => c === 'Next@0'), 'and each landed on the same control');
    A.eq([...answers], ['clicked Next (ref ' + next + ' had gone stale; re-found the same element by role and text on the same page)'],
      'with the same recovery receipt, byte for byte');
    A.ok(s._internals.refs.size <= 80 + 20, 'and the table holds only the agent\'s own two reads (' + s._internals.refs.size + ' refs; 160 091 before)');

    const amb = await message(s.click(del));
    const named = /\((b\d+), (b\d+)\), so which one you meant is ambiguous\. Take a fresh browser\.snapshot and pick one\.$/.exec(amb.message || '');
    A.ok(/^stale browser ref: b\d+ - 2 elements now match \[button\] "Delete" \(/.test(amb.message || '') && named, 'an ambiguous recovery still refuses and names its candidates: ' + amb.message);
    A.eq(await s.click(named[2]), 'clicked Delete', 'and a candidate it names is a live ref the agent can act on');
    A.eq(clicked[clicked.length - 1], 'Delete@2', 'on the element it named');
    for (let i = 0; i < 500; i++) await message(s.click(del));
    A.ok(s._internals.refs.size <= 80 + 20, 'repeating an ambiguous click keeps the table bounded too (' + s._internals.refs.size + ' refs)');
    A.eq(clicked.length, 2001, 'and never clicks anything');
  }

  // ---- 2. a ref from a CLOSED tab stays refused as a closed tab after it is retired ----
  {
    const tab = { tab: 0 };
    const drv = fakeDriver(tab);
    const s = T.makeBrowserSession({ makeDriver: () => drv, lookup: null, env: {} });
    await s.navigate('https://x.test/');
    const old = (await s.snapshot())[0].ref;
    tab.tab = 1;                       // tab 0 closed, another tab promoted
    await s.snapshot();                // a fresh snapshot on the promoted tab: the old document's refs retire
    A.ok(!s._internals.refs.has(old), 'the closed tab\'s refs left the table');
    const err = await message(s.click(old));
    A.eq(err.code, 'REF_TAB_CLOSED', 'and the old ref is still refused as a closed-tab ref, never re-aimed');
    A.ok(/the tab that snapshot was taken on was closed/.test(err.message), 'with the same reason');
    A.eq(drv.clicked, [], 'nothing was clicked');
  }

  // ---- 3. a replaced driver is released ----
  {
    const holder = { last: null };
    const s = T.makeBrowserSession({ lookup: null, env: {}, makeDriver: () => (holder.last = fakeDriver()) });
    await s.navigate('https://example.com/');
    await s.snapshot();
    const firstDriver = new WeakRef(holder.last);
    holder.last = null;
    await s.navigate('https://example.com/watch', { visible: true });   // a headed relaunch replaces the driver
    await s.snapshot();
    holder.last = null;
    for (let i = 0; i < 4; i++) { await turn(); gc(); }
    A.eq(firstDriver.deref(), undefined, 'the replaced driver is garbage once the session moved on (the ref table kept it alive before)');
  }

  A.report('browser.refs-retire.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
