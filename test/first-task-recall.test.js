/* node test/first-task-recall.test.js — THE FIRST TASK IS NEVER LOST TO A FAILED RUN (bug 159d44fc).

   YOUR FIRST TASK → "Start this task" sends the Commander's task for them (PitchStore.startHandoff → launchDirective →
   Chat.send). The composer's ArrowUp recall (chat.js sentHistory) was filled only by the composer's own Enter paths, so
   when that first run failed at the provider the composer was empty and ArrowUp brought back nothing: a beginner had to
   retype their very first task. This proves:
     1. a launched hand-off records the exact task in the composer's recall (Chat.rememberSent), once;
     2. a launch that did not go out records nothing (the task goes back into the composer instead, as before);
     3. chat.js exposes rememberSent as the composer's own recordSent (same dedupe, same cap, same reset rules). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

global.Pitch = require('../frontend/app/pitch.js');
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.U = { bus: A.makeBus() };
global.DossierStore = { summary: () => ({ known: [], blank: [] }) };
global.UnderstandingStore = { readiness: () => ({ ready: true, reasons: [] }) };
global.Dialogue = { node: async () => null, setStage() {} };
const { PitchStore } = require('../frontend/app/pitchstore.js');

(async () => {
  // ---- 1 + 2. the hand-off launch makes the task recallable ----
  {
    const remembered = [], prefilled = [];
    let allow = false;
    global.Chat = { isBusy: () => false, prefill: t => prefilled.push(t), rememberSent: t => remembered.push(t) };
    PitchStore.reset();
    PitchStore.init({ getPurpose: () => '', launchDirective: () => allow });
    PitchStore.armFirstMove('Build a tiny weather app');
    const task = 'Build a tiny weather app that shows tomorrow in Lisbon';
    A.eq(PitchStore.startHandoff(task), false, 'a launch that did not go out reports so');
    A.eq(remembered, [], 'a task that was never sent is not recorded as sent');
    A.eq(prefilled, [task], '…it goes back into the composer, as before');
    allow = true;
    A.eq(PitchStore.startHandoff(task), true, 'the launch goes out');
    A.eq(remembered, [task], 'the sent first task is in the composer\'s ArrowUp recall, exactly as sent');
    A.eq(PitchStore.handoffPending(), false, 'the hand-off is done');
    // an older page whose Chat has no rememberSent still launches
    global.Chat = { isBusy: () => false, prefill() {} };
    PitchStore.reset(); PitchStore.init({ getPurpose: () => '', launchDirective: () => true }); PitchStore.armFirstMove('x');
    A.eq(PitchStore.startHandoff('another task'), true, 'a Chat without rememberSent still launches');
    delete global.Chat;
  }

  // ---- 3. chat.js: rememberSent IS the composer's recordSent ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    const ret = src.lastIndexOf('return { init, load, paintTitle');
    A.ok(ret > 0 && /\brememberSent: recordSent\b/.test(src.slice(ret, src.indexOf('})();', ret))), 'Chat exports rememberSent as the composer\'s own recordSent');
    const web = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'chat.js'), 'utf8');
    A.ok(/\brememberSent: recordSent\b/.test(web), 'the website mirror carries it too');
  }

  A.report('first-task-recall');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
