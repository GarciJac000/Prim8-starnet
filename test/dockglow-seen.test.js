'use strict';
/* node test/dockglow-seen.test.js — the BUILD-dock glow announces a gap, it is not a standing state (Andrew 10-23: "i think
   its weird that build is always highlighted": a station gap can stay open for weeks, so "glow while any gap is open" lit
   BUILD for good).
   GENUINE (executed): the real dockglow.js ticks over a fake page (the BUILD toggle, the BUILD MODE item inside the dock,
   localStorage) and a fake StationQuestStore. A gap from before the rule started never lights it; a new gap does; the
   glow follows into the open dock; closing the dock or entering BUILD MODE marks every open gap seen; only the next new
   gap lights it again; done/dismissed gaps never do; the tutorial still wins; all of it survives a reload. */
const A = require('./_assert.js');
const path = require('path');

/* ---- the fake page ---- */
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const mkEl = name => {
  const cls = new Set();
  return { name, laidOut: true, getClientRects() { return this.laidOut ? [{}] : []; }, classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) } };
};
const toggle = mkEl('BUILD toggle'), item = mkEl('BUILD MODE item');
item.laidOut = false;   // the dock popover starts closed: its items are not laid out (TRAP 1)
global.document = { querySelector: sel => sel === '#bb-build' ? item : (/data-group="build"/.test(sel) ? toggle : null) };
let gaps = [], coaching = false, refit = false, now = 10000;
global.StationQuestStore = { quests: () => gaps.slice() };
global.Tutorial = { isCoaching: () => coaching };
global.Build = { isOpen: () => refit };
const realNow = Date.now; Date.now = () => now;
const glowing = () => toggle.classList.contains('dock-glow') ? 'toggle' : item.classList.contains('dock-glow') ? 'item' : 'none';
const load = () => { delete require.cache[path.resolve(__dirname, '../frontend/app/dockglow.js')]; return require('../frontend/app/dockglow.js').DockGlow; };

/* ---- 1. the first run stamps SINCE: a gap from before it never lights BUILD ---- */
let DG = load();
gaps = [{ id: 'sq:nova:web', status: 'open', firstSeenAt: 5000 }];
DG.tick();
A.eq(glowing(), 'none', 'a gap first seen before the rule started does not light BUILD (an update never opens on a lit BUILD)');
A.eq(store[DG.SINCE_KEY], '10000', 'the first tick stamps when the rule started');

/* ---- 2. a new gap lights it; the glow follows into the open dock ---- */
now = 20000;
gaps.push({ id: 'sq:rex:dish', status: 'open', firstSeenAt: 15000 });
DG.tick();
A.eq(glowing(), 'toggle', 'a new gap lights the BUILD toggle');
item.laidOut = true; DG.tick();
A.eq(glowing(), 'item', 'the dock opened: the glow moves to BUILD MODE inside it');

/* ---- 3. closing the dock = the Commander looked: every open gap is seen ---- */
item.laidOut = false; DG.tick();
A.eq(glowing(), 'none', 'the dock closed again: the gap is seen and BUILD goes dark');
A.ok(JSON.parse(store[DG.SEEN_KEY]).includes('sq:rex:dish'), 'the seen gap is remembered under its own key');
DG.tick(); DG.tick();
A.eq(glowing(), 'none', 'and it stays dark while that gap stays open (no standing glow)');

/* ---- 4. only a NEW gap lights it again; BUILD MODE open marks it seen too ---- */
now = 30000;
gaps.push({ id: 'sq:kaze:shell', status: 'open', firstSeenAt: 25000 });
DG.tick();
A.eq(glowing(), 'toggle', 'the next new gap lights BUILD again');
refit = true; DG.tick();
A.eq(glowing(), 'none', 'entering BUILD MODE clears it (the Commander is where the fix is made)');
refit = false; DG.tick();
A.eq(glowing(), 'none', 'and leaving BUILD MODE does not relight a gap already seen');

/* ---- 5. done and dismissed gaps never glow; the tutorial still wins ---- */
gaps.push({ id: 'sq:echo:web', status: 'done', firstSeenAt: 26000 });
DG.tick();
A.eq(glowing(), 'none', 'a done gap never lights BUILD (a dismissed one never reaches quests() at all)');
gaps.push({ id: 'sq:vega:dish', status: 'open', firstSeenAt: 27000 });
coaching = true; DG.tick();
A.eq(glowing(), 'none', 'the tutorial is coaching: the glow stands down');
coaching = false; DG.tick();
A.eq(glowing(), 'toggle', 'the tutorial done, the unseen gap glows');

/* ---- 6. a station whose first tick has NO gap still stamps SINCE then: its first gap, minted later, glows ---- */
{
  const keep = Object.assign({}, store);
  for (const k of Object.keys(store)) delete store[k];
  const savedGaps = gaps; gaps = [];
  toggle.classList.remove('dock-glow'); item.classList.remove('dock-glow'); item.laidOut = false;
  now = 50000; let fresh = load();
  fresh.tick();
  A.eq(store[fresh.SINCE_KEY], '50000', 'the first in-game tick stamps SINCE even with no gap open');
  now = 50400; gaps = [{ id: 'sq:bolt:web', status: 'open', firstSeenAt: 50300 }];
  fresh.tick();
  A.eq(glowing(), 'toggle', 'a gap minted after that first tick lights BUILD (it was not dated before the rule)');
  toggle.classList.remove('dock-glow');
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, keep); gaps = savedGaps; now = 30000;
}

/* ---- 7. a reload keeps both the seen gaps and SINCE ---- */
toggle.classList.remove('dock-glow');
DG = load();
gaps = gaps.filter(g => g.id !== 'sq:vega:dish');
DG.tick();
A.eq(glowing(), 'none', 'after a reload the seen gaps stay seen');
A.eq(store[DG.SINCE_KEY], '10000', 'and SINCE keeps its first stamp');

Date.now = realNow;
A.report('dockglow-seen.test');
