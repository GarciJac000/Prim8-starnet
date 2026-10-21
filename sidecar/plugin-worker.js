/* sidecar/plugin-worker.js — ONE plugin's code, in its OWN process (plugin extensions phase 2, 2026-09-29).

   Forked by sidecar/plugin-runtime.js with the station-secret-free environment. Why a process per plugin: NOT a
   security boundary (an approved plugin runs with the Commander's full computer permissions, and the approval card
   says so), but a FAILURE boundary — a plugin that throws, leaks, spins forever or calls process.exit() takes down
   itself, never the station. Before this, plugin code ran inside the sidecar, so one bad folder could stop every run.

   The plugin's main exports register(api). The api is the plugin's whole reach into the station, over IPC:
     api.on(event, fn)                 hook the run (pre_tool_call may return { decision: 'block', reason })
     api.tool({ name, description, parameters, readOnly, run(args, ctx) })   a tool the crew can call
     api.handle(name, fn(args))        answer the plugin's own windows: starnet.backend.call(name, args)
     api.every(ms, fn)                 a background job (min 10 s)
     api.store.get/set/delete/keys     the SAME private store the plugin's windows use
     api.log(...)                      a line in the station log, prefixed with the plugin id
   Everything registered must be registered during register() (sync, or the promise it returns). */
'use strict';
const { note } = require('./failopen.js');   // the worker's own IPC failures are noted, never silently dropped

const MIN_EVERY_MS = 10000;
const MAX_TOOLS = 32, MAX_HANDLERS = 64, MAX_JOBS = 8;
const subs = new Map();       // event -> [fn]
const hookTimeouts = {};      // event -> the longest timeoutMs a handler asked for (api.on(event, fn, { timeoutMs }))
const tools = new Map();      // name -> { def, run }
const handlers = new Map();   // name -> fn
const jobs = [];
let jobTimers = [], jobsPaused = false;
function startJobs() {
  if (jobTimers.length) return;
  for (const j of jobs) {
    const t = setInterval(() => {
      if (jobsPaused) return;
      Promise.resolve().then(() => j.fn()).catch((e) => log('[job] ' + errText(e)));
    }, j.ms);
    if (t && typeof t.unref === 'function') t.unref();
    jobTimers.push(t);
  }
}
function stopJobs() { for (const t of jobTimers) clearInterval(t); jobTimers = []; }
let registering = false;
let info = { id: '', name: '' };
let seq = 0;
const pending = new Map();

// note() logs through console, which this worker routes back over IPC: a failing send must not re-enter itself
let noting = false;
function send(m) {
  try { if (process.connected) process.send(m); }
  catch (e) { if (!noting) { noting = true; try { note('plugins.worker.send', e); } finally { noting = false; } } }
}
function errText(e) { return String((e && e.message) || e || 'error').slice(0, 2000); }
function log() {
  const line = Array.prototype.slice.call(arguments).map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(' ');
  send({ t: 'log', line: line.slice(0, 4000) });
}
// Keep the plugin's own console output flowing to the station log (stdout may be a closed pipe on some hosts).
console.log = log; console.info = log; console.warn = log; console.error = log;

function request(op, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('the station did not answer ' + op)); } }, 15000);
    pending.set(id, { resolve, reject, timer });
    send({ t: 'req', id, op, args });
  });
}

function needRegistering(what) {
  if (!registering) throw new Error(what + ' must be called inside register(api)');
}

function makeApi() {
  return {
    get id() { return info.id; },
    get name() { return info.name; },
    on(event, fn, meta) {
      needRegistering('api.on');
      if (typeof fn !== 'function') return () => {};
      const e = String(event || '');
      if (!subs.has(e)) subs.set(e, []);
      subs.get(e).push(fn);
      const ms = Number(meta && meta.timeoutMs);
      if (ms > 0) hookTimeouts[e] = Math.min(30000, Math.max(hookTimeouts[e] || 0, ms));
      return () => {};
    },
    tool(def) {
      needRegistering('api.tool');
      const d = def || {};
      const name = String(d.name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(name)) throw new Error('api.tool: name must start with a letter; letters, numbers, _ or - (max 48)');
      if (typeof d.run !== 'function') throw new Error('api.tool: run(args, ctx) is required');
      if (tools.size >= MAX_TOOLS) throw new Error('api.tool: at most ' + MAX_TOOLS + ' tools per plugin');
      const parameters = d.parameters || d.schema || { type: 'object', properties: {} };
      tools.set(name, { def: { name, description: String(d.description || '').slice(0, 1200), parameters, readOnly: d.readOnly === true }, run: d.run });
    },
    handle(name, fn) {
      needRegistering('api.handle');
      const n = String(name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(n)) throw new Error('api.handle: name must start with a letter (max 64)');
      if (typeof fn !== 'function') throw new Error('api.handle: a function is required');
      if (handlers.size >= MAX_HANDLERS) throw new Error('api.handle: at most ' + MAX_HANDLERS + ' handlers per plugin');
      handlers.set(n, fn);
    },
    every(ms, fn) {
      needRegistering('api.every');
      if (typeof fn !== 'function') throw new Error('api.every: a function is required');
      if (jobs.length >= MAX_JOBS) throw new Error('api.every: at most ' + MAX_JOBS + ' jobs per plugin');
      jobs.push({ ms: Math.max(MIN_EVERY_MS, Number(ms) || MIN_EVERY_MS), fn });
    },
    store: {
      get: (key) => request('store', { op: 'get', key }),
      set: (key, value) => request('store', { op: 'set', key, value }),
      delete: (key) => request('store', { op: 'delete', key }),
      keys: () => request('store', { op: 'keys' })
    },
    log
  };
}

// JSON-safe copy (IPC is JSON): a plugin returning a Map or a cycle must fail loudly, not crash the channel.
function plain(v) {
  if (v === undefined) return null;
  return JSON.parse(JSON.stringify(v));
}

/* NO HIDDEN STREAMS. An NTFS alternate data stream ('lib.js:evil.js') is invisible to the folder listing the approval
   digest is computed from, so require()ing one would run code nobody approved. Every module this plugin loads must
   resolve to an ordinary path (the only ':' allowed is the drive letter). */
const Module = require('module');
const pathMod = require('path');   // resolved BEFORE the hook below: a require() inside it would recurse
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  const out = resolveFilename.call(this, request, parent, isMain, options);
  if (typeof out === 'string' && pathMod.isAbsolute(out) && out.indexOf(':', 2) >= 0) throw new Error('refused to load ' + out + ' — a path with ":" can hide code from the approval');
  return out;
};

async function onInit(m) {
  info = { id: String(m.id || ''), name: String(m.name || m.id || '') };
  let mod;
  try { mod = require(m.main); }
  catch (e) { return send({ t: 'ready', ok: false, error: 'failed to load — ' + errText(e) }); }
  const register = mod && (typeof mod.register === 'function' ? mod.register : (typeof mod === 'function' ? mod : null));
  if (!register) return send({ t: 'ready', ok: false, error: 'exports no register(api) function' });
  registering = true;
  try { await register(makeApi()); }
  catch (e) { registering = false; return send({ t: 'ready', ok: false, error: 'register() threw — ' + errText(e) }); }
  registering = false;
  // E-STOP pauses background jobs (the station sends jobsPaused at init and { t: 'jobs' } later); hooks keep answering
  jobsPaused = m.jobsPaused === true;
  if (!jobsPaused) startJobs();
  send({
    t: 'ready', ok: true,
    subs: Array.from(subs.keys()),
    hookTimeouts,
    tools: Array.from(tools.values()).map((x) => x.def),
    handlers: Array.from(handlers.keys()),
    jobs: jobs.length
  });
}

const toolAborts = new Map();   // tool call id -> AbortController (the station's { t:'cancel', ref })
async function answer(m, fn) {
  try { send({ t: 'res', id: m.id, ok: true, v: plain(await fn()) }); }
  catch (e) { send({ t: 'res', id: m.id, ok: false, err: errText(e) }); }
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'init') return void onInit(m);
  if (m.t === 'ans') {   // the station answering one of OUR requests
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    return m.ok ? p.resolve(m.v) : p.reject(new Error(String(m.err || 'refused')));
  }
  if (m.t === 'hook') {
    // Same contract as the in-process spine: handlers in registration order; the first one that returns a
    // decision (block) or a context note is the plugin's answer for this event.
    return void answer(m, async () => {
      for (const fn of (subs.get(String(m.event)) || [])) {
        const r = await fn(m.payload);
        if (r && typeof r === 'object') return r;
      }
      return null;
    });
  }
  if (m.t === 'tool') {
    const t = tools.get(String(m.name));
    if (!t) return send({ t: 'res', id: m.id, ok: false, err: 'this plugin has no tool named ' + m.name });
    // ctx.signal aborts when the run that called this tool is stopped (STOP / E-STOP): a tool can stop its own work
    const ac = new AbortController();
    toolAborts.set(m.id, ac);
    return void answer(m, () => t.run(m.args || {}, Object.assign({}, m.ctx || {}, { signal: ac.signal }))).finally(() => toolAborts.delete(m.id));
  }
  if (m.t === 'cancel') { const ac = toolAborts.get(m.ref); if (ac) { toolAborts.delete(m.ref); try { ac.abort(); } catch (e) { note('plugins.worker.cancel', e); } } return; }
  if (m.t === 'call') {
    const fn = handlers.get(String(m.name));
    if (!fn) return send({ t: 'res', id: m.id, ok: false, err: 'this plugin has no handler named "' + m.name + '"' });
    return void answer(m, () => fn(m.args == null ? null : m.args));
  }
  if (m.t === 'jobs') { jobsPaused = m.paused === true; if (jobsPaused) stopJobs(); else startJobs(); return; }
  // the runtime's liveness check after a call timed out: answering it at all proves this event loop is not wedged
  if (m.t === 'ping') return send({ t: 'pong', ref: m.ref });
  if (m.t === 'stop') { try { process.exit(0); } catch (e) { note('plugins.worker.stop-exit', e); } }
});

process.on('disconnect', () => { try { process.exit(0); } catch (e) { note('plugins.worker.disconnect-exit', e); } });
// An uncaught throw leaves the plugin's state unknowable: say why, then die. The runtime marks it crashed and
// restarts it on its next use (bounded), so the station never keeps talking to a half-broken plugin.
process.on('uncaughtException', (e) => { log('[uncaught] ' + errText(e)); setTimeout(() => process.exit(1), 50); });
process.on('unhandledRejection', (e) => { log('[unhandled] ' + errText(e)); });
