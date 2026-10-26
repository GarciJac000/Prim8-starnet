/* sidecar/run-streams.js — ONE response stream per page for every run that page watches.

   WHY (2026-10-21, connection-pool exhaustion). A browser opens at most SIX HTTP/1.1 connections to one host — Chromium,
   WebView2 (the Windows app) and WebKit (the Mac app) alike — and POST /api/run used to answer with the run's own NDJSON
   stream, held open for the run's whole life, approval pauses included. Five paused conversations plus the station's SSE
   bridge filled the pool, and every other request the page made queued behind them inside the browser: the next
   conversation's run never started, Approve/Deny (POST /api/consent) never left the page, and each paused run waited on
   an answer that was waiting on it, until the ask timed out to a denial.

   Now the page holds ONE stream (GET /api/run/stream) for all of its runs and names it on each run it starts
   ({ stream: { id, key } } in the POST /api/run body). The POST is answered at once; the run's events ride the page's
   stream, each line tagged with the key the page chose for that run:
     {"stream":"ready","id":"<id>"}                    first line: the id the page names on its runs
     {"k":"<key>","name":"agent.token","payload":{…}}  one run event (the same {name,payload} line /api/run streamed)
     {"k":"<key>","end":true}                          that run's last line (its response ending, before)
     (a blank line)                                    keepalive through long silences, as on /api/run

   THE WATCHER LAW IS UNCHANGED. The stream closing (a reload, a closed tab, a lost connection) does for EVERY run on it
   exactly what that run's own response closing did (the caller's gone callback: handleRun's page-gone path), and a page
   that stops watching one run withdraws it (POST /api/run/stream/withdraw) — what aborting that run's fetch did. A
   withdrawal that reaches the station before the run does (a Stop that beat the POST) is remembered, so that run never
   starts. Pure + testable: a stream is any object with write() and on() (an http ServerResponse duck-types it); the id
   source and the keepalive timer are injected. */
'use strict';

const { note: failNote } = require('./failopen.js');   // a swallowed error stays visible (tagged warn + counter)

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const WITHDRAWN_MAX = 256;   // withdrawals remembered per stream for runs not yet arrived (oldest forgotten first)

function makeRunStreams(opts) {
  const o = opts || {};
  const uuid = typeof o.uuid === 'function' ? o.uuid : null;
  const keepAliveMs = Math.max(1, Number(o.keepAliveMs) || 20000);
  const setIntervalFn = typeof o.setInterval === 'function' ? o.setInterval : setInterval;
  const clearIntervalFn = typeof o.clearInterval === 'function' ? o.clearInterval : clearInterval;
  let seq = 0;
  const streams = new Map();   // id -> { id, res, runs: Map(key -> run), withdrawn: Set(key), ka, closed }

  // A finished or destroyed response never takes another write: an http response written after end() emits 'error',
  // which nothing here would catch.
  function writeRaw(s, line) {
    if (s.closed) return false;
    const r = s.res;
    if (!r || r.writableEnded || r.destroyed) return false;
    try { r.write(line); return true; } catch (_) { return false; }
  }

  function closeStream(s) {
    if (s.closed) return;
    s.closed = true;
    streams.delete(s.id);
    if (s.ka) { try { clearIntervalFn(s.ka); } catch (e) { failNote('runstreams.keepalive.clear', e); } s.ka = null; }
    const runs = [...s.runs.values()];
    s.runs.clear();
    for (const run of runs) {
      run.live = false;
      if (typeof run.gone === 'function') { try { run.gone(); } catch (e) { failNote('runstreams.close.gone', e); } }
    }
  }

  // Register a page's stream on an already-answered (200, NDJSON) response. Returns its id.
  function open(res) {
    const id = String(uuid ? uuid() : ('rs-' + (++seq)));
    const s = { id, res, runs: new Map(), withdrawn: new Set(), ka: null, closed: false };
    streams.set(id, s);
    const close = () => closeStream(s);
    try { res.on('close', close); res.on('error', close); } catch (e) { failNote('runstreams.listen', e); }
    s.ka = setIntervalFn(() => { if (!writeRaw(s, '\n')) closeStream(s); }, keepAliveMs);
    if (s.ka && typeof s.ka.unref === 'function') s.ka.unref();
    writeRaw(s, JSON.stringify({ stream: 'ready', id }) + '\n');
    return id;
  }

  /* A run joins its page's stream. null when the stream is gone (closed, or never existed on this station: a restart),
     the key is malformed or already in use, or the page withdrew this key before the run arrived — the caller refuses
     the run before doing any work. The sink:
       write(name, payload)  one event line (payload already redacted by the caller); false once the run is off the stream
       onGone(fn)            what the page leaving means for this run (called at most once, never after end/release)
       end()                 the run is over: its last line, then it leaves the stream
       release()             leave without a last line (the station refused the run after attaching it) */
  function attach(id, key) {
    const s = streams.get(String(id == null ? '' : id));
    key = String(key == null ? '' : key);
    if (!s || s.closed || !KEY_RE.test(key) || s.runs.has(key) || s.withdrawn.has(key)) return null;
    const run = { key, live: true, gone: null };
    s.runs.set(key, run);
    const prefix = '{"k":' + JSON.stringify(key) + ',';
    const leave = () => { run.live = false; if (s.runs.get(key) === run) s.runs.delete(key); };
    return {
      streamId: s.id,
      key,
      live: () => run.live,
      write(name, payload) {
        if (!run.live) return false;
        let body;
        try { body = JSON.stringify({ name, payload }); } catch (_) { return false; }
        return writeRaw(s, prefix + body.slice(1) + '\n');
      },
      onGone(fn) { run.gone = fn; },
      end() { if (!run.live) return; leave(); writeRaw(s, prefix + '"end":true}\n'); },
      release() { if (run.live) leave(); }
    };
  }

  /* The page stopped watching one run (its Stop, or any abort of that run's fetch). A run on the stream is gone at once
     (its gone callback, as if its own response had closed); a key not yet attached is remembered so the run, arriving
     later, is refused. { ok, live } — live: a run was on the stream and was let go. */
  function withdraw(id, key) {
    const s = streams.get(String(id == null ? '' : id));
    key = String(key == null ? '' : key);
    if (!s || s.closed || !KEY_RE.test(key)) return { ok: false, live: false };
    const run = s.runs.get(key);
    if (run) {
      s.runs.delete(key);
      run.live = false;
      if (typeof run.gone === 'function') { try { run.gone(); } catch (e) { failNote('runstreams.withdraw.gone', e); } }
      return { ok: true, live: true };
    }
    s.withdrawn.add(key);
    while (s.withdrawn.size > WITHDRAWN_MAX) s.withdrawn.delete(s.withdrawn.values().next().value);
    return { ok: true, live: false };
  }

  function size() { return streams.size; }
  function runsOn(id) { const s = streams.get(String(id == null ? '' : id)); return s ? s.runs.size : 0; }
  function has(id) { return streams.has(String(id == null ? '' : id)); }

  return { open, attach, withdraw, size, runsOn, has };
}

// The page's { id, key } for a run, when its POST /api/run body named one. null = the run streams on its own response.
function runStreamOf(body) {
  const v = body && body.stream;
  if (!v || typeof v !== 'object') return null;
  const id = typeof v.id === 'string' ? v.id.slice(0, 120) : '';
  const key = typeof v.key === 'string' ? v.key : '';
  return id ? { id, key } : null;
}

module.exports = { makeRunStreams, runStreamOf, KEY_RE };
