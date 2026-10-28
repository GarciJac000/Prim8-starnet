/* node test/browser.attach.test.js — DRIVING THE COMMANDER'S OWN CHROME.

   browser.attach connects to an already-running Chrome over its DevTools port instead of launching a
   station browser. That buys the thing a fresh headless profile can never have — the Commander's real
   signed-in sessions, in a real browser with a real fingerprint — and it is the honest answer to sites
   that refuse automated profiles, as opposed to a fingerprint-spoofing engine.

   It is also the single most dangerous surface in the file, because their browser is signed into
   everything they own. These assertions exist to hold that line:
     · consent is ALWAYS required (never defaulted away),
     · browser.eval stays refused for as long as the session is attached,
     · detaching NEVER closes their browser, and neither does close(),
     · a mode switch can never silently swap their browser for a station one,
     · a bad port is discovered BEFORE the working session is torn down. */
'use strict';
const A = require('./_assert.js');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

async function rejects(p, re, msg) {
  try { await p; A.ok(false, msg + ' — did not reject'); }
  catch (e) { A.ok(re.test((e && e.message) || String(e)), msg + ' (got: ' + ((e && e.message) || e) + ')'); }
}

// A DevTools endpoint that answers /json/version, like a real Chrome started with --remote-debugging-port.
function devtoolsFetch(opts) {
  opts = opts || {};
  const seen = [];
  const f = async (url) => {
    seen.push(String(url));
    if (opts.dead) throw new Error('ECONNREFUSED');
    if (opts.notChrome) return { json: async () => ({ hello: 'i am not chrome' }) };
    return { json: async () => ({ Browser: 'Chrome/141.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }) };
  };
  f.seen = seen;
  return f;
}

function fakeDriver() {
  const log = { closed: 0, killedProcess: false };
  return {
    log,
    navigate: async u => u,
    snapshot: async () => [{ role: 'button', text: 'Inbox', x: 1, y: 2, w: 10, h: 10 }],
    click: async n => 'clicked ' + n.text,
    type: async () => 'typed', press: async k => k, scroll: async () => 'scrolled',
    back: async () => '', forward: async () => '', getText: async () => 'text',
    tabs: async () => [], selectTab: async () => '', closeTab: async () => '',
    consoleLog: () => [], networkLog: () => [], handleDialog: async () => ({}),
    screenshot: async () => '', evalPublic: async () => ({ ok: true, value: 1 }),
    usingPersistentProfile: () => false,
    // close() on a driver in ATTACH mode must not kill anything: the real driver only kills a process it
    // spawned, and in attach mode it spawned none. A fake that "killed" here would hide a regression.
    close: () => { log.closed++; }
  };
}

(async () => {
  // ---- 1. THE CONSENT CONTRACT — attach can never be silent ----
  {
    const B = makeBrowserTools({ driver: fakeDriver() });
    const attach = B.tools.find(t => t.name === 'browser.attach');
    const detach = B.tools.find(t => t.name === 'browser.detach');
    A.ok(!!attach, 'browser.attach is registered');
    A.eq(attach.requiresConsent, true, 'attaching to the Commander\'s own browser ALWAYS asks first');
    A.eq(attach.scope, 'execute', 'and it is execute scope, not read');
    A.eq(attach.capability, 'web', 'it rides the web capability like the rest of the browser surface');
    A.eq(detach.requiresConsent, false, 'LETTING GO costs no prompt — a gated release is a release that does not happen');
  }

  // ---- 1b. ATTACH STARTS ON CHROME'S ACTUALLY ACTIVE TAB -------------------------------------
  // Browser-level auto-attach does not promise page-event order. The first event below is a background
  // inbox; the second is the visible Commander tab. Treating the first event as tab 0 makes the very first
  // snapshot/read/click land in the wrong signed-in page even though Chrome itself is showing CURRENT.
  {
    const sent = [];
    class MultiTabWS {
      constructor() { this.handlers = {}; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
      fire(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
      event(method, params) { this.fire('message', { data: JSON.stringify({ method, params }) }); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        if (m.method === 'Target.setAutoAttach' && !m.sessionId) {
          setTimeout(() => {
            this.event('Target.attachedToTarget', { sessionId: 'background-session', targetInfo: { type: 'page', targetId: 'BACKGROUND' } });
            this.event('Target.attachedToTarget', { sessionId: 'current-session', targetInfo: { type: 'page', targetId: 'CURRENT' } });
          }, 0);
        }
        const expr = String((m.params && m.params.expression) || '');
        let result = {};
        if (m.method === 'Target.getTargets') {
          result = { targetInfos: [
            { type: 'page', targetId: 'BACKGROUND' },
            { type: 'page', targetId: 'CURRENT' }
          ] };
        } else if (m.method === 'Runtime.evaluate' && /visibilityState/.test(expr)) {
          result = { result: { value: m.sessionId === 'current-session'
            ? { visibility: 'visible', focused: true }
            : { visibility: 'hidden', focused: false } } };
        } else if (m.method === 'Runtime.evaluate' && /location\.href, title/.test(expr)) {
          result = { result: { value: m.sessionId === 'current-session'
            ? { url: 'https://current.test/', title: 'CURRENT' }
            : { url: 'https://background.test/', title: 'BACKGROUND' } } };
        } else if (m.method === 'Page.getFrameTree') {
          result = { frameTree: { frame: { id: 'top' } } };
        } else if (m.method === 'Runtime.evaluate') {
          result = { result: { value: null } };
        }
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const driver = T.makeCdpDriver({
      attachPort: 9222, headed: true, syntheticInputOnly: true, timeoutMs: 500,
      fetchImpl: async () => ({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/multi' }) }),
      WebSocketImpl: MultiTabWS
    });
    const tabs = await driver.tabs();
    A.eq(tabs[0].title, 'CURRENT', 'tab 0 is the page Chrome is actually showing, not the first auto-attach event');
    A.eq(tabs[0].active, true, 'the visible Commander tab is the initial action target');
    A.eq(tabs[1].title, 'BACKGROUND', 'other already-open tabs remain available without stealing focus');
    await driver.close();
  }

  // ---- 2. PORT VALIDATION, before anything is touched ----
  {
    const S = T.makeBrowserSession({ driver: fakeDriver(), fetchImpl: devtoolsFetch() });
    await rejects(S.attach(0), /integer 1-65535/, 'port 0 is refused');
    await rejects(S.attach(70000), /integer 1-65535/, 'an out-of-range port is refused');
    await rejects(S.attach('nine'), /integer 1-65535/, 'a non-numeric port is refused');
    A.eq(S.attachedToUser(), false, 'and none of those marked the session attached');
  }

  // ---- 3. A DEAD PORT IS DIAGNOSED, and the existing session SURVIVES ----
  {
    const d = fakeDriver();
    const S = T.makeBrowserSession({ driver: d, fetchImpl: devtoolsFetch({ dead: true }) });
    await S.snapshot();                     // a working session exists first
    await rejects(S.attach(9222), /nothing is listening/, 'a dead port says so plainly');
    // The probe runs BEFORE the relaunch precisely so this holds: discovering the port is dead must not
    // cost the agent the browser it already had.
    A.eq(S.attachedToUser(), false, 'the session is not marked attached');
    const still = await S.snapshot();
    A.eq(still.length, 1, 'and the previous browser still works');
  }

  // ---- 4. THE ERROR TEACHES THE FIX. A capability nobody can turn on is not a capability. ----
  {
    const S = T.makeBrowserSession({ driver: fakeDriver(), fetchImpl: devtoolsFetch({ dead: true }) });
    try { await S.attach(9222); A.ok(false, 'should reject'); }
    catch (e) {
      A.ok(/--remote-debugging-port=9222/.test(e.message), 'it names the exact flag, with the port filled in');
      A.ok(/separate --user-data-dir/i.test(e.message), 'the current Chrome separate-profile requirement is explained');
    }
  }

  // ---- 5. SOMETHING ELSE ON THE PORT is not mistaken for Chrome ----
  {
    const S = T.makeBrowserSession({ driver: fakeDriver(), fetchImpl: devtoolsFetch({ notChrome: true }) });
    await rejects(S.attach(9222), /not a Chrome DevTools endpoint/, 'a non-DevTools listener is refused, not attached to');
  }

  // ---- 6. THE PROBE IS LOOPBACK-ONLY ----
  {
    const f = devtoolsFetch();
    const S = T.makeBrowserSession({ driver: fakeDriver(), fetchImpl: f });
    await S.attach(9222);
    A.eq(f.seen.length, 1, 'exactly one probe');
    A.ok(/^http:\/\/127\.0\.0\.1:9222\//.test(f.seen[0]), 'and it is 127.0.0.1 — a DevTools port is unauthenticated RCE, never reached across a network');
  }

  // ---- 7. EVAL IS REFUSED WHILE ATTACHED — the whole security argument ----
  {
    const B = makeBrowserTools({ driver: fakeDriver(), fetchImpl: devtoolsFetch() });
    const before = B.session.evalAllowed();
    A.eq(before.ok, true, 'eval is allowed on an ordinary throwaway station browser');

    await B.session.attach(9222);
    const after = B.session.evalAllowed();
    A.eq(after.ok, false, 'and REFUSED the moment the session drives the Commander\'s own browser');
    A.ok(/your own Chrome/.test(after.reason), 'the reason names the real hazard');
    await rejects(B.session.evalPublic('document.cookie'), /refused/, 'the refusal is enforced, not merely advertised');
  }

  // ---- 8. THE ATTACHED STATE IS STICKY — no silent fallback to a station browser ----
  {
    const resolved = [];
    const B = makeBrowserTools({ driver: fakeDriver(), fetchImpl: devtoolsFetch(), lookup: async host => {
      resolved.push(host);
      return [{ address: '93.184.216.34', family: 4 }];
    } });
    await B.session.attach(9222);
    /* A headless request would ordinarily relaunch the driver. Honouring it here would rebuild WITHOUT
       attachPort — the agent would keep clicking, in a different browser, signed into nothing, and the
       transcript would not say so. */
    await B.session.navigate('https://example.com');
    A.eq(resolved, ['example.com', 'example.com'], 'attached navigation validates requested and final URLs through fixture DNS');
    A.eq(B.session.attachedToUser(), true, 'still attached after a navigation');
    A.eq(B.session.evalAllowed().ok, false, 'and the eval door is still shut');
  }

  // ---- 9. DETACH LETS GO WITHOUT CLOSING THEIR BROWSER ----
  {
    const B = makeBrowserTools({ driver: fakeDriver(), fetchImpl: devtoolsFetch() });
    await B.session.attach(9222);
    const msg = await B.session.detach();
    A.ok(/still running/.test(msg), 'the answer states their browser was left alone');
    A.ok(/untouched/.test(msg), 'in words a human can check');
    A.eq(B.session.attachedToUser(), false, 'the session is no longer attached');
    A.eq(B.session.evalAllowed().ok, true, 'and eval is available again on the station browser');
    A.eq((await B.tools.find(t => t.name === 'browser.detach').run({}, {})).content, 'Not attached; nothing to detach.', 'a second detach is a no-op, not an error');
  }

  // ---- 10. ATTACHING RELEASES THE STATION PROFILE LEASE ----
  {
    /* The persistent profile is single-owner. Holding its lease while driving a completely different
       browser would block a concurrent run out of a profile nobody is using. */
    let acquired = 0, released = 0;
    const built = [];
    // A makeDriver SEAM, not an injected driver: an injected driver short-circuits ensureDriver, so
    // profileDeps() — and therefore the lease — would never run at all.
    const B = makeBrowserTools({
      makeDriver: (d) => { built.push(d); return fakeDriver(); },
      fetchImpl: devtoolsFetch(), lookup: null,
      persistentProfile: { dir: 'C:/tmp/profile', acquire: () => { acquired++; return true; }, release: () => { released++; } }
    });
    await B.session.navigate('https://example.com');   // takes the lease the ordinary way
    A.ok(acquired >= 1, 'an ordinary run takes the station profile lease');
    await B.session.attach(9222);
    A.eq(released, 1, 'attaching RELEASES it — the station profile is not in play while attached');
    const attachBuild = built[built.length - 1];
    A.eq(attachBuild.attachPort, 9222, 'the driver is rebuilt in ATTACH mode against the probed port');
    A.eq(!!attachBuild.profileIsPersistent, false, 'and NOT flagged as the persistent station profile');
  }

  // ---- 11. REFS DO NOT SURVIVE THE SWITCH ----
  {
    const B = makeBrowserTools({ driver: fakeDriver(), fetchImpl: devtoolsFetch() });
    const snap = await B.session.snapshot();
    const ref = snap[0].ref;
    await B.session.attach(9222);
    // A different browser showing a different page: recovery must refuse exactly as it does across a
    // navigation, or a click could land on whatever happens to share a role and label over there.
    await rejects(B.session.click(ref), /navigated since that snapshot|unknown browser ref/, 'refs from before the attach are dead');
  }

  A.report('browser.attach.test');
})().catch(e => { console.log('FAIL: browser.attach.test threw -- ' + (e && e.stack || e)); process.exit(1); });
