'use strict';
// A streamless internal run (the quiet title call, the goal judge, pitch …) is the station talking to itself: a real
// sidecar files its rows in 'global' stamped 'internal', so recall and the conversation view never read them as the
// Commander's words (bug 4dee26ba). A Commander run on 'global' keeps its rows exactly as before.
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'] }] })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ocelot Habitat Survey' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'selftalk-transcript-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base,
    SKYNET_OPENROUTER_KEY: 'fixture', STARNET_OPENROUTER_KEY: 'fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0'
  } });
  async function run(body) {
    const r = await fixture.json('POST', '/api/run', Object.assign({ model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent' }, body));
    assert.equal(r.status, 200);
    const events = typeof r.body === 'string' ? r.body.trim().split('\n').filter(Boolean).map(JSON.parse) : null;
    assert(events && events.some(e => e.name === 'agent.run.end'), 'the run ends on its own NDJSON stream');
  }
  async function globalTurns() { const r = await fixture.json('GET', '/api/transcript?stream=global'); assert.equal(r.status, 200); return r.body.turns; }
  try {
    await fixture.start();
    const titlePrompt = 'Survey the ocelot habitat corridor\n\nAssistant reply (context only): The ocelot corridor runs';
    await run({ internal: true, isTask: false, system: 'Reply with ONLY a title.', messages: [{ role: 'user', content: titlePrompt }] });
    let turns = await globalTurns();
    assert(!turns.some(t => /ocelot/i.test(String(t.content))), 'the quiet title call is not shown as global dialogue: ' + JSON.stringify(turns));
    await run({ messages: [{ role: 'user', content: 'COMMANDER_GLOBAL: note the ocelot count' }] });
    turns = await globalTurns();
    assert.deepEqual(turns.filter(t => t.role === 'user').map(t => t.content), ['COMMANDER_GLOBAL: note the ocelot count'], 'a Commander run on global keeps its own rows');
    await fixture.restart();
    turns = await globalTurns();
    assert.deepEqual(turns.filter(t => t.role === 'user').map(t => t.content), ['COMMANDER_GLOBAL: note the ocelot count'], 'the stamp survives a restart');
    console.log('selftalk-transcript: a streamless internal run is filed as self-talk; a Commander global run is unchanged; both survive restart PASS');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
