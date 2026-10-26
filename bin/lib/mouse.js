/* bin/lib/mouse.js — the mouse in the `starnet` dashboard: PURE parts (no I/O).

   A terminal reports the mouse once the screen asks it to (ESC[?1000h: presses, releases and the wheel; ESC[?1006h: in SGR
   form, ESC[<b;x;yM on a press and …m on a release, x and y counted from 1). Node's keypress reader does not know the SGR
   form: it hands the dashboard '\x1b[<' as one key and then every character after it as keys of its own. makeReader puts
   them back together, so a click never types "0;12;7M" into the prompt.

   What a click lands on is the screen's own business: tui.render returns `hits` — { x0, x1, y, act } spans (x1 exclusive)
   for everything it drew that can be clicked — and hitAt finds the one under the pointer. */
'use strict';

const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';

// one SGR report's parameters → { kind: down|up|wheel, button, dir, x, y, shift, meta, ctrl } (x, y from 0), or null
function parse(params, press) {
  const m = /^(\d{1,4});(\d{1,5});(\d{1,5})$/.exec(String(params || ''));
  if (!m) return null;
  const b = Number(m[1]), x = Number(m[2]) - 1, y = Number(m[3]) - 1;
  if (x < 0 || y < 0) return null;
  const mods = { shift: !!(b & 4), meta: !!(b & 8), ctrl: !!(b & 16) };
  if (b & 64) return Object.assign({ kind: 'wheel', dir: (b & 1) ? 'down' : 'up', x, y }, mods);
  if (b & 32) return null;   // motion: never asked for (no ?1002h / ?1003h), never acted on
  return Object.assign({ kind: press ? 'down' : 'up', button: ['left', 'middle', 'right', 'none'][b & 3], x, y }, mods);
}

// a keypress filter: true when the key was part of a mouse report (the dashboard drops it). onMouse gets each whole report.
// An Esc pressed just before a click reaches Node glued to the report ('\x1b\x1b[<': a lone Esc waits up to 500 ms for more
// bytes): it is still the Esc you pressed — onEscape gets it first — and the click is still a click.
function makeReader(onMouse, onEscape) {
  let buf = null;
  return function feed(str, key) {
    const seq = (key && key.sequence) || (typeof str === 'string' ? str : '');
    if (/^\x1b+\[<$/.test(seq)) {
      if (seq.length > 3 && onEscape) onEscape();
      buf = '';
      return true;
    }
    if (buf === null) {
      // a terminal that sends the whole report as one key (a newer reader) is parsed the same
      const whole = /^\x1b\[<([\d;]+)([Mm])$/.exec(seq);
      if (!whole) return false;
      const ev = parse(whole[1], whole[2] === 'M');
      if (ev) onMouse(ev);
      return true;
    }
    if (/^[\d;]$/.test(seq) && buf.length < 20) { buf += seq; return true; }
    if (seq === 'M' || seq === 'm') {
      const ev = parse(buf, seq === 'M');
      buf = null;
      if (ev) onMouse(ev);
      return true;
    }
    buf = null;   // not a report after all: this key is the person's
    return false;
  };
}

// the span under (x, y): the last one drawn wins (a card over the pane, a key over its card)
function hitAt(hits, x, y) {
  let found = null;
  for (const h of hits || []) if (h.y === y && x >= h.x0 && x < h.x1) found = h;
  return found;
}

// the http(s) link a click at column x lands on, read off the row as drawn (cells, so a wide glyph before it counts two)
const URL_CH = /[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]/;
function urlAt(segs, x, widthOf) {
  const cells = [];
  for (const [t] of segs || []) for (const ch of String(t)) { cells.push(ch); if (widthOf && widthOf(ch) === 2) cells.push(''); }
  if (!(x >= 0 && x < cells.length) || !URL_CH.test(cells[x] || '')) return '';
  let a = x, b = x;
  while (a > 0 && URL_CH.test(cells[a - 1] || '')) a--;
  while (b + 1 < cells.length && URL_CH.test(cells[b + 1] || '')) b++;
  const word = cells.slice(a, b + 1).join('');
  const m = /https?:\/\/[^\s]+/.exec(word);
  if (!m) return '';
  // a link said in parentheses or at the end of a sentence keeps its own characters only
  const url = m[0].replace(/[).,;:!?'\]]+$/, '');
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''; } catch (_) { return ''; }
}

// the path a file tool acts on, read off its arguments (cut at 400 characters, so read the key, not the JSON)
function fileArg(tool, argsSummary) {
  if (!/^fs[._](?:write|append|edit|patch|read|create)$/.test(String(tool || ''))) return '';
  const m = /"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(argsSummary || ''));
  if (!m) return '';
  let p;
  try { p = JSON.parse('"' + m[1] + '"'); } catch (_) { return ''; }
  return typeof p === 'string' && p.trim() ? p.trim() : '';
}

/* The station's own page for a file an agent wrote (GET /api/file, jailed to the agent's workspace or a trusted project),
   with the short-lived ticket the desktop app signs for the same link (sidecar/apitickets.js, the station's own module):
   a browser opens it without the station token. A text file opens as the station's reading page (?view=doc), as in the app. */
const TEXT_DOC_RE = /\.(md|markdown|txt|text|csv|tsv|log|json|ya?ml|toml|ini|cfg|conf|py|tsx?|jsx|s?css|sh|ps1|bat|sql|rb|go|rs|java|kt|c|h|cpp|cs|php)$/i;
function fileUrl(base, tickets, key, o) {
  const agent = o.agent || 'agent', rel = String(o.path || '');
  const t = tickets.mint(key, 'file', tickets.scopeFile(agent, rel), { now: o.now });
  return String(base).replace(/\/+$/, '') + '/api/file?agent=' + encodeURIComponent(agent) + '&path=' + encodeURIComponent(rel) +
    (o.project ? '&project=' + encodeURIComponent(o.project) : '') + (TEXT_DOC_RE.test(rel) ? '&view=doc' : '') + '&ticket=' + encodeURIComponent(t);
}

module.exports = { ENABLE, DISABLE, parse, makeReader, hitAt, urlAt, fileArg, fileUrl };
