/* node test/servicekeys-1password.http.test.js — a 1Password reference through the REAL /api/servicekeys surface.

   Boots the real host with a STUB `op` first on PATH (a shell script on macOS/Linux; on Windows a tiny C program
   built with the local cc/gcc, because Node will not spawn a .cmd without a shell). Proves:
     - saving op://… reads it at once: the row is READY, names its reference, and the response never carries the value;
     - the value is never written to servicekeys.json (or its backup) — only the reference is;
     - a reference 1Password refuses is still SAVED, and the row says why it is not ready (truthful, not "live");
     - `op` gets an explicit minimal env: the user's OP_* vars, never a STARNET_/SKYNET_ station secret;
     - after a restart the reference survives but the value does not (it is re-read on use, never restored from disk).
   Rides test:http (child-process boot). Without a C compiler on Windows the stub cannot be built: SKIP, said aloud. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const VALUE = 'sk_live_STUBVAULT_4242';
const GOOD = 'op://Private/Stripe/credential';
const LOCKED = 'op://Private/Locked/credential';

const C_STUB = `#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(int argc, char **argv, char **envp) {
  const char *log = getenv("OP_STUB_LOG");
  if (log) { FILE *f = fopen(log, "a"); if (f) { for (char **e = envp; *e; e++) { const char *eq = strchr(*e, '='); if (eq) fprintf(f, "%.*s\\n", (int)(eq - *e), *e); } fclose(f); } }
  if (argc < 4 || strcmp(argv[1], "read") != 0 || strcmp(argv[2], "--no-newline") != 0) { fprintf(stderr, "[ERROR] 2026/10/18 12:00:00 unexpected arguments\\n"); return 2; }
  if (strcmp(argv[3], "${GOOD}") == 0) { fputs("${VALUE}", stdout); return 0; }
  if (strcmp(argv[3], "${LOCKED}") == 0) { fprintf(stderr, "[ERROR] 2026/10/18 12:00:00 You are not currently signed in. Please run \`op signin --help\` for instructions\\n"); return 1; }
  fprintf(stderr, "[ERROR] 2026/10/18 12:00:00 isn't an item in the \\"Private\\" vault\\n"); return 1;
}
`;
const SH_STUB = `#!/bin/sh
[ -n "$OP_STUB_LOG" ] && env | cut -d= -f1 >> "$OP_STUB_LOG"
[ "$1" = "read" ] && [ "$2" = "--no-newline" ] || { echo "[ERROR] 2026/10/18 12:00:00 unexpected arguments" >&2; exit 2; }
case "$3" in
  "${GOOD}") printf '%s' "${VALUE}"; exit 0 ;;
  "${LOCKED}") echo "[ERROR] 2026/10/18 12:00:00 You are not currently signed in. Please run op signin --help for instructions" >&2; exit 1 ;;
  *) echo "[ERROR] 2026/10/18 12:00:00 isn't an item in the Private vault" >&2; exit 1 ;;
esac
`;

function buildStub(dir) {
  if (process.platform !== 'win32') {
    const p = path.join(dir, 'op');
    fs.writeFileSync(p, SH_STUB, { mode: 0o755 });
    return p;
  }
  const src = path.join(dir, 'op-stub.c');
  fs.writeFileSync(src, C_STUB);
  for (const cc of ['gcc', 'cc', 'clang']) {
    try { execFileSync(cc, [src, '-o', path.join(dir, 'op.exe')], { stdio: 'ignore', timeout: 60000 }); return path.join(dir, 'op.exe'); }
    catch (e) { if (!/ENOENT/.test(String(e && e.code))) console.log('stub build with ' + cc + ' failed: ' + (e && e.message)); }
  }
  return '';
}

(async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-opstub-'));
  const stub = buildStub(stubDir);
  if (!stub) {
    console.log('SKIP: servicekeys-1password.http.test — no C compiler to build the Windows op stub');
    A.ok(true, 'skipped: no stub');
    A.report('servicekeys-1password.http.test');
    return;
  }
  const log = path.join(stubDir, 'env.log');
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const fixture = SidecarFixture.create({ prefix: 'sk-1password-', env: {
    [pathKey]: stubDir + path.delimiter + (process.env[pathKey] || ''),
    ProgramFiles: stubDir,   // never fall through to a real install
    OP_STUB_LOG: log,
    OP_ACCOUNT: 'stub-account'
  } });
  await fixture.start();
  const B = () => fixture.baseUrl;
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: B() };
    if (fixture.token) headers['X-StarNet-Token'] = fixture.token;
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v, text: t };
  };

  try {
    // ---- the 0.14 upgrade path: a key PASTED before is replaced by its 1Password reference ----
    const PASTED = 'sk_live_PASTED_BEFORE_7777';
    A.eq((await j('POST', '/api/servicekeys', { name: 'Stripe', key: PASTED })).status, 200, 'a pasted key saved first');
    A.eq((await j('POST', '/api/servicekeys', { name: 'Stripe', key: '', docsUrl: 'https://docs.stripe.com' })).status, 200, 'an edit that keeps it');

    // ---- save a reference: read at once, ready, value never echoed ----
    const up = await j('POST', '/api/servicekeys', { name: 'Stripe', key: GOOD });
    A.eq(up.status, 200, 'POST op:// -> 200');
    A.eq(up.body.key.source, '1password', 'the row is a 1Password row');
    A.eq(up.body.key.ref, GOOD, 'it names its reference');
    A.eq(up.body.key.refReady, true, 'it was read on save — got ' + JSON.stringify(up.body.key));
    A.eq(up.body.key.envVar, 'STRIPE_API_KEY', 'same env var as a pasted key');
    A.ok(up.text.indexOf(VALUE) < 0, 'the save response NEVER carries the value');
    const list = await j('GET', '/api/servicekeys');
    A.ok(list.body.keys[0].refReady && list.body.keys[0].refReadAt > 0, 'the list says when it was read');
    A.ok(list.text.indexOf(VALUE) < 0, 'the list NEVER carries the value');

    // ---- only the reference is on disk ----
    const file = path.join(fixture.workspace, 'connectors', 'servicekeys.json');
    const disk = fs.readFileSync(file, 'utf8') + (fs.existsSync(file + '.bak') ? fs.readFileSync(file + '.bak', 'utf8') : '');
    A.ok(disk.indexOf(GOOD) >= 0, 'the reference is persisted');
    A.ok(disk.indexOf(VALUE) < 0, 'the value read from 1Password is NEVER persisted');
    A.ok(fs.existsSync(file + '.bak') && disk.indexOf(PASTED) < 0, 'the pasted key the reference replaced is in neither the main file nor its recovery copy');

    // ---- op's environment: OP_* yes, station secrets no ----
    const names = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
    A.ok(names.indexOf('OP_ACCOUNT') >= 0 && names.indexOf('OP_STUB_LOG') >= 0, 'the user\'s OP_* vars reach op');
    A.ok(!names.some(n => /^(STARNET|SKYNET)_/i.test(n)), 'no STARNET_/SKYNET_ variable reaches op — got ' + names.filter(n => /^(STARNET|SKYNET)_/i.test(n)).join(','));

    // ---- a refused reference is saved, and says why it is not ready ----
    const lk = await j('POST', '/api/servicekeys', { name: 'Locked Thing', key: LOCKED });
    A.eq(lk.status, 200, 'a reference 1Password refuses is still saved');
    A.eq(lk.body.key.refReady, false, 'and is NOT ready');
    A.ok(/unlock the 1Password app/.test(lk.body.key.refError) && /not currently signed in/.test(lk.body.key.refError), 'it says what to do and what op said — got ' + lk.body.key.refError);
    A.eq((await j('POST', '/api/servicekeys', { name: 'Bad', key: 'op://Private/Stripe' })).status, 400, 'a malformed reference -> 400');

    // ---- restart: the reference survives, the value does not ----
    await fixture.restart();
    const after = await j('GET', '/api/servicekeys');
    const stripe = after.body.keys.find(k => k.id === 'stripe');
    A.ok(stripe && stripe.ref === GOOD, 'REBOOT: the reference survived');
    A.eq(stripe && stripe.refReady, false, 'REBOOT: the value did not (it is re-read on use, never restored from disk)');
    A.ok(/^not read yet/.test(stripe && stripe.refError), 'REBOOT: the row says it reads on use');

    // ---- re-save re-reads; remove forgets ----
    const again = await j('POST', '/api/servicekeys', { name: 'Stripe', key: '' });
    A.eq(again.body.key.refReady, true, 'saving again (empty key keeps the reference) reads it again');
    A.eq((await j('POST', '/api/servicekeys/remove', { id: 'stripe' })).status, 200, 'remove -> 200');
    A.ok(!(await j('GET', '/api/servicekeys')).body.keys.some(k => k.id === 'stripe'), 'gone after remove');
  } finally {
    await fixture.dispose();
    try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch (e) { console.log('stub cleanup: ' + (e && e.message)); }
  }

  A.report('servicekeys-1password.http.test');
})().catch(e => { console.log('FAIL: servicekeys-1password.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
