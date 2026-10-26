/* bin/lib/version.js — which StarNet build this `starnet` command belongs to, read from what actually ships beside bin/.
   package.json is not a bundle resource (src-tauri/tauri.conf.json ships sidecar, frontend, shared, bin), so an
   installed build needs its own source of truth:
     a checkout              package.json
     the macOS app           StarNet.app/Contents/Info.plist (bin/ sits in Contents/Resources) CFBundleShortVersionString
     a Windows install       skynet-desktop.exe beside bin\ — its VS_FIXEDFILEINFO file version, the number the
                             installer's own GetDLLVersion reads (src-tauri/installer/hooks.nsh)
   and 'unknown' when none says — never a made-up 'dev'. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// VS_FIXEDFILEINFO: dwSignature 0xFEEF04BD, dwStrucVersion, dwFileVersionMS, dwFileVersionLS → "major.minor.patch"
function peFileVersion(buf) {
  const i = buf.indexOf(Buffer.from([0xBD, 0x04, 0xEF, 0xFE]));
  if (i < 0 || i + 16 > buf.length) return '';
  const ms = buf.readUInt32LE(i + 8), ls = buf.readUInt32LE(i + 12);
  return (ms >>> 16) + '.' + (ms & 0xffff) + '.' + (ls >>> 16);
}

function cliVersion(repo) {
  try { const v = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version; if (v) return String(v); } catch (_) {}
  try {
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(path.join(repo, '..', 'Info.plist'), 'utf8'));
    if (m && m[1].trim()) return m[1].trim();
  } catch (_) {}
  try { const v = peFileVersion(fs.readFileSync(path.join(repo, 'skynet-desktop.exe'))); if (v) return v; } catch (_) {}
  return 'unknown';
}

module.exports = { cliVersion, peFileVersion };
