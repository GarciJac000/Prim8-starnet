/* sidecar/channels/telegram.format.js — turn a model's MARKDOWN into Telegram HTML (C9).

   THE BUG THIS FIXES (2026-07-28, visible in a member's own screenshots). Every reply left the sidecar as
   plain text with NO `parse_mode`, so an LLM's ordinary markdown arrived on the phone as raw syntax: literal
   `**bold**`, backticked `code`, `## headings`, ``` fences. The station reads as broken formatting on the one
   surface most members actually use.

     toTelegramHtml(text) -> { html, converted }

   DELIBERATELY A SMALL, BALANCED-ONLY SUBSET. The failure mode of `parse_mode` is not a cosmetic one: Telegram
   rejects a malformed entity string with 400 and the message is LOST, so every rule here converts only what it
   can prove is balanced WITHIN THIS STRING and escapes everything else as literal text. Two consequences are
   intentional:
     · `_underscore_` and single `*star*` are NEVER treated as emphasis. Bullets ("* item"), file names
       (`voice_generate`) and snake_case tool names are far commoner in this app's output than the emphasis they
       would imply, and a wrong italic is a worse trade than a missing one.
     · A chunk that split mid-`**bold**` (the hub chunks BEFORE this runs) simply keeps its literal asterisks
       rather than emitting an unclosed <b>, which would 400 the whole chunk.

   Only http/https links become anchors — a `javascript:`/`tg:` URL in model output must never become a tappable
   link on the Commander's phone.

   Length note: Telegram's 4096 cap counts the text AFTER entity parsing, so tags and `&amp;` expansion do not
   count against it. Chunking on the PLAIN text upstream therefore stays correct.

   Pure + deterministic: no clock, no rng, no I/O. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.telegramFormat = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Control-character sentinels: a model cannot emit these through the JSON wire in normal prose, and we strip
  // any stray ones from the input first so a crafted reply can never forge a placeholder and inject raw HTML.
  const OPEN = '\u0001', CLOSE = '\u0002';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* LINEAR-TIME HEADINGS AND FENCES (perf lane, 2026-10-20). The heading rule used to be the single regex
       /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm
     and its trailer has two adjacent [ \t]* runs: on a heading line holding a long run of spaces before more text,
     every lazy step of the body re-split that run every possible way. 2,000 spaces on one line took 6 s, and the
     stream edit re-runs the conversion every 1.5 s, so one reply could pin a core. The fence opener
     ```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n had the same two-run split (quadratic on a fence + spaces).
     Same output, without the backtracking:
       · HEADING_LINE matches the identical line HEAD (that part never backtracked) and takes the rest of the line;
         headingBody() then returns the body the old lazy rule chose: the SHORTEST non-empty prefix of the rest
         whose remainder is spaces/tabs, then '#'s, then spaces/tabs. Those remainders stay valid when their first
         character is dropped, so that prefix ends where the LONGEST such suffix (one backward scan) begins.
         A line that is head + spaces only keeps its old reading: two or more spaces leave the last one as the
         body, a single space never matched.
       · FENCE_BLOCK / FENCE_BODY accept the same opener with one space run before the optional language word.
     test/channels.telegram.linear.test.js diffs both against the old regexes on random and adversarial input. */
  const HEADING_LINE = /^[ \t]{0,3}#{1,6}[ \t]+.*$/gm;
  const isSpTab = ch => ch === ' ' || ch === '\t';
  function headingBody(line) {
    const n = line.length;
    let i = 0;
    while (i < n && isSpTab(line[i])) i++;
    while (i < n && line[i] === '#') i++;
    const afterHashes = i;
    while (i < n && isSpTab(line[i])) i++;
    if (i === n) return (i - afterHashes >= 2) ? line[n - 1] : null;   // head + spaces only
    let j = n;
    while (j > i && isSpTab(line[j - 1])) j--;
    while (j > i && line[j - 1] === '#') j--;
    while (j > i && isSpTab(line[j - 1])) j--;
    return line.slice(i, Math.max(i + 1, j));
  }
  // wrap(body) -> the replacement for a heading line; a line the old rule never matched comes back unchanged
  function replaceHeadings(s, wrap) {
    return s.replace(HEADING_LINE, line => { const body = headingBody(line); return body == null ? line : wrap(body); });
  }
  const FENCE_BLOCK = /```[ \t]*(?:([A-Za-z0-9_+-]+)[ \t]*)?\r?\n([\s\S]*?)```/g;
  const FENCE_BODY = /```[ \t]*(?:[A-Za-z0-9_+-]+[ \t]*)?\r?\n([\s\S]*?)```/g;

  function toTelegramHtml(text) {
    const src = String(text == null ? '' : text).replace(/[\u0001\u0002]/g, '');
    if (!src) return { html: '', converted: false };

    const held = [];                                    // extracted verbatim spans (code), restored at the end
    const hold = (html) => { held.push(html); return OPEN + (held.length - 1) + CLOSE; };
    let s = src;

    // 1. FENCED BLOCKS FIRST — their interior must never be scanned for other markup. An unpaired trailing
    //    fence (a chunk boundary landed inside a block) is left alone and ends up escaped as literal text.
    s = s.replace(FENCE_BLOCK, (m, lang, body) =>
      hold('<pre>' + esc(body.replace(/\s+$/, '')) + '</pre>'));
    //    a single-line ```code``` with no newline
    s = s.replace(/```([^`\n]+)```/g, (m, body) => hold('<pre>' + esc(body) + '</pre>'));

    // 2. INLINE CODE — balanced single backticks on one line only.
    s = s.replace(/`([^`\n]+)`/g, (m, body) => hold('<code>' + esc(body) + '</code>'));

    // 3. Everything that survives is prose: escape it ONCE, then apply the balanced inline rules. Escaping
    //    first is safe because none of the rules below key on & < >.
    s = esc(s);

    // 4. Links — http/https only, and the label may not contain markup we would then have to re-scan.
    s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g,
      (m, label, url) => hold('<a href="' + url.replace(/"/g, '&quot;') + '">' + label + '</a>'));

    // 5. **bold** — balanced, non-greedy, never spanning a blank line (that is a chunk/paragraph boundary,
    //    and a "bold" that swallows two paragraphs is always a mis-parse).
    s = s.replace(/\*\*(?!\s)([^*\n]{1,400}?)\*\*/g, (m, body) => '<b>' + body + '</b>');

    // 6. Markdown headings become bold lines — Telegram has no heading entity, and leaving the '#' visible is
    //    exactly the raw-syntax leak this module exists to stop.
    s = replaceHeadings(s, body => '<b>' + body + '</b>');

    // 7. Blockquote markers: the '>' is already escaped to '&gt;' — render it as a quote glyph instead of
    //    leaving markdown punctuation on screen.
    s = s.replace(/^[ \t]{0,3}&gt;[ \t]?/gm, '“ ');

    // 8. Bullet markers to a real bullet glyph (leading '-'/'*' only, never mid-line arithmetic).
    s = s.replace(/^([ \t]{0,8})[*-][ \t]+(?=\S)/gm, (m, indent) => indent + '• ');

    // restore held spans
    s = s.replace(new RegExp(OPEN + '(\\d+)' + CLOSE, 'g'), (m, i) => held[Number(i)] || '');

    return { html: s, converted: s !== src };
  }

  /* The FALLBACK for a rejected entity string. Telegram answers 400 "can't parse entities" when a tag is
     malformed; we then resend WITHOUT parse_mode, but stripped of the markdown punctuation so the member still
     reads clean prose rather than the raw syntax that started all this. Never throws. */
  function toPlainText(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(FENCE_BODY, (m, body) => body.replace(/\s+$/, ''));
    s = s.replace(/```([^`\n]+)```/g, '$1');
    s = s.replace(/`([^`\n]+)`/g, '$1');
    s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g, '$1 ($2)');
    s = s.replace(/\*\*(?!\s)([^*\n]{1,400}?)\*\*/g, '$1');
    s = replaceHeadings(s, body => body);
    s = s.replace(/^([ \t]{0,8})[*-][ \t]+(?=\S)/gm, (m, indent) => indent + '• ');
    return s;
  }

  // Does this Bot API error mean "your entity markup is broken"? Those are the ONLY ones worth resending as
  // plain text — a 403 (blocked) or 400 "chat not found" would fail identically the second time.
  function isParseError(description) {
    return /can't parse entities|can not parse entities|unsupported start tag|unclosed start tag|entity/i
      .test(String(description == null ? '' : description));
  }

  return { toTelegramHtml, toPlainText, isParseError, esc, _internals: { replaceHeadings, headingBody, FENCE_BLOCK, FENCE_BODY } };
});
