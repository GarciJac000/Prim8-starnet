/* node test/update-snapshot-budget.test.js — the pre-update recovery point is BOUNDED, station state first.

   A recovery bundle is one JSON string with every payload base64 inside it. V8 caps a string at ~536.8M chars, so a
   station holding more than ~400 MB of included files (coding agents' node_modules, long transcripts, checkpoints)
   threw RangeError in JSON.stringify and every in-app update stopped at "Update paused - no verified recovery point
   was created" with no way past it. The pre-update capture now takes a byte budget: the saves + roster first, every
   other station store next, agents' own workspace files (smallest first) last. What does not fit is never read, is
   listed in the bundle's report.skipped with its size, and is summarised in the receipt (tooLarge). An explicit
   export (no budget) still takes everything. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { constants: bufferConstants } = require('node:buffer');
const R = require('../sidecar/station-recovery.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const Prep = require('../sidecar/update-preparation.js');

const REASON = 'too large for the pre-update recovery point';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-snapshot-budget-'));
const ws = path.join(sandbox, 'workspaces');
function write(rel, value) {
  const file = path.join(ws, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
const size = rel => fs.statSync(path.join(ws, ...rel.split('/'))).size;
const filler = n => 'x'.repeat(n);

write('agent.roster.json', { version: 1, agents: [{ agentId: 'agent' }, { agentId: 'engineer' }] });
write('agent.save.json', { version: 1, agentId: 'agent', updatedAt: 1, doc: { agent: { id: 'agent' }, pad: filler(20000) } });
write('transcript.jsonl', JSON.stringify({ role: 'user', content: 'keep me' }) + '\n');
write('transcript-history-v2/agent/0001.json', { pad: filler(8000) });
write('.run-journal/run-1.json', { pad: filler(2000) });
write('agent/notes.md', filler(1000));
write('engineer/report.md', filler(2000));
write('agent/node_modules/huge/index.js', Buffer.alloc(60000, 1));
write('agent/build/out.bin', Buffer.alloc(40000, 2));
write('.checkpoints/agent/git/objects/aa/bb', Buffer.alloc(30000, 3));

const BIG = ['agent/node_modules/huge/index.js', 'agent/build/out.bin', '.checkpoints/agent/git/objects/aa/bb'];
const browserStore = { 'starnet.save': JSON.stringify({ version: 5, updatedAt: 1 }) };

(async () => {
  try {
    // ---- 1. capture({ maxBytes }) keeps station state, leaves the largest workspace files out, never lies about it
    const budget = 50 * 1024;
    const b = R.capture({ workspaceRoot: ws, now: 1, browserStore, maxBytes: budget });
    const has = rel => b.files.some(f => f.path === rel);
    for (const rel of ['agent.save.json', 'agent.roster.json', 'transcript.jsonl', 'transcript-history-v2/agent/0001.json', '.run-journal/run-1.json', 'agent/notes.md', 'engineer/report.md']) {
      A.ok(has(rel), 'within the budget, ' + rel + ' rides in the recovery point');
    }
    for (const rel of BIG) {
      A.eq(has(rel), false, rel + ' does not fit the budget and is left out');
      const row = (b.report.skipped || []).find(s => s.path === rel);
      A.eq(row && row.reason, REASON, rel + ' is listed in report.skipped as too large for the pre-update recovery point');
      A.eq(row && row.bytes, size(rel), rel + ' is listed with its size');
    }
    const fileBytes = b.files.reduce((n, f) => n + f.bytes, 0);
    const browserBytes = b.browser.reduce((n, e) => n + e.bytes, 0);
    A.ok(fileBytes + browserBytes <= budget, 'files + browser state stay within the budget (' + (fileBytes + browserBytes) + ' <= ' + budget + ')');
    A.eq(R.validate(b).ok, true, 'a budgeted bundle still validates');
    const file = path.join(sandbox, 'out', 'budget.starnet-backup.json');
    const written = R.writeBundleAtomic({ bundle: b, file, allowIncomplete: true });
    A.eq(R.readBundle(file).manifestSha256, written.manifestSha256, 'and it writes + reads back verified');

    // ---- 2. station state beats a SMALLER workspace file: the save + roster ride, the 1 KB agent note does not
    const tight = R.capture({ workspaceRoot: ws, now: 1, maxBytes: size('agent.save.json') + size('agent.roster.json') });
    A.eq(tight.files.map(f => f.path).sort(), ['agent.roster.json', 'agent.save.json'], 'a tight budget keeps exactly the saves + roster, not the smallest files');
    A.eq((tight.report.skipped || []).filter(s => s.reason === REASON).length, 8, 'every other included file is listed as too large');

    // ---- 3. an explicit export (no budget) is unchanged: everything rides
    const full = R.capture({ workspaceRoot: ws, now: 1, browserStore });
    for (const rel of BIG) A.ok(full.files.some(f => f.path === rel), 'without a budget ' + rel + ' is still exported');
    A.eq((full.report.skipped || []).some(s => s.reason === REASON), false, 'and nothing is skipped as too large');

    // ---- 4. prepare passes its budget and the receipt says what was left out
    let clock = 5000;
    const prep = Prep.makeUpdatePreparation({
      fs, path, recovery: R, writeDurable: writeFileDurable, workspaceRoot: ws,
      now: () => clock, newId: () => 'budget', appVersion: () => '0.14.0', snapshotBudgetBytes: budget,
      sleep: async () => { clock += 25; }
    });
    const made = await prep.prepare({ targetVersion: '0.14.1', browserStore });
    A.eq(made.ok, true, 'a station over the budget still gets its verified recovery point');
    const tooLarge = made.receipt && made.receipt.tooLarge;
    A.eq(tooLarge && tooLarge.reason, REASON, 'the receipt names why files were left out');
    A.eq(tooLarge && tooLarge.files, 3, 'the receipt counts the files left out');
    A.eq(tooLarge && tooLarge.bytes, BIG.reduce((n, rel) => n + size(rel), 0), 'and their bytes');
    A.eq(tooLarge && tooLarge.paths.map(p => p.path), BIG, 'largest first');
    const onDisk = R.readBundle(made.receipt.snapshot.file);
    A.eq(onDisk.files.some(f => f.path === 'agent.save.json'), true, 'the save rides in the pre-update recovery point');
    A.eq(onDisk.files.some(f => f.path === BIG[0]), false, 'the oversized workspace file does not');
    prep.cancel();

    // ---- 5. the default budget leaves room under V8's string cap, and prepare uses it when nothing is injected
    A.ok(Number.isFinite(Prep.SNAPSHOT_BUDGET_BYTES) && Prep.SNAPSHOT_BUDGET_BYTES > 0, 'a default pre-update budget exists');
    const b64 = Math.ceil(Prep.SNAPSHOT_BUDGET_BYTES / 3) * 4;
    A.ok(b64 + 64 * 1024 * 1024 < bufferConstants.MAX_STRING_LENGTH, 'the default budget (' + b64 + ' base64 chars) + 64M of framing fits under MAX_STRING_LENGTH ' + bufferConstants.MAX_STRING_LENGTH);
    let seen = null;
    const spy = Object.assign({}, R, { capture: opts => { seen = opts.maxBytes; return R.capture(opts); } });
    const prepDefault = Prep.makeUpdatePreparation({
      fs, path, recovery: spy, writeDurable: writeFileDurable, workspaceRoot: ws,
      now: () => clock, newId: () => 'default', sleep: async () => { clock += 25; }
    });
    const madeDefault = await prepDefault.prepare({ targetVersion: '0.14.1', browserStore: {} });
    A.eq(madeDefault.ok, true, 'prepare with the default budget succeeds');
    A.eq(seen, Prep.SNAPSHOT_BUDGET_BYTES, 'and hands capture the default budget');
    prepDefault.cancel();

    A.report('update-snapshot-budget.test');
  } finally {
    const dir = path.join(sandbox, 'update-snapshots');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      try { fs.chmodSync(path.join(dir, name), 0o666); } catch (e) { console.log('chmod ' + name + ': ' + e.code); }
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
