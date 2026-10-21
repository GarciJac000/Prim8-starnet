/* node test/edgetts-stream-end.test.js — the free Edge floor must never pass a HALF clip off as a whole one.

   sweep/voice 2026-10-20: synth() resolved with whatever audio had arrived when the server sent a websocket CLOSE
   frame before `Path:turn.end` — so /api/tts answered 200 with half a sentence AND wrote it to the voice cache
   under the full sentence's key: every later request for that line (stock prewarm lines included) replayed the
   truncated clip from disk with Edge healthy again. A server that simply dropped the TCP connection was not
   handled at all — the request sat until the 15s wall clock, three times per sentence with the client's retries.
   Offline: a loopback server speaking the same codec (edge.wsEncode / edge.makeWsParser). */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const crypto = require('node:crypto');
const edge = require('../sidecar/edgetts.js');

const CLIP = Buffer.alloc(4000, 0x5a);
function audioFrame(chunk) {
  const hdr = Buffer.from('X-RequestId:t\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
  const hl = Buffer.alloc(2); hl.writeUInt16BE(hdr.length, 0);
  return edge.wsEncode(0x2, Buffer.concat([hl, hdr, chunk]), { mask: false });
}
const text = s => edge.wsEncode(0x1, Buffer.from(s, 'utf8'), { mask: false });

let mode = 'ok';
const server = http.createServer((rq, rs) => { rs.writeHead(426); rs.end(); });
server.on('upgrade', (rq, socket) => {
  const accept = crypto.createHash('sha1').update(String(rq.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.on('error', () => {});
  socket.on('data', edge.makeWsParser((op, payload) => {
    if (!(op === 0x1 && payload.toString('utf8').includes('Path:ssml'))) return;
    socket.write(text('X-RequestId:t\r\nPath:turn.start\r\n\r\n{}'));
    socket.write(audioFrame(CLIP.subarray(0, 2000)));
    if (mode === 'close') { socket.write(edge.wsEncode(0x8, Buffer.from([0x03, 0xe8]), { mask: false })); return; }
    if (mode === 'drop') { setTimeout(() => { try { socket.end(); } catch (_) {} }, 10); return; }
    socket.write(audioFrame(CLIP.subarray(2000)));
    socket.write(text('X-RequestId:t\r\nPath:turn.end\r\n\r\n{}'));
  }, () => {}));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const opts = { nowMs: 1784000000000, host: '127.0.0.1', port: server.address().port, insecure: true, timeoutMs: 4000 };
  const attempt = async () => {
    const t0 = Date.now();
    try { const buf = await edge.synth('one whole sentence', opts); return { ok: true, bytes: buf.length, ms: Date.now() - t0 }; }
    catch (e) { return { ok: false, reason: String(e && e.message || e), ms: Date.now() - t0 }; }
  };
  try {
    mode = 'ok';
    const ok = await attempt();
    A.ok(ok.ok && ok.bytes === CLIP.length, 'a healthy stream (audio then turn.end) resolves the WHOLE clip (' + JSON.stringify(ok) + ')');

    mode = 'close';
    const cut = await attempt();
    A.eq(cut.ok, false, 'a CLOSE frame before turn.end REJECTS — half a sentence is not a clip (' + JSON.stringify(cut) + ')');
    A.ok(/before turn\.end/.test(cut.reason || ''), 'the rejection says the stream ended early: ' + cut.reason);

    mode = 'drop';
    const drop = await attempt();
    A.eq(drop.ok, false, 'a dropped TCP connection before turn.end rejects (' + JSON.stringify(drop) + ')');
    A.ok(drop.ms < 2000, 'and it rejects AT ONCE, not at the wall-clock timeout (' + drop.ms + 'ms of a 4000ms ceiling)');
    A.ok(/socket/.test(drop.reason || ''), 'the reason reads as a transient socket failure, so the client retries it: ' + drop.reason);
  } finally {
    try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
    server.close();
  }
  A.report('edgetts-stream-end');
})().catch(e => { console.error(e); process.exit(1); });
