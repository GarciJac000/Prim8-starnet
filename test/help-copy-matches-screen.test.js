/* node test/help-copy-matches-screen.test.js — org pass P30 (2026-10-14): help, glossary and the agent manual name the
   screens that actually exist.

   Every assertion here pairs the copy with the real place it now names:
     - a model failure points at SETTINGS › AI & MODELS (where model keys live), never CONNECT (tools + channels);
     - the glossary's overseer is the first agent (it leads and delegates), never "the station itself"; a capability
       readout points at CONNECT › ABILITIES, never a SKILLS tab the dossier does not have;
     - the FIELD MANUAL's CONTROLS calls BUILD MODE key 9 by build.js's own label (CONVEYOR LINES), lists the APPS
       dock and the keys that work anywhere — each backed by a real handler in the app;
     - the manual and the HELP chapter send waiting items to NEEDS YOU at the top of SESSIONS first;
     - START FRESH is not listed under APP & BACKUP (it lives only on the boot recovery screen);
     - MY WORK's display words read TASKS / AGENT DOSSIER while the window keys stay `tasks` / `agents`;
     - BROWSER settings never promise "your own Chrome" (outputbrowser.js does not offer it);
     - a stop line never names an E-STOP the desk does not show.
   Source-level and pure: no DOM, no sidecar. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const onboarding = read('frontend/app/onboarding.js');
const firstvalue = read('frontend/app/firstvalue.js');
const tutorial = read('frontend/app/tutorial.js');
const station = read('frontend/app/stationui.js');
const build = read('frontend/app/build.js');
const manualSrc = read('sidecar/manual.js');

// ---- model failures name the model door ----
A.ok(!/check CONNECT/.test(onboarding) && /check SETTINGS › AI & MODELS before starting a task/.test(onboarding),
  'the awakening\'s model-failure line points at SETTINGS › AI & MODELS');
A.ok(!/Open CONNECT/.test(firstvalue) && /Open SETTINGS › AI & MODELS to configure/.test(firstvalue),
  'FIRST VALUE\'s model fallback points at SETTINGS › AI & MODELS');
// (live walk 10-14) FIELD MANUAL › HELP › NO REPLY named only SYSTEM › SETTINGS: it names the tab the provider's key is on
A.ok(/fmEntry\('NO REPLY', 'Check the connection', 'Open <b>SYSTEM › SETTINGS › AI &amp; MODELS<\/b> and check the selected provider’s sign-in or key\./.test(tutorial)
  && !/Open <b>SYSTEM › SETTINGS<\/b> and check the selected provider/.test(tutorial),
  'FIELD MANUAL › HELP › NO REPLY points at SYSTEM › SETTINGS › AI & MODELS');

// ---- the glossary ----
const gsrc = read('frontend/app/glossary.js');
const entry = key => { const m = gsrc.match(new RegExp('\\n\\s+' + key + ':\\s+\'([^\']*)\'')); return m ? m[1] : ''; };
A.ok(/your first agent; it leads and delegates/.test(entry('overseer')) && !/station itself/.test(entry('overseer')),
  'the overseer is the first agent that leads and delegates: ' + entry('overseer'));
A.ok(/CONNECT › ABILITIES/.test(entry('capability')) && !/SKILLS tab/.test(entry('capability')),
  'a capability readout points at ABILITIES, not a SKILLS tab: ' + entry('capability'));
A.ok(/MY WORK › TASKS/.test(entry('workstream')) && /SESSIONS/.test(entry('workstream')) && !/TASK BOARD/.test(entry('workstream')),
  'a workstream is a SESSION, and planned ones show on MY WORK › TASKS: ' + entry('workstream'));

// ---- CONTROLS ----
const key9 = (build.match(/id: 'line', key: '9', label: '([^']+)'/) || [])[1];
A.eq(key9, 'CONVEYOR LINES', 'build.js names key 9 CONVEYOR LINES');
A.ok(/\['9', 'Conveyor lines'\]/.test(tutorial) && !/\['9', 'Layouts'\]/.test(tutorial), 'CONTROLS names key 9 the way BUILD does');
A.ok(/<div><b>APPS<\/b>/.test(tutorial), 'CONTROLS lists the APPS dock');
// P30 polish: a key chip holds only keys — never context words ("Esc in COMMS") and never a '+' doing double duty as
// joiner and key ("Ctrl + / Ctrl -"); the focus keys' sentences get their own one-column list; an odd dock card spans
A.ok(!/\['Esc in COMMS'/.test(tutorial) && !/'Ctrl \+ \/ Ctrl -'/.test(tutorial), 'no context words or ambiguous joiners inside a key chip');
A.ok(/class="fm-keys fm-keys-wide">' \+ keyRows\(onFocus\)/.test(tutorial), 'the focus keys read as their own one-column list');
A.ok(/class="fm-map fm-dock"/.test(tutorial) && /\.fm-dock > div:last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1; \}/.test(read('frontend/css/tutorial.css')),
  'the dock map never leaves its last card beside an empty cell');
for (const [k, proof, where] of [
  ['F11', /ev\.key === 'F11'/, 'frontend/app/fullscreen.js'],
  ['Ctrl + Shift + H', /e\.ctrlKey && e\.shiftKey[\s\S]{0,80}KeyH/, 'frontend/app/hudmode.js'],
  ['Ctrl + = / Ctrl + -', /\(ev\.key === '=' \|\| ev\.key === '\+'\) \? 1 : \(ev\.key === '-'/, 'frontend/app/stationui.js'],
  ['Ctrl + 0', /ev\.key === '0' \? 0/, 'frontend/app/stationui.js'],
  ['Esc', /ev\.key === 'Escape'[\s\S]{0,600}requestCloseTerm\(key\)/, 'frontend/app/stationui.js'],
  // P30 review fix: Esc in COMMS is NOT a window close — the composer stops a live turn, a focused approval card denies,
  // a focused question card answers "use your judgment". CONTROLS says so, each against its real handler.
  ['Esc', /e\.key === 'Escape' && isBusy\(\)\)[\s\S]{0,200}stopActive\('esc'\)/, 'frontend/app/chat.js'],
  // P30 review fix: Shift+F10 on a SESSION row opens its actions menu (app.js openWsMenu); on a crew row it opens the
  // dossier (stationui.js openAgent) — the label names both.
  ['Shift + F10', /\(e\.shiftKey && e\.key === 'F10'\)\) \{\s*e\.preventDefault\(\);\s*const r = li\.getBoundingClientRect\(\);\s*openWsMenu\(/, 'frontend/app/app.js'],
]) {
  A.ok(tutorial.includes("['" + k + "', "), 'CONTROLS lists the anywhere key ' + k);
  A.ok(proof.test(read(where)), 'the ' + k + ' key it lists has a real handler in ' + where);
}
A.ok(!/\['Alt \+ H'/.test(tutorial), 'CONTROLS never lists Alt+H: no handler for it exists in the app');
{
  const chatSrc = read('frontend/app/chat.js');
  A.ok(/addEventListener\('keydown', e => \{ if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); decide\('deny'/.test(chatSrc)
    && /\['Esc', 'In COMMS: [^']*approval card: Deny/.test(tutorial), 'Esc on a focused approval card denies, and CONTROLS says so');
  A.ok(/addEventListener\('keydown', e => \{ if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); answer\('use your judgment'/.test(chatSrc)
    && /\['Esc', 'In COMMS: [^']*question card: answers “use your judgment”/.test(tutorial), 'Esc on a focused question card answers "use your judgment", and CONTROLS says so');
  A.ok(/\['Esc', 'In a window: close it/.test(tutorial) && !/\['Esc', 'Close the window you are in'\]/.test(tutorial), 'the window Esc row is scoped to windows');
  A.ok(!/These keys work from any screen\. <kbd>Esc<\/kbd>/.test(tutorial) && /The first four keys work from any screen/.test(tutorial), 'only the four global keys are claimed to work from any screen');
  A.ok(/ev\.shiftKey && ev\.key === 'F10'\)\) \{ ev\.preventDefault\(\); sfx\('click'\); openAgent\(/.test(station)
    && /\['Shift \+ F10', 'On a focused row: a session or project row opens its actions; a crew row opens the agent’s dossier\.'\]/.test(tutorial),
    'Shift+F10 on a crew row opens the dossier, and CONTROLS says so');
  A.ok(/e\.shiftKey && e\.key === 'F10'\)\) \{ e\.preventDefault\(\); const b = li\.getBoundingClientRect\(\); openProjectMenu\(/.test(read('frontend/app/app.js')), 'a project row\'s Shift+F10 opens its actions');
}

// ---- NEEDS YOU first ----
A.ok(/NEEDS YOU at the top of SESSIONS lists every one still waiting \(also NOTIFICATIONS › NEEDS YOU\)/.test(manualSrc),
  'the manual sends waiting approvals to NEEDS YOU at the top of SESSIONS first');
A.ok(/<b>NEEDS YOU<\/b> at the top of SESSIONS lists every job waiting on you \(also <b>NOTIFICATIONS › NEEDS YOU<\/b>\)/.test(tutorial),
  'the HELP chapter\'s WAITING entry names NEEDS YOU');

// ---- START FRESH is a boot-screen door only ----
const Places = require('../frontend/app/places.js');
const app = Places.PLACES.find(p => p.id === 'settings-app');
A.ok(app && !/START FRESH/.test(app.about) && /ERASE EVERYTHING/.test(app.about), 'APP & BACKUP lists ERASE EVERYTHING and not START FRESH: ' + (app && app.about));
{
  // P30 review fix: the agent manual must not put START FRESH under APP & BACKUP either — in any section. The settings
  // system section renders no START FRESH key; the only station-wide one is app.js's boot recovery screen.
  const Manual = require('../sidecar/manual.js');
  for (const s of Manual.MANUAL_SECTIONS) {
    const text = Manual.manualSection(s.id).replace(/\n/g, ' ');
    for (const clause of text.split(/;/)) {
      A.ok(!(/settings-app/.test(clause) && /START FRESH/.test(clause)), 'manual ' + s.id + ' never puts START FRESH under APP & BACKUP: ' + clause.slice(0, 120));
    }
  }
  A.ok(/START FRESH \(sets the old station aside\) is only on the startup recovery screen/.test(Manual.starnetManual()), 'CONCEPTS says where START FRESH really is');
  A.ok(/id="btn-unreachable-fresh"|btn-unreachable-fresh/.test(read('frontend/app/app.js')), 'the startup recovery screen owns the START FRESH key');
  A.ok(!/START FRESH/.test(read('frontend/app/stationui.js')), 'the SETTINGS window renders no START FRESH key');
}

// ---- MY WORK display words; keys unchanged ----
A.ok(/const WORK_LABELS = \{ tasks: 'TASKS', deliverables: 'DELIVERABLES', agents: 'AGENT DOSSIER', notifs: 'NOTIFICATIONS' \}/.test(station),
  'MY WORK\'s trail words read TASKS / AGENT DOSSIER, keyed by the unchanged window ids');
A.ok(/tasks:\s+\['TASKS',\s+buildTasks,/.test(station) && /agents:\s+\['AGENT DOSSIER',\s+buildAgents,/.test(station), 'window titles: TASKS and AGENT DOSSIER');
A.ok(/Manage planned tasks under MY WORK › TASKS/.test(station) && !/on the TASK BOARD and saved/.test(station), 'ABOUT names MY WORK › TASKS');

// ---- BROWSER promises only what it offers ----
A.ok(!/or in your own Chrome/.test(station), 'BROWSER settings never promise "your own Chrome"');
A.ok(/YOUR CHROME[^\n]*not offered/.test(read('frontend/app/outputbrowser.js')), 'outputbrowser.js still withholds YOUR CHROME');

// ---- stop lines ----
const Friendly = require('../frontend/app/friendlyerror.js');
for (const o of [undefined, { cancelSource: 'estop_by_run' }]) {
  const line = Friendly.stopLine('cancelled', o);
  A.ok(!/E-STOP/.test(line) && /Pause Automation in the StarNet tray menu/.test(line), 'stop line names the tray\'s Pause Automation: ' + line);
}

/* ---- org P05: "where do I paste my key?" has one answer per kind of key ----
   SETTINGS' tip and dock subtitle say what is actually in there; ABILITIES' own copy names its real tabs; AI & MODELS'
   API KEYS points service keys at CONNECT › ABILITIES › CONNECTED › API KEYS through the places.js target.
   (UX night 2026-10-26, Andrew: CONNECT "more like the settings menu" — ONE flat list APPS / CONNECTED / SKILL MARKET /
   SKILLS / TOOLS / EXTENSIONS; the old keys tab is the API KEYS block inside CONNECTED, reached by the same 'keys' section.) */
{
  const rd = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const sys = rd('frontend/app/systems.js'), idx = rd('frontend/index.html'), con = rd('frontend/app/windows/connectors.js');
  const ui = rd('frontend/app/stationui.js'), places = rd('frontend/app/places.js');
  A.ok(/tip: 'Models, keys, permissions, spending & more'/.test(sys), 'SETTINGS dock tip names what Settings holds, and says there is more');
  A.ok(/<small>models, keys, permissions, spending &amp; more<\/small>/.test(idx), 'the SETTINGS dock subtitle says the same line, on one line like its neighbours');
  A.ok(!/Keys, models, voice, data|keys, models, voice, data/.test(sys + idx), 'the old "keys, models, voice, data" line is gone');
  A.ok(!/in <b>MCP CONNECTORS<\/b>|in <b>KEYS<\/b>|in TOOLSETS:|'CATALOG' : 'MCP CONNECTORS'/.test(con), 'ABILITIES copy names no retired tab (MCP CONNECTORS, KEYS, TOOLSETS)');
  A.ok(!/SAVED API CONNECTIONS|CONNECTED SERVICES|BUILT-IN ABILITIES|label: 'CATALOG'/.test(con.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), 'ABILITIES copy names none of the pre-flat-list tabs (SAVED API CONNECTIONS, CONNECTED SERVICES, BUILT-IN ABILITIES, CATALOG)');
  A.ok(/Not listed\? Add it yourself in <b>CONNECTED<\/b>: a service by its address, or any platform’s API key\./.test(con), 'the APPS footer sends an unlisted platform to CONNECTED (a service by its address, or an API key)');
  A.ok(/\{ id: 'catalog', label: 'APPS'/.test(con) && /\{ id: 'mcp', label: 'CONNECTED'/.test(con) && /\{ id: 'toolsets', label: 'TOOLS'/.test(con) && /id="ab-keys"><span class="sec-l">API KEYS</.test(con), 'the names it uses are the real rail labels, and API KEYS is a real block of CONNECTED');
  // (live walk 10-14) the service-key door lands ON the API KEYS block — the place its sentence names — and the sign-in
  // services are named at APPS, the neighbouring section of that same window
  A.ok(/A key for any other service goes in CONNECT › ABILITIES › CONNECTED › API KEYS; Gmail, Notion and other sign-in services connect from APPS beside it\.<\/p>' \+\s*'<div class="mc-acts"><button type="button" class="bb sm" data-act="to-service-keys">▸ CONNECT › API KEYS<\/button><\/div>/.test(ui), 'API KEYS: one full-strength glass key to CONNECTED › API KEYS, outside the dimmed prose; Gmail/Notion named at APPS');
  A.ok(!/data-act="to-service-catalog"|↗ CATALOG<\/button>/.test(ui), 'the old door to CATALOG (which the sentence never named as the key place) is gone');
  A.ok(!/Keys for Gmail, Notion and other services live in CONNECT › ABILITIES › (?:SAVED API CONNECTIONS|CONNECTED › API KEYS)/.test(ui), 'never the old wrong claim: an API key cannot connect Gmail or Notion');
  A.ok(/toServiceKeys\.addEventListener\('click', \(\) => \{ sfx\('click'\); openTerm\('connectors', 'keys'\); \}\)/.test(ui), 'the key opens the connectors keys section');
  A.ok(/connectors: \{ keys: \['mcp', '#ab-keys'\]/.test(ui), 'and the keys section lands on CONNECTED, scrolled to its API KEYS block');
  A.ok(/P\('api-connections', 'CONNECT › ABILITIES › CONNECTED › API KEYS', [^\n]*\{ term: 'connectors', section: 'keys' \}\)/.test(places), 'which is the places.js api-connections target');
  A.ok(/P\('find-a-service', [^\n]*\{ term: 'connectors', section: 'catalog' \}\)/.test(places) && /\{ id: 'catalog', label: 'APPS'/.test(con), 'APPS, named for the sign-in services, is a real section of that window');
  // (live walk 10-14) the STORE under the key keeps the section's spacing, never flush against the key
  const setCss = rd('frontend/css/settings.css');
  A.ok(/\.settings-console \.mc-acts \+ #credits-store:not\(:empty\) \{ margin-top: 18px; \}/.test(setCss) && /'<div id="credits-store"><\/div>';/.test(ui), 'the STORE sits 18px below the API KEYS key row');
  // the named examples really are SIGN IN catalog connectors (the reason the door is APPS, not API KEYS)
  const cat = rd('sidecar/mcp/catalog.js');
  for (const id of ['gmail', 'notion']) A.ok(new RegExp("\\{ id: '" + id + "', [^\\n]*authType: 'oauth'").test(cat), id + ' is an oauth CATALOG connector');
  // the public "Connect a service" guide walks the same paths the app shows (P05 review): no retired window or tab name
  const guide = rd('website/docs/connect-a-platform.html');
  A.ok(!/TOOLSETS &amp; CONNECTORS|&#8644; TOOLSETS|in <b>KEYS<\/b>|row in\s+KEYS|in TOOLSETS\.|MCP CONNECTORS|PICK A PLATFORM|SAVED API CONNECTIONS|CONNECTED SERVICES|BUILT-IN ABILITIES|<b>CATALOG<\/b>/.test(guide), 'the Connect a service guide names no retired window or tab (TOOLSETS & CONNECTORS, KEYS, TOOLSETS, PICK A PLATFORM, SAVED API CONNECTIONS, CONNECTED SERVICES, BUILT-IN ABILITIES, CATALOG)');
  A.ok(/CONNECT &rsaquo; ABILITIES &rarr; CONNECTED &rarr; Add an API key/.test(guide) && /\(dock: <b>&#8644; CONNECT<\/b>\)/.test(guide), 'its paths read CONNECT › ABILITIES › CONNECTED › Add an API key, from the ⇄ CONNECT dock button');
  // the other public pages that name the key place say the same thing (privacy names it as the place a key is saved)
  for (const f of ['website/docs/glossary.html', 'website/docs/providers.html', 'website/legal/privacy.html', 'website/legal/_privacy.nocredits.html', 'website/docs/skills.html', 'website/docs/guides/routines.html'])
    A.ok(!/SAVED API CONNECTIONS|CONNECTED SERVICES|BUILT-IN ABILITIES|SKILL LIBRARY|AGENT SKILLS|SKILL EXCHANGE|DISCOVER › SKILL MARKET/.test(rd(f)), f + ' names no pre-flat-list ABILITIES tab');
}

A.report('help-copy-matches-screen.test');
