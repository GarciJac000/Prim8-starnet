/* node test/redact.known-cache.test.js — known-value redaction reuses its derived list while the held secrets are
   unchanged, and still catches a rotated, added or in-place-edited secret on the very next redact().

   THE BUG (perf review 2026-10-19): knownSecrets() rebuilt and sorted the whole held-secret list on every redact(),
   which is every token frame. The fix caches the derived list against a private copy of what the source returned.
   Part 1 counts the list rebuilds (each one sorts) across 200 redact() calls on an unchanged source: it was 200 on the
   old code and must be 1. Part 2 is the security floor: the cache must never let a new or changed secret through. */
'use strict';
const A = require('./_assert.js');
const { redact, setKnownSecretSource } = require('../sidecar/context.js');

const KEY1 = 'zq7Shapeless0Service4821Canary';
const KEY2 = 'plainProviderKey77310Canary';
const KEY3 = 'rotatedConnectorToken55120Canary';

// count Array.prototype.sort calls made while redact() runs: the known-value list is the only thing it sorts
function countSorts(fn) {
  const orig = Array.prototype.sort;
  let n = 0;
  Array.prototype.sort = function () { n++; return orig.apply(this, arguments); };
  try { fn(); } finally { Array.prototype.sort = orig; }
  return n;
}

// ---- 1. an unchanged source is not rebuilt on every call ----
{
  const held = [KEY1, KEY2, '  ' + KEY3 + '  ', 'short', 42, null];
  setKnownSecretSource(() => held.slice());   // a fresh array every call, like the host's collector
  const frame = 'token frame without any secret in it';
  const sorts = countSorts(() => { for (let i = 0; i < 200; i++) redact(frame); });
  A.ok(sorts <= 1, '200 redact() calls on an unchanged source rebuild the list at most once (sorted ' + sorts + ' times)');
  A.eq(redact('a ' + KEY1 + ' b ' + KEY3 + ' c'), 'a [redacted-secret] b [redacted-secret] c', 'the cached list still scrubs every held value');
  const objSorts = countSorts(() => { for (let i = 0; i < 50; i++) redact({ a: frame, b: [frame, { c: frame }] }); });
  A.ok(objSorts <= 0, 'object payloads reuse the same cached list (sorted ' + objSorts + ' times)');
}

// ---- 2. the cache never lets a new or changed secret through ----
{
  let held = [KEY1];
  setKnownSecretSource(() => held);
  A.eq(redact('x ' + KEY1), 'x [redacted-secret]', 'baseline: the held key is scrubbed');
  held = [KEY1, KEY2];   // a key is added
  A.eq(redact('y ' + KEY2), 'y [redacted-secret]', 'an ADDED key is scrubbed on the very next call');
  held = [KEY3];         // a rotation: the old keys are gone, the new one is held
  A.eq(redact('z ' + KEY3), 'z [redacted-secret]', 'a ROTATED key is scrubbed on the very next call');
  A.eq(redact('w ' + KEY1), 'w ' + KEY1, 'a key no longer held is no longer treated as one (the list is current, not sticky)');
  held = [KEY3, KEY1];
  A.eq(redact(KEY1), '[redacted-secret]', 'two keys held');
  held = [KEY3];         // the LAST key dropped: same prefix, shorter list
  A.eq(redact('t ' + KEY1), 't ' + KEY1, 'dropping the last key is noticed (a shorter list with the same prefix is a new revision)');

  const same = [KEY1, KEY2];   // the source edits ONE array in place
  setKnownSecretSource(() => same);
  A.eq(redact(KEY2), '[redacted-secret]', 'in-place source: baseline');
  same[1] = KEY3;
  A.eq(redact('v ' + KEY3), 'v [redacted-secret]', 'a value edited IN PLACE in the same array is scrubbed on the next call');
  same.push('anotherHeldValue9921');
  A.eq(redact('u anotherHeldValue9921'), 'u [redacted-secret]', 'a value pushed onto the same array is scrubbed on the next call');

  // a contained key: longest first still holds after a reorder that only the cache could get wrong
  const inner = 'innerKey0042', outer = 'outer-' + inner + '-tail99';
  let order = [inner, outer];
  setKnownSecretSource(() => order);
  A.eq(redact('k ' + outer), 'k [redacted-secret]', 'a key containing another is scrubbed whole');
  order = [outer, inner];
  A.eq(redact('k ' + outer + ' ' + inner), 'k [redacted-secret] [redacted-secret]', 'the same keys reordered still scrub whole and alone');

  // swapping the source drops the old cache at once
  setKnownSecretSource(() => [KEY2]);
  A.eq(redact(KEY2 + ' ' + KEY3), '[redacted-secret] ' + KEY3, 'a new source replaces the old list immediately');

  // a generator is read fresh each call
  let gen = [KEY1];
  setKnownSecretSource(function* () { yield* gen; });
  A.eq(redact(KEY1), '[redacted-secret]', 'a generator source works');
  gen = [KEY3];
  A.eq(redact(KEY3), '[redacted-secret]', 'a generator source that changes is re-read on the next call');

  // a throwing source degrades to shape-only redaction, never to a crash, and recovers when it heals
  let broken = true;
  setKnownSecretSource(() => { if (broken) throw new Error('store busy'); return [KEY1]; });
  A.eq(redact('sk-ant-api03-AbCdEfGhIjKl ' + KEY1), '[redacted-key] ' + KEY1, 'a throwing source falls back to shape-only redaction');
  broken = false;
  A.eq(redact(KEY1), '[redacted-secret]', 'the healed source is read again on the next call');
  setKnownSecretSource(null);
  A.eq(redact(KEY1), KEY1, 'no source: shape-only');
}

A.report('redact.known-cache.test');
