/* sidecar/edgetts.js — zero-dependency client for Microsoft's Edge "Read Aloud" TTS endpoint.
   This is the FREE, KEYLESS neural voice floor: any station (zero-key / Anthropic-only / Codex-only)
   gets a decent neural voice with no credential and no Edge install. It speaks the same private
   websocket protocol the Edge browser's read-aloud feature uses.

   Why hand-rolled instead of Node's global WebSocket: the endpoint only answers requests that carry
   a browser User-Agent + the chrome-extension Origin + Connection:Upgrade. Node's WHATWG WebSocket
   forbids setting those headers, so we drive node:https' raw HTTP upgrade and frame the protocol by
   hand (masked client frames, incremental server-frame parser, binary audio payloads).

   Pure pieces (secMsGec / wsEncode / makeWsParser) are exported so they can be unit-tested offline,
   and synth() takes host/port/insecure overrides (also readable from env) so a test can point it at a
   loopback server that speaks the same codec. No dependencies: node:https / node:http / node:crypto only. */
'use strict';

const https = require('node:https');
const http = require('node:http');
const { createHash, randomBytes, randomUUID } = require('node:crypto');

// The public trusted-client token + Chromium version string the Edge read-aloud client presents.
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VER = '143.0.3650.96';
// Nearest Edge neural voice to the station's locked Algenib identity (low gravelly male bass).
const DEFAULT_VOICE = 'en-US-ChristopherNeural';
// Edge outputs mp3 for this format (matches what the browser <audio> plays natively).
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
// WebSocket GUID (RFC 6455) — only needed by a peer that VALIDATES the handshake accept; the raw
// node:http upgrade path here doesn't, but the loopback test server uses it, so export nothing extra.

// STARNET_/SKYNET_-prefixed env, mirroring sidecar/index.js's ENV() so overrides work under either brand.
function env(suffix) { const k = 'STARNET_' + suffix; return (k in process.env) ? process.env[k] : process.env['SKYNET_' + suffix]; }
function truthyOff(v) { return /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim()); }
function truthyOn(v) { return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }

// Sec-MS-GEC token = uppercase hex SHA256 of (Windows FILETIME ticks rounded down to a 300s window) + the
// trusted token. The endpoint rejects a request whose token is outside the current ~5-minute window.
// The clock is INJECTED (determinism law: no ambient Date.now outside the composition root).
function secMsGec(nowMs) {
  const secs = Math.floor(Number(nowMs) / 1000) + 11644473600;   // unix → windows epoch offset
  const rounded = secs - (secs % 300);
  const ticks = BigInt(rounded) * 10000000n;                     // 100ns FILETIME ticks
  return createHash('sha256').update(`${ticks}${TRUSTED_TOKEN}`).digest('hex').toUpperCase();
}

// Which Edge voice to use — explicit opt wins, else SKYNET_EDGE_TTS_VOICE, else the Algenib-nearest default.
function resolveVoice(opts) {
  return String((opts && opts.voice) || env('EDGE_TTS_VOICE') || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
}

// XML-escape text interpolated into the SSML <voice> body so a stray & < > ' " can't break the document.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Encode ONE websocket frame. Client→server frames MUST be masked (opts.mask omitted/true); a server (the
// loopback test) passes {mask:false}. opcode: 0x1 text, 0x2 binary, 0x9 ping, 0xA pong, 0x8 close.
function wsEncode(opcode, payload, opts) {
  const mask = !opts || opts.mask !== false;
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payload.length;
  const maskBit = mask ? 0x80 : 0x00;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, maskBit | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = maskBit | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = maskBit | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([header, payload]);
  const m = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ m[i & 3];
  return Buffer.concat([header, m, masked]);
}

// Incremental server→client frame parser. Buffers partial reads and calls onFrame(opcode, payload) once a
// full message is assembled — reassembling continuation (0x0) fragments under the initiating opcode, passing
// ping (0x9) through so the caller can pong, dropping pong (0xA), and calling onClose() on a close (0x8) frame.
function makeWsParser(onFrame, onClose) {
  let buf = Buffer.alloc(0);
  let fragOp = 0, fragParts = [];
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;                     // masked server frames are non-spec but tolerated
      if (buf.length < off + len) return;       // wait for the rest of the frame
      let payload = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(off - 4, off); const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; payload = p; }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { if (onClose) onClose(); return; }
      if (opcode === 0x9) { onFrame(0x9, payload); continue; }   // ping — caller must pong
      if (opcode === 0xA) continue;                              // pong — ignore
      if (opcode === 0x0) { fragParts.push(payload); if (fin) { onFrame(fragOp, Buffer.concat(fragParts)); fragParts = []; fragOp = 0; } continue; }
      if (!fin) { fragOp = opcode; fragParts = [payload]; continue; }
      onFrame(opcode, payload);
    }
  };
}

/* synth(text, opts) → Promise<Buffer mp3>. On ANY failure (refused upgrade, timeout, socket error, empty
   audio) it REJECTS — the /api/tts caller catches and degrades. opts:
     voice     — Edge voice name (default: env SKYNET_EDGE_TTS_VOICE or en-US-ChristopherNeural)
     host/port — endpoint override (default speech.platform.bing.com / 443|80). Test-only.
     insecure  — use plain http upgrade instead of https (loopback test server). Test-only.
     timeoutMs — hard wall-clock (default 15000).
   host/port/insecure also read from SKYNET_EDGE_TTS_HOST / _PORT / _INSECURE so a spawned sidecar can be
   aimed at a loopback server without a code change. */
function synth(text, opts) {
  opts = opts || {};
  // determinism law: the wall clock is injected by the composition root (sidecar/index.js passes Date.now()).
  const nowMs = Number(opts.nowMs);
  if (!Number.isFinite(nowMs) || nowMs <= 0) return Promise.reject(new Error('edgetts.synth: opts.nowMs (injected clock) is required'));
  const voice = resolveVoice(opts);
  const insecure = (opts.insecure != null) ? !!opts.insecure : truthyOn(env('EDGE_TTS_INSECURE'));
  const host = String(opts.host || env('EDGE_TTS_HOST') || 'speech.platform.bing.com').trim();
  const port = Number(opts.port || env('EDGE_TTS_PORT')) || (insecure ? 80 : 443);
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
  const transport = insecure ? http : https;
  const safe = xmlEscape(String(text || ''));

  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const p = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec(nowMs)}&Sec-MS-GEC-Version=1-${CHROMIUM_VER}&ConnectionId=${randomUUID().replace(/-/g, '')}`;
    let req, sock = null, settled = false;
    try {
      req = transport.request({
        host, port, path: p, method: 'GET', headers: {
          'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        },
      });
    } catch (e) { return reject(e); }
    // Timeout MUST tear down BOTH the request and any upgraded socket — a leaked half-open socket would keep a
    // peer (e.g. a loopback test server) from ever closing. All exits funnel through settle() so nothing lingers.
    const timer = setTimeout(() => settle(new Error('edge timeout')), timeoutMs);
    function settle(err, val) {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch (_) {}
      if (sock) { try { sock.destroy(); } catch (_) {} }
      if (err) reject(err instanceof Error ? err : new Error(String(err))); else resolve(val);
    }
    req.on('error', (e) => settle(e));
    // A plain HTTP response (not a 101 upgrade) means the endpoint refused the websocket — degrade.
    req.on('response', (res) => settle(new Error('edge upgrade refused: HTTP ' + res.statusCode)));
    req.on('upgrade', (res, socket) => {
      sock = socket;
      const audio = [];
      const done = (err, val) => settle(err, val);
      socket.on('error', (e) => done(e));
      // ONLY turn.end completes a clip. A CLOSE frame or a dropped connection before it is a CUT stream: resolving
      // the audio received so far served half a sentence as a whole one — and /api/tts cached it under the full
      // sentence's key, so the truncated clip replayed from disk forever. A drop used to wait out the wall clock.
      const cut = () => done(new Error('edge socket closed before turn.end'));
      socket.on('end', cut); socket.on('close', cut);
      const finish = () => { const out = Buffer.concat(audio); if (out.length) done(null, out); else done(new Error('edge: empty audio')); };
      const parse = makeWsParser((opcode, payload) => {
        if (opcode === 0x9) { try { socket.write(wsEncode(0xA, payload)); } catch (_) {} return; }   // pong the ping
        if (opcode === 0x1) {                                            // text control frame
          if (payload.toString('utf8').includes('Path:turn.end')) finish();
          return;
        }
        if (opcode === 0x2) {                                            // binary: [2-byte BE hlen][header][audio]
          if (payload.length < 2) return;
          const hlen = payload.readUInt16BE(0);
          const headerTxt = payload.subarray(2, 2 + hlen).toString('utf8');
          if (headerTxt.includes('Path:audio')) { const audioBody = payload.subarray(2 + hlen); if (audioBody.length) audio.push(audioBody); }
        }
      }, cut);
      socket.on('data', parse);
      const ts = new Date(nowMs).toISOString();   // derived from the injected clock (no ambient new Date())
      // 1) speech.config — output format + boundary metadata off (we don't consume word boundaries).
      socket.write(wsEncode(0x1, Buffer.from(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } } }), 'utf8')));
      // 2) the SSML request itself — Edge has no style-prompt support, so this is plain single-voice SSML.
      socket.write(wsEncode(0x1, Buffer.from(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>${safe}</voice></speak>`, 'utf8')));
    });
    req.end();
  });
}

// Is the Edge floor enabled? Default ON; disable with SKYNET_EDGE_TTS=0 (tests need offline determinism).
function enabled() { return !truthyOff(env('EDGE_TTS')); }

module.exports = { secMsGec, wsEncode, makeWsParser, synth, resolveVoice, enabled, DEFAULT_VOICE, OUTPUT_FORMAT };
