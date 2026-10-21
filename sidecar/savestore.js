/* sidecar/savestore.js — durable server-side persistence for the agent the user builds (M-save).

   The browser's localStorage is the FRAGILE store: a cache wipe, a different browser, or a fresh
   machine loses the agent (identity, XP/level/confidence, personalization, workstreams, station).
   `save.js` itself says "localStorage for now ... moves to the SQLite sidecar later." This module is
   that move: a durable mirror of the save envelope on the sidecar's own disk (the app-data dir that
   survives a browser wipe). The frontend keeps localStorage as a fast cache and writes through to here.

     makeSaveStore({ fs, pathMod, root, clock }) -> {
       load(agentId)        -> doc | undefined        // the stored save envelope; undefined if none/corrupt
       stamp(agentId)       -> string                 // one stat: moves on every save/outside edit; '' = unknown
       loadStamped(agentId) -> { doc, stamp }         // load()'s doc + the pre-read stamp ('' unless a clean read)
       save(agentId, doc, {compareRevision?}) -> { ok, conflict?, revision?, updatedAt }
     }

   The file lives at <root>/<agentId>.save.json — a SIBLING of the notebook/channels stores, OUTSIDE the
   agent's fs jail (<root>/<agentId>/), so the agent's own fs.* tools can neither read nor corrupt the
   record of its own growth. It holds NO secret: the API key/OAuth tokens are stored separately and are
   never part of the save envelope, so mirroring it to disk leaks nothing.

   Save-safe like its siblings: atomic temp+rename; a missing/corrupt file loads as undefined and NEVER
   throws; an incoming write whose updatedAt is older than what's on disk is rejected (a stale tab cannot
   clobber a newer save). Pure + deterministic: all I/O is the injected `fs` (sync), time is the injected
   `clock` — no Date.now/rng, so it replays identically under test. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.savestore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // same agentId grammar as the notebook / fs jail / channels store

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function makeSaveStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const rootDir = d.root;
    const clock = d.clock;
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeSaveStore: an injected fs (readFileSync/writeFileSync/renameSync[/mkdirSync]) is required');
    if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeSaveStore: an injected pathMod is required');
    if (!rootDir) throw new Error('makeSaveStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeSaveStore: an injected clock is required');

    let tmpSeq = 0;   // deterministic process-unique tmp suffix (a single host; no pid/rng needed)
    let writes = 0;   // main-file saves made by this process: part of stamp(), so an in-process save always moves it
    const recoveredMissing = new Set();
    const lastWritten = new Map();   // file -> { stamp, updatedAt, revision, replayAt } of this process's own last write (see save())

    /* Rejected-save snapshots are recoveries, not history: every stale client (a reopened tab, a flaky beacon)
       used to add one forever (audit 2026-09-25 #18). Keep the newest CONFLICT_KEEP per agent — the file just
       written always survives — and drop the rest. Best-effort: a failed prune never fails the save response. */
    const CONFLICT_KEEP = Number(d.conflictKeep) > 0 ? Math.floor(Number(d.conflictKeep)) : 20;
    function pruneConflicts(agentId, keepName) {
      if (typeof fs.readdirSync !== 'function' || typeof fs.unlinkSync !== 'function' || typeof fs.statSync !== 'function') return 0;
      const prefix = agentId + '.save-conflict-';
      let names;
      try { names = fs.readdirSync(rootDir).filter(n => typeof n === 'string' && n.indexOf(prefix) === 0 && /\.json$/.test(n)); }
      catch (e) { failNote('savestore.conflict-prune.list', e); return 0; }
      if (names.length <= CONFLICT_KEEP) return 0;
      const rows = [];
      for (const n of names) {
        let m = 0;
        try { m = Number(fs.statSync(pathMod.join(rootDir, n)).mtimeMs) || 0; } catch (e) { failNote('savestore.conflict-prune.stat', e); }
        rows.push({ n, m: n === keepName ? Infinity : m });
      }
      rows.sort((a, b) => (b.m - a.m) || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
      let removed = 0;
      for (const r of rows.slice(CONFLICT_KEEP)) {
        try { fs.unlinkSync(pathMod.join(rootDir, r.n)); removed++; } catch (e) { failNote('savestore.conflict-prune.unlink', e); }
      }
      return removed;
    }
    function ensureRoot() { try { if (fs.mkdirSync) fs.mkdirSync(rootDir, { recursive: true }); } catch (_) {} }
    function saveFile(agentId) {
      if (!AID_RE.test(String(agentId))) throw new Error('bad save agentId: ' + agentId);
      return pathMod.join(rootDir, agentId + '.save.json');
    }
    // see stamp() in the API below
    function stamp(agentId) {
      const file = saveFile(agentId);
      if (typeof fs.statSync !== 'function') return '';
      try {
        const s = fs.statSync(file, { bigint: true });
        if (!s || s.mtimeNs == null || s.size == null) return '';
        return writes + ':' + s.mtimeNs + ':' + s.size + ':' + s.ino;
      } catch (_) { return ''; }
    }
    // reads + parses a save file path, returning a TAGGED result so callers can tell a genuinely-absent file
    // from one that EXISTS but couldn't be READ (locked/EBUSY/EACCES on Windows) versus one that read but has
    // GARBAGE bytes. The distinction is load-bearing for the anti-clobber gate. The agentId grammar is validated
    // by the caller via saveFile() BEFORE this.
    //   { status: 'ok', wrapper }      — read + parsed
    //   { status: 'absent' }           — ENOENT: no file at all (safe to write a fresh save)
    //   { status: 'unreadable', err }  — present but a non-ENOENT errno blocked the read (locked/EACCES): bytes
    //                                     are probably FINE, freshness UNKNOWN — do NOT clobber (conservative)
    //   { status: 'corrupt', err }     — present + read but the bytes don't parse: unrecoverable garbage, safe to
    //                                     overwrite (a corrupt save is already lost — preserves prior product behavior)
    function readTaggedRaw(file, keepRaw) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (e) {
        if (e && e.code === 'ENOENT') return { status: 'absent' };
        return { status: 'unreadable', err: e };   // present but locked/EACCES/etc. — NOT absent, bytes intact
      }
      // a zero-length main is a TORN write (crash between temp-open and rename, or an interrupted legacy write):
      // treat it like corrupt so the .bak recovery path below kicks in rather than loading empty.
      if (raw == null || String(raw).length === 0) return { status: 'corrupt', err: new Error('zero-length save file') };
      try { const wrapper = JSON.parse(raw); return keepRaw ? { status: 'ok', wrapper: wrapper, raw: raw } : { status: 'ok', wrapper: wrapper }; }
      catch (e) { return { status: 'corrupt', err: e }; }   // present + read but garbage — recoverable-over
    }
    // quarantine a corrupt main aside (rename to <file>.corrupt-<seq>) so it's preserved for forensics but no
    // longer blocks the store, then recover from <file>.bak if it holds a clean prior save. Best-effort + loud.
    // Returns the quarantine destination path (null if the move failed) so the recovery marker can disclose it.
    // A quarantined copy may be the ONLY remaining bytes of a lost save, and the recovery notice names it. tmpSeq
    // restarts in every process, so `.corrupt-<seq>` repeats across restarts: never replace an existing copy (the old
    // unlink-then-rename destroyed the first incident's bytes on the second) — step to the first free name instead.
    function taken(p) {
      if (typeof fs.existsSync === 'function') return fs.existsSync(p);
      try { fs.readFileSync(p); return true; } catch (e) { return !(e && e.code === 'ENOENT'); }
    }
    function quarantine(file, why) {
      try {
        let dead = file + '.corrupt-' + (++tmpSeq);
        while (taken(dead)) dead = file + '.corrupt-' + (++tmpSeq);
        fs.renameSync(file, dead);
        try { console.warn('[savestore] quarantined corrupt save ' + file + ' -> ' + dead + ' (' + why + ')'); } catch (_) {}
        return dead;
      } catch (_) { return null; /* couldn't move it (locked/gone) — leave it; recovery below still tries .bak */ }
    }
    // RECOVERY NOTICE (EL-11 FIX 2/3): when the store quarantines an unrecoverable save ('quarantined') or
    // restores one from .bak ('recovered'), persist a sibling marker the frontend reads on the next boot —
    // silent data loss / silent recovery is the lie class this kills. Worse news is STICKY: an unacked
    // 'quarantined' marker is never papered over by a later 'recovered'. Best-effort, never throws (a notice
    // failure must not block the store), and only written at the quarantine event itself (no churn on reads).
    function recoveryFile(file) { return file.replace(/\.json$/, '') + '.recovery.json'; }
    function writeRecoveryMarker(file, kind, extra) {
      try {
        const rf = recoveryFile(file);
        const cur = readTaggedRaw(rf);
        if (cur.status === 'ok' && cur.wrapper && cur.wrapper.kind === 'quarantined' && kind === 'recovered') return;
        writeDurable(rf, JSON.stringify(Object.assign({ version: 1, kind: kind, at: clock.now() }, extra || {})));
      } catch (e) { failNote('savestore.notice', e); }
    }
    // RESILIENT tagged read: main first; on a corrupt/torn main, quarantine it and recover from <file>.bak. An
    // 'unreadable' main is NOT quarantined (bytes are fine, just locked) — surfaced as-is so the caller stays
    // conservative. Adds status 'recovered' (main was bad, .bak was clean -> the .bak value is authoritative).
    function readTagged(file, keepRaw) {
      const m = readTaggedRaw(file, keepRaw);
      if (m.status === 'ok') { recoveredMissing.delete(file); return m; }
      if (m.status === 'unreadable') return m;   // locked/EBUSY: don't roll back to a possibly-stale .bak
      // main is absent OR corrupt/torn — try the last-known-good .bak.
      const b = readTaggedRaw(file + '.bak');
      // The backup may be the only intact copy. A transient read failure proves neither
      // absence nor corruption, even when main is torn. Do not quarantine or replace it.
      if (b.status === 'unreadable') return b;
      if (b.status === 'ok') {
        if (m.status === 'corrupt') {
          const dead = quarantine(file, 'main unparseable; recovered from .bak');
          writeRecoveryMarker(file, 'recovered', dead ? { quarantinedTo: dead } : undefined);
          recoveredMissing.add(file);
        } else {
          // Missing main is also a recovery, not a pristine first run. Avoid re-arming an
          // acknowledged notice on every read while the backup remains authoritative.
          if (!recoveredMissing.has(file)) {
            writeRecoveryMarker(file, 'recovered');
            recoveredMissing.add(file);
          }
        }
        return { status: 'recovered', wrapper: b.wrapper, err: m.err };
      }
      // no usable .bak. A genuinely-absent main with no .bak is just a new agent (absent). A corrupt main with
      // no clean .bak is unrecoverable — quarantine it so the next write starts fresh (preserves prior "corrupt
      // save is already lost" product behavior) and report corrupt.
      if (m.status === 'corrupt') {
        const dead = quarantine(file, 'main unparseable and no usable .bak');
        writeRecoveryMarker(file, 'quarantined', { quarantinedTo: dead || (file + ' (quarantine rename failed; left in place)') });
      }
      return m.status === 'absent' ? { status: 'absent' } : { status: 'corrupt', err: m.err };
    }
    // back-compat convenience: the parsed wrapper, or undefined when absent/unreadable/corrupt.
    // 'recovered' (from .bak) is a usable value, so it returns the wrapper too.
    function readWrapper(file) { const r = readTagged(file); return (r.status === 'ok' || r.status === 'recovered') ? r.wrapper : undefined; }
    // atomic temp+rename, with the temp file fsync'd before the rename so the DURABLE store of record actually
    // survives a hard power loss (the ledger/runs siblings fsync their appends; this is the same guarantee). The
    // fsync is capability-guarded: the real node:fs supplies openSync/writeSync/fsyncSync, while the in-memory
    // test fs (writeFileSync/renameSync only) falls back to the plain path — keeps the store deterministic + testable.
    function writeDurable(file, data) {
      const tmp = file + '.' + (++tmpSeq) + '.tmp';
      if (typeof fs.openSync === 'function' && typeof fs.fsyncSync === 'function' && typeof fs.writeSync === 'function') {
        // FULL-WRITE LOOP (the exact hazard durable-write.js documents): a single unchecked writeSync may
        // make partial progress — fsync + rename of that prefix then replaces the good main with a torn
        // save while save() reports ok, and the next load quarantines it. Write a Buffer with progress
        // accounting; a non-advancing write throws BEFORE the rename, so main is never touched.
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        let fd = null;
        try {
          fd = fs.openSync(tmp, 'w');
          let offset = 0;
          while (offset < bytes.length) {
            const wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (wrote === undefined) break;   // an injected test fs without a byte count keeps single-shot semantics
            if (!Number.isInteger(wrote) || wrote <= 0 || offset + wrote > bytes.length) {
              throw new Error('short write on ' + tmp + ': ' + offset + '/' + bytes.length);
            }
            offset += wrote;
          }
          fs.fsyncSync(fd);
        }
        finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
      } else {
        fs.writeFileSync(tmp, data);   // test/in-memory fs: no fsync available, plain write
      }
      fs.renameSync(tmp, file);   // atomic replace
    }
    /* linkBackup — the good main becomes <file>.bak as a HARD LINK: a second name for the bytes that were made durable
       when they were written as the main (two metadata ops instead of a second temp + write + fsync + rename of the
       whole save). The main never goes missing, and the shared inode ends when the main's own tmp+rename lands (this
       store never writes a file in place). false = no link (FAT/exFAT, an fs facade without linkSync, a refusal):
       the caller copies instead. Same discipline as durable-store.js. */
    function linkBackup(file) {
      if (typeof fs.linkSync !== 'function' || typeof fs.unlinkSync !== 'function') return false;
      try {
        try { fs.unlinkSync(file + '.bak'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
        fs.linkSync(file, file + '.bak');
        return true;
      } catch (e) {
        if (!e || (e.code !== 'EPERM' && e.code !== 'ENOTSUP' && e.code !== 'EXDEV' && e.code !== 'ENOSYS')) failNote('savestore.bak.link', e);
        return false;
      }
    }
    // prior (optional): what the caller already knows about THIS file's current main — { status, raw? } from its own
    // read moments ago (save() reads it for the anti-clobber gate), so the main is not read and parsed a second time.
    function writeAtomic(file, value, prior) {
      ensureRoot();
      // LAST-KNOWN-GOOD snapshot: before overwriting main, keep the CURRENT clean main as <file>.bak so a torn
      // replace of main can be recovered from the prior committed save. A main that is itself corrupt/torn is NOT
      // kept (never clobber a possibly-good .bak with garbage). Best-effort — a .bak failure must never block the
      // real save.
      if (prior) {
        if (prior.status === 'ok' && !linkBackup(file)) {
          try {
            const cur = prior.raw != null ? prior.raw : fs.readFileSync(file, 'utf8');
            if (cur && String(cur).length) writeDurable(file + '.bak', cur);
          } catch (e) { failNote('savestore.bak', e); }
        }
      } else {
        try {
          const cur = fs.readFileSync(file, 'utf8');
          if (cur && String(cur).length) { try { JSON.parse(cur); writeDurable(file + '.bak', cur); } catch (_) {} }
        } catch (_) { /* no current main (first write) — nothing to back up */ }
      }
      writeDurable(file, JSON.stringify(value));   // atomic + durable replace of main
    }

    return {
      // HTTP callers must distinguish a missing station from temporarily inaccessible bytes.
      // Keep load()'s legacy optional-document shape for internal best-effort readers.
      loadState(agentId) {
        const r = readTagged(saveFile(agentId));
        const w = r.wrapper;
        return { status: r.status, doc: w && typeof w === 'object' && w.doc && typeof w.doc === 'object' ? w.doc : undefined };
      },
      // the stored save envelope (the exact doc the frontend persisted), or undefined when there is none or
      // the file is unreadable/corrupt. Never throws on a bad file — a wiped agent reads as "nothing yet".
      load(agentId) {
        const w = readWrapper(saveFile(agentId));   // saveFile() validates the id (throws on traversal) before any read
        return (w && typeof w === 'object' && w.doc && typeof w.doc === 'object') ? w.doc : undefined;
      },

      /* A SAVE STAMP, so a reader can tell "the save has not changed since I projected it" without parsing it again
         (idle-cpu piece 2, 2026-10-19: GET /api/overseer re-parsed the whole 3.8 MB save on every 2.5 s poll per page).
         stamp() = this process's save count + the file's mtime (ns) + size + file id, from one stat (~0.2 ms). Every save
         here is a temp+rename, so it moves the file id and mtime; an outside edit moves mtime (and on NTFS the id). '' when
         there is no file or no stat: '' never matches, so a caller then reads afresh, exactly as without a stamp.
         loadStamped() = load()'s exact doc plus the stamp taken BEFORE the read, and only for a clean ('ok') read: an
         absent, locked, corrupt or .bak-recovered read stamps '' and is never memoized by anyone. The parsed doc itself is
         never cached here: it is ~4x the file in heap and ~15 load() callers would share one mutable object. */
      stamp,
      loadStamped(agentId) {
        const file = saveFile(agentId);
        const before = stamp(agentId);
        const r = readTagged(file);
        const w = (r.status === 'ok' || r.status === 'recovered') ? r.wrapper : undefined;
        return { doc: (w && typeof w === 'object' && w.doc && typeof w.doc === 'object') ? w.doc : undefined, stamp: r.status === 'ok' ? before : '' };
      },

      // persist the save envelope durably. Wrapped with the server receive time + the doc's own updatedAt so
      // a later read can compare freshness without parsing the frontend schema. ANTI-CLOBBER: if the incoming
      // doc is OLDER than what's on disk (updatedAt regressed), the write is refused — a stale background tab
      // can never overwrite a newer save. HTTP clients additionally use compareRevision to reject stale
      // snapshots even when they have a new timestamp; timestamp-only behavior remains for legacy internal callers.
      save(agentId, doc, options = {}) {
        if (!doc || typeof doc !== 'object') throw new Error('save: a doc object is required');
        const file = saveFile(agentId);   // validates the id (throws on traversal)
        /* THE MAIN THIS PROCESS JUST WROTE (perf review 10-19: ~3 parses, 3 stringifies and 2 fsyncs of the whole
           envelope per debounced persist, 121-161 ms at 5.8 MiB). When stamp() still equals the stamp taken right after
           this process's own last write of this file, the main IS that write — no other save and no outside edit moved
           it — so the anti-clobber facts it needs (updatedAt, the revision, the stored request's updatedAt) are known
           without reading and parsing the save again. Only an exact REPLAY can need the stored doc itself (the
           idempotency compare below), and a replay must carry the stored request's updatedAt: such a request, and any
           moved stamp, takes the full read exactly as before. */
        const memo = lastWritten.get(file);
        const known = (memo && memo.stamp && memo.stamp === stamp(agentId)
          && !(options.compareRevision && JSON.stringify(doc.updatedAt) === JSON.stringify(memo.replayAt))) ? memo : null;
        const prevRead = known ? { status: 'ok' } : readTagged(file, true);
        // CONSERVATIVE anti-clobber on an UNREADABLE prior: the file EXISTS but a non-ENOENT errno blocked the
        // read (locked/EBUSY/EACCES), so the bytes are probably a perfectly good — possibly NEWER — save we just
        // couldn't read this instant. We cannot prove this incoming write isn't a lower-progress overwrite, so we
        // refuse rather than blow it away (the Windows errno conflation would otherwise treat it as progress=0 and
        // always accept, silently wiping the record). A genuinely CORRUPT prior (read but garbage) still recovers-
        // over as before. Report unreadable distinctly so the caller can retry/surface.
        if (prevRead.status === 'unreadable') {
          try { console.warn('[savestore] refusing save for ' + String(agentId) + ' — existing record is unreadable (' + ((prevRead.err && prevRead.err.code) || 'EUNKNOWN') + '); not clobbering a possibly-newer save'); } catch (_) {}
          return { ok: false, stale: true, unreadable: true, updatedAt: 0 };
        }
        // a prior read cleanly ('ok') OR recovered from .bak ('recovered') is an authoritative prior for the
        // anti-clobber freshness gate — a torn main whose .bak we restored must still not be regressed.
        const prev = known ? undefined : ((prevRead.status === 'ok' || prevRead.status === 'recovered') ? prevRead.wrapper : undefined);
        const prevUpdated = known ? known.updatedAt : (prev && typeof prev === 'object' ? num(prev.updatedAt) : 0);
        const requestUpdatedAt = num(doc.updatedAt);
        let incomingUpdated = requestUpdatedAt;
        if (options.compareRevision) {
          const revision = known ? known.revision : num(prev && prev.doc && prev.doc._saveRevision);
          const expected = num(doc._saveRevision);
          // A replay of an acknowledged request (including a beacon racing fetch) is idempotent. The two JSON texts
          // can only be equal when the request's updatedAt is the stored request's (that key is in both), so that one
          // scalar is compared first and the two whole-envelope stringifies run only for a real replay candidate.
          const replayAt = prev ? (prev.requestUpdatedAt == null ? prevUpdated : prev.requestUpdatedAt) : undefined;
          const same = !known && prev && JSON.stringify(doc.updatedAt) === JSON.stringify(replayAt)
            && JSON.stringify(Object.assign({}, prev.doc, { updatedAt: replayAt, _saveRevision: expected, _saveDirty: false })) === JSON.stringify(Object.assign({}, doc, { _saveDirty: false }));
          if (same) return { ok: true, updatedAt: prevUpdated, revision };
          if (expected !== revision) {
            // Keep the rejected snapshot durably as well as the current station. Never silently
            // merge whole envelopes: removals and roster/config edits have conflicting semantics.
            const client = /^[A-Za-z0-9_-]{1,80}$/.test(String(doc._saveClient || '')) ? doc._saveClient : clock.now() + '-' + (++tmpSeq);
            const recovery = String(agentId) + '.save-conflict-' + client + '.json';
            writeAtomic(pathMod.join(rootDir, recovery), doc);
            pruneConflicts(String(agentId), recovery);
            return { ok: false, stale: true, conflict: true, revision, recovery, updatedAt: prevUpdated };
          }
          incomingUpdated = Math.max(incomingUpdated, prevUpdated + 1);
          doc = Object.assign({}, doc, { updatedAt: incomingUpdated, _saveRevision: revision + 1, _saveDirty: false });
        }

        if (!options.compareRevision && (known || prev) && incomingUpdated < prevUpdated) return { ok: false, stale: true, updatedAt: prevUpdated };
        lastWritten.delete(file);
        writeAtomic(file, { version: 1, agentId: String(agentId), updatedAt: incomingUpdated, savedAt: clock.now(), ...(options.compareRevision ? { requestUpdatedAt } : {}), doc: doc },
          { status: prevRead.status, raw: prevRead.raw });
        writes++;
        recoveredMissing.delete(file);   // the main exists again and is this write
        const after = stamp(agentId);
        if (after) lastWritten.set(file, { stamp: after, updatedAt: incomingUpdated, revision: num(doc._saveRevision), replayAt: options.compareRevision ? requestUpdatedAt : incomingUpdated });
        return { ok: true, updatedAt: incomingUpdated, ...(options.compareRevision ? { revision: doc._saveRevision } : {}) };
      },

      // the persisted quarantine/recovery marker for this agent's save (EL-11 FIX 2/3), or undefined when there
      // is none / it doesn't parse. { version, kind:'quarantined'|'recovered', at, quarantinedTo? }. Read-only —
      // the frontend shows the honest notice and then acks via clearRecoveryNotice().
      recoveryNotice(agentId) {
        const r = readTaggedRaw(recoveryFile(saveFile(agentId)));
        const w = (r.status === 'ok') ? r.wrapper : undefined;
        return (w && typeof w === 'object' && (w.kind === 'quarantined' || w.kind === 'recovered')) ? w : undefined;
      },

      // the user has SEEN the notice — remove the marker so it shows exactly once. Best-effort boolean.
      clearRecoveryNotice(agentId) {
        try {
          if (typeof fs.unlinkSync !== 'function') return false;
          fs.unlinkSync(recoveryFile(saveFile(agentId)));
          return true;
        } catch (_) { return false; }
      },

      _internals: { saveFile, AID_RE, num, readTagged, recoveryFile }
    };
  }

  return { makeSaveStore, _internals: { AID_RE, num } };
});
