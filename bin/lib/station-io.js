/* bin/lib/station-io.js — the station, as the terminal's awakening (bin/lib/awaken.js) talks to it.

   get / post: the client's own requests (token in the header). chat: ONE reason-only round trip the way the app's
   Harness.chat makes it for the awakening — POST /api/run with internal:true, isTask:false, placed:[] (no tools, nothing on
   the station's bus: thinking about the Commander is not a shipped task), the reply read off the run's own NDJSON stream.
   Resolves { text } or { error } (a refusal, an error event, a stream that ended without a reply, or the time limit);
   never throws. open: the link in the person's browser. */
'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');

function makeStationIO(client) {
  const get = (p, ms) => client.request('GET', p, null, { timeoutMs: ms || 10000 });
  const post = (p, body, ms) => client.request('POST', p, body || {}, { timeoutMs: ms || 15000 });
  function chat(o) {
    return new Promise(resolve => {
      const body = { model: o.model, provider: o.provider, agentId: o.agentId || 'agent', system: o.system || '', messages: [{ role: 'user', content: String(o.directive || '') }], isTask: false, placed: [], internal: true };
      if (o.effort) body.reasoningEffort = o.effort;
      if (o.keepEffort) body.keepEffort = true;   // a verdict that steers the Commander's work runs on their effort, never the cheap aux one
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      let text = '', error = '', ended = false, done = false, req = null;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(error ? { error, text } : text.trim() ? { text } : { error: ended ? 'the provider returned an error' : 'the run ended without a reply' }); };
      const timer = setTimeout(() => { if (!text) error = 'no reply within ' + Math.round((o.ms || 60000) / 1000) + ' seconds (network or provider stall)'; try { req.destroy(); } catch (_) {} finish(); }, o.ms || 60000);
      try {
        req = http.request({ host: client.host, port: client.port, method: 'POST', path: '/api/run', headers: { Origin: client.base, 'Content-Type': 'application/json', 'Content-Length': payload.length, 'x-starnet-token': client.token(), Accept: 'application/x-ndjson' } }, res => {
          res.setEncoding('utf8');
          if (res.statusCode !== 200) {
            let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { error = 'the station refused the run (HTTP ' + res.statusCode + ')' + (b ? ': ' + b.slice(0, 160) : ''); finish(); });
            return;
          }
          let buf = '';
          res.on('data', chunk => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
              if (!line) continue;
              let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
              const p = (ev && ev.payload) || {};
              if (ev.name === 'agent.token' && p.delta) text += String(p.delta);
              else if (ev.name === 'agent.run.error') error = String(p.message || p.error || 'run error');
              else if (ev.name === 'agent.run.end') { ended = true; if (p.reason && p.reason !== 'done' && !text && !error) error = String(p.error || p.message || ('the run ended: ' + p.reason)); }
            }
          });
          res.on('end', finish); res.on('close', finish); res.on('error', e => { if (!error) error = String((e && e.message) || e); finish(); });
        });
        req.on('error', e => { if (!error) error = 'the station did not answer: ' + ((e && e.message) || e); finish(); });
        req.end(payload);
      } catch (e) { error = String((e && e.message) || e); finish(); }
    });
  }
  function open(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return false;
    const u = String(url);
    const cmd = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
    try { const c = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }); c.on('error', () => {}); c.unref(); return true; } catch (_) { return false; }
  }
  return { get, post, chat, open };
}

module.exports = { makeStationIO };
