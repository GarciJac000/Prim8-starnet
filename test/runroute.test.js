// runroute.test.js — a failure escaping handleRun must NEVER look like an empty 200.
'use strict';
const A = require('assert');
const { runRouteFailure } = require('../sidecar/runroute.js');
const { redact } = require('../sidecar/context.js');

function mockRes(headersSent) {
  const r = {
    headersSent: !!headersSent, status: null, headers: null, chunks: [], ended: false,
    writeHead(code, h) { this.status = code; this.headers = h || null; this.headersSent = true; },
    write(c) { this.chunks.push(String(c)); return true; },
    end(c) { if (c != null) this.chunks.push(String(c)); this.ended = true; }
  };
  return r;
}

// pre-stream failure -> 500 JSON envelope
{
  const res = mockRes(false);
  runRouteFailure(res, new Error('boom during setup'), redact);
  A.strictEqual(res.status, 500, 'pre-stream failure is a 500, not an empty 200');
  A.strictEqual(res.headers['Content-Type'], 'application/json', 'json content type');
  const body = JSON.parse(res.chunks.join(''));
  A.ok(/boom during setup/.test(body.error), 'error names the failure');
  A.ok(res.ended, 'response ended');
}

// mid-stream failure -> final agent.run.error NDJSON line, then end
{
  const res = mockRes(true);
  runRouteFailure(res, new Error('stream fell over'), redact);
  A.strictEqual(res.status, null, 'no second writeHead after headers sent');
  const line = JSON.parse(res.chunks[0]);
  A.strictEqual(line.name, 'agent.run.error', 'stream close is named as a run error');
  A.strictEqual(line.payload.transient, false, 'not retried silently');
  A.ok(/stream fell over/.test(line.payload.message), 'message carried');
  A.ok(res.ended, 'stream ended');
}

// secrets in an error message are redacted on the way out
{
  const res = mockRes(false);
  runRouteFailure(res, new Error('provider said sk-or-v1-abcdef0123456789zzzz rejected'), redact);
  const body = JSON.parse(res.chunks.join(''));
  A.ok(body.error.indexOf('sk-or-v1-') < 0, 'key redacted from 500 envelope');
}

// a broken socket must not throw out of the failure path
{
  const res = mockRes(true);
  res.write = () => { throw new Error('EPIPE'); };
  A.doesNotThrow(() => runRouteFailure(res, new Error('x'), redact), 'EPIPE swallowed');
  A.ok(res.ended, 'still ends');
}

// non-Error throwables are stringified, not crashed on
{
  const res = mockRes(false);
  runRouteFailure(res, 'plain string reason', redact);
  const body = JSON.parse(res.chunks.join(''));
  A.ok(/plain string reason/.test(body.error), 'non-Error reason carried');
}

// a response already answered AND ended (a run on the page's shared stream answers its POST at once) takes no write:
// an http response written after end() emits an 'error' nothing catches
{
  const res = mockRes(true);
  res.writableEnded = true;
  res.write = () => { throw new Error('write after end'); };
  res.end = () => { throw new Error('end after end'); };
  A.doesNotThrow(() => runRouteFailure(res, new Error('late failure'), redact), 'an ended response is left alone');
  A.strictEqual(res.chunks.length, 0, 'nothing written after end');
}

console.log('runroute.test: OK (15 assertions)');
