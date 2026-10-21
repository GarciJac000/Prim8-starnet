/* node test/mcp.stdio.test.js - MCP stdio transport:
   real newline-framed child process, command allowlist, env redaction/minimal
   inheritance, manager wiring, consent flags, and close cleanup. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { makeMcpClient } = require('../sidecar/mcp/client.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
const { makeStdioTransport, _internals: T } = require('../sidecar/mcp/transport.stdio.js');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  return predicate();
}
function writeServer(dir) {
  const file = path.join(dir, 'stdio-server.js');
  fs.writeFileSync(file, [
    "'use strict';",
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }",
    "rl.on('line', line => {",
    "  let msg; try { msg = JSON.parse(line); } catch (_) { return; }",
    "  if (!msg || msg.id == null) return;",
    "  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', explicit: process.env.SECRET_TOKEN || '', ambient: process.env.OPENROUTER_KEY || '' } });",
    "  if (msg.method === 'tools/list') return reply(msg.id, { tools: [",
    "    { name: 'create_issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },",
    "    { name: 'read_note', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }",
    "  ] });",
    "  if (msg.method === 'tools/call') return reply(msg.id, { content: [{ type: 'text', text: 'called ' + msg.params.name + ' ' + JSON.stringify(msg.params.arguments || {}) }] });",
    "  return reply(msg.id, {});",
    "});",
    "process.on('SIGTERM', () => process.exit(0));"
  ].join('\n'));
  return file;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-mcp-stdio-'));
  const server = writeServer(tmp);
  const nodeBase = path.basename(process.execPath);
  try {
    // allowlist + env hygiene
    A.notThrows(() => T.assertAllowedCommand(process.execPath, [nodeBase]), 'the current node executable can be explicitly allowlisted');
    A.throws(() => makeStdioTransport({ command: 'cmd.exe', allowedCommands: [nodeBase] }), 'non-allowlisted command is refused before spawn');
    const childEnv = T.buildChildEnv({ SECRET_TOKEN: 'explicit-secret' }, { PATH: 'safe-path', OPENROUTER_KEY: 'ambient-secret' });
    A.eq(childEnv.SECRET_TOKEN, 'explicit-secret', 'explicit stdio env is passed through');
    A.eq(childEnv.OPENROUTER_KEY, undefined, 'ambient secret env is not inherited by default');
    A.eq(childEnv.STARNET_COMPUTER_DRIVER, '0', 'connector env cannot enable the physical-input driver');
    A.eq(childEnv.STARNET_BROWSER_HEADLESS, '1', 'connector env is pinned headless');
    A.throws(() => makeStdioTransport({ command: process.execPath, allowedCommands: [nodeBase], processEnv: {} }), 'stdio defaults to denied without an isolated process broker');
    A.throws(() => makeStdioTransport({ command: process.execPath, allowedCommands: [nodeBase], processEnv: { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_MCP_STDIO: '0' } }), 'installed preserve mode refuses stdio before spawn');
    const redacted = T.redactEnv({ SECRET_TOKEN: 'explicit-secret', MODE: 'test' });
    A.eq(redacted.SECRET_TOKEN, '<redacted>', 'secret-like env keys redact their value');
    A.eq(redacted.MODE, '<set>', 'non-secret env keys still avoid exposing values');
    A.eq(T.safeLedgerCommand('npx', ['--token', 'secret-value', '@scope/server@1']).indexOf('secret-value'), -1, 'orphan receipt command redacts secret argv');

    // real child process, newline-framed JSON-RPC
    {
      const errors = [];
      const ledgered = [], released = [];
      const tp = makeStdioTransport({
        userControlIsolated: true,
        command: process.execPath,
        args: [server],
        env: { SECRET_TOKEN: 'explicit-secret' },
        processEnv: { PATH: process.env.PATH || '', OPENROUTER_KEY: 'ambient-secret' },
        allowedCommands: [nodeBase],
        timeoutMs: 1000,
        onError: e => errors.push((e && e.message) || String(e)),
        ledger: { record: row => ledgered.push(row), release: pid => released.push(pid) }
      });
      const client = makeMcpClient({ transport: tp, timeoutMs: 1000 });
      const init = await client.initialize();
      A.eq(ledgered.length, 1, 'stdio child is recorded in the durable process ownership ledger at spawn');
      A.eq(ledgered[0].kind, 'mcp.stdio', 'ledger receipt identifies the MCP child kind');
      A.eq(init.serverInfo.explicit, 'explicit-secret', 'stdio child sees explicit connector env');
      A.eq(init.serverInfo.ambient, '', 'stdio child does not inherit ambient secrets');
      const tools = await client.listTools();
      A.eq(tools.map(t => t.name).sort(), ['create_issue', 'read_note'], 'tools/list arrives over newline-framed stdio');
      const called = await client.callTool('create_issue', { title: 'hi' });
      A.ok(called.content[0].text.indexOf('called create_issue') >= 0, 'tools/call round-trips through the child process');
      client.close('test cleanup');
      await waitFor(() => released.length === 1);
      A.eq(tp.isClosed(), true, 'transport close marks the stdio child closed');
      A.eq(errors.length, 0, 'happy-path stdio child produced no transport errors');
      A.eq(released.length, 1, 'clean stdio child exit releases its ownership receipt');
    }

    // manager wiring + sanitized summaries + MCP consent posture
    {
      const mgr = makeConnectorManager({
        makeTransport: cfg => {
          A.eq(cfg.transport, 'stdio', 'manager passes the stdio transport kind to the transport factory');
          A.eq(cfg.agentId, 'safe-agent', 'manager passes the durable Safe Cell owner to the transport factory');
          return makeStdioTransport(Object.assign({}, cfg, {
            userControlIsolated: true,
            processEnv: { PATH: process.env.PATH || '', OPENROUTER_KEY: 'ambient-secret' },
            allowedCommands: [nodeBase],
            timeoutMs: 1000
          }));
        },
        clock: { now: () => 123 },
        timeoutMs: 1000
      });
      const r = await mgr.configure('local', {
        transport: 'stdio',
        command: process.execPath,
        args: [server, '--token', 'synthetic-arg-secret', '--api-key=synthetic-inline-secret', 'https://local.invalid/mcp?password=synthetic-query-secret'],
        cwd: os.tmpdir(),
        env: { SECRET_TOKEN: 'explicit-secret' },
        agentId: 'safe-agent',
        label: 'Local'
      });
      A.eq(r.ok, true, 'stdio connector configured through manager');
      A.eq(r.state, 'up', 'stdio connector reaches up state');
      const status = mgr.status('local');
      A.eq(status.transport, 'stdio', 'status records stdio transport');
      A.eq(status.agentId, 'safe-agent', 'status names the Safe Cell agent that owns the stdio child');
      A.eq(status.url, undefined, 'stdio status does not pretend to have an HTTP URL');
      A.eq(status.env.SECRET_TOKEN, '<redacted>', 'manager summary redacts stdio env values');
      A.eq(JSON.stringify(status).indexOf('explicit-secret'), -1, 'manager summary never leaks the env secret');
      A.eq(JSON.stringify(status).indexOf('synthetic-arg-secret'), -1, 'manager summary redacts a following secret argument');
      A.eq(JSON.stringify(status).indexOf('synthetic-inline-secret'), -1, 'manager summary redacts an inline secret argument');
      A.eq(JSON.stringify(status).indexOf('synthetic-query-secret'), -1, 'manager summary redacts URL arguments');
      A.eq(status.hasCwd, true, 'manager summary reports that a custom cwd exists');
      A.eq('cwd' in status, false, 'manager summary does not expose the workspace path');
      const defs = mgr.toolDefsFor('local');
      A.eq(defs.find(d => d.name === 'mcp__local__create_issue').requiresConsent, true, 'mutating MCP stdio tools still require consent');
      A.eq(defs.find(d => d.name === 'mcp__local__read_note').requiresConsent, true, 'stdio MCP annotations cannot suppress live consent');
      A.eq(defs.find(d => d.name === 'mcp__local__read_note').impact, 'external-unknown', 'stdio MCP tools are classified as untrusted local effects');
      const out = await defs.find(d => d.name === 'mcp__local__create_issue').run({ title: 'ship' }, {});
      A.ok(out.content.indexOf('called create_issue') >= 0, 'projected stdio MCP tool dispatches through the warm client');
      await mgr.close();
    }

    // CLEAN IDLE SELF-EXIT IS STILL A TRANSPORT DEATH. The exit hook used to skip onError for a code-0
    // exit with nothing pending, so the manager kept state 'up' over a dead child: ensureLive short-
    // circuits on 'up', the stdio call path has no CALL_FAIL_LIMIT net, and per-call lastUsedAt bumps
    // held off the idle recycle — the connector answered -32000 forever while the panel said up.
    {
      const quitFile = path.join(tmp, 'stdio-quitter.js');
      fs.writeFileSync(quitFile, [
        "'use strict';",
        "const readline = require('readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  let msg; try { msg = JSON.parse(line); } catch (_) { return; }",
        "  if (!msg || msg.id == null) return;",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'quitter' } } }) + '\\n');",
        "  setTimeout(() => process.exit(0), 50);"
      ].concat(["});"]).join('\n'));
      const deaths = [];
      const tp2 = makeStdioTransport({
        userControlIsolated: true, command: process.execPath, args: [quitFile],
        env: {}, processEnv: { PATH: process.env.PATH || '' }, allowedCommands: [nodeBase], timeoutMs: 1000,
        onError: e => deaths.push((e && e.message) || String(e))
      });
      const cl2 = makeMcpClient({ transport: tp2, timeoutMs: 1000 });
      await cl2.initialize();
      A.ok(await waitFor(() => deaths.length > 0, 2000), 'a clean idle code-0 self-exit still reports transport death (never a wedged "up")');
      tp2.close();
    }

    // INCREMENTAL FRAMING. The parser appended every chunk to one string and re-ran /\r?\n/ over the whole
    // unterminated line each time: a 16 MB reply arriving in 64 KB pipe chunks cost ~2.5 s of host CPU (4 MB:
    // ~0.3 s; quadratic). Only the new chunk is searched now. The child is injected so the chunking is exact; the
    // transport, client and JSON-RPC routing are the real ones.
    {
      const EE = require('events');
      let fake = null;
      const mkFake = () => {
        const c = new EE(); c.stdout = new EE(); c.stderr = new EE(); c.pid = 0; c.kill = () => {};
        c.stdin = { write(line, enc, cb) {
          const msg = JSON.parse(line);
          if (msg.id == null) { if (cb) cb(); return true; }   // notifications/initialized
          setImmediate(() => {
            if (msg.method === 'initialize') return c.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }) + '\r');
            if (msg.method !== 'tools/call') return c.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
            const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'z'.repeat(16 * 1024 * 1024) }] } }) + '\r\n';
            for (let i = 0; i < body.length; i += 65536) c.stdout.emit('data', body.slice(i, i + 65536));
          });
          if (cb) cb(); return true;
        }, end() {}, setDefaultEncoding() {} };
        return c;
      };
      const errs = [];
      const tp3 = makeStdioTransport({ userControlIsolated: true, command: 'node', allowedCommands: ['node'], processEnv: {},
        spawnImpl: () => (fake = mkFake()), onError: e => errs.push((e && e.message) || String(e)) });
      const cl3 = makeMcpClient({ transport: tp3, timeoutMs: 10000 });
      const initP = cl3.initialize();
      await waitFor(() => !!fake);
      setImmediate(() => fake.stdout.emit('data', '\n'));   // the initialize reply's CRLF straddles two chunks
      await initP;
      A.ok(true, 'a CRLF split across two chunks still frames one message');
      const t0 = Date.now();
      const big = await cl3.callTool('dump', {});
      const ms = Date.now() - t0;
      A.eq(big.content[0].text.length, 16 * 1024 * 1024, 'a 16 MB reply in 64 KB chunks arrives whole');
      A.ok(ms < 1000, 'a 16 MB single-line reply parses in linear time (' + ms + ' ms; the rescanning parser took ~2500 ms)');
      A.eq(errs, [], 'a large but legal line is not a transport error');
      tp3.close();
    }

    // A LINE WITH NO END. No ceiling meant a server streaming one endless line grew the host string until V8's
    // ~512M-char limit threw inside the 'data' handler and took the sidecar down. Past the cap, the connection
    // fails LOUDLY: the waiting call gets the reason, the manager hears a transport death, and the child is stopped.
    {
      const floodFile = path.join(tmp, 'stdio-flood.js');
      fs.writeFileSync(floodFile, [
        "'use strict';",
        "const readline = require('readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  let msg; try { msg = JSON.parse(line); } catch (_) { return; }",
        "  if (!msg || msg.id == null) return;",
        "  if (msg.method === 'initialize') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'flood' } } }) + '\\n');",
        "  const blob = 'x'.repeat(8192);",
        "  const pump = () => { for (let i = 0; i < 4; i++) process.stdout.write(blob); setTimeout(pump, 5); };",
        "  pump();",
        "});",
        "setInterval(() => {}, 1000);"
      ].join('\n'));
      const died = [], freed = [];
      const tp4 = makeStdioTransport({
        userControlIsolated: true, command: process.execPath, args: [floodFile],
        env: {}, processEnv: { PATH: process.env.PATH || '' }, allowedCommands: [nodeBase], timeoutMs: 1000,
        maxLineChars: 20000,
        onError: e => died.push((e && e.message) || String(e)),
        ledger: { record: () => {}, release: pid => freed.push(pid) }
      });
      const cl4 = makeMcpClient({ transport: tp4, timeoutMs: 5000 });
      await cl4.initialize();
      let callErr = null;
      try { await cl4.callTool('flood', {}); } catch (e) { callErr = e; }
      A.ok(callErr && /sent a line with no newline past the 20000 characters limit/.test(callErr.message), 'the waiting call fails with the over-long-line reason, not a timeout (' + (callErr && callErr.message) + ')');
      A.ok(died.some(m => /past the 20000 characters limit/.test(m)), 'the transport reports the death to its manager');
      A.eq(tp4.isClosed(), true, 'the transport is closed');
      A.ok(await waitFor(() => freed.length === 1, 5000), 'the flooding child is stopped and its ownership receipt released');
    }

    // TINY CHUNKS COUNT AS MEMORY (review 2026-10-21, the SSE fix's twin). The open line is kept as the chunks that
    // carried it; counting characters alone, a server writing an endless line 2 characters at a time kept one string
    // per chunk: 32M of them under the 64 MiB cap, ~1.7 GB for one connector. Every kept chunk now costs its fixed
    // overhead too, and the reason says so. The child is injected so the chunking is exact; the transport and client
    // are the real ones.
    {
      const EE = require('events');
      let fake = null, flood = false;
      const mkFake = () => {
        const c = new EE(); c.stdout = new EE(); c.stderr = new EE(); c.pid = 0; c.kill = () => {};
        c.stdin = { write(line, enc, cb) {
          const msg = JSON.parse(line);
          if (msg.id != null) setImmediate(() => {
            if (msg.method === 'initialize') return c.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'drip' } } }) + '\n');
            flood = true;
          });
          if (cb) cb(); return true;
        }, end() {}, setDefaultEncoding() {} };
        return c;
      };
      const died = [];
      const tp5 = makeStdioTransport({ userControlIsolated: true, command: 'node', allowedCommands: ['node'], processEnv: {}, maxLineChars: 20000,
        spawnImpl: () => (fake = mkFake()), onError: e => died.push((e && e.message) || String(e)) });
      const cl5 = makeMcpClient({ transport: tp5, timeoutMs: 5000 });
      await cl5.initialize();
      const callP = cl5.callTool('drip', {}).then(() => null, e => e);
      A.ok(await waitFor(() => flood, 2000), 'fixture: the server starts its endless line');
      let fed = 0;   // endless for this transport's purposes: it stops at 20000 chunks only so a regression fails here
      while (!tp5.isClosed() && fed < 20000) { fake.stdout.emit('data', 'ab'); fed++; }
      const callErr = await callP;
      A.ok(tp5.isClosed() && fed <= Math.ceil(20000 / (2 + T.PIECE_COST)) + 1, 'an endless line in 2-character chunks is cut off by what it holds: ' + fed + ' chunks kept under a 20000 cap (counting characters alone it kept 10000)');
      A.eq(T.PIECE_COST, 48, 'each kept chunk is charged 48 on top of its characters, as on the SSE path');
      A.ok(callErr && /^mcp stdio server sent a line with no newline past the 20000 characters limit \(each chunk held counts its characters plus 48\): connection closed$/.test(callErr.message), 'the call fails with the real accounting: ' + (callErr && callErr.message));
      A.eq(died, [callErr && callErr.message], 'the connection is reported dead once, with the same reason');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  A.report('mcp.stdio.test');
})();
