/* bin/lib/app-modules.js — the desktop app's OWN modules, for the terminal's onboarding (bin/lib/awaken.js).

   The awakening in the terminal must be the app's awakening, not a copy that drifts: its interview prompts and parsers
   (wakemind.js), the Commander dossier (dossier.js), the autonomy presets (autonomy.js), the starter room and the station
   presets (worldmodel.js, stationtemplates.js), the save envelope (save.js) … are loaded from the app's frontend folder,
   which ships beside bin/ in the dev tree and in the installed app alike (…/StarNet/bin + …/StarNet/frontend/app).

   Two of them are browser-only scripts: personas.js (a page global) runs in a sandbox, and the system-prompt composer —
   app.js's own composeSystemPrompt and the clauses it folds in — is lifted out of app.js by name and run against the
   pieces it reads. So a terminal agent's prompt is the one the app would compose for it. A function that can no longer
   be lifted is an error here (test/cli-dashboard.test.js runs this against the real app.js, so a drift fails the gate). */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_DIR = path.join(__dirname, '..', '..', 'frontend', 'app');

// the source of one top-level `function name(…) { … }` in a script, by brace matching (strings, templates, comments and
// regex literals skipped), or null
function liftFunction(src, name) {
  const m = new RegExp('(^|\\n)([ \\t]*)(async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  const start = m.index + m[1].length + m[2].length;
  let i = src.indexOf('{', src.indexOf(')', start));
  if (i < 0) return null;
  let depth = 0, prev = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === '\'' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      prev = q; continue;
    }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && /[=(,:;!&|?{}\[]$/.test(prev)) {   // a regex literal
      i++;
      while (i < src.length && src[i] !== '/') { if (src[i] === '\\') i++; else if (src[i] === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } } i++; }
      prev = '/'; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    if (!/\s/.test(c)) prev = c;
  }
  return null;
}

// a browser script that declares one page global (const X = (() => …)()) → that global
function pageGlobal(file, name, sandbox) {
  const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
  return vm.runInNewContext(src + '\n;' + name, Object.assign({ console }, sandbox || {}), { filename: file });
}

const COMPOSER_PARTS = ['baseIdentity', 'orchestratorClause', 'agentDocs', 'rosterClause', 'foundationClause', 'approvalClause', 'composeSystemPrompt'];

/* the app's composeSystemPrompt, lifted: compose(agent, { crew, dossierBlock }) → the system prompt the app would send for
   that agent. crew = the other agents on the station (the orchestrator's YOUR CREW clause); dossierBlock = the Commander
   dossier block (Dossier.composeBlock). The parts it calls that live elsewhere in app.js are given to it here. */
function makeComposer(Personas) {
  const src = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
  const parts = COMPOSER_PARTS.map(n => { const f = liftFunction(src, n); if (!f) throw new Error('app.js no longer has function ' + n); return f; });
  const ctx = { Personas, console, __crew: [], __block: '' };
  ctx.liveAgents = () => ctx.__crew;
  ctx.rosterRole = a => String((a && (a.purpose || a.role)) || 'specialist').split('\n')[0].slice(0, 80);
  ctx.DossierStore = { composeBlock: () => ctx.__block };
  vm.runInNewContext(parts.join('\n') + '\n;this.__compose = composeSystemPrompt; this.__docs = agentDocs; this.__identity = baseIdentity;', ctx, { filename: 'app.js (lifted)' });
  return {
    compose(agent, o) {
      ctx.__crew = [agent].concat((o && o.crew) || []);
      ctx.__block = (o && o.dossierBlock) || '';
      return ctx.__compose(agent);
    },
    docs: a => ctx.__docs(a),
    identity: (name, role) => ctx.__identity(name, role)
  };
}

let cache = null;
function load() {
  if (cache) return cache;
  const req = f => require(path.join(APP_DIR, f));
  const m = {
    dir: APP_DIR,
    WakeMind: req('wakemind.js'), Dossier: req('dossier.js'), Autonomy: req('autonomy.js'), StationTemplates: req('stationtemplates.js'),
    WorldModel: req('worldmodel.js'), Interview: req('interview.js'), Classify: req('classify.js'), Profile: req('profile.js'),
    Understanding: req('understanding.js'), NightReport: req('nightreport.js'), Save: req('save.js'), Goals: req('goals.js'),
    Dialogue: req('dialogue.js').Dialogue
  };
  try { m.PropSprites = req('propsprites.js'); } catch (_) { m.PropSprites = null; }
  m.Personas = pageGlobal('personas.js', 'Personas');
  m.composer = makeComposer(m.Personas);
  cache = m;
  return m;
}

module.exports = { load, liftFunction, APP_DIR, COMPOSER_PARTS };
