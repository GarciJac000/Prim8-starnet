#!/usr/bin/env node
/* dev/summon-lines-styles.mjs — the SAME frame in every activity-plate style, side by side, at Andrew's real look.
 * Seeded station, desks spread, crew recruited through the real path (App.summonAgent), then one scripted delegation
 * through the bus seam the floor listens to (no model runs). Each style (window.__plateStyle 0..3) is shot as a
 * room crop of the identical moment.   node dev/summon-lines-styles.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const PORT = '9552', CDP_PORT = 9553, URL = `http://127.0.0.1:${PORT}/`;
const OUT = join(process.cwd(), 'dev', '.shots-summon-styles');
const CREW = [
  { name: 'Researcher', agentName: 'VEGA', skin: 'astronaut', task: 'Search the web for the current monthly price of Linear Standard and Notion Plus', tool: ['web_fetch', '{"url":"https://linear.app/pricing"}'] },
  { name: 'Writer', agentName: 'QUILL', skin: 'secretagent', task: 'Write a 3-line tagline for a SaaS pricing page and save it', tool: ['fs_write', '{"path":"notes/tagline.md"}'] },
  { name: 'Engineer', agentName: 'BOLT', skin: 'robot', task: 'Build pricing.html with three plan cards: Free, Pro, Team', tool: ['fs_write', '{"path":"pricing.html"}'] },
];
const DESKS = [[2, 5], [14, 5], [8, 8]];

const scratch = mkdtempSync(join(tmpdir(), 'plstyles-'));
materializeSeedWorkspace(join(scratch, 'ws'));
const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws') });
let chrome = null;
try {
  if (!(await waitUp(URL))) throw new Error('no sidecar');
  chrome = launchChrome({ cdpPort: CDP_PORT, profileDir: join(scratch, 'c'), win: '1920,1080' });
  await sleep(1200);
  const cdp = await connectCDP(CDP_PORT); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const diag = collectDiagnostics(cdp);
  await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
  if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('no game screen');
  await evalJS(cdp, `(() => { localStorage.setItem('starnet.crewrail.w', '400'); localStorage.setItem('starnet.crewrail.rows', '2'); localStorage.setItem('starnet.chatw', '767'); location.reload(); return 1; })()`);
  await sleep(1500);
  if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('no game screen after reload');
  await evalJS(cdp, `StationUI.setLook({ theme: 'custom', themeHue: 216, themeSat: 100, themeGlow: 20, panelBright: -100, flicker: false, textScale: 90 })`);
  await sleep(1500);
  const ids = await evalJS(cdp, `(() => {
    const st = Build.__test__.station();
    for (const [x, y] of ${JSON.stringify(DESKS)}) st.addProp({ t: 'desk', x, y, w: 2, h: 1 });
    return ${JSON.stringify(CREW)}.map(s => { const a = App.summonAgent(s, { activate: false, desk: true }); return a && a.id; });
  })()`);
  await sleep(5000);
  // one delegation through the real bus seam: lead dispatch window → worker runs → their briefs, tools and costs
  await evalJS(cdp, `(() => {
    const crew = ${JSON.stringify(CREW)}, ids = ${JSON.stringify(ids)}, E = (n, p) => U.bus.emit(n, p);
    E('agent.run.start', { agentId: 'agent', runId: 'r-lead', trigger: 'directive', model: 'anthropic/claude-sonnet-4.6' });
    E('taskbrief.settled', { agentId: 'agent', runId: 'r-lead', objective: 'Split the pricing page launch across VEGA, QUILL and BOLT' });
    E('agent.tool_call', { agentId: 'agent', runId: 'r-lead', callId: 'd1', name: 'team_dispatch', argsSummary: '{}' });
    ids.forEach((id, i) => {
      E('agent.run.start', { agentId: id, runId: 'r' + i, trigger: 'directive', model: 'anthropic/claude-haiku-4.5' });
      E('taskbrief.settled', { agentId: id, runId: 'r' + i, objective: crew[i].task });
      E('agent.tool_call', { agentId: id, runId: 'r' + i, callId: 't' + i, name: crew[i].tool[0], argsSummary: crew[i].tool[1] });
      E('cost.estimate', { agentId: id, runId: 'r' + i, usd: 0.012 + i * 0.009, tokens: 4000 });
    });
    E('cost.estimate', { agentId: 'agent', runId: 'r-lead', usd: 0.14, tokens: 20000 });
    if (World.setCinecamIdle) World.setCinecamIdle(1e9);
    return true;
  })()`);
  await sleep(6000);   // workers walk to their desks, links grow
  mkdirSync(OUT, { recursive: true });
  for (const st of [9]) {   // one shot: the style knob is gone (Andrew picked IDENTITY)
    await evalJS(cdp, `window.__plateStyle = ${st}`);
    await sleep(700);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 478, y: 300, width: 604, height: 420, scale: 2 } });
    writeFileSync(join(OUT, 'style-' + st + '.png'), Buffer.from(r.data, 'base64'));
    const full = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'style-' + st + '-full.png'), Buffer.from(full.data, 'base64'));
    console.log('shot style', st);
  }
  console.log('diag', JSON.stringify({ exceptions: diag.exceptions.slice(0, 3) }));
} finally { try { chrome && chrome.proc.kill(); } catch (e) { console.error(e.message); } try { side.kill(); } catch (e) { console.error(e.message); } }
