/* node test/browser.desktop-login-journey.test.js
   Packaged-desktop acceptance contract for the attended LinkedIn login journey:
   ordinary browsing stays headless, login opens a visible browser on the station profile,
   Done restores headless automation, and a restarted sidecar reuses the same profile. */
'use strict';

const A = require('./_assert.js');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const dns = require('node:dns');
const originalLookup = dns.promises.lookup;
const liveDnsAttempts = [];
dns.promises.lookup = async host => {
  liveDnsAttempts.push(host);
  throw new Error('desktop login fixture attempted live DNS: ' + host);
};

function makeLease(dir) {
  const state = { acquired: 0, released: 0 };
  return {
    state,
    profile: {
      dir,
      acquire() { state.acquired++; return true; },
      release() { state.released++; }
    }
  };
}

function makeDriverSeam() {
  const launches = [];
  return {
    launches,
    makeDriver(options) {
      const navigated = [];
      const driver = {
        options,
        navigated,
        navigate: async url => { navigated.push(url); return url; },
        visible: () => options.headed === true,
        close: async () => { driver.closed = true; }
      };
      launches.push(driver);
      return driver;
    }
  };
}

function desktopBrowser(seam, lease, prompts) {
  return makeBrowserTools({
    // The driver is simulated; keep DNS deterministic while retaining URL/address guards.
    lookup: async host => {
      if (host !== 'www.linkedin.com') throw new Error('unexpected fixture hostname: ' + host);
      return [{ address: '93.184.216.34', family: 4 }];
    },
    // This models the packaged desktop host after src-tauri starts the sidecar: there is
    // deliberately no desktop-wide STARNET_BROWSER_HEADLESS pin.
    env: { STARNET_DESKTOP_SHELL: '1', STARNET_USER_CONTROL_MODE: 'preserve' },
    forceHeadless: true,
    syntheticInputOnly: true,
    profileDir: 'C:\\temp\\ephemeral-browser-profile',
    persistentProfile: lease.profile,
    makeDriver: seam.makeDriver,
    attendedLogin: {
      prompt: async request => {
        prompts.push(request);
        return 'once';
      }
    }
  });
}

(async () => {
  const stationProfile = 'C:\\Users\\Commander\\AppData\\Roaming\\StarNet\\browser-profile';
  const lease = makeLease(stationProfile);
  const seam = makeDriverSeam();
  const prompts = [];
  const firstRun = desktopBrowser(seam, lease, prompts);

  await firstRun.session.navigate('https://www.linkedin.com/feed/');
  A.eq(seam.launches.length, 1, 'ordinary desktop browsing launches once');
  A.eq(seam.launches[0].options.headed, false, 'ordinary desktop browsing remains headless');
  A.eq(seam.launches[0].options.syntheticInputOnly, true, 'ordinary browsing retains synthetic-input isolation');
  A.eq(seam.launches[0].options.profileDir, stationProfile, 'ordinary browsing uses the persistent station profile');

  const login = firstRun.tools.find(tool => tool.name === 'browser.login');
  const result = await login.run({ url: 'https://www.linkedin.com/login' }, {});

  A.eq(prompts.map(request => request.tool), ['browser.login', 'browser.login.done'], 'the user gets open-window and Done consent controls');
  A.eq(prompts[0].argsSummary, 'www.linkedin.com', 'the visible-window consent names LinkedIn');
  A.eq(seam.launches.length, 3, 'login relaunches headed and then restores headless automation');
  A.eq(seam.launches[1].options.headed, true, 'LinkedIn login opens a real visible browser');
  A.eq(seam.launches[1].options.syntheticInputOnly, false, 'human login does not inherit synthetic-input restrictions');
  A.eq(seam.launches[1].options.forceHeadless, false, 'the attended login explicitly overrides ordinary headless policy');
  A.eq(seam.launches[1].options.profileDir, stationProfile, 'the visible browser uses the station profile');
  A.eq(seam.launches[1].navigated, ['https://www.linkedin.com/login'], 'the visible browser opens the requested LinkedIn login page');
  A.eq(seam.launches[2].options.headed, false, 'Done returns control to a headless browser');
  A.eq(seam.launches[2].options.syntheticInputOnly, true, 'Done restores ordinary input isolation');
  A.eq(seam.launches[2].options.profileDir, stationProfile, 'the restored browser keeps the signed-in profile');
  A.ok(/finished logging in/i.test(result.content), 'the completed attended flow is reported truthfully');

  await firstRun.session.navigate('https://www.linkedin.com/feed/');
  A.eq(seam.launches.length, 3, 'post-login work continues in the restored browser without another relaunch');
  await firstRun.session.close();

  const secondRun = desktopBrowser(seam, lease, []);
  await secondRun.session.navigate('https://www.linkedin.com/feed/');
  A.eq(seam.launches.length, 4, 'a restarted sidecar launches a fresh browser process');
  A.eq(seam.launches[3].options.headed, false, 'the restarted sidecar resumes ordinary headless browsing');
  A.eq(seam.launches[3].options.profileDir, stationProfile, 'the restarted sidecar reuses the authenticated station profile');
  A.ok(lease.state.released >= 1 && lease.state.acquired >= 2, 'the persistent profile lease survives clean run handoff');
  await secondRun.session.close();

  A.eq(liveDnsAttempts, [], 'the simulated desktop login journey never invokes live DNS');
  A.report('browser.desktop-login-journey.test');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { dns.promises.lookup = originalLookup; });
