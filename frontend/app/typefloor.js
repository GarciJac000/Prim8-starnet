/* STARNET — typefloor.js : the station windows' text floor.

   WHY (Andrew 10-19: "make sure the text isnt too small everywhere", then "give the windows the same text floor and
   spacing too"): measured across every station window and each of its rail sections at his settings, 3,179 pieces of
   text sat under the floor, down to 9 screen px, set by 223 different rules — badge and chip classes, hard-set px in
   the windows' own CSS, inline styles, and generic classes (.dim, .mc-hint, `p > b`) that are 12px in one window and
   18px in the next. Raising the reading tokens (readability.css, raised on #terms in pipglass.css) lifts only the roles
   that use them; a stylesheet cannot "raise only what is smaller" without shrinking the instances that are already
   larger, and a list of 223 selectors would miss the next window and every plugin window.

   HOW: the floor is MEASURED, not guessed. Each time a window's content is built or rebuilt, every element that paints
   its own words is read once; one whose computed size is under the floor (the --sn-type-meta token in force there) is
   marked `data-sn-floor`, and pipglass.css sets a marked element to that token. Text already at or over the floor is
   never touched, so nothing is ever made smaller. An icon glyph (✕ ▸ ● ★ — no letter or digit), anything aria-hidden,
   and non-text fields (checkboxes, sliders) keep their own metrics. All reads happen before any write, so a pass is
   one style recalculation; a MutationObserver callback runs before the next paint, so text never flashes small. A window
   that settles at a new size is read again (its own narrow rules can shrink a text the first read found at the floor).
   SPACING, the dashboard's too: a caps label at the floor's size is marked `data-sn-caps="label"` (tracked 1.6, the
   dashboard's caps labels) and a caps key — a button, a link, a summary, a pill or chip — `data-sn-caps="key"` (tracked .9,
   the dashboard's keys); a larger caps title keeps its own wide tracking.
   CUT TEXT FADES (Andrew 10-19: "swap the cut-off card descriptions to fades"): VT323 draws "…" as one flat bar, so a
   text cut by an ellipsis or a line clamp is marked `data-sn-cut` ("line", or "clamp" with its line count in --sn-clamp)
   and pipglass.css trades the ellipsis for a fade — shown only while the text actually overflows its box.

   UMD: a `TypeFloor` global in the browser; module.exports under node so the rule is testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TypeFloor = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ATTR = 'data-sn-floor', CAPS = 'data-sn-caps', CUT = 'data-sn-cut';
  const KEYISH = /^(BUTTON|A|SUMMARY|SELECT)$/, KEY_CLASS = /(^|[\s-])(pill|chip|badge|tag|key|btn|bb)([\s-]|$)/;
  const WORDS = /[A-Za-z0-9]/;                                   // an icon glyph alone keeps its own size
  const TEXT_FIELD = /^(|text|search|email|url|number|password|tel)$/;
  const SKIP_TAG = /^(SCRIPT|STYLE|SVG|svg|CANVAS|IMG|VIDEO|IFRAME)$/;

  // does this element paint words of its own (not only its children's)?
  function ownsWords(el) {
    const tag = el.tagName || '';
    if (SKIP_TAG.test(tag)) return false;
    if (tag === 'INPUT') return TEXT_FIELD.test(String(el.getAttribute('type') || '').toLowerCase());
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    for (const c of el.childNodes || []) if (c.nodeType === 3 && WORDS.test(c.textContent || '')) return true;
    return false;
  }
  const hidden = el => !!(el.closest && el.closest('[aria-hidden="true"]'));

  /* every candidate in a subtree: the elements that paint words of their own and have not been read yet */
  function collect(root, into) {
    if (!root || typeof root.querySelectorAll !== 'function') return into;
    for (const el of [root].concat(Array.from(root.querySelectorAll('*')))) {
      if (!el || el.nodeType !== 1 || into.has(el) || (el.hasAttribute(ATTR) && el.hasAttribute(CAPS)) || !ownsWords(el) || hidden(el)) continue;
      into.add(el);
    }
    return into;
  }
  /* read every candidate's size, THEN mark the ones under the floor (all reads before any write, so a batch costs one
     style recalculation however many elements it holds) */
  function measure(els, w) {
    const lift = [], caps = [], cut = [];
    for (const el of els) {
      const lifted = el.hasAttribute(ATTR);
      const cs = w.getComputedStyle(el);
      const size = parseFloat(cs.fontSize), floor = parseFloat(cs.getPropertyValue('--sn-type-meta'));
      if (!(size > 0 && floor > 0)) continue;
      if (!lifted && size < floor - 0.01) lift.push(el);
      // a caps label or key at the floor's size takes the dashboard's tracking (a bigger caps title keeps its own)
      if (!el.hasAttribute(CAPS) && cs.textTransform === 'uppercase' && Math.max(size, floor) <= floor + 0.5) {
        caps.push([el, KEYISH.test(el.tagName) || el.getAttribute('role') === 'button' || KEY_CLASS.test(String(el.className || '')) ? 'key' : 'label']);
      }
      // a text its own box cuts with "…" fades instead: a line clamp that is in force, or a one-line ellipsis
      if (!el.hasAttribute(CUT)) {
        // (Chrome now computes a clamped -webkit-box as flow-root, so the clamp itself, on a clipping box, is the test)
        const lines = parseInt(cs.webkitLineClamp, 10);
        if (lines > 0 && /hidden|clip/.test(cs.overflowY)) cut.push([el, 'clamp', lines]);
        else if (cs.textOverflow === 'ellipsis' && /hidden|clip/.test(cs.overflowX)) cut.push([el, 'line', 0]);
      }
    }
    for (const el of lift) el.setAttribute(ATTR, '');
    for (const [el, kind] of caps) el.setAttribute(CAPS, kind);
    for (const [el, kind, lines] of cut) { if (lines) el.style.setProperty('--sn-clamp', String(lines)); el.setAttribute(CUT, kind); }
    return lift.length;
  }
  const viewOf = v => v || (typeof window !== 'undefined' ? window : null);
  // one pass over a subtree
  function pass(root, view) {
    const w = viewOf(view);
    if (!root || !w || typeof w.getComputedStyle !== 'function' || typeof root.querySelectorAll !== 'function') return 0;
    return measure(collect(root, new Set()), w);
  }
  /* read a subtree again from scratch: its floor and caps marks off, one read, the marks back where they belong — all in
     one task, so nothing paints small in between. For a window that changed size: its own narrow rules (container
     queries) can shrink a text the first pass found at the floor, or grow one it lifted. */
  function refloor(root, view) {
    const w = viewOf(view);
    if (!root || !w || typeof root.querySelectorAll !== 'function') return 0;
    for (const el of Array.from(root.querySelectorAll('[' + ATTR + '],[' + CAPS + ']'))) { el.removeAttribute(ATTR); el.removeAttribute(CAPS); }
    return pass(root, w);
  }

  /* keep a host's content on the floor: a pass now, then one batch per burst of changes — whatever was added (a section
     switch, a list repaint, a card that opens) is read; a LIFTED text whose class changed is read again without its marks,
     so a state that grows it (a selected row at its larger size) is never held at the floor. A re-classed element that was
     never lifted is not read (a search re-classes hundreds of cards per keystroke; reading each subtree on its own forced
     a recalculation per card and doubled the keystroke's cost). */
  function watch(host, view) {
    const w = viewOf(view);
    if (!host || !w || typeof w.MutationObserver !== 'function') return null;
    pass(host, w);
    // a window that settles at a new size (dragged narrower, or a TEXT SIZE change re-fits it) is read again once,
    // 150ms after its last resize
    const sized = typeof w.ResizeObserver === 'function' ? watchSizes(w) : null;
    if (sized) sized.add(host);
    const mo = new w.MutationObserver(records => {
      const els = new Set(), again = [];
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1) { if (n.isConnected !== false) { collect(n, els); if (sized) sized.add(n); } }
            else if (n.nodeType === 3 && r.target.nodeType === 1 && ownsWords(r.target) && !hidden(r.target)) els.add(r.target);
          }
          if (sized) for (const n of r.removedNodes) if (n.nodeType === 1) sized.drop(n);
        } else if (r.type === 'attributes' && r.target.nodeType === 1 && (r.target.hasAttribute(ATTR) || r.target.hasAttribute(CAPS) || r.target.hasAttribute(CUT))) again.push(r.target);
      }
      for (const t of again) { t.removeAttribute(ATTR); t.removeAttribute(CAPS); t.removeAttribute(CUT); els.add(t); }
      if (els.size) measure(els, w);
    });
    mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return mo;
  }
  // the windows (.term) under a subtree, each re-read once its size settles
  function watchSizes(w) {
    const timers = new Map();
    const ro = new w.ResizeObserver(entries => {
      for (const e of entries) {
        const t = e.target;
        w.clearTimeout(timers.get(t));
        timers.set(t, w.setTimeout(() => { timers.delete(t); if (t.isConnected) refloor(t, w); }, 150));
      }
    });
    const terms = n => (n.classList && n.classList.contains('term') ? [n] : []).concat(typeof n.querySelectorAll === 'function' ? Array.from(n.querySelectorAll('.term')) : []);
    return {
      add: n => { for (const t of terms(n)) ro.observe(t); },
      drop: n => { for (const t of terms(n)) { ro.unobserve(t); w.clearTimeout(timers.get(t)); timers.delete(t); } }
    };
  }

  /* Where the floor holds (Andrew 10-20, after the windows: "run the same audits over … BUILD MODE, onboarding, toasts and
     tooltips … then fix what they find"): the station windows (#terms), the first-run screens and the dock coach — all in
     the page from the start — and BUILD MODE and the workflow panel, which mount on the body when they open. The
     dashboard rails and COMMS keep their own tuned scale (pipglass.css). */
  const HOSTS = ['#terms', '#screen-splash', '#screen-connect', '#nav-coach'];
  const LATE_HOSTS = /(^|\s)(refit-overlay|wf-panel)(\s|$)/;
  function startAll(doc, view) {
    const w = viewOf(view), watched = new WeakSet();   // a closed BUILD MODE overlay is let go
    const take = el => { if (el && !watched.has(el)) { watched.add(el); watch(el, w); } };
    for (const sel of HOSTS) take(doc.querySelector(sel));
    for (const el of doc.body.children) if (LATE_HOSTS.test(String(el.className || ''))) take(el);
    if (typeof w.MutationObserver !== 'function') return;
    new w.MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && LATE_HOSTS.test(String(n.className || ''))) take(n);
    }).observe(doc.body, { childList: true });
  }

  // Self-start in the browser
  if (typeof document !== 'undefined') {
    const start = () => startAll(document);
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  return { pass, refloor, watch, startAll, ownsWords, ATTR, CAPS, CUT, HOSTS };
});
