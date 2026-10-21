/* node test/source-collapsed-escapes.test.js — no shipped source file may carry a COLLAPSED ESCAPE byte.

   A tool that wrote source through an extra string layer turned the two characters `\b` into the single byte 0x08
   (and `\a` into 0x07). Inside a regex that is silent and fatal: `/\x08rpm\x08/` only matches text that contains
   backspace bytes, i.e. never. Found live by sweep/providers (2026-10-20), three times on trunk:
     · frontend/app/friendlyerror.js SHORT_WINDOW_RE — the browser's per-minute veto had lost `rpm`/`tpm`;
     · sidecar/index.js parseCronScheduleOr400 — the "every other week cannot be scheduled" refusal never fired,
       so a fortnightly routine got the generic "couldn't read that schedule";
     · website/docs/glossary.html — the Windows data path read "%APPDATA%<BEL>i.skynet.harness".
   0x01 (chat.js placeholder sentinel, modeldock.js key separator) and 0x1B (an ANSI example) are deliberate and are
   NOT in the banned set: only the bytes a collapsed \0 \a \b \v \f escape produces are. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['sidecar', 'frontend', 'shared', 'website', 'desktop/src', 'scripts'];
const EXT = /\.(?:js|mjs|cjs|html|css|json)$/i;
const SKIP = /(?:^|[\\/])(?:node_modules|\.git|dist|target|vendor)(?:[\\/]|$)/;
const BANNED = /[\x00\x07\x08\x0B\x0C]/;

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && EXT.test(e.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);
A.ok(files.length > 200, 'the scan saw the source tree (' + files.length + ' files)');
let scanned = 0;
for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (_) { continue; }
  if (buf.length > 8 * 1024 * 1024) continue;            // generated bundles / images-as-json are not hand-written source
  if (buf.indexOf(0) >= 0 && !/\.(?:js|mjs|cjs|html|css)$/i.test(f)) continue;   // a binary-ish json blob
  scanned++;
  const text = buf.toString('utf8');
  if (!BANNED.test(text)) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (BANNED.test(lines[i])) {
      const shown = lines[i].replace(/[\x00-\x1F]/g, c => '<0x' + c.charCodeAt(0).toString(16).padStart(2, '0') + '>').trim().slice(0, 160);
      A.ok(false, path.relative(ROOT, f).replace(/\\/g, '/') + ':' + (i + 1) + ' carries a collapsed escape byte: ' + shown);
    }
  }
}
A.ok(scanned > 200, 'scanned ' + scanned + ' source files');
A.report('source-collapsed-escapes.test');
