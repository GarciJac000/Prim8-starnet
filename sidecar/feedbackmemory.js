/* sidecar/feedbackmemory.js — THE COMMANDER'S TASTE: rate-the-work verdicts + corrections become durable memory.

   Product law (Andrew, 2026-10-01): feedback is critical. Every like and dislike must be remembered and must steer
   later work, so an agent converges on exactly what the Commander wants over months, not minutes.

   Before this, a verdict reached later runs only through a RAM-held skill-review packet (6h TTL, lost on restart,
   skill tools only), and a typed correction ("too long, 3 bullets") never became a belief recall could surface.
   Now a first-time verdict writes ONE notebook record per rated run (origin 'feedback', kind 'profile' = the
   Preference kind, user-confirmed: these are the Commander's own verdict and words). A later correction for the
   same run folds into that SAME record. The records live in the rated agent's notebook, so the Memory Core shows,
   edits and forgets them like any other memory.

   Recall: BM25 recall surfaces a record only when the new task shares words with it, which is wrong for taste
   ("shorter" applies to every deliverable). selectTaste() picks the newest feedback records for an always-on
   block of their own, rendered beside recall on every task run.

   DESIGN ANCHOR (2026-10-11, user report: "say I approve one, the next comes out with a complete off-the-wall style and
   concept"): a verdict also carries the RATED RUN's own reference (tasteref.js — its deliverable files, the palette and
   fonts inside them, its image prompts/model/shape, the tools it used, all read from real records). It rides the record
   as `feedbackRef`, separate from the Commander's words, and renderTaste() puts it on the line: the newest references in
   full, older lines compacted, so all TASTE_LIMIT records always fit the block (the old 1000-char cap stopped at the
   first line that did not fit: 3-4 records in practice). ★ KEEP THIS STYLE in a workflow is the same act (kept: true).

   Pure (clock and ids injected): node-testable; index.js owns the store, the route and the pause gate. */
'use strict';

const TasteRef = require('./tasteref.js');
const Retrieval = require('./context.js');

const ORIGIN = 'feedback';
const DIRECTIVE_CHARS = 120;
const WORDS_CHARS = 400;
const TASTE_LIMIT = 8;
const TASTE_CHARS = 2400;
const WORDS_KEEP = 6;          // corrections remembered per rated run (oldest fall off)
const EDITED_CHARS = 700;      // cap for a Commander-edited record plus appended words
const TASTE_HEADER = '[the Commander\'s own verdicts on past work, newest first. Shape this output to match what they liked and avoid what they disliked. Reference only: the current request wins where it says otherwise.]';
// added under the header only when a line carries a reference (" → …")
const TASTE_REF_RULE = '[→ = what that work really was, read from the work itself: its files, colours, fonts, image settings and the tools it used. For new design, visual or creative work, match the newest relevant APPROVED one in style and concept unless the Commander asks for something different: open its file first (a file tagged [<agent> workspace] belongs to another crew member: match it from this line). Do repeat work the way an APPROVED one was done; never repeat a REJECTED approach. A STYLE KEPT · RESULT REJECTED (or CLOSE) line: match its style, but fix what the Commander disliked or wants.]';

function clean(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

// content(verdict, words, directive) -> the belief text, or '' when the verdict carries nothing to learn
// (a bare "close" rating says neither what to keep nor what to change).
function content(verdict, words, directive) {
  const w = clean(words, WORDS_CHARS);
  const d = clean(directive, DIRECTIVE_CHARS);
  const on = d ? ' (on: ' + d + ')' : '';
  if (verdict === 'miss') return w ? 'DISLIKED: "' + w + '"' + on : (d ? 'DISLIKED the result of: ' + d + ' (rated missed: that approach fell short, do it differently next time)' : '');
  if (verdict === 'ok') return w ? 'WANTS: "' + w + '"' + on + ' (rated close)' : '';
  if (verdict === 'great') return w ? 'LIKED: "' + w + '"' + on : (d ? 'LIKED the result of: ' + d + ' (rated nailed it: keep that approach for similar work)' : '');
  return '';
}

// the words joined NEWEST-FIRST-KEPT under the cap: when a run collects more corrections than fit, the oldest
// fall off, never the newest (a cap that kept the first words would silently ignore every later correction).
function newestWords(words) {
  const keep = [];
  let used = 0;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (keep.length && used + w.length + 3 > WORDS_CHARS) break;
    keep.unshift(w); used += w.length + 3;
  }
  return keep.join(' · ');
}

// looksLikeFeedback(text) — is a TYPED message (sent right after a short-of-the-mark rating) actually about the work?
// The chat treats the next message to that agent within 10 minutes as the correction; that was harmless when it only
// fed a one-shot review, but a permanent taste record built from "now summarize my inbox" would tell every future run
// the Commander DISLIKED that. Evaluative cues only; a chip or a rating-body correction is explicit and skips this.
const FEEDBACK_CUES = /\b(too|shorter|longer|tighter|simpler|clearer|more|less|fewer|instead|rather|prefer|should(n'?t)?|don'?t|do not|never|always|wrong|missed|missing|forgot|not what|not quite|not enough|need(s|ed)? (to|more|less)|wanted|meant|keep it|make it|use (bullets|a table|headers|plain)|format|tone|style|length|verbose|wordy|boring|generic|vague|off)\b/i;
function looksLikeFeedback(text) {
  const t = String(text == null ? '' : text).trim();
  return !!t && t.length <= 400 && FEEDBACK_CUES.test(t);
}

// apply(list, input, deps) — fold one verdict/correction into an agent's notebook list.
//   input: { runId, verdict, words?, directive?, ref?, kept? }  words APPEND to what this run already holds; ref = the rated
//          run's reference (tasteref.buildRef), a fresh capture replaces the stored one; kept = ★ KEEP THIS STYLE (an
//          explicit approval of that run's style, never a rewrite of what the Commander said about it)
//   deps:  { now, nextId(list), nextTrust(prev, delta), trustDelta }
// Returns { list, rec, created } or null when there is nothing to write or change.
function apply(list, input, deps) {
  list = Array.isArray(list) ? list : [];
  input = input || {}; deps = deps || {};
  const runId = String(input.runId || '').trim();
  const verdict = String(input.verdict || '');
  if (!runId || !/^(great|ok|miss)$/.test(verdict)) return null;
  const now = Number(deps.now) || 0;
  const at = list.findIndex(r => r && r.origin === ORIGIN && r.sourceRunId === runId);
  const prev = at >= 0 ? list[at] : null;
  const ref = input.ref && typeof input.ref === 'object' ? input.ref : null;
  const kept = input.kept === true;
  // a NEW reference or a new ★ KEEP THIS STYLE is something to write even when no new words came with it
  // (a real verdict on a record that only ★ KEEP THIS STYLE made turns it into a verdict record: PUT IT BACK must not delete it)
  const verdictOnKept = !kept && !!(prev && prev.feedbackKeptOnly);
  const extra = !!(ref && (!prev || JSON.stringify(prev.feedbackRef || null) !== JSON.stringify(ref))) || (kept && !(prev && prev.feedbackKept)) || verdictOnKept || (!kept && !!prev && prev.feedbackVerdict !== verdict);
  // A real verdict replaces the synthetic keep-style approval; keeping a style never replaces a real verdict.
  const refFields = Object.assign({}, !kept ? { feedbackVerdict: verdict } : null, ref ? { feedbackRef: ref } : null, kept ? { feedbackKept: true } : null, verdictOnKept ? { feedbackKeptOnly: false } : null);
  const words = (prev && Array.isArray(prev.feedbackWords) ? prev.feedbackWords : []).slice();
  let add = clean(input.words, WORDS_CHARS);
  if (add && prev && words.indexOf(add) >= 0) { if (!extra) return null; add = ''; }   // a repeated chip/message teaches nothing new
  if (add) { words.push(add); while (words.length > WORDS_KEEP) words.shift(); }
  const directive = (prev && prev.feedbackDirective) || clean(input.directive, DIRECTIVE_CHARS);
  // THE COMMANDER EDITED IT in the Memory Core (content no longer what this module generated): their wording is the
  // truth now — append the new words to it, never regenerate over it.
  // (sticky: once edited, a record is never regenerated again — feedbackEdited survives our own later appends)
  // Only the COMMANDER's edit counts (confirmation stays user-confirmed through a Memory Core edit). An agent's
  // notebook.write replaceId leaves it 'inferred': that rewrite is not their wording, so it is regenerated over.
  if (prev && prev.confirmation === 'user-confirmed' && (prev.feedbackEdited || (prev.feedbackGenerated && String(prev.content || prev.body || '') !== prev.feedbackGenerated))) {
    if (!add && !extra) return null;
    const tail = add ? ' · also: "' + add + '"' : '';
    const edited = add ? clean(prev.content || prev.body, EDITED_CHARS - tail.length) + tail : String(prev.content || prev.body || '');
    const rec = Object.assign({}, prev, { body: edited, content: edited, feedbackGenerated: edited, feedbackEdited: true, feedbackWords: words, updatedAt: now, lastFeedbackAt: now, feedbackAt: now }, refFields);
    const out = list.slice(); out[at] = rec;
    return { list: out, rec, created: false };
  }
  // ★ KEEP THIS STYLE on a run already rated short keeps what the Commander SAID about it (their words stay a dislike
  // or a want); the kept flag is what marks the style approved. Never regenerate their words under another verdict.
  const textVerdict = kept && prev && prev.feedbackVerdict && prev.feedbackVerdict !== verdict ? prev.feedbackVerdict : verdict;
  const text = content(textVerdict, newestWords(words), directive);
  if (!text) return null;
  if (prev && prev.content === text && !extra) return null;   // nothing new
  if (prev) {
    const rec = Object.assign({}, prev, { body: text, content: text, feedbackGenerated: text, feedbackWords: words, updatedAt: now, lastFeedbackAt: now, feedbackAt: now, confirmation: 'user-confirmed', feedbackEdited: false }, refFields);
    const out = list.slice(); out[at] = rec;
    return { list: out, rec, created: false };
  }
  const delta = Number(deps.trustDelta) || 0;
  const trust = typeof deps.nextTrust === 'function' && delta ? deps.nextTrust(0, delta) : 0;
  const rec = {
    id: typeof deps.nextId === 'function' ? deps.nextId(list) : 'note_' + (list.length + 1),
    kind: 'profile', title: 'Preference', body: text, content: text,
    // taste is about the Commander, not one repo, so it stays global even when the rated run was in a project
    scope: 'global', streamId: null, projectRoot: null,
    sourceRunId: runId, confirmation: 'user-confirmed', authority: 'reference-only', origin: ORIGIN,
    feedbackVerdict: verdict, feedbackWords: words, feedbackDirective: directive, feedbackGenerated: text,
    createdAt: now, ts: now, updatedAt: now, lastFeedbackAt: now, feedbackAt: now, lastUsedAt: null, useCount: 0, trust, pinned: false
  };
  Object.assign(rec, refFields);
  if (kept) rec.feedbackKeptOnly = true;   // made by ★ KEEP THIS STYLE alone: its PUT IT BACK removes it whole
  return { list: list.concat([rec]), rec, created: true };
}

// unkeep(list, runId) — ★ STYLE KEPT · PUT IT BACK (or the panel's UNDO of its example): the approval goes with it. A record
// that keep-style alone made is removed; one that also carries a real verdict only loses the kept flag (the verdict and
// the Commander's words stay). -> { list, rec, removed } or null when that run has no kept style.
function unkeep(list, runId) {
  list = Array.isArray(list) ? list : [];
  const id = String(runId || '').trim();
  const at = id ? list.findIndex(r => r && r.origin === ORIGIN && r.sourceRunId === id && r.feedbackKept) : -1;
  if (at < 0) return null;
  const prev = list[at];
  if (prev.feedbackKeptOnly) return { list: list.slice(0, at).concat(list.slice(at + 1)), rec: prev, removed: true };
  const rec = Object.assign({}, prev);
  delete rec.feedbackKept; delete rec.feedbackKeptOnly;
  const out = list.slice(); out[at] = rec;
  return { list: out, rec, removed: false };
}

// directiveFor(candidates, messages) — what the rated work was ABOUT, for the "(on: …)" citation. A run started by
// "yes" (accepting the agent's offer) is titled "yes", which cites nothing: skip bare short turns and fall back to
// the most recent substantive user turn in the run's transcript.
function substantive(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length >= 3; }
function directiveFor(candidates, messages) {
  for (const c of (Array.isArray(candidates) ? candidates : [])) if (substantive(c)) return String(c).trim();
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && substantive(m.content) && !/^\s*</.test(m.content)) return m.content.trim();
  }
  return String((Array.isArray(candidates) && candidates.find(c => String(c || '').trim())) || '').trim();
}

/* TASTE IS THE COMMANDER'S OWN WORDS (sweep 2026-10-02). notebook.write { replaceId } keeps a record's origin, so an
   agent (or a page it read) could rewrite a feedback record and have it injected into EVERY agent's runs as "the
   Commander's own verdicts". A revision the Commander did not confirm is 'inferred': it is not taste. */
function isTaste(r) { return !!(r && r.origin === ORIGIN && r.confirmation === 'user-confirmed' && !r.taintedBy && !r.projectRoot && r.scope !== 'project' && r.scope !== 'stream' && String(r.content || r.body || '').trim()); }
// "the same belief" = the same words AND the same reference: two approvals of "design the landing page" on two different
// designs are two references, and deduping them on the words alone dropped the newer design.
function tasteKey(r) { return String(r.content || r.body || '').trim() + (r.feedbackRef ? '\u0000' + JSON.stringify(r.feedbackRef) : ''); }

// selectTaste(records, opts) -> the newest feedback records (most recently given or updated first), capped.
function selectTaste(records, opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(32, Number(opts.limit) || TASTE_LIMIT));
  const at = r => Number(r.feedbackAt) || Number(r.createdAt || r.ts) || 0;
  const all = Retrieval.activeMemoryRecords(records).filter(isTaste).slice().sort((a, b) => at(b) - at(a));
  const query = typeof opts.query === 'string' ? opts.query : '';
  const relevance = Retrieval.lexicalScores(all, query).scores;
  const standing = r => /\b(?:always|never|from now on|going forward|by default|every time|whenever|(?:i|we) (?:would )?prefer)\b/i.test(
    Array.isArray(r.feedbackWords) ? r.feedbackWords.join(' ') : r.feedbackEdited ? String(r.content || r.body || '') : '');
  // Keep the newest verdict visible, then let applicable older corrections and explicit standing
  // preferences compete. A stream of bare approvals must not flush every durable correction.
  const chosen = new Set(all.slice(0, Math.min(2, limit)));
  const candidates = all.map((r, i) => ({ r, i, score: (standing(r) ? 8 : 0) + 2 * relevance[i]
    + (Array.isArray(r.feedbackWords) && r.feedbackWords.length ? 1 : 0) + 1 / (i + 1) }));
  candidates.sort((a, b) => b.score - a.score || a.i - b.i);
  for (const row of candidates) { if (chosen.size >= limit) break; chosen.add(row.r); }
  const selected = all.filter(r => chosen.has(r));   // render newest first, so conflicts retain temporal authority
  // notShown: every verdict the selection left out (a ranking cut, not an omission). ownNotShown: the left-out records
  // that live in THIS notebook (not another agent's), the only ones notebook.read can return.
  Object.defineProperty(selected, 'recallMeta', { value: { notShown: all.length - selected.length, ownNotShown: all.filter(r => !chosen.has(r) && !r.foreign).length } });
  return selected;
}

// Ordinary global standing preferences share the same owner-only boundary as taste. Never lift
// inferred notes, project requirements, biography, or tainted observations into station authority.
// Foreign ids are notebook-local: remove them so a local feedback/update cannot hit the wrong note.
function stationStanding(own, others) {
  const mine = Array.isArray(own) ? own : [];
  const foreign = [];
  for (const entry of (Array.isArray(others) ? others : [])) {
    const list = Array.isArray(entry) ? entry : entry && entry.records;
    const owner = entry && /^[A-Za-z0-9_-]{1,40}$/.test(String(entry.agentId || '')) ? String(entry.agentId) : '';
    for (const r of (Array.isArray(list) ? list : [])) {
      if (Retrieval.isStandingMemory(r)) foreign.push(Object.assign({}, r, { id: '', foreign: true, sourceAgentId: owner, sourceRecordId: String(r.id || '') }));
    }
  }
  const all = Retrieval.activeMemoryRecords(mine.concat(foreign)).filter(Retrieval.isStandingMemory);
  const key = r => String(r.content || r.body || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Set();
  return all.filter(r => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

// stationTaste(own, others, opts) — the Commander's taste is about THE COMMANDER, not one agent: a correction given
// to a specialist must shape the overseer's next deliverable too. Merge this agent's own feedback records with every
// other agent's, newest first. Foreign copies lose their id (an id is only meaningful in its own notebook: rendered,
// it would invite notebook.feedback on the wrong record, and recall's useCount bump would hit a same-numbered local
// note). The same belief given twice (same text) appears once, own copy preferred.
function stationTaste(own, others, opts) {
  const mine = (Array.isArray(own) ? own : []).filter(isTaste);
  const seen = new Set(mine.map(tasteKey));
  const foreign = [];
  for (const entry of (Array.isArray(others) ? others : [])) {
    const list = Array.isArray(entry) ? entry : entry && entry.records;
    for (const r of (Array.isArray(list) ? list : [])) {
      if (!isTaste(r)) continue;
      const key = tasteKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      foreign.push(Object.assign({}, r, { id: '', foreign: true }));
    }
  }
  return selectTaste(mine.concat(foreign), opts);
}

/* adoptTaste(heroList, departedList, nextId, from) — DELETING AN AGENT MUST NOT DELETE THE COMMANDER'S TASTE (sweep
   2026-10-02). Taste is about the Commander, not the agent it was given to, but it lives in that agent's notebook — and
   agent delete archives the notebook, so every rating ever given on its work silently stopped steering anyone. The
   departing agent's taste records move into the hero's notebook (new ids there; the same words once) before archive.
   -> the new hero list, or null when there is nothing to adopt. */
function adoptTaste(heroList, departedList, nextId, from) {
  const hero = Array.isArray(heroList) ? heroList.slice() : [];
  const have = new Set(hero.filter(isTaste).map(tasteKey));
  let added = 0;
  for (const r of (Array.isArray(departedList) ? departedList : [])) {
    if (!isTaste(r)) continue;
    const text = tasteKey(r);
    if (have.has(text)) continue;
    have.add(text);
    const id = typeof nextId === 'function' ? nextId(hero) : 'note_' + (hero.length + 1);
    hero.push(Object.assign({}, r, { id, adoptedFrom: from ? String(from) : undefined, pinned: false }));
    added++;
  }
  return added ? hero : null;
}

/* renderTaste(records, renderRecall, { agentId? }) — the taste block for a run's prompt (both injection sites in index.js).
   agentId names the prompt's reader: the agent whose notebook stationTaste's `own` was.
   One compact line per record — VERDICT YYYY-MM-DD: <what the work was> — "<their words>" → <the reference> — under the
   taste header (which already says these are the Commander's own verdicts, so the generic recall prefix
   "[user-confirmed reference] Preference — ", ~40 chars a line, is not repeated). EVERY selected record renders: the
   newest lines keep their full reference, and when the block would overflow the OLDEST lines step down first (main file
   + 3 colours + main font, then the main file alone, clipped), so a long history compresses instead of falling off the
   end. It renders through the real renderRecall (fence, injection guard, usedIds); a line's full stored text rides
   `content`, so the injection scan reads all of it even when the shown line is compacted. */
function day(ms) { const n = Number(ms) || 0; return n > 0 ? new Date(n).toISOString().slice(0, 10) : ''; }
function baseLine(r, dirCap, wordsCap) {
  const v = String(r.feedbackVerdict || '');
  // a kept style with a 👎 or "close" verdict shows both facts: APPROVED alone hid the rejection (review memory-learning-12)
  const lab = r.feedbackKept
    ? (v === 'miss' ? 'STYLE KEPT · RESULT REJECTED' : v === 'ok' ? 'STYLE KEPT · RESULT CLOSE' : 'APPROVED (style kept)')
    : v === 'great' ? 'APPROVED' : v === 'miss' ? 'REJECTED' : v === 'ok' ? 'CLOSE' : '';
  const d = day(r.feedbackAt || r.createdAt || r.ts);
  const head = lab ? lab + (d ? ' ' + d : '') + ': ' : (d ? d + ': ' : '');
  const stored = String(r.content || r.body || '');
  // the Commander's own wording (a Memory Core edit), or a record this renderer cannot rebuild: shown as stored
  if (!lab || r.feedbackEdited || (r.feedbackGenerated && stored !== r.feedbackGenerated) || !Array.isArray(r.feedbackWords)) return head + clean(stored, dirCap + wordsCap);
  const what = clean(r.feedbackDirective, dirCap) || 'that work';
  const words = clean(newestWords(r.feedbackWords), wordsCap);
  if (!words) return head + what + (v === 'miss' ? (r.feedbackKept ? ' (keep the style, change the result)' : ' (do it differently)') : '');
  return head + what + (v === 'great' ? ' — liked: "' : v === 'ok' ? ' — wants: "' : v === 'miss' ? ' — disliked: "' : ' — "') + words + '"';
}
const LEVELS = [{ dir: 160, words: 300, line: 900 }, { dir: 120, words: 160, line: 420 }, { dir: 90, words: 80, line: 250 }];
function tasteLine(r, lv, viewer) { const c = LEVELS[lv]; return clean(baseLine(r, c.dir, c.words) + TasteRef.refLine(r.feedbackRef, lv, viewer), c.line); }
function renderTaste(records, renderRecall, opts) {
  opts = opts || {};
  const budget = Number(opts.limit) || TASTE_CHARS;
  const recs = (Array.isArray(records) ? records : []).filter(isTaste);
  if (typeof renderRecall !== 'function' || !recs.length) return { text: '', count: 0, chars: 0, usedIds: [] };
  const prefix = r => 2 + (/^[A-Za-z0-9_-]{1,80}$/.test(String(r.id || '')) ? String(r.id).length + 3 : 0);   // "• [note_12] "
  const levels = recs.map(() => 0);
  const viewer = opts.agentId ? String(opts.agentId) : '';   // whose prompt: their own workspace files need no owner tag
  const total = () => recs.reduce((n, r, i) => n + prefix(r) + tasteLine(r, levels[i], viewer).length + 1, 0);
  for (let lv = 1; lv < LEVELS.length && total() > budget; lv++) {
    for (let i = recs.length - 1; i >= 0 && total() > budget; i--) if (levels[i] < lv) levels[i] = lv;
  }
  const lines = recs.map((r, i) => ({ id: r.id, title: '', body: tasteLine(r, levels[i], viewer), content: String(r.content || r.body || '') + TasteRef.refLine(r.feedbackRef, 0, viewer) }));
  const header = TASTE_HEADER + (recs.some(r => r.feedbackRef) ? '\n' + TASTE_REF_RULE : '');
  // the levels above already fit the budget; the slack only absorbs a recall-line format change, never drops a record.
  // The selection cut is disclosed as older verdicts not shown: a ranking cut, never called an omission, and never a
  // bare notebook.read (an unqueried read lists the whole notebook; review memory-learning-04). notebook.read can
  // return only the named READER's own records, so only those get a query-bound retrieval path. Another agent's verdicts (shared with no id here), or a prompt with no named reader (a delegated
  // worker's task context: its notebook.read reads its own notebook), get no retrieval promise they cannot keep.
  const meta = records.recallMeta || {};
  const notShown = Math.max(0, Number(meta.notShown) || 0);
  const ownNotShown = viewer ? Math.min(notShown, Math.max(0, Number(meta.ownNotShown) || 0)) : 0;
  Object.defineProperty(lines, 'recallMeta', { value: { notShown, priority: [] } });
  return renderRecall(lines, { limit: budget + 400, priorityLimit: 0, header, pointer: false,
    notShownText: n => n + ' older verdict' + (n === 1 ? '' : 's') + ' not shown'
      + (ownNotShown ? ' (' + ownNotShown + ' of them are in your own notebook: notebook.read with a query finds them)' : '') });
}

/* forgetRatedWork(rec) — THE RATED RUN'S SESSION WAS DELETED (qa/bugs/3e926b6a). The verdict and the Commander's own
   rating words stay: they are about the Commander, and every like and dislike keeps steering later work. What quoted
   the deleted session goes: the "(on: …)" directive (its request) and the reference read from its work (feedbackRef).
   A record the Commander edited in the Memory Core (or an older one this module cannot rebuild) keeps its stored
   wording, minus that directive clause.
   -> the record to keep (unchanged when there is nothing to strip), or null when nothing of the Commander's own is
   left: a bare rating with no words taught only through the deleted work (content() writes no record for it either). */
function forgetRatedWork(rec) {
  if (!rec || rec.origin !== ORIGIN) return rec;
  const stored = String(rec.content != null ? rec.content : rec.body || '');
  const directive = clean(rec.feedbackDirective, DIRECTIVE_CHARS);
  const edited = !!(rec.feedbackEdited || (rec.feedbackGenerated && stored !== rec.feedbackGenerated));
  const rebuildable = Array.isArray(rec.feedbackWords) && !!(rec.feedbackVerdict || rec.feedbackKept);
  const words = rebuildable ? rec.feedbackWords.filter(w => typeof w === 'string' && w) : [];
  const text = (edited || !rebuildable
    ? (directive ? stored.split(' (on: ' + directive + ')').join('') : stored)
    : content(rec.feedbackVerdict || 'great', newestWords(words), '')).trim();
  if (!text) return null;
  if (text === stored && !rec.feedbackDirective && rec.feedbackRef === undefined) return rec;
  const out = Object.assign({}, rec, { body: text, content: text, feedbackGenerated: text, feedbackDirective: '' });
  if (edited) out.feedbackEdited = true;   // their wording: never regenerated over by a later correction
  delete out.feedbackRef;
  return out;
}

module.exports = { ORIGIN, TASTE_HEADER, TASTE_REF_RULE, TASTE_LIMIT, TASTE_CHARS, content, apply, directiveFor, looksLikeFeedback, isTaste, selectTaste, stationTaste, stationStanding, adoptTaste, renderTaste, unkeep, forgetRatedWork };
