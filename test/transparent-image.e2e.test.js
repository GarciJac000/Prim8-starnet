/* node test/transparent-image.e2e.test.js — REAL sidecar proof of the 2026-09-28 "transparent background" fix.

   A user with OpenRouter connected asked for a design with a transparent background. The Gemini default cannot make
   alpha, so the agent reached for the raw OpenRouter key through web_request, was told "add it in KEYS" (which
   refuses provider keys), and kept asking for access nobody can grant. The unit tests pin each module; this pins the
   COMPOSITION the host builds (studio route -> image_generate, KEYS resolver + reserved provider names -> web_request):

     1. image_generate {transparent:true} through the real host: the media call leaves the Gemini default for the
        alpha model, the saved file is the RGBA render, and the tool result the model reads says it was VERIFIED.
     2. web_request with ${OPENROUTER_API_KEY} through the real host: the refusal names a model-provider key and the
        built-in tool, never "add it in KEYS" (only true if index.js hands the resolver the reserved set).

   Provider and image responses are local mocks: zero spend, no network (the web_request target is an IP literal,
   which skips DNS, and the refusal fires before any send). Runs in test:http (child-process boot). */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { logoPng } = require('./helpers/png-fixture.js');

const HOST = '127.0.0.1';
const LOGO = logoPng();

function sse(res, delta, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const call = (id, name, args) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

function startProvider() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(req.url.includes('/models')
          ? { data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }
          : { data: {} }));
      }
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      requests.push({ body, authorization: String(req.headers.authorization || '') });
      if (Array.isArray(body.modalities) && body.modalities.includes('image')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + LOGO.toString('base64') } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.01 } }));
      }
      // Only the run's own turn may emit a tool call: auxiliary calls (titles, reviews) carry their own registries.
      const blob = JSON.stringify(body.messages || []);
      const offered = name => (body.tools || []).some(t => t && t.function && t.function.name === name);
      const answered = (body.messages || []).some(m => m && m.role === 'tool');
      if (!answered && blob.includes('SCENARIO_IMAGE') && offered('image_generate')) {
        return sse(res, call('make_logo', 'image_generate', { prompt: 'a fox logo for a t-shirt', transparent: true, path: 'images/fox.png' }), 'tool_calls');
      }
      if (!answered && blob.includes('SCENARIO_KEY') && offered('web_request')) {
        return sse(res, call('raw_key', 'web_request', { url: 'https://1.1.1.1/api/v1/models', headers: { Authorization: 'Bearer ${OPENROUTER_API_KEY}' } }), 'tool_calls');
      }
      return sse(res, { content: 'Finished.' });
    });
  });
  return new Promise(resolve => server.listen(0, HOST, () => resolve({ server, requests, baseUrl: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

// The tool result the model was shown: the role:'tool' message in the run's follow-up turn.
function toolResultFor(requests, callId) {
  for (const r of requests) {
    for (const m of (r.body.messages || [])) {
      if (m && m.role === 'tool' && m.tool_call_id === callId) return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    }
  }
  return '';
}

(async () => {
  const provider = await startProvider();
  const fixture = SidecarFixture.create({ prefix: 'transparent-image-', timeoutMs: 20000, env: {
    STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: '',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CREDITS_TOKEN: '', SKYNET_CREDITS_TOKEN: '', STARNET_CLOUD_URL: '',
    STARNET_IMAGE_MODEL: '', SKYNET_IMAGE_MODEL: '',
    SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0',
    STARNET_OPENROUTER_BASE: provider.baseUrl
  } });
  try {
    await fixture.start();
    const run = async (agentId, placed, content) => {
      const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        provider: 'openrouter', model: 'test/model', key: 'fixture-openrouter-key', agentId, isTask: true, placed,
        messages: [{ role: 'user', content }]
      }) });
      A.eq(r.status, 200, agentId + ': /api/run accepted');
      return (await r.text()).split('\n').filter(Boolean).map(x => JSON.parse(x));
    };

    // ---- 1. image_generate {transparent:true} through the real host ----
    const img = await run('studio-agent', ['studio'], 'SCENARIO_IMAGE: make me a fox logo for a t-shirt');
    const media = provider.requests.filter(r => Array.isArray(r.body.modalities) && r.body.modalities.includes('image'));
    A.eq(media.length, 1, 'exactly one media call was made');
    A.eq(media[0] && media[0].body.model, 'openai/gpt-5-image-mini', 'the host-built studio route renders a transparent ask on the alpha model');
    A.eq(media[0] && media[0].authorization, 'Bearer fixture-openrouter-key', 'the media call rides the connected OpenRouter key');
    A.ok(media[0] && /fully transparent background/.test(JSON.stringify(media[0].body.messages)), 'the media prompt asks for an alpha channel');
    const saved = path.join(fixture.workspace, 'studio-agent', 'images', 'fox.png');
    A.ok(fs.existsSync(saved) && fs.readFileSync(saved).equals(LOGO), 'the saved file is the RGBA render');
    const imgResult = toolResultFor(provider.requests, 'make_logo');
    A.ok(/Transparent background verified in the saved file: 83\.3% of pixels are see-through/.test(imgResult), 'the model is told the transparency was VERIFIED: ' + JSON.stringify(imgResult.slice(0, 400)));
    A.ok(/cannot output transparency, so openai\/gpt-5-image-mini rendered this/.test(imgResult), 'the model is told why the model changed');
    A.eq((img.filter(e => e.name === 'agent.run.end').pop() || {}).payload && img.filter(e => e.name === 'agent.run.end').pop().payload.reason, 'done', 'the transparent image run completes');

    // ---- 2. web_request with a provider key placeholder through the real host ----
    await run('dish-agent', ['dish'], 'SCENARIO_KEY: list the OpenRouter models with my key');
    const keyResult = toolResultFor(provider.requests, 'raw_key');
    A.ok(keyResult.length > 0, 'the web_request call reached the tool and its result reached the model');
    A.ok(/OPENROUTER_API_KEY is a model-provider key/.test(keyResult) && /do not ask the Commander for it/.test(keyResult), 'the host refuses a provider key as one: ' + JSON.stringify(keyResult.slice(0, 400)));
    A.ok(/image_generate/.test(keyResult) && /transparent:true/.test(keyResult), 'and points at the built-in tool');
    A.ok(!/add it in (?:CONNECT › ABILITIES|TOOLSETS & CONNECTORS)/.test(keyResult), 'it never sends the Commander to API KEYS');
  } finally {
    await fixture.dispose();
    provider.server.closeAllConnections(); await new Promise(r => provider.server.close(r));
  }
  A.report('transparent-image.e2e');
})().catch(e => { console.log('FAIL: transparent-image.e2e threw — ' + (e && e.stack || e)); process.exit(1); });
