/* node test/no-smooth-infinite-animation.test.js — v0.14.0 perf: every forever-looping animation in frontend/ is STEPPED.

   Measured on Andrew's installed app (2026-10-22): pausing just five forever-looping SMOOTH CSS animations (the three
   `.ws-dot.failed` gd-session-failure pulses, the `span.prompt` caret pulse and the `bb-grp.dock-glow` dockGlowPulse)
   took the whole app from 165% to 55% of a CPU core (GPU process 98% -> 27%, renderer 65% -> 27%). A smooth
   (ease / linear / cubic-bezier / no timing = ease) infinite animation gives Chromium/WebView2 a new value on EVERY
   vsync (240 Hz on his panel), so the window is recomposited 240x a second all day, and every recomposite re-applies
   the frosted-glass backdrop-filter on the big panels. A `steps()` animation only changes when a step changes.

   The law this file locks: an animation that loops forever (CSS `infinite`, or a JS `animate()` with
   `iterations: Infinity`) carries a STEPPED timing function — `steps(...)`, `step-start` or `step-end` — and no
   per-keyframe `animation-timing-function` sneaks a smooth curve back in. One-shot animations are untouched (they
   end). A failure names the file:line.

   Scanned: every *.css under frontend/, every <style> block and style="" attribute in frontend/ HTML, and every
   frontend/ JS file (CSS injected from strings, `el.style.animation = ...`, and `.animate(..., { iterations: Infinity })`).

   ALLOW-LIST: an entry here is a deliberate, reviewed exception that truly must stay smooth. Keep it empty unless
   there is no stepped alternative; every entry needs a comment saying why. Key = 'path/from/repo:animation-name'. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const FRONTEND = path.join(root, 'frontend');

const ALLOW = new Map([
  // (none) — e.g. ['frontend/css/x.css:some-anim', 'why it cannot be stepped'],
]);

/* ---------------------------------------------------------------------------------------------------------------
   scanner (pure: source text in, findings out) */
const STEPPED = /^(steps\([^)]*\)|step-start|step-end)$/i;

// comments and string contents -> spaces (newlines kept) so offsets and line numbers stay true
function maskCss(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2), stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const close = src[j] === c ? 1 : 0;
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + (close ? c : ''); i = j + close; continue;
    }
    out += c; i++;
  }
  return out;
}

// split on a separator at paren depth 0 ('a b(c, d)' -> tokens / layers)
function splitTop(value, sepRe) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && sepRe.test(ch)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const tokensOf = layer => splitTop(layer, /\s/).filter(t => t !== '!important');
const NON_NAME = /^(infinite|none|normal|reverse|alternate|alternate-reverse|forwards|backwards|both|running|paused|ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|initial|inherit|unset|revert|!important)$/i;
const nameOf = toks => toks.find(t => !NON_NAME.test(t) && !/^[-+.\d]/.test(t) && !/\(/.test(t)) || '';

// 1-based line of an offset: newline offsets of the last source seen are cached, then a binary search
function lineOf(src, idx) {
  if (lineOf.lastSrc !== src) {
    const nl = []; for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) nl.push(i);
    lineOf.lastSrc = src; lineOf.nl = nl;
  }
  const nl = lineOf.nl; let lo = 0, hi = nl.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < idx) lo = mid + 1; else hi = mid; }
  return lo + 1;
}

/* CSS: walk the blocks, keep each block's declarations in order, judge the cascade inside one block */
function scanCss(src, file, lineBase = 0) {
  const s = maskCss(src), findings = [], loops = [];
  const blocks = [], stack = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const b = { prelude: s.slice(start, i).trim(), decls: [], parent: stack[stack.length - 1] || null };
      blocks.push(b); stack.push(b); start = i + 1;
    } else if (c === ';' || c === '}' || i === s.length) {
      const text = s.slice(start, i), top = stack[stack.length - 1];
      const m = /^\s*([-\w]+)\s*:([\s\S]*)$/.exec(text);
      if (top && m) top.decls.push({ prop: m[1].toLowerCase(), value: m[2].trim(), line: lineBase + lineOf(s, start + text.search(/\S/)) });
      if (c === '}') stack.pop();
      start = i + 1;
    }
  }
  const keyframesOf = b => { for (let p = b.parent; p; p = p.parent) if (/^@(-webkit-)?keyframes\b/i.test(p.prelude)) return p; return null; };
  // per-keyframe smooth timing overrides the animation's own timing for that segment
  const smoothKeyframes = new Map();
  for (const b of blocks) {
    const kf = keyframesOf(b);
    if (!kf) continue;
    for (const d of b.decls) {
      if (d.prop === 'animation-timing-function' && !splitTop(d.value, /,/).every(v => STEPPED.test(v.replace(/\s*!important$/, '')))) {
        smoothKeyframes.set(kf.prelude.replace(/^@(-webkit-)?keyframes\s+/i, '').trim(), d.line);
      }
    }
  }
  for (const b of blocks) {
    if (keyframesOf(b) || /^@(-webkit-)?keyframes\b/i.test(b.prelude)) continue;
    let short = null, timing = null, iter = null;
    for (const d of b.decls) {
      if (d.prop === 'animation') { short = d; timing = null; iter = null; }   // the shorthand resets every longhand
      else if (d.prop === 'animation-timing-function') timing = d;
      else if (d.prop === 'animation-iteration-count') iter = d;
    }
    if (!short && !iter) continue;
    const layers = short ? splitTop(short.value, /,/).map(tokensOf) : [[]];
    layers.forEach((toks, k) => {
      const infinite = iter ? /\binfinite\b/i.test(splitTop(iter.value, /,/)[k] || iter.value) : toks.some(t => /^infinite$/i.test(t));
      if (!infinite) return;
      const name = nameOf(toks);
      const tVal = timing ? (splitTop(timing.value, /,/)[k] || splitTop(timing.value, /,/)[0] || '').replace(/\s*!important$/, '') : null;
      const stepped = timing ? STEPPED.test(tVal) : toks.some(t => STEPPED.test(t));
      const line = (short || iter).line;
      loops.push({ file, line, name, stepped });
      if (!stepped) findings.push({ file, line, name, why: 'loops forever with SMOOTH timing (' + (timing ? tVal : (toks.find(t => /^(ease|ease-in|ease-out|ease-in-out|linear)$|^(cubic-bezier|linear|var)\(/i.test(t)) || 'none given = ease')) + ')' });
      else if (name && smoothKeyframes.has(name)) findings.push({ file, line, name, why: '@keyframes ' + name + ' (line ' + smoothKeyframes.get(name) + ') overrides the steps with a smooth per-keyframe animation-timing-function' });
    });
  }
  return { findings, loops };
}

/* JS / HTML text outside <style>: CSS carried in strings, style.animation assignments, and WAAPI animate() */
function scanLoose(src, file) {
  const findings = [], loops = [];
  const judge = (value, idx) => {
    for (const layer of splitTop(value, /,/)) {
      const toks = tokensOf(layer);
      if (!toks.some(t => /^infinite$/i.test(t))) continue;
      const stepped = toks.some(t => STEPPED.test(t)), name = nameOf(toks), line = lineOf(src, idx);
      loops.push({ file, line, name, stepped });
      if (!stepped) findings.push({ file, line, name, why: 'loops forever with SMOOTH timing (CSS in a string: "' + layer.trim() + '")' });
    }
  };
  let m;
  // CSS text inside a string / template / style="" attribute: animation:<value> up to ; } or a quote
  const cssRe = /(^|[^-\w.])animation\s*:\s*([^;{}'"`\n<>]+)/g;
  while ((m = cssRe.exec(src))) if (!/^['"`]/.test(m[2])) judge(m[2], m.index + m[1].length);
  // el.style.animation = '...'  /  { animation: '...' }
  const propRe = /\banimation\s*[:=]\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
  while ((m = propRe.exec(src))) judge(m[2], m.index);
  // el.style.animationIterationCount = 'infinite' needs a stepped animationTimingFunction beside it
  const iterRe = /\banimationIterationCount\s*[:=]\s*['"`]infinite['"`]/g;
  while ((m = iterRe.exec(src))) {
    const near = src.slice(Math.max(0, m.index - 400), m.index + 400), line = lineOf(src, m.index);
    const stepped = /animationTimingFunction\s*[:=]\s*['"`]\s*(steps\(|step-start|step-end)/.test(near);
    loops.push({ file, line, name: '', stepped });
    if (!stepped) findings.push({ file, line, name: '', why: 'animationIterationCount = infinite without a stepped animationTimingFunction' });
  }
  // WAAPI: el.animate(keyframes, { iterations: Infinity, easing: 'steps(...)' })
  const animRe = /\.animate\s*\(/g;
  while ((m = animRe.exec(src))) {
    let depth = 1, j = m.index + m[0].length;
    while (j < src.length && depth) { const c = src[j]; if (c === '(') depth++; else if (c === ')') depth--; j++; }
    const args = src.slice(m.index, j);
    if (!/\biterations\s*:\s*(Infinity|Number\.POSITIVE_INFINITY)\b/.test(args)) continue;
    const line = lineOf(src, m.index);
    const stepped = /\beasing\s*:\s*['"`]\s*(steps\(|step-start|step-end)/.test(args) && !/\beasing\s*:\s*['"`]\s*(?!steps\(|step-start|step-end)[\w-]/.test(args);
    loops.push({ file, line, name: 'animate()', stepped });
    if (!stepped) findings.push({ file, line, name: 'animate()', why: 'animate() with iterations: Infinity and no stepped easing (every easing in the call must be steps()/step-start/step-end)' });
  }
  return { findings, loops };
}

function scanHtml(src, file) {
  const findings = [], loops = [];
  const add = r => { findings.push(...r.findings); loops.push(...r.loops); };
  let rest = src, m;
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleRe.exec(src))) {
    const bodyAt = m.index + m[0].indexOf('>') + 1;
    add(scanCss(m[1], file, lineOf(src, bodyAt) - 1));
    rest = rest.slice(0, m.index) + m[0].replace(/[^\n]/g, ' ') + rest.slice(m.index + m[0].length);   // same length: lines stay true
  }
  add(scanLoose(rest, file));
  return { findings, loops };
}

function scanFile(abs) {
  const file = path.relative(root, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  if (/\.css$/i.test(abs)) return scanCss(src, file);
  if (/\.html?$/i.test(abs)) return scanHtml(src, file);
  return scanLoose(src, file);
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (/\.(css|html?|m?js)$/i.test(ent.name)) out.push(abs);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------------------------
   1. the scanner itself catches what it must (so an empty result below is a real result, not a blind one) */
{
  const bad = s => scanCss(s, 'fixture.css').findings.length;
  A.eq(bad('.a { animation: p 1s ease-in-out infinite; }'), 1, 'scanner: ease-in-out infinite is flagged');
  A.eq(bad('.a { animation: p 1.3s infinite; }'), 1, 'scanner: no timing function (= ease) infinite is flagged');
  A.eq(bad('.a { animation: p 9s linear infinite; }'), 1, 'scanner: linear infinite is flagged');
  A.eq(bad('.a { animation: p 1s var(--ease-soft) infinite; }'), 1, 'scanner: a var() timing is not proof of steps');
  A.eq(bad('.a { animation: p 1s cubic-bezier(.2, 0, 0, 1) infinite; }'), 1, 'scanner: cubic-bezier infinite is flagged');
  A.eq(bad('.a { animation: p 1s steps(8, jump-none) infinite; }'), 0, 'scanner: steps(N, jump-none) infinite passes');
  A.eq(bad('.a { animation: p 1s step-end infinite; } .b { animation: q 1s step-start infinite; }'), 0, 'scanner: step-start / step-end pass');
  A.eq(bad('.a { animation: p 1s ease-in-out 1 forwards; }'), 0, 'scanner: a one-shot stays smooth');
  A.eq(bad('.a { animation: p 1s ease infinite; animation-timing-function: steps(4); }'), 0, 'scanner: a later longhand timing wins');
  A.eq(bad('.a { animation-timing-function: steps(4); animation: p 1s ease infinite; }'), 1, 'scanner: the shorthand resets an earlier longhand');
  A.eq(bad('.a { animation: p 1s steps(4) 1; animation-iteration-count: infinite; }'), 0, 'scanner: longhand infinite on a stepped shorthand passes');
  A.eq(bad('.a { animation-name: p; animation-iteration-count: infinite; }'), 1, 'scanner: longhand infinite with no timing (= ease) is flagged');
  A.eq(bad('.a { animation: p 1s steps(4) infinite, q 2s ease infinite; }'), 1, 'scanner: every layer of a multi-animation is judged');
  A.eq(bad('@media (x) { .a { animation: p 1s ease infinite; } }'), 1, 'scanner: rules inside @media are scanned');
  A.eq(bad('/* animation: p 1s ease infinite; */ .a { content: "animation: p 1s ease infinite;"; }'), 0, 'scanner: comments and strings are not rules');
  A.eq(bad('@keyframes p { 0% { opacity: 1; animation-timing-function: ease-in; } 100% { opacity: 0; } } .a { animation: p 1s steps(6, jump-none) infinite; }'), 1,
    'scanner: a smooth per-keyframe animation-timing-function on a looping animation is flagged');
  A.eq(bad('@keyframes p { 0% { opacity: 1; } 100% { opacity: 0; } } .a { animation: p 1s steps(6, jump-none) infinite; }'), 0, 'scanner: plain keyframes are fine');
  A.eq(scanCss('.a {\n  color: red;\n  animation: p 1s infinite;\n}', 'f.css').findings[0].line, 3, 'scanner: findings name the right line');
  const loose = s => scanLoose(s, 'fixture.js').findings.length;
  A.eq(loose("const css = `.x{animation:1s steps(1) infinite comms-blink}`;"), 0, 'scanner: stepped CSS in a JS template passes');
  A.eq(loose("const css = `.x{animation:pulse 1s ease-in-out infinite}`;"), 1, 'scanner: smooth CSS in a JS template is flagged');
  A.eq(loose("el.style.animation = 'pulse 1.2s infinite';"), 1, 'scanner: el.style.animation smooth infinite is flagged');
  A.eq(loose("el.animate([{opacity:1},{opacity:0}], { duration: 900, iterations: Infinity });"), 1, 'scanner: animate() Infinity with no easing is flagged');
  A.eq(loose("el.animate([{opacity:1},{opacity:0}], { duration: 900, iterations: Infinity, easing: 'ease-in-out' });"), 1, 'scanner: animate() Infinity with smooth easing is flagged');
  A.eq(loose("el.animate([{opacity:1},{opacity:0}], { duration: 900, iterations: Infinity, easing: 'steps(8, jump-none)' });"), 0, 'scanner: animate() Infinity with steps passes');
  A.eq(loose("el.animate([{opacity:1},{opacity:0}], { duration: 900, easing: 'ease' });"), 0, 'scanner: a one-shot animate() stays smooth');
  A.eq(scanHtml('<p>\n<style>\n.a { animation: p 1s infinite; }\n</style>\n<i style="animation: q 2s linear infinite"></i>', 'f.html').findings.map(f => f.line), [3, 5],
    'scanner: <style> blocks and style="" attributes are scanned with true line numbers');
}

/* ---------------------------------------------------------------------------------------------------------------
   2. the real frontend */
const files = walk(FRONTEND);
A.ok(files.length > 50 && files.some(f => /frontend[\\/]css[\\/]app\.css$/.test(f)), 'the walk found the frontend (css/app.css among ' + files.length + ' files)');
const findings = [], loops = [];
for (const f of files) { const r = scanFile(f); findings.push(...r.findings); loops.push(...r.loops); }
// a broken walk or parser would pass vacuously: there are dozens of status pulses, carets and glows in the app
A.ok(loops.length >= 60, 'the scan saw the app\'s forever-looping animations (' + loops.length + ' found, expected 60+)');
A.ok(loops.some(l => l.file === 'frontend/css/glass-demo.css' && l.name === 'gd-session-failure'), 'the scan reaches the measured gd-session-failure pulse');
A.ok(loops.some(l => l.file === 'frontend/css/style.css' && l.name === 'pulse'), 'the scan reaches the measured span.prompt caret pulse');
A.ok(loops.some(l => l.file === 'frontend/css/tutorial.css' && l.name === 'dockGlowPulse'), 'the scan reaches the measured dockGlowPulse');

const offenders = findings.filter(f => !ALLOW.has(f.file + ':' + f.name));
for (const f of offenders) A.ok(false, f.file + ':' + f.line + '  ' + (f.name || '(unnamed)') + ' ' + f.why + ' — use steps(N, jump-none), step-start or step-end');
A.ok(offenders.length === 0, offenders.length + ' forever-looping animation(s) still smooth (listed above)');
// a stale allow-list entry hides nothing and must go
for (const key of ALLOW.keys()) A.ok(findings.some(f => f.file + ':' + f.name === key), 'allow-list entry ' + key + ' still matches a smooth loop (remove it if not)');

A.report('no-smooth-infinite-animation.test');
