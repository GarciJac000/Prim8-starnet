/* runroute.js — names a failure that escapes handleRun instead of letting the socket
   close as an empty 200 the browser reads as success (truthful telemetry applies to
   HTTP shapes too):
   - headers not sent yet -> 500 JSON envelope { error }
   - stream already open  -> one final agent.run.error NDJSON line, then end
   Pure fold: res + redact injected; no requires. */
'use strict';

function runRouteFailure(res, err, redact) {
  const message = 'sidecar failure: ' + ((err && err.message) || err);
  const safe = typeof redact === 'function' ? redact(message) : message;
  // Already answered and ended — a run on the page's shared stream (run-streams.js) answers its POST at once. Nothing more
  // can travel on this response, and an http response written after end() emits an 'error' nobody catches.
  if (res && res.writableEnded) return;
  try {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: safe }));
    } else {
      try { res.write(JSON.stringify({ name: 'agent.run.error', payload: { message: safe, transient: false } }) + '\n'); } catch (_) {}
      res.end();
    }
  } catch (_) { try { res.end(); } catch (_) {} }
}

module.exports = { runRouteFailure };
