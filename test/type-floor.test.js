'use strict';
/* node test/type-floor.test.js — the station windows' text floor (Andrew 10-19: "make sure the text isnt too small
   everywhere", then "give the windows the same text floor and spacing too").
   GENUINE (executed): the real typefloor.js runs over a small fake DOM whose computed styles are set per element: text
   measured under the floor (the --sn-type-meta token in force) is marked and nothing else is — text at or over the floor
   is never marked (so never made smaller), an icon glyph alone, anything aria-hidden and a checkbox keep their own
   metrics; a caps label at the floor's size is marked a label (tracked 1.6) and a caps key a key (tracked .9), a bigger
   caps title keeps its own tracking; reads all happen before any write; a re-classed element is measured again.
   A text an ellipsis or a line clamp cuts is marked to fade; a window is read again after it resizes.
   SOURCE-LOCKED: pipglass.css sets marked text to the token and the two trackings, only inside the windows (#terms),
   raises the tokens there, and the page loads the module. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

global.document = undefined;   // the module self-starts only in a browser
const TF = require('../frontend/app/typefloor.js');

/* ---- a fake DOM: elements with tag, class, attributes, text children; getComputedStyle reads a per-element style ---- */
let reads = 0, writesBeforeLastRead = 0, writes = 0;
function el(tag, opts = {}, kids = []) {
  const attrs = Object.assign({}, opts.attrs || {});
  const node = { nodeType: 1, tagName: tag, className: opts.cls || '', style: opts.style || {}, childNodes: [], parent: null, isConnected: true,
    getAttribute: k => (k in attrs ? attrs[k] : null), hasAttribute: k => k in attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); writes++; }, removeAttribute: k => { delete attrs[k]; },
    classList: { contains: c => (' ' + (opts.cls || '') + ' ').includes(' ' + c + ' ') },
    closest(sel) { const m = /^\[aria-hidden="true"\]$/.exec(sel); for (let n = node; n; n = n.parent) if (m && n.getAttribute && n.getAttribute('aria-hidden') === 'true') return n; return null; },
    // '*', '.class', or a list of '[attr]' (what typefloor.js asks for)
    querySelectorAll(sel) {
      const out = []; const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); walk(c); } }; walk(node);
      if (sel === '*') return out;
      if (sel[0] === '.') return out.filter(c => c.classList.contains(sel.slice(1)));
      const names = sel.split(',').map(s => s.replace(/[[\]]/g, '').trim());
      return out.filter(c => names.some(k => c.hasAttribute(k)));
    },
    attrs };
  if (!node.style.setProperty) node.style.setProperty = (k, v) => { node.style[k] = v; };
  Object.defineProperty(node, 'children', { get: () => node.childNodes.filter(c => c.nodeType === 1) });
  for (const k of kids) { const c = typeof k === 'string' ? { nodeType: 3, textContent: k } : k; c.parent = node; node.childNodes.push(c); }
  return node;
}
const view = {
  getComputedStyle(n) { reads++; if (writes) writesBeforeLastRead = writes; const s = n.style; return { fontSize: (s.size || 16) + 'px', textTransform: s.caps ? 'uppercase' : 'none',
    webkitLineClamp: s.clamp ? String(s.clamp) : 'none', textOverflow: s.ell ? 'ellipsis' : 'clip', overflowX: s.ox || 'visible', overflowY: s.oy || s.ox || 'visible',
    getPropertyValue: k => (k === '--sn-type-meta' ? (s.floor || 16) + 'px' : '') }; },
  MutationObserver: null
};

/* ---- 1. the floor: under it lifted, at or over it never touched ---- */
const small = el('SPAN', { cls: 'cc-badge', style: { size: 12 } }, ['✓ official']);
const atFloor = el('SPAN', { cls: 'dim', style: { size: 16 } }, ['31m ago']);
const big = el('B', { style: { size: 18 } }, ['NO MEMORIES YET']);
const icon = el('BUTTON', { cls: 'x', style: { size: 11 } }, ['✕']);
const hiddenBox = el('DIV', { attrs: { 'aria-hidden': 'true' } }, [el('SPAN', { style: { size: 10 } }, ['decorative 2'])]);
const check = el('INPUT', { attrs: { type: 'checkbox' }, style: { size: 13.3 } });
const field = el('INPUT', { attrs: { type: 'text' }, style: { size: 13 } });
const wrapperOnly = el('DIV', { style: { size: 11 } }, [el('SPAN', { style: { size: 18 } }, ['Title'])]);
const capsLabel = el('SPAN', { cls: 'gx-lbl', style: { size: 14, caps: true } }, ['This level']);
const capsKey = el('BUTTON', { cls: 'sk-expand', style: { size: 14, caps: true } }, ['Read instructions']);
const capsPill = el('SPAN', { cls: 'dlv-pill ok', style: { size: 14, caps: true } }, ['DONE']);
const capsTitle = el('H4', { cls: 'ms-h', style: { size: 19, caps: true } }, ['API KEYS']);
const root = el('DIV', { cls: 'term', style: { size: 16 } }, [small, atFloor, big, icon, hiddenBox, check, field, wrapperOnly, capsLabel, capsKey, capsPill, capsTitle]);
reads = 0; writes = 0; writesBeforeLastRead = 0;
const n = TF.pass(root, view);
const marked = x => x.hasAttribute(TF.ATTR);
A.ok(marked(small) && marked(field) && marked(capsLabel) && marked(capsKey) && marked(capsPill), 'text measured under the floor is lifted (a badge, a text field, caps labels and keys)');
A.ok(!marked(atFloor) && !marked(big) && !marked(capsTitle), 'text at or over the floor is never marked, so never made smaller');
A.ok(!marked(icon) && !marked(hiddenBox.childNodes[0]) && !marked(check), 'an icon glyph alone, aria-hidden text and a checkbox keep their own metrics');
A.ok(!marked(wrapperOnly) && !marked(wrapperOnly.childNodes[0]), 'an element that only wraps another element\'s words is not itself lifted');
A.eq(n, 5, 'five lifted');
A.eq(writesBeforeLastRead, 0, 'every read happens before any write: one style recalculation per pass');
A.eq([capsLabel, capsKey, capsPill, capsTitle, big].map(x => x.getAttribute(TF.CAPS)), ['label', 'key', 'key', null, null],
  'a caps label at the floor is a label (tracked 1.6), a caps button or pill a key (tracked .9), a bigger caps title keeps its own tracking');
A.eq(TF.pass(root, view), 0, 'a second pass over the same text marks nothing new');

/* ---- 2. the observer: added content is measured, a re-classed element is measured again without its mark ---- */
{
  let cb = null;
  view.MutationObserver = function (fn) { cb = fn; this.observe = () => {}; };
  const host = el('DIV', { style: { size: 16 } }, []);
  TF.watch(host, view);
  const added = el('P', { cls: 'cd-sub', style: { size: 13 } }, ['general']);
  host.childNodes.push(added); added.parent = host;
  cb([{ type: 'childList', addedNodes: [added], target: host }]);
  A.ok(marked(added), 'content added to a window is measured and lifted');
  added.style.size = 19; added.attrs[TF.ATTR] = '';
  cb([{ type: 'attributes', target: added }]);
  A.ok(!marked(added), 'a re-classed element is measured again without its mark: a state that grows it is never held at the floor');
}

/* ---- 3. cut text: a clamp on a clipping box and a one-line ellipsis are marked to fade; nothing else is ---- */
{
  const clamp = el('DIV', { cls: 'cc-blurb', style: { size: 16, clamp: 4, ox: 'hidden' } }, ['Work through the review comments on a pull request']);
  const line = el('P', { cls: 'ds-job', style: { size: 16, ell: true, ox: 'hidden' } }, ['Last job: Write the opportunity brief']);
  const loose = el('DIV', { style: { size: 16, clamp: 2 } }, ['a clamp with nothing clipping it cuts nothing']);
  const plain = el('P', { style: { size: 16, ox: 'hidden' } }, ['clipped, no ellipsis']);
  TF.pass(el('DIV', { style: { size: 16 } }, [clamp, line, loose, plain]), view);
  A.eq([clamp, line, loose, plain].map(x => x.getAttribute(TF.CUT)), ['clamp', 'line', null, null], 'a clamp on a clipping box and a one-line ellipsis are marked to fade; nothing else is');
  A.eq(clamp.style['--sn-clamp'], '4', 'a clamp carries its own line count to the fade (--sn-clamp)');
}

/* ---- 4. a window read again after a resize: its own narrow rules can shrink a text, or grow a lifted one ---- */
{
  const shrinks = el('SPAN', { style: { size: 16 } }, ['GIVE A JOB']);        // at the floor until a narrow rule takes it to 14
  const grows = el('SPAN', { style: { size: 13 } }, ['3 of 9 topics']);       // lifted, then a wide rule takes it to 18
  const term = el('DIV', { cls: 'term', style: { size: 16 } }, [shrinks, grows]);
  TF.pass(term, view);
  A.ok(!marked(shrinks) && marked(grows), 'first read: at the floor untouched, under it lifted');
  shrinks.style.size = 14; grows.style.size = 18;
  TF.refloor(term, view);
  A.ok(marked(shrinks) && !marked(grows), 'read again: the text a narrow rule shrank is lifted, the one a rule grew is let go');
  // the observer re-reads a window 150ms after its last resize, and stops watching a window that closes
  let roCb = null; const observed = new Set(); const timers = [];
  const v2 = Object.assign({}, view, {
    MutationObserver: function () { this.observe = () => {}; },
    ResizeObserver: function (fn) { roCb = fn; this.observe = t => observed.add(t); this.unobserve = t => observed.delete(t); },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: () => {}
  });
  const host = el('DIV', { style: { size: 16 } }, [term]);
  TF.watch(host, v2);
  A.ok(observed.has(term), 'every window under #terms is watched for its size');
  shrinks.style.size = 13; delete shrinks.attrs[TF.ATTR];
  roCb([{ target: term }]);
  A.eq(timers.length && timers[timers.length - 1][1], 150, 'a resize schedules one read 150ms after it settles');
  timers[timers.length - 1][0]();
  A.ok(marked(shrinks), 'that read lifts what the new size shrank');
}

/* ---- 5. beyond the windows: the first-run screens and the coach from the start, BUILD MODE when it mounts ---- */
{
  A.ok(['#terms', '#screen-splash', '#screen-connect', '#nav-coach'].every(h => TF.HOSTS.includes(h)), 'the floor holds in the windows, the first-run screens and the dock coach');
  let bodyCb = null;
  const v3 = Object.assign({}, view, { MutationObserver: function (fn) { if (!bodyCb) bodyCb = fn; this.observe = () => {}; } });
  const screen = el('DIV', { attrs: { id: 'screen-connect' }, style: { size: 16 } }, [el('P', { cls: 'ov-help', style: { size: 13 } }, ['Leave blank and we will choose a codename.'])]);
  const body = el('BODY', { style: { size: 16 } }, []);
  const doc = { querySelector: sel => (sel === '#screen-connect' ? screen : null), body };
  TF.startAll(doc, v3);
  A.ok(marked(screen.childNodes[0]), 'a first-run screen\'s 13px help line is lifted at start');
  const overlay = el('DIV', { cls: 'refit-overlay', style: { size: 16 } }, [el('SPAN', { cls: 'refit-matname', style: { size: 12 } }, ['TERRAZZO'])]);
  body.childNodes.push(overlay); overlay.parent = body;
  bodyCb([{ type: 'childList', addedNodes: [overlay], target: body }]);
  A.ok(marked(overlay.childNodes[0]), 'BUILD MODE mounting on the body is watched too: its 12px material name is lifted');
}

/* ---- 6. the stylesheet and the page ---- */
const glass = read('frontend/css/pipglass.css');
A.ok(/body\.glass-demo:not\(\.hud-mode\) #terms \{ --sn-type-meta: 16px; --sn-type-compact: 16px; \}/.test(glass), 'the windows raise the reading tokens to the floor (readability.css keeps its bounded defaults)');
A.ok(/body\.glass-demo:not\(\.hud-mode\) #terms \[data-sn-floor\] \{ font-size: var\(--sn-type-meta\) !important; \}/.test(glass), 'a lifted text takes the token, only inside the windows');
A.ok(/#terms \[data-sn-caps="label"\] \{ letter-spacing: 1\.6px !important; \}/.test(glass) && /#terms \[data-sn-caps="key"\] \{ letter-spacing: \.9px !important; \}/.test(glass),
  'window caps labels and keys take the dashboard\'s two trackings');
A.ok(/@supports \(animation-timeline: scroll\(\)\) \{[\s\S]*#terms \[data-sn-cut="line"\][\s\S]*animation-timeline: scroll\(self inline\)[\s\S]*#terms \[data-sn-cut="clamp"\][\s\S]*animation-timeline: scroll\(self block\)/.test(glass),
  'a cut text fades only while it overflows (a scroll-driven animation on its own box), and only where the engine can tell — elsewhere the ellipsis stays');
A.ok(/#terms :is\(\.con-pane, \.term-body:not\(\.term-console-body\)\) \{ container-type: inline-size; \}/.test(glass),
  'each window\'s content pane is a container, so its layouts stack by the window\'s own width');
const html = read('frontend/index.html');
A.ok(html.indexOf('app/typefloor.js') > html.indexOf('app/tooltip.js') && html.indexOf('id="terms"') < html.indexOf('app/typefloor.js'),
  'the page loads the floor after #terms exists, beside the tooltip (both self-start)');
A.report('type-floor.test');
