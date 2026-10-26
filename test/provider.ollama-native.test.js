/* node test/provider.ollama-native.test.js - Ollama chat on its native /api/chat with a request-sized window.
   Issue #20 reproduced on a real Ollama 0.34.4: /v1/chat/completions ran qwen3:8b at the server default of 4096
   tokens, ignored every request for more, and silently kept 2050 of a 20969-token task prompt (the tail of the
   tool list), so the model said it could not create files. These tests pin the translation and the sizing. */
'use strict';
const A = require('./_assert.js');
const N = require('../sidecar/providers/ollama-native.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const factory = require('../sidecar/providers/factory.js');
const errorClass = require('../sidecar/providers/errorClass.js');

async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }
const ndjson = rows => new Response(rows.map(r => JSON.stringify(r)).join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
const SHOW = (ctx, caps) => new Response(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': ctx }, capabilities: caps }), { status: 200 });
const TOOLS = [{ type: 'function', function: { name: 'fs_write', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

module.exports = (async () => {
  // ---- pure translation ----
  A.eq(N.nativeRoot('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434', 'native root strips /v1');
  A.eq(N.nativeRoot('http://host:11434/v1/'), 'http://host:11434', 'native root strips a trailing slash too');
  {
    const body = {
      model: 'qwen3:8b', max_tokens: 4096, tools: TOOLS, reasoning_effort: 'none',
      messages: [
        { role: 'system', content: 'Policy' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_write', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'Wrote a.txt' }
      ]
    };
    const n = N.toNativeRequest(body, { numCtx: 32768 });
    A.eq(n.stream, true, 'native requests stream');
    A.eq(n.truncate, false, 'truncate:false turns a silent cut into a refusal');
    A.eq(n.options.num_ctx, 32768, 'the window rides options.num_ctx');
    A.eq(n.options.num_predict, 4096, 'the output ceiling rides options.num_predict');
    A.eq(n.think, false, "effort 'none' on the wire maps to think:false");
    A.eq(n.tools, TOOLS, 'tool schemas pass through unchanged');
    A.eq(n.messages[1].content, 'look\n[image: https://x.test/a.png]', 'text parts join; a remote image is named, not dropped');
    A.eq(n.messages[1].images, ['QUJD'], 'a data-URL image rides as bare base64');
    A.eq(n.messages[2].tool_calls[0].function.arguments, { path: 'a.txt' }, 'assistant tool arguments are objects natively');
    A.eq(n.messages[2].content, '', 'a null assistant content is an empty string');
    A.eq(n.messages[3].tool_name, 'fs_write', 'a tool result names the tool it answers');
    A.eq(N.toNativeRequest({ model: 'm', messages: [] }).think, undefined, 'no effort on the request = the model default (no think field)');
    A.eq(N.toNativeRequest({ model: 'm', messages: [], reasoning_effort: 'high' }).think, true, 'a real effort turns thinking on');
  }
  {
    const t = N.makeChunkTranslator();
    A.eq(t({ message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false }).choices[0].delta, { reasoning: 'hmm' }, 'thinking maps to delta.reasoning');
    const call = t({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', function: { index: 0, name: 'fs_write', arguments: { path: 'hello.txt' } } }] }, done: false });
    A.eq(call.choices[0].delta.tool_calls[0], { index: 0, id: 'call_x', type: 'function', function: { name: 'fs_write', arguments: '{"path":"hello.txt"}' } }, 'a native call becomes a complete chat-completions call');
    const end = t({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20969, eval_count: 175 });
    A.eq(end.choices[0].finish_reason, 'tool_calls', "Ollama's 'stop' after a call reports tool_calls");
    A.eq(end.usage, { prompt_tokens: 20969, completion_tokens: 175, total_tokens: 21144 }, 'the final line carries real usage');
    const t2 = N.makeChunkTranslator();
    A.eq(t2({ message: { content: 'x' }, done: true, done_reason: 'length' }).choices[0].finish_reason, 'length', 'an output-cap stop stays length');
    A.eq(t2({ error: 'boom' }), { error: { message: 'boom' } }, 'a mid-stream error line becomes an error chunk');
  }
  // ---- window sizing ----
  A.eq(N.pickNumCtx(25000, {}), 32768, 'a StarNet task (~21k prompt + 4k output) lands on 32k');
  A.eq(N.pickNumCtx(25000, { modelMax: 16384 }), 16384, 'never past the model\'s trained window');
  A.eq(N.pickNumCtx(900000, {}), N.DEFAULT_MAX_CTX, 'never past the ceiling');
  A.eq(N.pickNumCtx(1000, { floor: 32768 }), 32768, 'never steps down from a window the model already runs at (a reload)');
  A.eq(N.pickNumCtx(1000, { pinned: 12000 }), 12000, 'a pinned window wins outright');
  A.eq(N.pickNumCtx(1000, {}), 8192, 'a small request takes the smallest step');
  {
    const inner = '{"error":{"code":400,"message":"request (20969 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":20969,"n_ctx":4096}}';
    A.eq(N.exceedFrom(inner), { promptTokens: 20969, numCtx: 4096 }, 'the refusal is read from its fields');
    A.eq(N.exceedFrom(JSON.stringify({ error: inner })), { promptTokens: 20969, numCtx: 4096 }, '...and from the escaped copy inside the error string');
    A.eq(N.exceedFrom('request (9000 tokens) exceeds the available context size (8192 tokens)'), { promptTokens: 9000, numCtx: 8192 }, '...and from the sentence alone');
    A.eq(N.exceedFrom('model "x" not found'), null, 'any other error is not a window refusal');
  }
  A.eq(N.showFacts({ model_info: { 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] }), { contextLength: 131072, supportsTools: true, supportsReasoning: null }, '/api/show facts');
  A.eq(N.showFacts({ model_info: {}, capabilities: ['completion'] }).supportsTools, false, 'a model Ollama says has no tools support is false');
  A.eq(N.showFacts({ model_info: {} }).supportsTools, null, 'no capabilities list = unknown, never false');

  // ---- adapter: the native wire end to end ----
  {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), { status: 200 });
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools', 'thinking']);
      if (url.endsWith('/api/chat')) return ndjson([
        { message: { role: 'assistant', content: '', thinking: 'plan' }, done: false },
        { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', function: { name: 'fs_write', arguments: { path: 'hello.txt' } } }] }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20969, eval_count: 30 }
      ]);
      return new Response('unexpected ' + url, { status: 500 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true, maxTokens: 4096 });
    const ev = await collect(p, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'x'.repeat(84000) }], tools: TOOLS });
    const chat = calls.find(c => c.url.endsWith('/api/chat'));
    A.ok(chat, 'chat goes to /api/chat');
    A.ok(!calls.some(c => c.url.endsWith('/chat/completions')), 'the /v1 chat wire is not used');
    A.eq(chat.body.options.num_ctx, 32768, 'the window is sized to the request (~21k estimated + 4096 output -> 32k)');
    A.eq(chat.body.truncate, false, 'the request refuses silent truncation');
    A.eq(ev.filter(e => e.type === 'tool_start').map(e => e.name), ['fs_write'], 'the structured call reaches the loop');
    A.eq(ev.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"path":"hello.txt"}', 'with its arguments as JSON text');
    A.eq(ev.find(e => e.type === 'usage').usage.prompt_tokens, 20969, 'the real prompt size reaches cost + compaction');
    const done = ev.filter(e => e.type === 'done');
    A.eq(done.length, 1, 'exactly one terminal event');
    A.eq(done[0].truncated, false, 'done:true is a complete stream, not a cut one');
    A.eq(p.contextLimit('qwen3:8b'), 40960, 'the run sees the model\'s real window (min of trained max and ceiling)');
    await p.listModels();
    A.eq(p.supportsTools('qwen3:8b'), true, '/api/show capabilities make tool support known');
  }
  // A refusal resizes once; the larger window sticks for the next request (a smaller one would reload the model).
  {
    const sizes = [];
    const fetch = async (url, init) => {
      if (url.endsWith('/api/show')) return SHOW(131072, ['completion', 'tools']);
      if (url.endsWith('/api/chat')) {
        const b = JSON.parse(init.body);
        sizes.push(b.options.num_ctx);
        if (b.options.num_ctx < 65536) return new Response(JSON.stringify({ error: '{"error":{"code":400,"message":"request (40000 tokens) exceeds the available context size (' + b.options.num_ctx + ' tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":40000,"n_ctx":' + b.options.num_ctx + '}}' }), { status: 400 });
        return ndjson([{ message: { content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 40000, eval_count: 1 }]);
      }
      return new Response('{"data":[]}', { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true, maxTokens: 4096 });
    const ev = await collect(p, { model: 'big', messages: [{ role: 'user', content: 'short estimate' }] });
    A.eq(sizes, [8192, 65536], 'an under-estimate is refused with the exact count and resent once at a window that holds it');
    A.eq(ev.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'the resent request answers');
    sizes.length = 0;
    await collect(p, { model: 'big', messages: [{ role: 'user', content: 'tiny' }] });
    A.eq(sizes, [65536], 'the next request keeps the larger window');
  }
  // At the model's usable maximum there is nothing bigger: the refusal surfaces and classifies as an overflow,
  // so the loop's reactive compaction (not a blind retry) takes over.
  {
    let posts = 0;
    const fetch = async (url) => {
      if (url.endsWith('/api/show')) return SHOW(8192, ['completion', 'tools']);
      if (url.endsWith('/api/chat')) { posts++; return new Response(JSON.stringify({ error: 'request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it' }), { status: 400 }); }
      return new Response('{"data":[]}', { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true });
    let err = null;
    try { await collect(p, { model: 'small', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
    A.ok(err, 'a prompt bigger than the model can ever hold fails');
    A.eq(posts, 1, 'without resending at the same window');
    A.eq(errorClass.classifyApiError(err, { model: 'small' }).reason, 'context_overflow', 'the refusal classifies as a context overflow');
  }
  // A URL with no /api/chat (a /v1-only proxy in front of Ollama) keeps working on the /v1 wire.
  {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/api/show') || url.endsWith('/api/chat')) return new Response('404 page not found', { status: 404 });
      if (url.endsWith('/chat/completions')) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'via v1' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { status: 200 });
      return new Response('{"data":[]}', { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://proxy.test/v1', nativeOllama: true });
    const ev = await collect(p, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(ev.filter(e => e.type === 'text').map(e => e.delta).join(''), 'via v1', 'falls back to /v1 chat');
    await collect(p, { model: 'm', messages: [{ role: 'user', content: 'again' }] });
    A.eq(urls.filter(u => u.endsWith('/api/chat')).length, 1, 'and stays there for the instance');
  }
  // Ollama's own 404 for an unpulled model is a real error, not "no native wire".
  {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/api/show')) return new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 });
      if (url.endsWith('/api/chat')) return new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 });
      return new Response('{"data":[]}', { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true });
    let err = null;
    try { await collect(p, { model: 'nope', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
    A.ok(err && /not found/.test(err.message), 'an unpulled model fails with Ollama\'s own words');
    A.ok(!urls.some(u => u.endsWith('/chat/completions')), 'without silently trying the /v1 wire');
  }
  // A model Ollama says cannot call tools is known up front (the host then refuses a task with a clear message).
  {
    const fetch = async (url) => {
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gemma2:2b' }] }), { status: 200 });
      if (url.endsWith('/api/show')) return SHOW(8192, ['completion']);
      return new Response('{}', { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true });
    const models = await p.listModels();
    A.eq(models[0].context_length, 8192, 'the catalog carries the model\'s window');
    A.eq(p.supportsTools('gemma2:2b'), false, 'and its lack of tool support');
  }
  // The profile wires it: Ollama speaks native, a custom OpenAI-compatible endpoint never does.
  {
    const seen = [];
    const fetch = async (url) => { seen.push(url); return url.endsWith('/api/chat') ? ndjson([{ message: { content: 'hi' }, done: true, done_reason: 'stop' }]) : new Response('{}', { status: 200 }); };
    await collect(factory.selectProvider({ provider: 'ollama', fetch }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(seen.some(u => /127\.0\.0\.1:11434\/api\/chat$/.test(u)), 'the ollama profile chats on /api/chat');
    seen.length = 0;
    await collect(factory.selectProvider({ provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', fetch: async (url) => { seen.push(url); return new Response('data: [DONE]\n\n', { status: 200 }); } }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(seen.every(u => !/\/api\//.test(u)), 'a custom endpoint stays on /v1');
    // ...unless the custom endpoint IS an Ollama server (2026-10-11: a local Qwen added as CUSTOM ran at the 4k
    // default window and never saw its delegation tool).
    seen.length = 0;
    let customCtx = 0;
    await collect(factory.selectProvider({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', fetch: async (url, init) => {
      seen.push(url);
      if (url.endsWith('/api/chat')) { customCtx = JSON.parse(init.body).options.num_ctx; return ndjson([{ message: { content: 'hi' }, done: true, done_reason: 'stop' }]); }
      return new Response('{}', { status: 200 });
    } }), { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] });
    A.ok(seen.some(u => /localhost:11434\/api\/chat$/.test(u)), 'a CUSTOM endpoint on Ollama\'s port chats on the native /api/chat');
    A.ok(customCtx >= 8192, 'and asks for a real window, not the 4k server default');
    const prev = process.env.SKYNET_OLLAMA_NUM_CTX;
    process.env.SKYNET_OLLAMA_NUM_CTX = '12000';
    try {
      let ctx = 0;
      await collect(factory.selectProvider({ provider: 'ollama', fetch: async (url, init) => { if (url.endsWith('/api/chat')) { ctx = JSON.parse(init.body).options.num_ctx; return ndjson([{ message: { content: '' }, done: true }]); } return new Response('{}', { status: 200 }); } }), { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      A.eq(ctx, 12000, 'SKYNET_OLLAMA_NUM_CTX pins the window');
    } finally { if (prev == null) delete process.env.SKYNET_OLLAMA_NUM_CTX; else process.env.SKYNET_OLLAMA_NUM_CTX = prev; }
  }

  // The window outlives the provider INSTANCE (a run builds a fresh one): a greeting after a task must not reload
  // the model at a smaller window, and the next task must not reload it back.
  {
    const sizes = [];
    const fetch = async (url, init) => {
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
      if (url.endsWith('/api/chat')) { sizes.push(JSON.parse(init.body).options.num_ctx); return ndjson([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }]); }
      return new Response('{"models":[]}', { status: 200 });
    };
    const mk = () => makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://sticky.test:11434/v1', nativeOllama: true, maxTokens: 4096 });
    await collect(mk(), { model: 'q', messages: [{ role: 'user', content: 'x'.repeat(84000) }] });
    await collect(mk(), { model: 'q', messages: [{ role: 'user', content: 'hello' }] });
    A.eq(sizes, [32768, 32768], 'a small turn on a NEW provider instance keeps the window the task loaded');
  }
  // StarNet restarted while Ollama still holds the model at a larger window: adopt it instead of reloading smaller.
  {
    const sizes = [];
    const fetch = async (url, init) => {
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [{ name: 'q', size: 10e9, size_vram: 10e9, context_length: 32768 }] }), { status: 200 });
      if (url.endsWith('/api/chat')) { sizes.push(JSON.parse(init.body).options.num_ctx); return ndjson([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }]); }
      return new Response('{}', { status: 200 });
    };
    await collect(makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://loaded.test:11434/v1', nativeOllama: true }), { model: 'q', messages: [{ role: 'user', content: 'hello' }] });
    A.eq(sizes, [32768], 'an already-loaded window is kept (no reload to a smaller one)');
    A.eq(N.loadedWindow({ models: [{ name: 'q', context_length: 8192 }] }, 'other'), 0, 'a model that is not loaded has no window to adopt');
  }
  // A screenshot is megabytes of base64 but a fixed handful of tokens: it must not size the window to the ceiling.
  {
    const img = { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(2000000) } }] };
    const est = N.estimateTokens({ messages: [img] });
    A.ok(est > 1000 && est < 2000, 'an image counts as a flat allowance, not as its base64 length (got ' + est + ')');
  }

  // The host's own background calls (no tools, not a Commander turn) do not think on a thinking model: Ollama serves
  // one request at a time, and two such calls held the Commander's next greeting for 26s (measured, qwen3:8b).
  {
    const seen = [];
    const mkFetch = (caps) => async (url, init) => {
      if (url.endsWith('/api/show')) return SHOW(40960, caps);
      if (url.endsWith('/api/chat')) { seen.push(JSON.parse(init.body)); return ndjson([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }]); }
      return new Response('{"models":[]}', { status: 200 });
    };
    const thinker = () => makeOpenAICompatibleProvider({ fetch: mkFetch(['completion', 'tools', 'thinking']), baseUrl: 'http://think.test:11434/v1', nativeOllama: true });
    const msg = [{ role: 'user', content: 'hi' }];
    await collect(thinker(), { model: 'q', messages: msg });
    A.eq(seen.pop().think, false, 'a background call (no tools, isTask unset) tells a thinking model not to think');
    await collect(thinker(), { model: 'q', messages: msg, isTask: false });
    A.eq(seen.pop().think, undefined, 'a Commander greeting keeps the model default');
    await collect(thinker(), { model: 'q', messages: msg, tools: TOOLS, isTask: true });
    A.eq(seen.pop().think, undefined, 'a task keeps the model default');
    await collect(thinker(), { model: 'q', messages: msg, tools: TOOLS });
    A.eq(seen.pop().think, undefined, 'an internal run WITH tools keeps the model default');
    await collect(makeOpenAICompatibleProvider({ fetch: mkFetch(['completion', 'tools', 'thinking']), baseUrl: 'http://think.test:11434/v1', nativeOllama: true, sendReasoningEffort: true, reasoningEffort: 'high' }), { model: 'q', messages: msg, reasoningEffort: 'high' });
    A.eq(seen.pop().think, true, 'an explicit per-request reasoning effort (the aux tier) still wins on a background call');
    // Review providers-tools-04: a CUSTOM endpoint on Ollama's port carries CUSTOM's 'medium' run effort; a background
    // call that chose no effort of its own must not inherit it (it would think again and hold the next greeting).
    // (Once /api/show has been read, the catalog knows the model reasons and the effort reaches the wire: warm first.)
    const thinkFetch = mkFetch(['completion', 'tools', 'thinking']);
    const customOllama = factory.selectProvider({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', reasoningEffort: 'medium',
      fetch: async (url, init) => url.endsWith('/v1/models') ? new Response('{"data":[{"id":"q"}]}', { status: 200 }) : thinkFetch(url, init) });
    await collect(customOllama, { model: 'q', messages: msg, isTask: false }); seen.pop();
    await collect(customOllama, { model: 'q', messages: msg, tools: TOOLS, isTask: true });
    A.eq(seen.pop().think, true, 'a task on that endpoint keeps its effort');
    await collect(customOllama, { model: 'q', messages: msg });
    A.eq(seen.pop().think, false, 'a background call on a CUSTOM Ollama endpoint does not inherit the run effort');
    await collect(makeOpenAICompatibleProvider({ fetch: mkFetch(['completion', 'tools']), baseUrl: 'http://nothink.test:11434/v1', nativeOllama: true }), { model: 'q', messages: msg });
    A.eq('think' in seen.pop(), false, 'a model that cannot think is never sent the field');
  }

  // A silent local model reports placement evidence without inventing its loading or prompt-reading stage.
  {
    const ps = (vram) => ({ models: [{ name: 'qwen3:8b', size: 10e9, size_vram: vram, context_length: 32768 }] });
    A.ok(/entirely on the CPU/.test(N.placementNote(ps(0), 'qwen3:8b', 21000)), 'no VRAM = CPU only');
    A.ok(/~21k-token prompt/.test(N.placementNote(ps(0), 'qwen3:8b', 21000)), 'names the requested prompt estimate');
    A.ok(/only 40% on the GPU/.test(N.placementNote(ps(4e9), 'qwen3:8b', 21000)), 'a partial offload is stated as a share');
    A.ok(/fully on the GPU at a 32k window/.test(N.placementNote(ps(10e9), 'qwen3:8b', 21000)), 'a full GPU load is stated too');
    A.ok(!/smaller model/.test(N.placementNote(ps(10e9), 'qwen3:8b', 21000)), 'and no CPU advice when it is on the GPU');
    const absent = N.placementNote({ models: [] }, 'qwen3:8b', 21000);
    A.ok(/not listed as loaded/.test(absent), 'absence is reported as the observed status');
    A.ok(/may still be loading/.test(absent), 'loading is only a possibility');
    A.ok(!/so it was still loading|was still loading the model from disk/.test(absent), 'an absent model is not proof of disk loading');
    A.ok(!/had not finished reading/.test(N.placementNote(ps(10e9), 'qwen3:8b', 21000)), 'placement does not prove the model is reading the prompt');
    A.ok(/could not be read/.test(N.placementNote(null, 'qwen3:8b', 0)), 'an unreadable status says so, never guesses');
    A.ok(/^Ollama on this computer /.test(N.placementNote(ps(0), 'qwen3:8b', 21000)), 'a loopback server is named as this computer');
    // Review providers-tools-05: a remote Ollama (a GPU box on the LAN) is never called "this computer".
    for (const body of [ps(0), { models: [] }, null]) {
      const remote = N.placementNote(body, 'qwen3:8b', 21000, 'at ollama.lan');
      A.ok(/^Ollama at ollama\.lan /.test(remote) && !/this computer/.test(remote), 'a remote server is named by its host: ' + remote);
    }

    let statusBody = ps(0);
    const fetch = async (url, init) => {
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify(statusBody), { status: 200 });
      if (url.endsWith('/api/chat')) return new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
      return new Response('{"data":[]}', { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true, connectTimeoutMs: 30 });
    let err = null;
    try { await collect(p, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'x' }], preStreamRetries: 0 }); } catch (e) { err = e; }
    A.ok(err && /timed out/.test(err.message), 'a silent local model still times out');
    A.ok(err && /entirely on the CPU/.test(err.message), 'and the error says the model runs on the CPU (from /api/ps)');
    // #99 follow-up: a model /api/ps listed as loaded is not re-sent (test/ollama-loaded-timeout.test.js has the ladder)
    const loadedVerdict = errorClass.classifyApiError(err, { model: 'qwen3:8b' });
    A.eq([loadedVerdict.reason, loadedVerdict.retryable], ['local_timeout', false], 'a timeout on a loaded model classifies as local_timeout, not retried');
    statusBody = { models: [] };
    let absentErr = null;
    try { await collect(p, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'x' }], preStreamRetries: 0 }); } catch (e) { absentErr = e; }
    A.eq(absentErr && absentErr.phase, 'connect', 'missing placement does not change timeout phase');
    A.ok(absentErr && /not listed as loaded/.test(absentErr.message), 'actual timed-out request carries observed missing-model status');
    A.ok(absentErr && /may still be loading/.test(absentErr.message) && !/so it was still loading/.test(absentErr.message), 'actual adapter preserves uncertainty about loading');
    A.eq(errorClass.classifyApiError(absentErr, { model: 'qwen3:8b' }).reason, 'timeout', 'absent placement remains a timeout, not a model-load failure');
    statusBody = ps(0);
    const lan = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://ollama.lan:11434/v1', nativeOllama: true, connectTimeoutMs: 30 });
    let lanErr = null;
    try { await collect(lan, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'x' }], preStreamRetries: 0 }); } catch (e) { lanErr = e; }
    A.ok(lanErr && /Ollama at ollama\.lan had qwen3:8b loaded/.test(lanErr.message) && !/this computer/.test(lanErr.message), 'a remote timeout names the remote server');
  }

  // Explicit local allocation failures are terminal even when Ollama reports HTTP 500.
  // Replaying the same allocation caused repeated memory pressure after the owner's GPU/sidecar crash.
  {
    const details = [
      'llama-server reported out-of-memory during startup: cudaMalloc failed: out of memory',
      'failed to allocate CUDA0 buffer of size 4869357568',
      'failed to allocate buffer for kv cache',
      'model requires more system memory (8.0 GiB) than is available (1.1 GiB)'
    ];
    for (const detail of details) {
      for (const mode of ['http', 'stream', 'compatible-fallback']) {
        let posts = 0;
        const p = makeOpenAICompatibleProvider({ nativeOllama: true, baseUrl: 'http://localhost:11434/v1', fetch: async url => {
          if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
          if (url.endsWith('/api/chat') && mode === 'compatible-fallback') return new Response('not found', { status: 404 });
          if (url.endsWith('/api/chat') || url.endsWith('/chat/completions')) {
            posts++;
            return mode === 'stream' ? ndjson([{ error: detail }]) : new Response(JSON.stringify({ error: detail }), { status: 500 });
          }
          return new Response('{"data":[],"models":[]}', { status: 200 });
        } });
        let err;
        try { await collect(p, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hello' }] }); } catch (e) { err = e; }
        A.eq(posts, 1, mode + ': the failed allocation is never resent');
        const cls = errorClass.classifyApiError(err, { model: 'qwen3:8b' });
        A.eq(cls.reason, 'local_memory', mode + ': memory exhaustion has its own local category');
        A.eq(cls.retryable, false, mode + ': memory exhaustion cannot enter the host retry ladder');
        A.eq(require('../sidecar/recovery-policy.js').providerFailure({ classification: cls, hasFallback: false, maxRecoveries: 3 }).action,
          'fail', mode + ': with no eligible fallback it neither retries nor reallocates');
        A.eq(require('../sidecar/recovery-policy.js').providerFailure({ classification: cls, hasFallback: true, maxRecoveries: 3 }).action,
          'fallback', mode + ': a configured fallback (off this runtime, the loop decides) may take over');
        A.ok(/^Local model ran out of memory\./.test(err && err.message), mode + ': forwarded error carries an actionable local-memory headline');
        A.ok(err && err.message.includes(detail), mode + ': the exact allocation failure remains available for diagnostics');
      }
    }
    // Review providers-tools-05: an Ollama server on another machine is not "this computer": say which one.
    {
      const lan = makeOpenAICompatibleProvider({ nativeOllama: true, baseUrl: 'http://ollama.lan:11434/v1', fetch: async url => {
        if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
        if (url.endsWith('/api/chat')) return new Response(JSON.stringify({ error: details[1] }), { status: 500 });
        return new Response('{"data":[],"models":[]}', { status: 200 });
      } });
      let err;
      try { await collect(lan, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hello' }] }); } catch (e) { err = e; }
      A.ok(err && /^The model server at ollama\.lan ran out of memory\./.test(err.message), 'a remote allocation failure names that server: ' + (err && err.message));
      A.ok(err && !/Close other local models|this computer/.test(err.message), 'and never tells the Commander to close apps here');
      A.eq(errorClass.classifyApiError(err, { model: 'qwen3:8b' }).reason, 'local_memory', 'it is still the memory category');
    }
    // A generic hosted 500 with the same upstream detail stays retryable: this is an Ollama-specific decision.
    let posts = 0;
    const hosted = makeOpenAICompatibleProvider({ baseUrl: 'https://hosted.test/v1', fetch: async url => {
      if (url.endsWith('/chat/completions')) { posts++; return posts === 1
        ? new Response(JSON.stringify({ error: details[0] }), { status: 500 })
        : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 }); }
      return new Response('{"data":[]}', { status: 200 });
    } });
    await collect(hosted, { model: 'hosted', messages: [{ role: 'user', content: 'hello' }] });
    A.eq(posts, 2, 'hosted memory-related 500 keeps its transient retry behavior');
  }

  // The actual host loop must receive the terminal category and preserve the actionable message.
  {
    let posts = 0;
    const seq = [], waits = [], recoveries = [];
    const p = makeOpenAICompatibleProvider({ nativeOllama: true, baseUrl: 'http://127.0.0.1:11434/v1', fetch: async url => {
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
      if (url.endsWith('/api/chat')) { posts++; return new Response(JSON.stringify({ error: 'cudaMalloc failed: out of memory' }), { status: 500 }); }
      return new Response('{"data":[],"models":[]}', { status: 200 });
    } });
    const result = await require('../sidecar/loop.js').runAgentLoop({ provider: p, model: 'qwen3:8b', agentId: 'memory-test', runId: 'memory-test',
      messages: [{ role: 'user', content: 'hello' }], emit: (name, payload) => seq.push({ name, payload }),
      sleep: async ms => { waits.push(ms); }, onRecovery: row => recoveries.push(row) });
    A.eq(posts, 1, 'the real host loop does not restart a failed local model allocation');
    A.eq(waits, [], 'no adapter or host retry wait occurs');
    A.eq(recoveries, [], 'no retry recovery is falsely reported');
    A.eq([result.reason, result.failureStage, result.failureCode], ['error', 'provider_stream', 'local_memory'], 'terminal failure telemetry is retained');
    const error = seq.find(row => row.name === 'agent.run.error');
    A.eq(error && error.payload.transient, false, 'the actual emitted error is terminal');
    A.ok(error && /^Local model ran out of memory\./.test(error.payload.message), 'the actual error event carries the memory headline');
  }

  // Review providers-tools-02: out of memory fails over to a configured fallback OFF this local runtime, never to a
  // second model on the same Ollama (another allocation on the same GPU), and fails honestly when only those remain.
  for (const withHosted of [true, false]) {
    let localPosts = 0, hostedPosts = 0;
    const seq = [], waits = [];
    const local = makeOpenAICompatibleProvider({ nativeOllama: true, baseUrl: 'http://127.0.0.1:11434/v1', fetch: async url => {
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
      if (url.endsWith('/api/chat')) { localPosts++; return new Response(JSON.stringify({ error: 'failed to allocate CUDA0 buffer of size 4869357568' }), { status: 500 }); }
      return new Response('{"data":[],"models":[]}', { status: 200 });
    } });
    // the saved SETTINGS chain shape: a separate Ollama provider object on the same runtime, then a hosted one
    const localAgain = makeOpenAICompatibleProvider({ nativeOllama: true, baseUrl: 'http://127.0.0.1:11434/v1', fetch: async url => {
      if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
      if (url.endsWith('/api/chat')) { localPosts++; return new Response(JSON.stringify({ error: 'failed to allocate CUDA0 buffer' }), { status: 500 }); }
      return new Response('{"data":[],"models":[]}', { status: 200 });
    } });
    const hosted = makeOpenAICompatibleProvider({ baseUrl: 'https://hosted-fallback.test/v1', fetch: async url => {
      if (url.endsWith('/chat/completions')) { hostedPosts++; return new Response('data: {"choices":[{"delta":{"content":"hosted ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 }); }
      return new Response('{"data":[]}', { status: 200 });
    } });
    const fallbacks = [{ provider: local, providerId: 'ollama', model: 'qwen3:4b' }, { provider: localAgain, providerId: 'ollama', model: 'qwen3:1.7b' }];
    if (withHosted) fallbacks.push({ provider: hosted, providerId: 'openrouter', model: 'hosted/model' });
    const result = await require('../sidecar/loop.js').runAgentLoop({ provider: local, model: 'qwen3:14b', agentId: 'oom-fb', runId: 'oom-fb-' + withHosted,
      messages: [{ role: 'user', content: 'hello' }], fallbacks, emit: (name, payload) => seq.push({ name, payload }), sleep: async ms => { waits.push(ms); } });
    A.eq(localPosts, 1, (withHosted ? 'hosted chain' : 'local-only chain') + ': no second allocation on the same local runtime');
    A.eq(waits, [], 'no retry wait after a local out-of-memory');
    if (withHosted) {
      A.eq(hostedPosts, 1, 'the hosted fallback is taken');
      A.eq(result.reason, 'done', 'the run completes on the hosted fallback');
      const fb = seq.find(r => r.name === 'provider.fallback');
      A.ok(fb && fb.payload.toModel === 'hosted/model' && fb.payload.reason === 'local_memory', 'the failover receipt names the hosted model and the memory reason');
    } else {
      A.eq(result.reason, 'error', 'with only same-runtime fallbacks the run ends');
      const error = seq.find(r => r.name === 'agent.run.error');
      A.ok(error && /^Local model ran out of memory\./.test(error.payload.message), 'the memory headline is kept');
      A.ok(!seq.some(r => r.name === 'provider.fallback'), 'no failover to the same runtime is reported');
    }
  }

  /* GH#111 — THE OLLAMA CARD POINTED AT LM STUDIO. LM Studio answers a route it does not serve with HTTP 200 and ONE
     JSON object, {"error":"Unexpected endpoint or method. (POST /api/chat)"}, and that 200 was read as the native
     stream: a compact body surfaced the bare sentence (classified unknown, so retried), a pretty-printed one an EMPTY
     reply. The user must be told the URL is not Ollama, and which card speaks to it. */
  {
    const LMS = 'Unexpected endpoint or method. (POST /api/chat)';
    const lmStudio = (shape) => {
      const urls = [];
      const fetch = async (url, init) => {
        urls.push(url);
        const route = new URL(url).pathname;
        if (route === '/v1/models') return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }), { status: 200 });
        if (route === '/v1/chat/completions') return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'via v1' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { status: 200 });
        const body = { error: 'Unexpected endpoint or method. (' + ((init && init.method) || 'GET') + ' ' + route + ')' };
        const text = shape === 'pretty' ? JSON.stringify(body, null, 2) : JSON.stringify(body) + (shape === 'compact-nl' ? '\n' : '');
        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      return { urls, fetch };
    };
    for (const shape of ['compact', 'compact-nl', 'pretty']) {
      const s = lmStudio(shape);
      const p = makeOpenAICompatibleProvider({ fetch: s.fetch, baseUrl: 'http://127.0.0.1:1234/v1', nativeOllama: true });
      let err = null, ev = [];
      try { ev = await collect(p, { model: 'qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
      A.ok(err, shape + ': a 200 "no such route" from another server is an error, never an empty reply (got ' + JSON.stringify(ev) + ')');
      A.ok(err && /is not an Ollama server/.test(err.message), shape + ': the error says the URL is not Ollama: ' + (err && err.message));
      A.ok(err && /127\.0\.0\.1:1234/.test(err.message), shape + ': it names the server it reached');
      A.ok(err && /the way LM Studio does/.test(err.message), shape + ': it says what the server looked like, no more');
      A.ok(err && /SETTINGS → AI & MODELS → CUSTOM/.test(err.message), shape + ': it names the card that speaks to that server');
      A.ok(err && err.message.includes('[' + LMS + ']'), shape + ': the server\'s own words stay for diagnostics');
      const cls = errorClass.classifyApiError(err, { model: 'qwen2.5-7b-instruct' });
      A.eq([cls.reason, cls.retryable, cls.shouldFallback], ['endpoint_mismatch', false, false], shape + ': a wrong server is terminal: no retry, no fallback');
      A.eq(cls.message, err.message, shape + ': the adapter sentence is what the run reports');
      A.eq(s.urls.filter(u => u.endsWith('/api/chat')).length, 1, shape + ': the native chat was asked once');
      s.urls.length = 0;
      const again = await collect(p, { model: 'qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'again' }] });
      A.ok(!s.urls.some(u => u.endsWith('/api/chat')), shape + ': the native wire is off for this instance afterwards');
      A.eq(again.filter(e => e.type === 'text').map(e => e.delta).join(''), 'via v1', shape + ': the next call on it uses the /v1 wire');
    }
    // A pretty-printed error body of any other words is still that error, never an empty success.
    {
      const fetch = async (url) => {
        if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
        if (url.endsWith('/api/chat')) return new Response(JSON.stringify({ error: 'model runner has unexpectedly stopped' }, null, 2), { status: 200 });
        return new Response('{"data":[]}', { status: 200 });
      };
      let err = null, ev = [];
      try { ev = await collect(makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true }), { model: 'q', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
      A.ok(err && err.message === 'model runner has unexpectedly stopped', 'a pretty-printed error body throws its own words (got ' + (err ? err.message : JSON.stringify(ev)) + ')');
      A.ok(err && !err.endpointMismatch, 'and is not called a wrong server');
    }
    // Controls: Ollama's own first-line error keeps its words and its native wire; a body that is not JSON at all keeps
    // today's honest cut-stream end (Ollama proxies vary, so nothing is inferred from it).
    {
      const urls = [];
      const fetch = async (url) => {
        urls.push(url);
        if (url.endsWith('/api/show')) return SHOW(40960, ['completion', 'tools']);
        if (url.endsWith('/api/chat')) return ndjson([{ error: 'boom' }]);
        return new Response('{"data":[]}', { status: 200 });
      };
      const p = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true });
      for (let i = 0; i < 2; i++) {
        let err = null;
        try { await collect(p, { model: 'q', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
        A.eq(err && err.message, 'boom', 'an Ollama stream error keeps Ollama\'s words (call ' + (i + 1) + ')');
        A.ok(err && !err.endpointMismatch, 'and is never called a wrong server');
      }
      A.eq(urls.filter(u => u.endsWith('/api/chat')).length, 2, 'the native wire stays on after Ollama\'s own error');
      A.ok(!urls.some(u => u.endsWith('/chat/completions')), 'and nothing moved to the /v1 wire');
      const html = makeOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', nativeOllama: true, fetch: async (url) => {
        if (url.endsWith('/api/chat')) return new Response('<html>\n<body>proxy page</body>\n</html>', { status: 200 });
        return new Response('{"data":[]}', { status: 200 });
      } });
      const ev = await collect(html, { model: 'q', messages: [{ role: 'user', content: 'hi' }] });
      A.eq(ev.map(e => e.type + ':' + e.truncated), ['done:true'], 'a non-JSON 200 body still ends as one cut (truncated) stream');
    }
    // The real host loop: the named error reaches agent.run.error at once, with no retry ladder swallowing it into a
    // second (silent) attempt, and the run records why it failed.
    {
      const s = lmStudio('compact');
      const seq = [], waits = [];
      const p = makeOpenAICompatibleProvider({ fetch: s.fetch, baseUrl: 'http://127.0.0.1:1234/v1', nativeOllama: true });
      const result = await require('../sidecar/loop.js').runAgentLoop({ provider: p, model: 'qwen2.5-7b-instruct', agentId: 'lms-test', runId: 'lms-test',
        messages: [{ role: 'user', content: 'hello' }], emit: (name, payload) => seq.push({ name, payload }), sleep: async ms => { waits.push(ms); } });
      A.eq(s.urls.filter(u => /\/(?:api\/chat|chat\/completions)$/.test(u)).length, 1, 'the loop sends the turn once');
      A.eq(waits, [], 'no retry wait');
      A.eq([result.reason, result.failureStage, result.failureCode], ['error', 'provider_stream', 'endpoint_mismatch'], 'the run records the wrong-server failure');
      const error = seq.find(row => row.name === 'agent.run.error');
      A.ok(error && /is not an Ollama server/.test(error.payload.message) && /CUSTOM/.test(error.payload.message), 'the error event carries the named hint: ' + (error && error.payload.message));
      A.eq(error && error.payload.transient, false, 'and is terminal');
      A.ok(!seq.some(row => row.name === 'provider.retry'), 'no retry is reported');
    }
    /* THE CUSTOM CARD'S GUESS (review 10-15). A CUSTOM endpoint borrows the native wire only because its URL LOOKED like
       Ollama (port 11434, or "ollama" in the host name; factory.js looksLikeOllama). When that server is LM Studio, the
       wrong guess is StarNet's, not the user's: CUSTOM is already the card that speaks to it. The OLLAMA-card sentence
       told that user to do what they had done, on every run (the provider is rebuilt per run). The same turn goes once
       on the /v1 wire instead, the way the 404 path does, and no OLLAMA-card advice reaches a CUSTOM user. */
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://my-ollama.lan:1234/v1']) {
      for (const shape of ['compact', 'compact-nl', 'pretty']) {
        const tag = 'CUSTOM ' + baseUrl + ' ' + shape;
        const s = lmStudio(shape);
        const p = factory.selectProvider({ provider: 'custom', baseUrl, fetch: s.fetch });
        let err = null, ev = [];
        try { ev = await collect(p, { model: 'qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
        A.ok(!err, tag + ': a CUSTOM card on a non-Ollama server is not an error (got ' + (err && err.message) + ')');
        A.eq(ev.filter(e => e.type === 'text').map(e => e.delta).join(''), 'via v1', tag + ': the same turn is answered on the /v1 wire');
        A.eq(ev.filter(e => e.type === 'done').length, 1, tag + ': with exactly one terminal event');
        A.eq(s.urls.filter(u => u.endsWith('/api/chat')).length, 1, tag + ': the guessed native chat was asked once');
        A.eq(s.urls.filter(u => u.endsWith('/v1/chat/completions')).length, 1, tag + ': and the /v1 chat once');
        s.urls.length = 0;
        await collect(p, { model: 'qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'again' }] });
        A.ok(!s.urls.some(u => u.endsWith('/api/chat')), tag + ': the guess is not repeated on this instance');
      }
    }
    // A CUSTOM card whose /v1 then fails reports the /v1 failure in its own words, never the OLLAMA-card advice.
    {
      const s = lmStudio('compact');
      const fetch = async (url, init) => (url.endsWith('/v1/chat/completions')
        ? new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
        : s.fetch(url, init));
      let err = null;
      try { await collect(factory.selectProvider({ provider: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', fetch }), { model: 'q', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
      A.ok(err && err.status === 401 && /Invalid API key/.test(err.message), 'the /v1 failure is what a CUSTOM card reports: ' + (err && err.message));
      A.ok(err && !/OLLAMA card|is not an Ollama server/.test(err.message) && !err.endpointMismatch, 'and it carries no OLLAMA-card advice');
    }
    // The real host loop on a CUSTOM card: one run, answered, no retry wait and no error event.
    {
      const s = lmStudio('pretty');
      const seq = [], waits = [];
      const result = await require('../sidecar/loop.js').runAgentLoop({ provider: factory.selectProvider({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', fetch: s.fetch }),
        model: 'qwen2.5-7b-instruct', agentId: 'lms-custom', runId: 'lms-custom',
        messages: [{ role: 'user', content: 'hello' }], emit: (name, payload) => seq.push({ name, payload }), sleep: async ms => { waits.push(ms); } });
      A.eq(result.reason, 'done', 'a CUSTOM run on LM Studio completes: ' + JSON.stringify([result.reason, result.failureCode]));
      A.eq(waits, [], 'without a retry wait');
      A.ok(!seq.some(row => row.name === 'agent.run.error' || row.name === 'provider.retry'), 'and without an error or retry event');
      A.eq([s.urls.filter(u => u.endsWith('/api/chat')).length, s.urls.filter(u => u.endsWith('/v1/chat/completions')).length], [1, 1], 'one guessed native ask, one /v1 answer');
    }
    // The server named in the OLLAMA-card sentence is the URL's host:port as a URL parser reads it: credentials (even a
    // password with a raw "@") never reach COMMS, history or the diagnostics users paste into GitHub.
    {
      const s = lmStudio('compact');
      let err = null;
      try { await collect(makeOpenAICompatibleProvider({ fetch: s.fetch, baseUrl: 'http://user:p@ss@10.0.0.5:1234/v1', nativeOllama: true }), { model: 'q', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
      A.ok(err && err.message.includes('(10.0.0.5:1234)'), 'the sentence names host:port: ' + (err && err.message));
      A.ok(err && !err.message.includes('ss@') && !err.message.includes('user:'), 'and no part of the credentials');
    }
  }

  A.report('provider.ollama-native.test');
})();
