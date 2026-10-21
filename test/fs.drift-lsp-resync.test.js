/* node test/fs.drift-lsp-resync.test.js — after a concurrent write, the language server still holds what is on disk
   (2026-10-21).

   An fs mutation sends the file's pre-edit text to the language server (beginEdit: didOpen/didChange) and, after
   the write, sends the bytes now on disk (finishEdit: didChange + didSave). When another run wrote the file during
   the baseline, the edit landed on THEIR bytes and skipped finishEdit (its before/after delta would include their
   change), and a refusal under the file lock (stale fs.write, moved fs.patch source, vanished fs.edit "find")
   threw past it. Either way the server kept the pre-edit text as an open document, and for TypeScript, pyright and
   rust-analyzer an open document overrides disk: later diagnostics on OTHER files were computed against a file
   that matches neither run's write. The drift receipt text itself is unchanged.

   Real temp dirs, real fs, the real lsp-manager speaking JSON-RPC to the fake stdio server; the only hook is a
   baseline that parks until the test lets it go, and a spy on the text each document was last sent. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { makeLspManager } = require('../sidecar/lsp-manager.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const DRIFT_NOTE = '\n\n[LSP unavailable: the file changed on disk while this edit was in flight (another writer), so a before/after diagnostic comparison would include their change. Run verify.run for project-level proof.]';

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-drift-lsp-'));
  const fixture = path.join(__dirname, 'fixtures', 'fake-lsp-server.js');
  const manager = makeLspManager({
    spawn, fs, fsp, pathMod: path, env: Object.assign({}, process.env),
    servers: [{ id: 'fake', command: process.execPath, args: [fixture], extensions: ['.fake'], languageIds: { '.fake': 'fake' } }],
    limits: { requestTimeoutMs: 4000, diagnosticTimeoutMs: 1000, idleMs: 60000 }
  });
  // what the server was last told each open document holds
  const sent = new Map();
  const Client = manager._internals.Client;
  const notify = Client.prototype.notify;
  Client.prototype.notify = function (method, params) {
    if (method === 'textDocument/didOpen') sent.set(params.textDocument.uri, params.textDocument.text);
    if (method === 'textDocument/didChange') sent.set(params.textDocument.uri, params.contentChanges[0].text);
    return notify.call(this, method, params);
  };
  let n = 0;
  async function project(files) {
    const proj = path.join(root, 'proj' + (n++));
    await fsp.mkdir(proj, { recursive: true });
    for (const [rel, text] of Object.entries(files)) await fsp.writeFile(path.join(proj, rel), text);
    return proj;
  }
  // the lead's language server answers its baseline, then parks until the other run has written
  function leadTools(proj) {
    let reach, release;
    const reached = new Promise((r) => { reach = r; });
    const released = new Promise((r) => { release = r; });
    const editDiagnostics = {
      beginEdit: async (input) => { const t = await manager.beginEdit(input); reach(); await released; return t; },
      finishEdit: (t, input) => manager.finishEdit(t, input)
    };
    const tools = makeFsTools({ fsp, pathMod: path, root, pathTrust: async (abs) => ({ base: proj, abs }), editDiagnostics });
    return { tools, reached, release };
  }
  // the other writer has no language server of its own (a worker on a plain run, the Commander's editor)
  const otherTools = (proj) => makeFsTools({ fsp, pathMod: path, root, pathTrust: async (abs) => ({ base: proj, abs }) });
  async function rejection(p) { try { await p; return null; } catch (e) { return e; } }
  const uriOf = (abs) => pathToFileURL(abs).href;

  try {
    // ---- 1. fs.edit / fs.append that land on the other run's bytes: receipt unchanged, server re-synced ----
    for (const tool of ['edit', 'append']) {
      const proj = await project({ 'a.fake': 'clean A\nclean B\n' });
      const abs = path.join(proj, 'a.fake');
      const lead = leadTools(proj), other = otherTools(proj);
      const c1 = { agentId: 'lead', projectRoot: proj }, c2 = { agentId: 'worker', projectRoot: proj };
      await lead.tools.readTool.run({ path: 'a.fake' }, c1);
      await other.readTool.run({ path: 'a.fake' }, c2);
      const pending = tool === 'edit'
        ? lead.tools.editTool.run({ path: 'a.fake', find: 'clean A', replace: 'A edited' }, c1)
        : lead.tools.appendTool.run({ path: 'a.fake', content: 'A appended\n' }, c1);
      await lead.reached;
      await other.editTool.run({ path: 'a.fake', find: 'clean B', replace: 'B BROKEN' }, c2);
      lead.release();
      const r = await pending;
      const disk = await fsp.readFile(abs, 'utf8');
      A.ok(/B BROKEN/.test(disk), tool + ": the lead's change landed on the other run's bytes: " + JSON.stringify(disk));
      A.ok(r.content.endsWith(DRIFT_NOTE), tool + ': the drift receipt keeps its exact LSP-unavailable text: ' + JSON.stringify(r.content.slice(-80)));
      A.eq(r.diagnostics, { status: 'unavailable', reason: 'the file changed on disk while this edit was in flight (another writer), so a before/after diagnostic comparison would include their change', added: [], removed: [], addedCount: 0, removedCount: 0 }, tool + ': and the same diagnostics object');
      A.eq(sent.get(uriOf(abs)), disk, tool + ': the language server holds the bytes on disk, not the pre-edit text it was sent for the baseline');
    }

    // ---- 2. fs.write over a file this run never read, written by another run during the baseline ----
    {
      const proj = await project({ 'w.fake': 'clean\n' });
      const abs = path.join(proj, 'w.fake');
      const lead = leadTools(proj), other = otherTools(proj);
      const c1 = { agentId: 'lead', projectRoot: proj }, c2 = { agentId: 'worker', projectRoot: proj };
      await other.readTool.run({ path: 'w.fake' }, c2);
      const pending = lead.tools.writeTool.run({ path: 'w.fake', content: 'lead wrote this\n' }, c1);
      await lead.reached;
      await other.editTool.run({ path: 'w.fake', find: 'clean', replace: 'worker BROKEN' }, c2);
      lead.release();
      const r = await pending;
      A.ok(r.content.endsWith(DRIFT_NOTE), 'write: the drift receipt keeps its exact LSP-unavailable text');
      A.eq(sent.get(uriOf(abs)), 'lead wrote this\n', 'write: the language server holds the bytes on disk');
    }

    // ---- 3. refusals under the lock: stale fs.write, moved fs.patch source, vanished fs.edit "find" ----
    for (const kind of ['stale-write', 'patch', 'edit-vanished']) {
      const proj = await project({ 'r.fake': 'alpha\nbeta\n' });
      const abs = path.join(proj, 'r.fake');
      const lead = leadTools(proj), other = otherTools(proj);
      const c1 = { agentId: 'lead', projectRoot: proj }, c2 = { agentId: 'worker', projectRoot: proj };
      await lead.tools.readTool.run({ path: 'r.fake' }, c1);
      await other.readTool.run({ path: 'r.fake' }, c2);
      const pending = rejection(kind === 'stale-write'
        ? lead.tools.writeTool.run({ path: 'r.fake', content: 'from a stale read\n' }, c1)
        : kind === 'patch'
          ? lead.tools.patchTool.run({ patch: '*** Begin Patch\n*** Update File: r.fake\n@@\n-alpha\n+ALPHA\n beta\n*** End Patch' }, c1)
          : lead.tools.editTool.run({ path: 'r.fake', find: 'alpha', replace: 'ALPHA' }, c1));
      await lead.reached;
      if (kind === 'edit-vanished') await other.writeTool.run({ path: 'r.fake', content: 'gamma BROKEN\n' }, c2);
      else await other.editTool.run({ path: 'r.fake', find: 'beta', replace: 'beta BROKEN' }, c2);
      lead.release();
      const e = await pending;
      const disk = await fsp.readFile(abs, 'utf8');
      const expected = kind === 'stale-write' ? /^stale write refused: r\.fake changed on disk after you read it/
        : kind === 'patch' ? /^fs\.patch refused: r\.fake changed on disk while this patch was being prepared/
          : /^"find" text not found in r\.fake/;
      A.ok(e && expected.test(e.message), kind + ': refused with its existing error: ' + (e ? e.message : 'NOT refused'));
      A.ok(/BROKEN/.test(disk), kind + ": the other run's write is what is on disk");
      A.eq(sent.get(uriOf(abs)), disk, kind + ': the language server holds the bytes on disk, not the pre-edit text it was sent for the baseline');
    }

    // ---- 4. no drift: the ordinary edit keeps its real before/after comparison ----
    {
      const proj = await project({ 'x.fake': 'clean\n' });
      const abs = path.join(proj, 'x.fake');
      const tools = makeFsTools({ fsp, pathMod: path, root, pathTrust: async (a) => ({ base: proj, abs: a }), editDiagnostics: manager });
      const ctx = { agentId: 'solo', projectRoot: proj };
      await tools.readTool.run({ path: 'x.fake' }, ctx);
      const r = await tools.editTool.run({ path: 'x.fake', find: 'clean', replace: 'BROKEN' }, ctx);
      A.eq(r.diagnostics && r.diagnostics.addedCount, 1, 'an undisturbed edit still reports its one new diagnostic');
      A.eq(sent.get(uriOf(abs)), 'BROKEN\n', 'and the server holds the bytes on disk');
    }
  } finally {
    Client.prototype.notify = notify;
    await manager.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('fs.drift-lsp-resync.test');
})().catch((e) => { console.log('FAIL: fs.drift-lsp-resync.test threw — ' + (e && e.stack || e)); process.exit(1); });
