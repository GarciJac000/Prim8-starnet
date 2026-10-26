/* node test/front-doors-tabs.test.js — the one-menu tab strip never throws away unsaved work (sweep 2026-10-02):
   · the lit tab again is a no-op (RECIPES used to close + reopen and drop a recipe in progress);
   · a tab in the SAME window (AUTOMATE's SCHEDULES / GOAL LOOPS / AWAY WORK) meets the unsaved guard (a half-typed
     schedule vanished);
   · the second click on an armed guard switches tabs (it used to close the whole menu);
   · BRIEF's SEE FULL ACCESS opens CONFIG at the ACCESS group (it landed on six folded groups). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');

const sw = ui.slice(ui.indexOf('function switchFamilyTab('), ui.indexOf('function swapInPlace('));
A.ok(sw.length > 0, 'switchFamilyTab exists');
A.ok(/const lit = familyActiveTab\(famId, fromKey\);\s*if \(tab\.k === fromKey && lit && lit\.id === tab\.id\) return;/.test(sw), 'the lit tab again does nothing');
const guard = sw.indexOf("if (w && windowDirty(w) && !w._closeArmed) { requestCloseTerm(fromKey); return; }");
A.ok(guard > 0, 'a dirty window arms the guard on the first click and never closes on it');
A.ok(guard < sw.indexOf("if (tab.k === fromKey) { openFamilyTab(famId, tab); return; }"), 'the guard also covers a tab in the same window');
A.ok(guard < sw.indexOf('swapInPlace(fromKey'), 'and a tab in another window');
A.ok(!/if \(w && windowDirty\(w\)\) \{ requestCloseTerm\(fromKey\); return; \}/.test(sw), 'an armed second click is not routed to close the menu');
// requestCloseTerm arms (never closes) a dirty, un-armed window: the guard's first click is safe
const rc = ui.slice(ui.indexOf('function requestCloseTerm('), ui.indexOf('function requestCloseTerm(') + 400);
A.ok(/if \(w\._closeArmed \|\| !windowDirty\(w\)\) \{ closeTerm\(key\); return; \}/.test(rc), 'requestCloseTerm closes only an armed or clean window');

// QA 2026-10-02: a typed one-line draft (TASKS' composer) is unsaved work too — run the REAL windowDirty on fake windows
{
  const wd = ui.slice(ui.indexOf('function windowDirty(w) {'), ui.indexOf('function requestCloseTerm('));
  const vm = require('vm');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(wd, ctx);
  const win = (draftValue) => ({ querySelector: () => null, querySelectorAll: (sel) => (sel === 'input[data-draft]' && draftValue != null ? [{ value: draftValue }] : []) });
  A.eq(ctx.windowDirty(win('send the invoice to Sam')), true, 'a typed task in the TASKS composer arms the guard (a tab click no longer drops it)');
  A.eq(ctx.windowDirty(win('   ')), false, 'an empty composer is clean');
  A.eq(ctx.windowDirty(win(null)), false, 'a window without a draft input is clean');
  A.ok(/<input id="kb-in" data-draft /.test(ui), 'the TASKS composer is marked as a draft input');
}
A.ok(/\[data-access-full\]'\)\.onclick = \(\) => \{ cfOpen\.set\(a\.id \+ ':cf-grp-behaves', true\); consoleSection\['agents'\] = 'config';/.test(ui), 'SEE FULL ACCESS opens the ACCESS group');
A.ok(/\{ id: 'cf-grp-behaves', label: 'ACCESS' \}/.test(ui) && /const key = a\.id \+ ':' \+ g\.id;[\s\S]{0,200}cfOpen\.get\(key\) \? ' open'/.test(ui), 'the ACCESS group reads its open state from cfOpen by agent + group id');

// a remembered SETTINGS section that was renamed (LIVE VOICE -> LOOK & SOUND, models -> providers) reopens on its new page
A.ok(/if \(key === 'settings' && \(activeId === 'models' \|\| activeId === 'livevoice'\)\) activeId = activeId === 'models' \? 'providers' : 'appearance';/.test(ui), 'mountConsole applies the same section aliases openTerm does');
// the rating card's "missed" thumb is the up-thumb SVG flipped: the flip must hold in EVERY skin (HUD mode, ?glass=0),
// not only inside the glass skin, or both thumbs point up and the right-hand one files a miss (sweep 10-02)
const appCss = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');
A.ok(/^\.thumb-down \.thumb-px \{ transform: rotate\(180deg\); \}/m.test(appCss), 'app.css flips the down-thumb unscoped');
// org pass 10-14 (P11, #45/#46): MY WORK's FIRST open lands on DELIVERABLES (the TASKS board reads empty after plain
// COMMS work); after that the dock button reopens the last-used tab. Tab ORDER is unchanged. Runs the REAL toggleFamily.
{
  const vm = require('vm');
  const fam = ui.slice(ui.indexOf('const FAMILIES = {'), ui.indexOf('// which menu a window belongs to'));
  const tf = ui.slice(ui.indexOf('function toggleFamily(famId) {'), ui.indexOf('function toggleTerm(key, title, builder, opts) {'));
  A.ok(fam.length > 0 && tf.length > 0, 'FAMILIES and toggleFamily are found');
  const ctx = { open: {}, minimized: {}, store: {}, opened: [], familyOf: () => null };
  ctx.openFamilyTab = (f, t) => ctx.opened.push(f + ':' + t.id);
  vm.createContext(ctx); vm.runInContext(fam + '\n' + tf + '\nthis.FAMILIES = FAMILIES; this.toggleFamily = toggleFamily;', ctx);
  A.eq(ctx.FAMILIES.mywork.tabs.map(t => t.id).join(','), 'tasks,deliverables,recipes', 'the MY WORK tab order is unchanged');
  ctx.toggleFamily('mywork');
  A.eq(ctx.opened.pop(), 'mywork:deliverables', 'a first MY WORK open (no saved tab) lands on DELIVERABLES');
  ctx.store.famLast = { mywork: 'tasks' };
  ctx.toggleFamily('mywork');
  A.eq(ctx.opened.pop(), 'mywork:tasks', 'after that the last-used tab wins (TASKS stays one click away)');
  ctx.toggleFamily('automate');
  A.eq(ctx.opened.pop(), 'automate:workflows', 'a menu with no `first` still opens its first tab');
}
// org D9 (10-14): a door that moves an OPEN menu window to another section (AWAY WORK while SCHEDULES shows) lights that tab too
A.ok(/if \(open\[key\]\) \{ if \(minimized\[key\]\) restoreTerm\(key\); if \(section\) \{ rerender\(key\); syncFamilyTabs\(open\[key\], key\); \} return; \}/.test(ui),
  'openTerm on an open window re-syncs the menu tab strip after it re-renders the section');

/* 0.14.1 review (window-open lag lane): a sheet is seated the moment its frame mounts (SEAT BEFORE BUILD), reading its OWN
   dock state. A deep link to a sibling tab (TASKS' ▸ DELIVERABLES → openTerm('deliverables')) swapped in place without
   naming the window, so the source's docked height was carried only AFTER the seat and the switch snapped to the sibling's
   own height. Run the REAL swapInPlace: the height the opening sheet is seated at must be the source's. */
{
  const vm = require('vm');
  const src = ui.slice(ui.indexOf('  function swapInPlace('), ui.indexOf('  // the dock button of a menu'));
  const run = (toKeyArg) => {
    const seatedAt = [];
    const ctx = {
      termPos: { tasks: { left: 40, top: 300 } }, termSize: {}, store: { termDock: { tasks: { height: 610, expanded: false }, deliverables: { height: 260, expanded: false } } },
      open: { tasks: {} }, save() {}, closeTerm(k) { delete ctx.open[k]; }, placeTerm() {}, familyOf: () => 'mywork',
      document: { body: { setAttribute() {}, removeAttribute() {} } }, setTimeout: () => 0, clearTimeout() {}
    };
    // the opener = toggleTerm: the sheet seats from the store the moment it mounts; a later re-seat reads it again
    const openDeliverables = () => {
      const w = { _reseatDock: () => seatedAt.push(ctx.store.termDock.deliverables.height) };
      ctx.open.deliverables = w; seatedAt.push(ctx.store.termDock.deliverables.height);
    };
    vm.createContext(ctx); vm.runInContext(src + '\nthis.swapInPlace = swapInPlace;', ctx);
    ctx.swapInPlace('tasks', openDeliverables, toKeyArg);
    return seatedAt;
  };
  A.eq(run('deliverables').join(','), '610', 'a named swap carries the source\'s docked height before the sheet seats (it opens at 610, never at its own 260)');
  A.eq(run(undefined).slice(-1)[0], 610, 'an unnamed swap re-seats the opened sheet from the carried height (its last seat is the source\'s 610)');
  A.ok(/swapInPlace\(sib, \(\) => toggleTerm\(key, def\[0\], def\[1\], def\[2\]\), key\)/.test(ui), 'openTerm\'s sibling switch names the window it opens');
  const glass = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'glass-demo.js'), 'utf8');
  A.ok(/w\._reseatDock = \(\) => \{[\s\S]{0,260}_readDockState\(\)[\s\S]{0,200}seat\(w,s\);/.test(glass), 'a sheet can re-seat from its (carried) dock state');
}
A.report('front-doors-tabs');
