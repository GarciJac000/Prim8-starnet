'use strict';
/* node dev/cli-preview.cjs [rootDir] [--demo] — a REAL station (dev/seed.js, isolated workspace + profile) on a scripted
   local model, with a crew of four, for driving the `starnet` terminal dashboard without credentials or spend.

   The model streams its replies a word at a time and calls real tools (it opens the task brief, lists and reads files,
   writes one), so the dashboard has live text, tool lines and approvals to show. The crew runs on approvalMode 'ask'
   (SEED_FULL_ACCESS=0): every write waits for an answer. CLI_PREVIEW_DEBUG=1 logs what the model was offered.

   --desk plays the desk once into a station already running on the port.
   --demo plays the DESKTOP: once the station is up it starts work the way the page does (POST /api/run on a desk
   conversation, the floor's capability objects placed) — ASTRA fixes a redirect, CYPHER runs the tests, ULTRON drafts
   notes — so the dashboard shows runs it did not start, and their approvals. Answer them from the dashboard
   (y / n) or with `starnet approve`. --loop repeats the desk work every 90 s.

   Then, in another terminal:  node bin/starnet.js --port 9471   (or ls / watch / approve / flow).
   The scripted model proves the harness flow, not real-model judgment. */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'seed-workspace');
const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const LOOP = args.includes('--loop');
const DESK_ONLY = args.includes('--desk');   // a station is already up on the port: just play the desk once
const root = path.resolve(args.find(a => !a.startsWith('--')) || '.dogfood/cli-preview');
const port = Number(process.env.STARNET_PORT) || 9471;

const CREW = [
  { agentId: 'astra', name: 'ASTRA', role: 'backend fixer', system: 'You are ASTRA, a careful backend engineer aboard a StarNet station.' },
  { agentId: 'cypher', name: 'CYPHER', role: 'test runner', system: 'You are CYPHER, the station test runner.' },
  { agentId: 'ultron', name: 'ULTRON', role: 'writer', system: 'You are ULTRON, the station writer.' }
];

// scripted work, matched on the last user message: tools in order (by name pattern), then a streamed reply
const TASKS = [
  { when: /login redirect/i, steps: [[/^fs[._]read$/, { path: 'README.md' }], [/^fs[._]write$/, { path: 'auth-fix.md', content: '# Redirect fix\n\nKeep ?next= through the session refresh.\n' }]],
    reply: 'Found it. The session refresh dropped the ?next= param, so sign-in always landed on /home. I wrote the fix up in auth-fix.md.' },
  { when: /test suite/i, steps: [[/^fs[._]list$/, { path: '.' }], [/^fs[._]write$/, { path: 'test-report.md', content: '# Test report\n\n212 passing, 0 failing.\n' }]],
    reply: 'All 212 tests pass. The report is in test-report.md.' },
  { when: /release notes/i, steps: [[/^fs[._]list$/, { path: '.' }], [/^fs[._]write$/, { path: 'release-notes.md', content: '# Release notes\n\n- Redirect keeps ?next=.\n' }]],
    reply: 'Draft is in release-notes.md: one line for the redirect fix so far.' }
];

async function provider() {
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let body = ''; for await (const c of req) body += c;
    let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
    const messages = parsed.messages || [];
    const tools = (parsed.tools || []).map(t => t && t.function && t.function.name).filter(Boolean);
    res.setHeader('Content-Type', 'text/event-stream');
    const send = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    const end = (reason) => { res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }) + '\n\n'); res.end('data: [DONE]\n\n'); };
    const lastUser = messages.map(m => m.role).lastIndexOf('user');
    const raw = String((messages[lastUser] || {}).content || '');
    // the station wraps the Commander's words in a <run_context> block (station state, the task brief): match the words
    const user = (raw.lastIndexOf('</run_context>') >= 0 ? raw.slice(raw.lastIndexOf('</run_context>') + 14) : raw).trim();
    const used = messages.slice(lastUser + 1).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
    const task = TASKS.find(t => t.when.test(user));
    if (process.env.CLI_PREVIEW_DEBUG === '1') console.log('[mock] tools=' + tools.length + ' used=[' + used.join(',') + '] user=' + JSON.stringify(user.slice(0, 60)));
    if (!parsed.tools || !parsed.tools.length) {
      // a chat turn (no tools) still answers in words; station self-talk (titles, judges) gets a short label
      if (raw.indexOf('<run_context>') < 0) { send({ content: 'Station work' }); return end('stop'); }
      for (const word of ('Copy. You said: "' + user.slice(0, 80) + '". This is the scripted preview model.').split(' ')) { send({ content: word + ' ' }); await sleep(70); }
      return end('stop');
    }
    // a task opens its brief before any write (the station holds writes until it does)
    if (task && tools.includes('brief_proceed') && !used.includes('brief_proceed')) {
      await sleep(600);
      send({ tool_calls: [{ index: 0, id: 'brief' + Date.now(), type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify({ objective: user.slice(0, 120), deliverable: 'the change, done and checked' }) } }] });
      return end('tool_calls');
    }
    if (task) {
      for (const [rx, a] of task.steps) {
        const name = tools.find(n => rx.test(n));
        if (name && !used.includes(name)) {
          await sleep(1400);
          send({ tool_calls: [{ index: 0, id: name + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(a) } }] });
          return end('tool_calls');
        }
      }
    }
    const reply = task ? task.reply : 'Copy. ' + (user.length > 80 ? 'On it.' : 'You said: "' + user.slice(0, 80) + '". This is the scripted preview model, so that is all I can do.');
    for (const word of reply.split(' ')) { send({ content: word + ' ' }); await sleep(70); }
    end('stop');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}

function seedWorkspace(ws) {
  if (fs.existsSync(path.join(ws, 'agent.save.json'))) return;
  fs.mkdirSync(ws, { recursive: true });
  fs.cpSync(FIXTURE, ws, { recursive: true });
  const now = Date.now();
  const roster = JSON.parse(fs.readFileSync(path.join(ws, 'agent.roster.json'), 'utf8'));
  for (const a of roster.agents) { a.model = 'test/model'; a.approvalMode = 'ask'; }
  for (const c of CREW) roster.agents.push(Object.assign({ model: 'test/model', provider: 'openrouter', approvalMode: 'ask' }, c));
  roster.updatedAt = now;
  fs.writeFileSync(path.join(ws, 'agent.roster.json'), JSON.stringify(roster, null, 2));
  const save = JSON.parse(fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8'));
  save.updatedAt = now; save.savedAt = now;
  if (save.doc) { save.doc.updatedAt = now; if (save.doc.agent) save.doc.agent.model = 'test/model'; }
  fs.writeFileSync(path.join(ws, 'agent.save.json'), JSON.stringify(save, null, 2));
}

// the desk: work started the way the page starts it (its own conversation, the floor's objects placed)
async function desk(base, token) {
  const placed = [{ objectType: 'computer' }, { objectType: 'cabinet' }, { objectType: 'workbench' }];
  const runOne = (agentId, text) => new Promise(resolve => {
    const payload = Buffer.from(JSON.stringify({ model: 'test/model', provider: 'openrouter', agentId, streamId: 'desk-' + agentId, isTask: true, messages: [{ role: 'user', content: text }], placed }));
    const req = http.request(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'x-starnet-token': token, Origin: base } }, res => { res.resume(); res.on('end', resolve); res.on('close', resolve); });
    req.on('error', resolve);
    req.end(payload);
  });
  console.log('[cli-preview] the desk starts work for ASTRA, CYPHER and ULTRON');
  const jobs = [runOne('astra', 'fix the login redirect after sign-in')];
  await sleep(2500); jobs.push(runOne('cypher', 'get the test suite green'));
  await sleep(4000); jobs.push(runOne('ultron', 'draft the release notes'));
  await Promise.all(jobs);
  console.log('[cli-preview] desk work settled');
}

(async () => {
  if (DESK_ONLY) {
    const { makeClient } = require(path.join(REPO, 'bin', 'starnet.js'));
    const client = makeClient('127.0.0.1', port);
    const token = await client.discoverToken();
    if (!token) throw new Error('no station answering on ' + port);
    return desk(client.base, token);
  }
  const mock = await provider();
  const ws = path.join(root, 'workspace');
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile, { recursive: true });
  seedWorkspace(ws);
  const child = spawn(process.execPath, [path.join(__dirname, 'seed.js'), '--keep', '--workspace', ws], { windowsHide: true, stdio: 'inherit', env: {
    ...process.env, APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile,
    SKYNET_PORT: String(port), STARNET_PORT: String(port), SKYNET_DEFAULT_MODEL: 'test/model', SEED_FULL_ACCESS: '0',
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + mock.address().port + '/api/v1'
  } });
  child.on('exit', () => { mock.close(); process.exit(0); });
  process.on('exit', () => { try { child.kill(); } catch (_) {} });
  if (!DEMO) return;
  const { makeClient } = require(path.join(REPO, 'bin', 'starnet.js'));
  const client = makeClient('127.0.0.1', port);
  for (let i = 0; i < 120 && !(await client.health(1000)); i++) await sleep(500);
  const token = await client.discoverToken();
  if (!token) { console.error('[cli-preview] could not read the station token'); return; }
  console.log('[cli-preview] station up on http://127.0.0.1:' + port + ' — run: node bin/starnet.js --port ' + port);
  await sleep(LOOP ? 8000 : 15000);
  do { await desk(client.base, token); if (LOOP) await sleep(90000); } while (LOOP);
})().catch(e => { console.error(e); process.exitCode = 1; });
