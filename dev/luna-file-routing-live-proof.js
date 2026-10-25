/* node dev/luna-file-routing-live-proof.js — LIVE A/B for the 2026-10-25 user report on v0.14.0:
   "An agent with both INTEL CAB and DISH available repeatedly attempted to access local project files using shell
   commands and PowerShell. This triggered permission prompts and eventually caused the agent to report that the files
   were inaccessible. When explicitly instructed to use INTEL CAB instead, it immediately located and read the file."

   Drives a REAL hermetic sidecar (SidecarFixture: temp workspace + profile) against the REAL model (default
   openai/gpt-5.6-luna) through a local forwarding proxy to OpenRouter that only records the loop's requests. The agent
   has an INTEL CAB, a DISH and a WORKBENCH in ASK mode (the reporter's shell attempts raised approval cards, so the
   terminal was on its wire). The Commander names a file / a project folder OUTSIDE the agent's workspace, the way a
   user does. Every approval card is answered "allow once", like a Commander clicking through.

   Per run it reports which tool family touched the files FIRST, how many shell calls and approval cards it took, how
   many shell calls were refused after their card, and whether the answer carried the codename. PASS = the file tools
   went first, no shell call, codename found. PROOF_ENTRY=<a trunk sidecar/index.js> runs the baseline.
   Needs SKYNET_OPENROUTER_KEY (dev/.env.dev is read like dev/seed.js does). Optional: PROOF_MODEL, PROOF_RUNS (3),
   PROOF_TASKS (file,folder,project; "kind:runs" sets one count), PROOF_PATH_DECISION (once / always: the answer to a
   folder card; shell cards are always "once"), PROOF_OUT (a JSON file for the full per-run detail). */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('../test/helpers/sidecar-fixture.js');

for (const envFile of [path.join(__dirname, '.env.dev'), path.join(os.homedir(), 'Desktop', 'gen', 'dev', '.env.dev')]) {
  if (!fs.existsSync(envFile)) continue;
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
  break;
}
const KEY = String(process.env.SKYNET_OPENROUTER_KEY || '').trim();
const MODEL = String(process.env.PROOF_MODEL || 'openai/gpt-5.6-luna').trim();
const RUNS = parseInt(process.env.PROOF_RUNS || '3', 10);
// "kind" or "kind:runs" (runs defaults to PROOF_RUNS)
const TASKS = String(process.env.PROOF_TASKS || 'file,folder,project').split(',').map(s => s.trim()).filter(Boolean)
  .map(s => ({ kind: s.split(':')[0], runs: parseInt(s.split(':')[1] || '', 10) || RUNS }));
const ENTRY = process.env.PROOF_ENTRY ? path.resolve(process.env.PROOF_ENTRY) : undefined;
const RUN_MS = parseInt(process.env.PROOF_RUN_MS || '300000', 10);
// the answer to a "work with files in <folder>?" card: once (default, re-asked per call) or always (approves the folder)
const PATH_DECISION = process.env.PROOF_PATH_DECISION === 'always' ? 'always' : 'once';
const UPSTREAM = 'https://openrouter.ai/api/v1';
if (!KEY) { console.error('no SKYNET_OPENROUTER_KEY'); process.exit(2); }

// ---- forwarding proxy: everything piped to OpenRouter; the agent loop's requests (they carry fs_read) are recorded ----
function startProxy() {
  const stat = { loop: [] };
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const url = UPSTREAM + req.url.replace(/^\/api\/v1/, '');
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!/^(host|content-length|connection)$/i.test(k)) headers[k] = v;
      if (req.url.indexOf('/chat/completions') >= 0) {
        try { const j = JSON.parse(body.toString('utf8')); if ((j.tools || []).some(t => t && t.function && t.function.name === 'fs_read')) stat.loop.push(j); } catch (_) {}
      }
      let up;
      try { up = await fetch(url, { method: req.method, headers, body: req.method === 'GET' ? undefined : body }); }
      catch (e) { res.writeHead(502); res.end(String(e && e.message)); return; }
      const h = {}; up.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) h[k] = v; });
      res.writeHead(up.status, h);
      if (!up.body) { res.end(); return; }
      const reader = up.body.getReader();
      while (true) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ base: 'http://127.0.0.1:' + server.address().port + '/api/v1', stat, close: () => server.close() }));
  });
}

// a small real-looking project OUTSIDE the agent's workspace; the codename lives in one file only
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-proj-'));
  const codename = 'KESTREL-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Orbit Planner\n\nA small trip planner. See docs/ for release notes.\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orbit-planner', version: '1.4.2', scripts: { test: 'node src/app.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "'use strict';\nmodule.exports = function plan(a, b) { return [a, b]; };\n");
  fs.writeFileSync(path.join(dir, 'docs', 'RELEASE_NOTES.md'), '# Release notes\n\n## 1.4.2\n- Fixed the date picker.\n\n## Next release\nCodename: ' + codename + '\nTarget: November.\n');
  return { dir, codename };
}

// file: the Commander names the exact file · folder: names the project folder · project: a PROJECT session (the folder
// is blessed and the run is scoped to it, like a COMMS session opened on a project) and no path is named at all
function taskText(kind, dir) {
  if (kind === 'file') return 'Read ' + path.join(dir, 'docs', 'RELEASE_NOTES.md') + ' and tell me the codename it gives for the next release.';
  if (kind === 'project') return 'Look through the files in this project and tell me which one gives the codename for the next release, and what the codename is.';
  return 'My project is in ' + dir + ' — which file in it gives the codename for the next release, and what is the codename?';
}

const isShell = n => /^shell[._]exec$/.test(String(n || ''));
const isFs = n => /^fs[._](read|list|search)$/.test(String(n || ''));
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && (p.text || p.content)) || '').join('') : '';

async function oneRun(kind, idx) {
  const proxy = await startProxy();
  const proj = makeProject();
  const fixture = SidecarFixture.create({ prefix: 'luna-routing-', timeoutMs: 30000, entry: ENTRY,
    env: { SKYNET_OPENROUTER_BASE: proxy.base, SKYNET_QUEST_REFRESH: '0', SKYNET_AUX_BUDGET: '0' } });
  await fixture.start();
  const events = [], prompts = [];
  let runId = '', timedOut = false;
  const ac = new AbortController();
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, RUN_MS);
  try {
    if (kind === 'project') {
      const b = await fixture.request('/api/projects/bless', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: proj.dir }) });
      if (b.status !== 200) throw new Error('project bless refused: ' + b.status + ' ' + await b.text());
    }
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ key: KEY, model: MODEL, agentId: 'luna-' + kind + '-' + idx, streamId: 'luna-stream-' + idx, isTask: true,
        projectRoot: kind === 'project' ? proj.dir : undefined,
        placed: ['cabinet', 'dish', 'workbench'], messages: [{ role: 'user', content: taskText(kind, proj.dir) }] }) });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
          events.push(ev);
          if (!runId && ev.payload && ev.payload.runId) runId = ev.payload.runId;
          if (ev.name === 'permission.prompt') {
            prompts.push({ tool: ev.payload.tool, args: String(ev.payload.argsSummary || '').slice(0, 160) });
            const decision = ev.payload.tool === 'path.trust' ? PATH_DECISION : 'once';
            fixture.request('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) }).catch(() => {});
          }
        }
      }
    } catch (e) { if (!timedOut) throw e; }
  } finally {
    clearTimeout(timer);
    await fixture.dispose(); proxy.close();
  }
  // the model's own view: every tool call it made and the exact result text it read back (last loop request)
  const last = proxy.stat.loop[proxy.stat.loop.length - 1] || { messages: [] };
  const sys = textOf(((last.messages || [])[0] || {}).content);
  const steps = [];
  for (const m of last.messages || []) {
    for (const tc of (m && m.tool_calls) || []) steps.push({ id: tc.id, tool: tc.function && tc.function.name, args: String(tc.function && tc.function.arguments || '').slice(0, 200), result: '' });
    if (m && m.role === 'tool') { const s = steps.find(x => x.id === m.tool_call_id); if (s) s.result = textOf(m.content).slice(0, 300); }
  }
  let answer = '';
  for (const ev of events) if (ev.name === 'agent.token') answer += (ev.payload && ev.payload.delta) || '';
  const calls = events.filter(e => e.name === 'agent.tool_call').map(e => e.payload.name);
  const fileCalls = calls.filter(n => isShell(n) || isFs(n));
  const end = events.find(e => e.name === 'agent.run.end');
  const out = {
    sidecar: ENTRY ? 'PROOF_ENTRY' : 'this tree', model: MODEL, task: kind, run: idx,
    reason: timedOut ? 'TIMEOUT' : (end && end.payload.reason), turns: end && end.payload.turns, usd: end && end.payload.usd,
    firstFileTool: fileCalls.length ? (isShell(fileCalls[0]) ? 'shell' : 'fs') : 'none',
    shellCalls: calls.filter(isShell).length, fsCalls: calls.filter(isFs).length,
    shellCards: prompts.filter(p => /shell/.test(p.tool)).length, otherCards: prompts.filter(p => !/shell/.test(p.tool)).map(p => p.tool),
    shellRefusedAfterCard: steps.filter(s => isShell(s.tool) && /refused/i.test(s.result)).length,
    found: answer.indexOf(proj.codename) >= 0,
    saidInaccessible: /inaccessible|can(?:no|')t access|cannot (?:read|open|reach)|unable to (?:access|read|open)|(?:don't|do not) have access|not (?:able|allowed) to (?:access|read)/i.test(answer),
    promptHasShellAnchor: sys.indexOf('first anchor shell_exec.cwd') >= 0,
    calls,
    steps: steps.map(s => ({ tool: s.tool, args: s.args, result: s.result.slice(0, 160) })),
    answer: answer.slice(-400)
  };
  out.PASS = !!(out.reason === 'done' && out.firstFileTool === 'fs' && out.shellCalls === 0 && out.found);
  try { fs.rmSync(proj.dir, { recursive: true, force: true }); } catch (_) {}
  return out;
}

(async () => {
  const results = [];
  for (const { kind, runs } of TASKS) {
    for (let i = 1; i <= runs; i++) {
      const r = await oneRun(kind, i);
      results.push(r);
      const brief = Object.assign({}, r); delete brief.steps; delete brief.answer; delete brief.calls;
      console.log(JSON.stringify(brief));
    }
  }
  if (process.env.PROOF_OUT) fs.writeFileSync(process.env.PROOF_OUT, JSON.stringify(results, null, 1));
  const sum = (f) => results.reduce((n, r) => n + (f(r) || 0), 0);
  console.log('luna-file-routing: ' + results.filter(r => r.PASS).length + '/' + results.length + ' PASS · shell-first ' + results.filter(r => r.firstFileTool === 'shell').length
    + ' · shell calls ' + sum(r => r.shellCalls) + ' · shell cards ' + sum(r => r.shellCards) + ' · refused after card ' + sum(r => r.shellRefusedAfterCard)
    + ' · found ' + results.filter(r => r.found).length + ' · said inaccessible ' + results.filter(r => r.saidInaccessible).length + ' · $' + sum(r => r.usd).toFixed(4));
  process.exit(results.every(r => r.PASS) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
