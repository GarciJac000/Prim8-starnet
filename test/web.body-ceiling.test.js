/* node test/web.body-ceiling.test.js — the raw-body ceiling is enforced WHILE READING, and a cut body says so.

   readBodyBounded called Response.text(), which pulls, decompresses and decodes the WHOLE body before the
   2 Mi-character slice: a 32 MiB file pulled 33,554,432 bytes to keep 2,097,152 characters (station RSS
   61 -> 164 MB), an endless stream never finished, and a gzip bomb inflated in full. The cut was also
   silent, so web_request later described a cut body as "the whole N-character response" / "The complete
   response is saved". Real WHATWG Response + ReadableStream objects (Node's own), driven through the real
   web_fetch / web_request tools with lookup:null (no DNS, no dispatcher). */
'use strict';
const A = require('./_assert.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');

const MiB = 1024 * 1024, CHUNK = 64 * 1024, CEILING = 2 * 1024 * 1024;
const passThrough = { run: (u, s, f) => f() };

// a stream of `total` bytes of `fill`, counting how many bytes the reader actually pulled
function bigResponse(total, fill, ct) {
  const st = { pulled: 0 };
  const stream = new ReadableStream({ pull(c) {
    if (st.pulled >= total) return c.close();
    const n = Math.min(CHUNK, total - st.pulled);
    st.pulled += n;
    c.enqueue(new Uint8Array(n).fill(fill));
  } });
  st.response = new Response(stream, { status: 200, headers: { 'content-type': ct, 'content-length': String(total) } });
  return st;
}
// the same bytes split into 7-byte chunks, so multibyte characters straddle chunk edges
function chunked(buf, ct) {
  let i = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (i >= buf.length) return c.close();
    c.enqueue(new Uint8Array(buf.subarray(i, i + 7))); i += 7;
  } }), { status: 200, headers: { 'content-type': ct } });
}

(async () => {
  // ---- 1. web_fetch on a 32 MiB page: the read stops at the ceiling and the label says the page was cut ----
  {
    let st = null;
    const web = makeWebTools({ fetchImpl: async () => { st = bigResponse(32 * MiB, 0x61, 'text/plain'); return st.response; }, lookup: null, politeness: passThrough });
    const r = await web.fetchTool.run({ url: 'https://example.com/huge.txt' }, {});
    A.ok(st.pulled <= 6 * MiB + 4 * CHUNK, 'pulled ' + st.pulled + ' bytes of a 33,554,432-byte body (ceiling 6 MiB of raw bytes; trunk pulled all of it)');
    A.ok(/page text from https:\/\/example\.com\/huge\.txt \(first 2,097,152 characters of a longer page\)/.test(r.content), 'the fence label says the page was cut at the raw-body ceiling');
    const full = await web.webFetch('https://example.com/huge.txt', {});
    A.eq((full.fullText || full.text).length, CEILING, 'the kept text is the full 2 Mi characters');
    A.eq(full.cut, true, 'webFetch reports the cut');
  }

  // ---- 1b. the same through the Jina reader (a key configured): its cut body is reported exactly like the direct one ----
  {
    let st = null, jinaCalls = 0, directCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).indexOf('https://r.jina.ai/') === 0) { jinaCalls++; st = bigResponse(32 * MiB, 0x65, 'text/plain'); return st.response; }
      directCalls++; return new Response('direct page', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const web = makeWebTools({ fetchImpl, jinaKey: 'test-key', lookup: null, politeness: passThrough });
    const r = await web.fetchTool.run({ url: 'https://example.com/huge-reader.txt' }, {});
    A.eq([jinaCalls, directCalls], [1, 0], 'the page came through the Jina reader, no direct fallback');
    A.ok(st.pulled <= 6 * MiB + 4 * CHUNK, 'jina: pulled ' + st.pulled + ' bytes of a 33,554,432-byte body');
    A.ok(/page text from https:\/\/example\.com\/huge-reader\.txt \(first 2,097,152 characters of a longer page\)/.test(r.content), 'the Jina-path fence label says the page was cut' + (/first 2,097,152/.test(r.content) ? '' : ' (it read as the whole page: ' + JSON.stringify(r.content.slice(0, 120)) + ')'));
    A.ok(/via jina$/.test(r.summary), 'and the summary still names the Jina source: ' + r.summary);
    const full = await web.webFetch('https://example.com/huge-reader.txt', {});
    A.eq([full.source, full.cut], ['jina', true], 'webFetch reports the Jina cut');
    const small = makeWebTools({ fetchImpl: async () => new Response('Title: t\nURL Source: u\nMarkdown Content:\nsmall reader page', { status: 200 }), jinaKey: 'test-key', lookup: null, politeness: passThrough });
    const s = await small.webFetch('https://example.com/small', {});
    A.eq([s.source, s.text, s.cut], ['jina', 'small reader page', undefined], 'an uncut Jina page has no cut flag and the historic text');
  }

  // ---- 2. web_request on a 32 MiB answer: the host note says it was cut, and nothing calls it whole ----
  {
    let st = null;
    const web = makeWebTools({ fetchImpl: async () => { st = bigResponse(32 * MiB, 0x62, 'application/json'); return st.response; }, lookup: null, politeness: passThrough });
    const plain = await web.requestTool.run({ url: 'https://api.example.com/v1/everything' }, {});
    A.ok(st.pulled <= 6 * MiB + 4 * CHUNK, 'web_request pulled ' + st.pulled + ' bytes, not 33,554,432');
    A.ok(plain.content.indexOf('[response body cut at its first 2,097,152 characters (raw-body ceiling); the rest was not kept, and the download stopped at 6,291,456 bytes]\n') === 0, 'the host note rides first, outside the fence, and says the download stopped: ' + JSON.stringify(plain.content.slice(0, 160)));
    const sel = await web.requestTool.run({ url: 'https://api.example.com/v1/everything', select: ['items'] }, {});
    A.ok(sel.content.indexOf('[response body cut at its first 2,097,152 characters') === 0, 'a select over a cut body carries the same note');
    A.ok(!/whole|complete response/i.test(sel.content.slice(0, 2000)), 'a cut body is never called "whole" or "complete": ' + JSON.stringify(sel.content.slice(0, 300)));
  }

  // ---- 2b. a 3 MiB ASCII answer is downloaded WHOLE and only its text is cut: the note never says "not downloaded" ----
  {
    let st = null;
    const web = makeWebTools({ fetchImpl: async () => { st = bigResponse(3 * MiB, 0x64, 'application/json'); return st.response; }, lookup: null, politeness: passThrough });
    const r = await web.requestTool.run({ url: 'https://api.example.com/v1/mid' }, {});
    A.eq(st.pulled, 3 * MiB, 'the whole 3 MiB body was pulled (it is under the 6 MiB byte cap)');
    A.ok(r.content.indexOf('[response body cut at its first 2,097,152 characters (raw-body ceiling); the rest was not kept]\n') === 0, 'the note says the rest was not KEPT: ' + JSON.stringify(r.content.slice(0, 160)));
    A.ok(!/not downloaded|download stopped/.test(r.content.slice(0, 300)), 'and never that it was not downloaded (it was: the note once said "the rest was not downloaded")');
  }

  // ---- 3. under the ceiling, streaming decodes exactly as Response.text() did (BOM, invalid bytes, split chars) ----
  {
    const samples = [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello wörld ✓ 😀 end', 'utf8')]),
      Buffer.from([0x61, 0xe2, 0x82, 0x62, 0xff, 0x63, 0xf0, 0x9f, 0x98]),
      Buffer.from('x'.repeat(70000) + '😀'.repeat(9000) + 'é', 'utf8')
    ];
    let same = 0;
    for (const b of samples) {
      const expected = (await chunked(b, 'text/plain').text()).trim();
      const web = makeWebTools({ fetchImpl: async () => chunked(b, 'text/plain'), lookup: null, politeness: passThrough });
      const r = await web.webFetch('https://example.com/s.txt', {});
      if ((r.fullText || r.text) === expected && r.cut === undefined) same++;
    }
    A.eq(same, samples.length, 'every small body reads identically to Response.text(), with no cut flag');
    const json = Buffer.from(JSON.stringify({ name: 'ünïcode ✓', n: 1 }), 'utf8');
    const web = makeWebTools({ fetchImpl: async () => chunked(json, 'application/json'), lookup: null, politeness: passThrough });
    const r = await web.requestTool.run({ url: 'https://api.example.com/v1/one', select: ['name'] }, {});
    A.ok(/^\[selected 1 of 1 field path\(s\) from the whole \d+-character response\. The complete response is saved too; its file is named below\.\]\n/.test(r.content), 'an uncut select keeps its historic note byte-for-byte');
    const p = await web.requestTool.run({ url: 'https://api.example.com/v1/one' }, {});
    A.ok(p.content.indexOf('[response body cut') < 0 && /ünïcode ✓/.test(p.content), 'an uncut body has no cut note and decodes correctly');
  }

  // ---- 4. a response double with only text() keeps the historic path (and still honours the ceiling) ----
  {
    const web = makeWebTools({ fetchImpl: async () => ({ status: 200, headers: { get: () => 'text/plain' }, text: async () => 'DOUBLE BODY' }), lookup: null, politeness: passThrough });
    const r = await web.webFetch('https://example.com/d.txt', {});
    A.eq(r.text, 'DOUBLE BODY', 'a text()-only double still reads');
    let calls = 0;
    const big = makeWebTools({ fetchImpl: async () => ({ status: 200, headers: { get: () => 'text/plain' }, text: async () => { calls++; return 'z'.repeat(CEILING + 10); } }), lookup: null, politeness: passThrough });
    const rb = await big.webFetch('https://example.com/big.txt', {});
    A.eq([calls, (rb.fullText || rb.text).length, rb.cut], [1, CEILING, true], 'text() is called once, the slice still applies, and the cut is reported');
  }

  // ---- 5. REAL undici + a real socket serving an ENDLESS body: the call returns and the pinned dispatcher closes ----
  {
    const http = require('node:http');
    const undici = require('undici');
    let served = 0, stopped = false;
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const block = Buffer.alloc(CHUNK, 0x63);
      const pump = () => { while (!stopped && res.write(block)) served += CHUNK; if (!stopped) res.once('drain', pump); };
      res.on('close', () => { stopped = true; });
      pump();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    let closes = 0;
    const web = makeWebTools({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      politeness: passThrough,
      agentFactory: (opts) => {
        const agent = new undici.Agent(Object.assign({}, opts, { connect: Object.assign({}, opts.connect, {
          lookup(h, o, cb) { opts.connect.lookup(h, o, (err, a, f) => err ? cb(err) : (Array.isArray(a) ? cb(null, a.map(x => ({ address: '127.0.0.1', family: x.family }))) : cb(null, '127.0.0.1', f))); }
        }) }));
        const close = agent.close.bind(agent);
        // callback form: undici's promise form re-enters this.close, which is this wrapper
        agent.close = () => new Promise((resolve, reject) => close((err) => { if (err) return reject(err); closes++; resolve(); }));
        return agent;
      }
    });
    let out = null, failure = null;
    let timer = null;
    const cap = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('still reading an endless body after 20 s')), 20000); });
    try { out = await Promise.race([web.requestTool.run({ url: 'http://api.endless.example:' + port + '/stream' }, {}), cap]); }
    catch (e) { failure = String(e && e.message); }
    clearTimeout(timer);
    stopped = true;
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    A.eq(failure, null, 'web_request over an endless real-socket body returns instead of buffering forever');
    A.ok(out && out.content.indexOf('[response body cut at its first 2,097,152 characters') === 0, 'and says the body was cut');
    A.eq(closes, 1, 'the pinned dispatcher closed after the read was cancelled');
  }

  A.report('web.body-ceiling.test');
})().catch((e) => { console.log('FAIL: web.body-ceiling.test threw -- ' + (e && e.stack || e)); process.exit(1); });
