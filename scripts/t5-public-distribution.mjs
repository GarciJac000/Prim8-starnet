#!/usr/bin/env node
// t5-public-distribution.mjs - public Windows distribution readiness gate.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCurrentNsisInstaller } from './lib/release-installer.mjs';
import { resolvePubkeyText, verifySignature } from './minisign-verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);
const LOOP_ARG = rawArgs.find(a => /^--loop(=|$)/.test(a));
const LOOP_MAX = LOOP_ARG ? Math.max(1, Number(LOOP_ARG.split('=')[1] || process.env.STARNET_T5_LOOPS || 3) || 3) : 1;
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace(/Z$/, '') + '-' + process.pid;
const OUT = resolve(process.env.STARNET_T5_PUBLIC_DISTRIBUTION_DIR || join(ROOT, '.dogfood', 't5-public-distribution-' + STAMP));
const LATEST = resolve(process.env.STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR || join(ROOT, '.dogfood', 't5-public-distribution-latest'));
const PROOF_SCHEMA = 'starnet.t5-public-distribution-proof.v1';
const PLATFORM = 'windows-x86_64';

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }
function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch (_) { return ''; }
}
function readJson(file, fallback = null) {
  try { return JSON.parse(stripBom(readFileSync(file, 'utf8'))); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function sha256(file) {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}
function fileInfo(file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) return null;
  const st = statSync(file);
  return { path: resolve(file), bytes: st.size, sha256: sha256(file), mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
}
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
function statusIcon(status) {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  if (status === 'blocked') return 'BLOCKED';
  return 'SKIP';
}
function copyLatest() {
  rmSync(LATEST, { recursive: true, force: true });
  ensureDir(LATEST);
  for (const name of readdirSync(OUT)) {
    const src = join(OUT, name);
    try { if (statSync(src).isFile()) copyFileSync(src, join(LATEST, name)); } catch (_) {}
  }
}
function argValue(name) {
  const eq = rawArgs.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const idx = rawArgs.indexOf(name);
  return idx >= 0 ? rawArgs[idx + 1] : '';
}
function installerPath() {
  const raw = process.env.STARNET_T5_INSTALLER_EXE || process.env.STARNET_T4_INSTALLER_EXE || process.env.STARNET_T3_INSTALLER_EXE || '';
  if (raw) return resolve(raw);
  return findCurrentNsisInstaller(ROOT);
}
function manifestPath() {
  const raw = process.env.STARNET_T5_MANIFEST || argValue('--manifest') || '';
  if (raw) return resolve(raw);
  return resolve(join(ROOT, 'release', 'latest.json'));
}
function distributionEvidencePath() {
  const raw = process.env.STARNET_T5_DISTRIBUTION_EVIDENCE || argValue('--distribution-evidence') || '';
  return raw ? resolve(raw) : '';
}
function statusPath(label) {
  const env = process.env['STARNET_T5_' + label + '_STATUS'];
  if (env) return resolve(env);
  const map = {
    T0: join(ROOT, '.dogfood', 't0-clean-install-latest', 't0-clean-install-status.json'),
    T1: join(ROOT, '.dogfood', 't1-signing-latest', 't1-signing-status.json'),
    T2: join(ROOT, '.dogfood', 't2-state-safety-latest', 't2-state-safety-status.json'),
    T3: join(ROOT, '.dogfood', 't3-release-smoke-latest', 't3-release-smoke-status.json'),
    T4: join(ROOT, '.dogfood', 't4-update-delivery-latest', 't4-update-delivery-status.json')
  };
  return resolve(map[label]);
}
function tauriConfig() {
  return readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'), {});
}
function tauriVersion() {
  const conf = tauriConfig();
  return conf && conf.version || '';
}
function updaterEndpoint() {
  const conf = tauriConfig();
  const endpoints = conf && conf.plugins && conf.plugins.updater && conf.plugins.updater.endpoints;
  return Array.isArray(endpoints) && endpoints.length ? String(endpoints[0]) : '';
}
function step(id, phase, title, status, reason, extra = {}) {
  return Object.assign({ id, phase, title, status, required: true, reason }, extra);
}
function hasHttpsUrl(s) {
  return /^https:\/\//i.test(String(s || ''));
}
function sameHash(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
function readyValue(status, key) {
  return !!(status && status[key] === true && status.verdict === 'green');
}
function readGate(label) {
  const file = statusPath(label);
  return { file, status: readJson(file) };
}
function checkPlan(loop) {
  const file = join(ROOT, 'docs', 'STARNET_T5_PUBLIC_DISTRIBUTION.md');
  const text = readText(file).toLowerCase();
  const required = [PROOF_SCHEMA, 'publicdistributionready=true', 'authenticode', 'latest.json', 'single stable public channel', 'smartscreen'];
  const missing = required.filter(term => text.indexOf(term.toLowerCase()) < 0);
  return step('t5.0-loop-spec', 'T5.0', 'T5 public distribution loop is documented', existsSync(file) && !missing.length ? 'pass' : 'fail', missing.length ? 'Missing terms: ' + missing.join(', ') : 'T5 public distribution spec exists.', { loop, evidenceFile: file });
}
/* The installer sha256/bytes a prereq rung actually TESTED, dug out of its own status document. The
   installer-bearing rungs record `results[].artifacts.installer`; T2 is a repository state-safety proof and
   is instead bound by its generatedAt timestamp being newer than the installer. An older status shape that
   cannot prove either binding must fail closed at the final public-distribution gate. */
function gateInstallerHash(status) {
  const results = (status && status.results) || [];
  for (const r of results) {
    const got = r && r.artifacts && r.artifacts.installer;
    if (got && got.sha256) return { sha256: String(got.sha256).toLowerCase(), bytes: Number(got.bytes || 0) };
  }
  return null;
}
function checkPrereqs(loop, installerInfo) {
  const gates = {
    t0: readGate('T0'),
    t1: readGate('T1'),
    t2: readGate('T2'),
    t3: readGate('T3'),
    t4: readGate('T4')
  };
  const missing = Object.entries(gates).filter(([, g]) => !g.status).map(([k, g]) => k.toUpperCase() + ' missing at ' + g.file);
  const notReady = [];
  if (gates.t0.status && !readyValue(gates.t0.status, 'cleanInstallProofReady')) notReady.push('T0 clean install is not green');
  if (gates.t1.status && gates.t1.status.publicReleaseReady !== true) notReady.push('T1 public signing is not green');
  if (gates.t2.status && !readyValue(gates.t2.status, 'stateSafetyReady')) notReady.push('T2 state safety is not green');
  if (gates.t3.status && !readyValue(gates.t3.status, 'releaseSmokeReady')) notReady.push('T3 release smoke is not green');
  if (gates.t4.status && !readyValue(gates.t4.status, 'updateDeliveryReady')) notReady.push('T4 update delivery is not green');
  /* BIND THE VERDICTS TO THE BINARY. This gate read only verdict/ready booleans, and copyLatest()
     unconditionally re-stamps the `-latest` dirs on every run of every rung, so those verdicts persist across
     rebuilds indefinitely. Build installer A, take t0–t4 green, rebuild, then run only t5: T5.1 passed on A's
     leftover evidence while T5.2 hashed the NEW installer, and the lane stamped publicDistributionReady=true
     for a binary that was never clean-installed, never state-safety tested and never update-delivery tested.
     On the LAST gate before publishing to real users, that is the false green this lane's governing law calls
     the worst outcome in the repo. t3.2 already binds T0's recorded hash to the installer on disk; do the same
     for all five, and record WHICH binary each verdict was about so the status document can be audited. */
  const stale = [];
  const bound = {};
  for (const [k, g] of Object.entries(gates)) {
    const h = gateInstallerHash(g.status);
    const generatedAt = String(g.status && g.status.generatedAt || '').trim();
    const generatedAtMs = Date.parse(generatedAt);
    const freshForInstaller = !!installerInfo && Number.isFinite(generatedAtMs) && generatedAtMs >= installerInfo.mtimeMs;
    bound[k] = { installer: h, generatedAt, freshForInstaller };
    if (!g.status || !installerInfo) continue;
    if (!Number.isFinite(generatedAtMs)) {
      stale.push(k.toUpperCase() + ' has no valid generatedAt timestamp — re-run it against this build');
    } else if (!freshForInstaller) {
      stale.push(k.toUpperCase() + ' evidence is OLDER than the current installer — re-run it against this build');
    }
    // T2 proves repository-level migration/state behavior and has no installer artifact. Every other rung
    // directly inspects the packaged binary, so accepting a hashless status would recreate the false green.
    if (k !== 't2' && !h) {
      stale.push(k.toUpperCase() + ' does not record which installer it tested — re-run it against this build');
      continue;
    }
    if (!h) continue;
    const hashSame = sameHash(h.sha256, installerInfo.sha256);
    const bytesSame = !h.bytes || h.bytes === installerInfo.bytes;
    if (!hashSame) stale.push(k.toUpperCase() + ' is green for a DIFFERENT installer (sha256 ' + h.sha256.slice(0, 12) + '… vs ' + String(installerInfo.sha256 || '').slice(0, 12) + '…) — re-run it against this build');
    else if (!bytesSame) stale.push(k.toUpperCase() + ' is green for a DIFFERENT installer (same sha256 but ' + h.bytes + ' bytes vs ' + installerInfo.bytes + ') — re-run it against this build');
  }
  const problems = missing.concat(notReady).concat(stale);
  return step('t5.1-prerequisite-gates', 'T5.1', 'Replacement and public-signing gates are green FOR THIS INSTALLER', problems.length ? 'blocked' : 'pass', problems.length ? problems.join('; ') : 'T0, T1 public, T2, T3, and T4 are green for the current installer.', {
    loop,
    installer: installerInfo || null,
    gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, {
      file: g.file,
      verdict: g.status && g.status.verdict || '',
      ready: g.status && (g.status.cleanInstallProofReady ?? g.status.publicReleaseReady ?? g.status.stateSafetyReady ?? g.status.releaseSmokeReady ?? g.status.updateDeliveryReady),
      // the binary that verdict was actually about — null when the rung recorded none (cannot bind)
      installer: bound[k] && bound[k].installer,
      generatedAt: bound[k] && bound[k].generatedAt,
      freshForInstaller: !!(bound[k] && bound[k].freshForInstaller)
    }]))
  });
}
function validateManifest(file, installerInfo, sigFile) {
  const errors = [];
  const manifest = readJson(file);
  if (!manifest) return { ok: false, errors: ['manifest is missing or invalid JSON'], manifest: null };
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))) errors.push('manifest.version must be SemVer');
  if (!manifest.pub_date) errors.push('manifest.pub_date is missing');
  const platform = manifest.platforms && manifest.platforms[PLATFORM];
  if (!platform) errors.push('manifest.platforms.' + PLATFORM + ' is missing');
  const sigText = sigFile && existsSync(sigFile) ? readText(sigFile).trim() : '';
  if (platform) {
    if (!hasHttpsUrl(platform.url)) errors.push('manifest installer url must be https');
    if (!String(platform.signature || '').trim()) errors.push('manifest signature is missing');
    if (sigText && String(platform.signature || '').trim() !== sigText) errors.push('manifest signature does not match installer .sig file');
  }
  // A text match proves the manifest carries the .sig, not that the .sig signs THESE bytes with the key every installed
  // app trusts. Run the installed updater's own check (minisign over the installer, baked pubkey). STARNET_T5_PUBKEY is
  // a test-only override of the tauri.conf.json key, and the step records which key it trusted.
  if (installerInfo && sigText) {
    try {
      const v = verifySignature(readFileSync(installerInfo.path), sigText, resolvePubkeyText(process.env.STARNET_T5_PUBKEY || '', ROOT));
      if (!v.ok) errors.push('installer .sig does not verify against the updater public key: ' + v.reason);
    } catch (e) { errors.push('installer .sig could not be verified against the updater public key: ' + ((e && e.message) || e)); }
  }
  const endpoint = updaterEndpoint();
  if (endpoint && !hasHttpsUrl(endpoint)) errors.push('configured updater endpoint must be https');
  if (installerInfo && manifest.version && tauriVersion() && String(manifest.version).replace(/^v/, '') !== tauriVersion()) {
    errors.push('manifest.version does not match src-tauri version');
  }
  return { ok: errors.length === 0, errors, manifest: manifest || null };
}
function checkArtifacts(loop) {
  const installer = fileInfo(installerPath());
  if (!installer) return step('t5.2-signed-updater-artifacts', 'T5.2', 'Signed updater artifacts and manifest are valid', 'blocked', 'Build the current NSIS installer first.', { loop, artifacts: { installer: null } });
  const sigFile = installer.path + '.sig';
  const sig = fileInfo(sigFile);
  const manifestFile = manifestPath();
  const manifestInfo = fileInfo(manifestFile);
  if (!sig) return step('t5.2-signed-updater-artifacts', 'T5.2', 'Signed updater artifacts and manifest are valid', 'blocked', 'Updater .sig artifact is missing next to the current installer.', { loop, artifacts: { installer, signature: null, manifest: manifestInfo } });
  if (sig.mtimeMs < installer.mtimeMs) return step('t5.2-signed-updater-artifacts', 'T5.2', 'Signed updater artifacts and manifest are valid', 'blocked', 'Updater .sig artifact is older than the current installer. Rebuild with the Tauri signing private key before publishing latest.json.', { loop, artifacts: { installer, signature: sig, manifest: manifestInfo } });
  if (!manifestInfo) return step('t5.2-signed-updater-artifacts', 'T5.2', 'Signed updater artifacts and manifest are valid', 'blocked', 'Production latest.json manifest is missing. Generate it with scripts/release-assemble-manifest.mjs after signing.', { loop, artifacts: { installer, signature: sig, manifest: null } });
  const validation = validateManifest(manifestFile, installer, sigFile);
  writeJson(join(OUT, 'validated-latest-json.json'), validation.manifest || { errors: validation.errors });
  return step('t5.2-signed-updater-artifacts', 'T5.2', 'Signed updater artifacts and manifest are valid', validation.ok ? 'pass' : 'fail', validation.ok ? 'Installer .sig verifies against the updater public key and matches latest.json.' : validation.errors.join('; '), {
    loop,
    artifacts: { installer, signature: sig, manifest: manifestInfo, endpoint: updaterEndpoint(), version: tauriVersion(), pubkeySource: process.env.STARNET_T5_PUBKEY ? 'STARNET_T5_PUBKEY override' : 'src-tauri/tauri.conf.json' },
    errors: validation.errors
  });
}
function validateDistributionProof(doc, installerInfo, manifest) {
  const hostingErrors = [];
  const channelErrors = [];
  const evidenceErrors = [];
  if (!doc || typeof doc !== 'object') return { ready: false, hostingReady: false, channelReady: false, errors: ['distribution evidence is not valid JSON'], hostingErrors: ['distribution evidence is not valid JSON'], channelErrors, proof: null };
  if (doc.schema !== PROOF_SCHEMA) evidenceErrors.push('schema must be ' + PROOF_SCHEMA);
  const rel = doc.release || {};
  if (String(rel.channel || '') !== 'stable') evidenceErrors.push('release.channel must be stable');
  if (installerInfo) {
    if (!sameHash(rel.installerSha256, installerInfo.sha256)) evidenceErrors.push('release.installerSha256 does not match current installer');
    if (Number(rel.installerBytes || 0) !== installerInfo.bytes) evidenceErrors.push('release.installerBytes does not match current installer');
  }
  if (manifest && manifest.version && rel.version && String(rel.version).replace(/^v/, '') !== String(manifest.version).replace(/^v/, '')) {
    evidenceErrors.push('release.version does not match latest.json');
  }
  const hosting = doc.hosting || {};
  if (!hasHttpsUrl(hosting.latestJsonUrl)) hostingErrors.push('hosting.latestJsonUrl must be https');
  if (!hasHttpsUrl(hosting.installerUrl)) hostingErrors.push('hosting.installerUrl must be https');
  if (Number(hosting.latestStatus || 0) !== 200) hostingErrors.push('hosting.latestStatus must be 200');
  if (Number(hosting.installerStatus || 0) !== 200) hostingErrors.push('hosting.installerStatus must be 200');
  if (hosting.manifestInstallerUrlMatches !== true) hostingErrors.push('hosting.manifestInstallerUrlMatches must be true');
  if (hosting.installerHashMatches !== true) hostingErrors.push('hosting.installerHashMatches must be true');
  if (hosting.installerBytesMatch !== true) hostingErrors.push('hosting.installerBytesMatch must be true');
  const endpoint = updaterEndpoint();
  if (endpoint && hosting.latestJsonUrl && String(hosting.latestJsonUrl) !== endpoint) hostingErrors.push('hosting.latestJsonUrl does not match configured updater endpoint');
  const manifestUrl = manifest && manifest.platforms && manifest.platforms[PLATFORM] && manifest.platforms[PLATFORM].url;
  if (manifestUrl && hosting.installerUrl && String(hosting.installerUrl) !== String(manifestUrl)) hostingErrors.push('hosting.installerUrl does not match latest.json package URL');

  const channels = doc.channels || {};
  if (channels.publicChannel !== 'stable') channelErrors.push('channels.publicChannel must be stable');
  if (channels.singlePublicChannel !== true) channelErrors.push('channels.singlePublicChannel must be true');
  if (channels.dailyDriverPinnedStable !== true) channelErrors.push('channels.dailyDriverPinnedStable must be true');
  if (channels.devTreeSeparate !== true) channelErrors.push('channels.devTreeSeparate must be true');

  const errors = evidenceErrors.concat(hostingErrors, channelErrors);
  return {
    ready: errors.length === 0,
    hostingReady: evidenceErrors.length === 0 && hostingErrors.length === 0,
    channelReady: channelErrors.length === 0,
    errors,
    hostingErrors: evidenceErrors.concat(hostingErrors),
    channelErrors,
    proof: {
      schema: doc.schema || '',
      generatedAt: doc.generatedAt || '',
      release: rel,
      hosting,
      channels,
      notes: Array.isArray(doc.notes) ? doc.notes : []
    }
  };
}
function loadProof(installerInfo, manifest) {
  const file = distributionEvidencePath();
  if (!file) return { file: '', missing: true, validation: null };
  if (!existsSync(file)) return { file, missing: true, reason: 'Distribution evidence file does not exist: ' + file, validation: null };
  const validation = validateDistributionProof(readJson(file), installerInfo, manifest);
  writeJson(join(OUT, 'imported-public-distribution-proof.json'), validation.proof || { path: file, errors: validation.errors });
  return { file, missing: false, validation };
}
function currentInstallerInfo() {
  return fileInfo(installerPath());
}
function currentManifest() {
  return readJson(manifestPath());
}
function checkHosting(loop, proofState) {
  if (proofState.missing) {
    return step('t5.3-public-hosting-proof', 'T5.3', 'Public update host evidence is imported', 'blocked', proofState.reason || 'No public distribution evidence was provided. Set STARNET_T5_DISTRIBUTION_EVIDENCE or pass --distribution-evidence.', { loop, evidenceFile: proofState.file || '' });
  }
  const v = proofState.validation;
  return step('t5.3-public-hosting-proof', 'T5.3', 'Public update host evidence is imported', v.hostingReady ? 'pass' : 'fail', v.hostingReady ? 'Hosted latest.json and installer proof match the current release.' : v.hostingErrors.join('; '), { loop, evidenceFile: proofState.file, hosting: v.proof && v.proof.hosting, errors: v.hostingErrors });
}
function checkChannels(loop, proofState) {
  if (proofState.missing) {
    return step('t5.4-release-channel-discipline', 'T5.4', 'Stable public channel discipline is evidenced', 'blocked', 'Import distribution evidence with stable channel and daily-driver separation proof.', { loop, evidenceFile: proofState.file || '' });
  }
  const v = proofState.validation;
  return step('t5.4-release-channel-discipline', 'T5.4', 'Stable public channel discipline is evidenced', v.channelReady ? 'pass' : 'fail', v.channelReady ? 'Stable channel, pinned daily driver, and separate dev tree are evidenced.' : v.channelErrors.join('; '), { loop, evidenceFile: proofState.file, channels: v.proof && v.proof.channels, errors: v.channelErrors });
}
function checkEvidence(loop, proofState) {
  if (proofState.missing) {
    return step('t5.5-evidence-gate', 'T5.5', 'Public distribution evidence is importable and redacted', 'blocked', 'No imported distribution evidence exists yet.', { loop, evidenceFile: proofState.file || '' });
  }
  const v = proofState.validation;
  return step('t5.5-evidence-gate', 'T5.5', 'Public distribution evidence is importable and redacted', v.ready ? 'pass' : 'fail', v.ready ? 'Imported public distribution proof was normalized into shareable T5 evidence.' : v.errors.join('; '), { loop, evidenceFile: proofState.file, importedEvidenceFile: join(OUT, 'imported-public-distribution-proof.json'), errors: v.errors });
}
function runOnce(loop) {
  const results = [];
  results.push(checkPlan(loop));
  const installerNow = currentInstallerInfo();
  results.push(checkPrereqs(loop, installerNow));
  results.push(checkArtifacts(loop));
  const proofState = loadProof(currentInstallerInfo(), currentManifest());
  results.push(checkHosting(loop, proofState));
  results.push(checkChannels(loop, proofState));
  results.push(checkEvidence(loop, proofState));
  return results;
}
function signature(results) {
  return results.map(r => r.id + ':' + r.status + ':' + (r.reason || '')).join('|');
}
function chooseNextAction(latest) {
  const nonPass = latest.filter(r => r.status === 'fail' || r.status === 'blocked');
  if (!nonPass.length) return null;
  const failed = nonPass.find(r => r.status === 'fail');
  if (failed) return failed;
  const priority = [
    't5.1-prerequisite-gates',
    't5.2-signed-updater-artifacts',
    't5.3-public-hosting-proof',
    't5.4-release-channel-discipline',
    't5.5-evidence-gate',
    't5.0-loop-spec'
  ];
  for (const id of priority) {
    const match = nonPass.find(r => r.id === id);
    if (match) return match;
  }
  return nonPass[0];
}
function writeArtifactHashes(files) {
  const hashes = {};
  for (const file of files) {
    const p = join(OUT, file);
    if (existsSync(p)) hashes[file] = { sha256: sha256(p), bytes: statSync(p).size };
  }
  writeJson(join(OUT, 'artifact-hashes.json'), hashes);
}
function writeSummary(allResults, loopsRun, stableIterations) {
  const latest = allResults.filter(r => r.loop === loopsRun);
  const pass = latest.filter(r => r.status === 'pass').length;
  const fail = latest.filter(r => r.status === 'fail').length;
  const blocked = latest.filter(r => r.status === 'blocked').length;
  const nextAction = chooseNextAction(latest);
  const publicDistributionReady = fail === 0 && blocked === 0 && latest.length > 0 && latest.every(r => r.status === 'pass');
  const verdict = fail ? 'red' : (blocked ? 'blocked' : 'green');
  const status = {
    schema: 'starnet.t5-public-distribution-status.v1',
    generatedAt: nowIso(),
    lane: 'T5-public-distribution',
    verdict,
    publicDistributionReady,
    loopsRun,
    stableIterations,
    outDir: OUT,
    counts: { pass, blocked, fail },
    nextAction: nextAction ? { id: nextAction.id, status: nextAction.status, reason: nextAction.reason } : null,
    results: latest,
    history: allResults.map(r => ({ loop: r.loop, id: r.id, status: r.status, reason: r.reason || '' }))
  };
  writeJson(join(OUT, 't5-public-distribution-status.json'), status);

  let md = '# StarNet T5 Public Distribution Evidence\n\n';
  md += '- Generated: `' + status.generatedAt + '`\n';
  md += '- Verdict: `' + status.verdict + '`\n';
  md += '- Public distribution ready: `' + status.publicDistributionReady + '`\n';
  md += '- Loops run: `' + status.loopsRun + '`\n\n';
  md += '| Status | Phase | Step | Notes |\n|---|---|---|---|\n';
  for (const r of latest) md += '| ' + statusIcon(r.status) + ' | `' + mdEscape(r.phase) + '` | `' + r.id + '` ' + mdEscape(r.title) + ' | ' + mdEscape(r.reason) + ' |\n';
  md += '\n## Next Action\n\n';
  if (nextAction) md += 'Work `' + nextAction.id + '`: ' + nextAction.reason + '\n';
  else md += 'T5 public distribution is ready.\n';
  md += '\nEvidence is redacted by contract. Do not place private signing keys, API keys, or cert secrets in T5 proof files.\n';
  writeFileSync(join(OUT, 'summary.md'), md);
  writeArtifactHashes(['t5-public-distribution-status.json', 'summary.md', 'validated-latest-json.json', 'imported-public-distribution-proof.json']);
  copyLatest();
  return status;
}

ensureDir(OUT);
let allResults = [];
let loopsRun = 0;
let prevSig = '';
let stableIterations = 0;
for (let i = 1; i <= LOOP_MAX; i += 1) {
  console.log('[t5-public-distribution] loop ' + i + ' starting');
  const results = runOnce(i);
  loopsRun = i;
  allResults = allResults.concat(results);
  for (const r of results) console.log('[t5-public-distribution]   ' + statusIcon(r.status) + ' ' + r.id);
  const sig = signature(results);
  stableIterations = sig === prevSig ? stableIterations + 1 : 1;
  if (!results.some(r => r.status === 'fail' || r.status === 'blocked')) break;
  if (prevSig && prevSig === sig) break;
  prevSig = sig;
}

const summary = writeSummary(allResults, loopsRun, stableIterations);
console.log('[t5-public-distribution] evidence: ' + OUT);
console.log('[t5-public-distribution] latest: ' + LATEST);
console.log('[t5-public-distribution] publicDistributionReady=' + summary.publicDistributionReady);
if (summary.verdict === 'red') process.exit(1);
if (!summary.publicDistributionReady) process.exit(2);
process.exit(0);
