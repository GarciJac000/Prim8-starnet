#!/usr/bin/env node
// cpuprofile-top.mjs — the functions a .cpuprofile spent its time in: self time and inclusive time, by function @ file:line.
// Usage: node scripts/perf/cpuprofile-top.mjs <file.cpuprofile> [--n 25] [--match substring]
import { readFileSync } from 'node:fs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const p = JSON.parse(readFileSync(process.argv[2], 'utf8')), n = Number(arg('--n', '25')), match = arg('--match', null);
const byId = new Map(p.nodes.map(x => [x.id, x])), parent = new Map();
for (const x of p.nodes) for (const c of x.children || []) parent.set(c, x.id);
const dt = new Map(); // node id → sampled ms
for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) || 0) + (p.timeDeltas[i + 1] || p.timeDeltas[i] || 0) / 1000);
const label = x => { const c = x.callFrame; return (c.functionName || '(anon)') + ' @' + String(c.url).split('/').pop() + ':' + (c.lineNumber + 1); };
const self = new Map(), incl = new Map();
for (const [id, ms] of dt) {
  const x = byId.get(id); self.set(label(x), (self.get(label(x)) || 0) + ms);
  const seen = new Set(); let cur = id;
  while (cur != null) { const l = label(byId.get(cur)); if (!seen.has(l)) { seen.add(l); incl.set(l, (incl.get(l) || 0) + ms); } cur = parent.get(cur); }
}
const total = [...dt.values()].reduce((a, b) => a + b, 0);
const show = (title, m) => { console.log(`\n== ${title} (of ${Math.round(total)} ms sampled)`); [...m].filter(([k]) => !match || k.includes(match)).sort((a, b) => b[1] - a[1]).slice(0, n).forEach(([k, v]) => console.log(String(Math.round(v)).padStart(7) + ' ms  ' + k)); };
show('SELF', self); show('INCLUSIVE', incl);
