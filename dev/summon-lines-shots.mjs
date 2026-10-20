#!/usr/bin/env node
/* dev/summon-lines-shots.mjs — live look at SUMMON LINES on the real station.
 *
 * Boots a seeded sidecar from THIS worktree, puts six extra crew bodies on the floor, then replays a
 * nested delegation through the REAL bus seam the world listens to (team.dispatch tool_call → worker
 * agent.run.start → tool_result … agent.run.end) and captures the floor as the links grow, live and return.
 * The events are scripted (no model runs), the rendering path is the shipped one.
 *
 *   node dev/summon-lines-shots.mjs        (ports: SKYNET_SHOT_PORT / SKYNET_CDP_PORT)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const PORT = process.env.SKYNET_SHOT_PORT || '9512';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9513);
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.SKYNET_SHOT_OUT || join(process.cwd(), 'dev', '.shots-summon-lines');
const LOOK = process.argv.includes('--look');

const CREW = [
  { id: 'researcher', name: 'RESEARCHER', skin: 'astronaut', dx: -5, dy: 2 },
  { id: 'writer', name: 'WRITER', skin: 'secretagent', dx: 0, dy: 3 },
  { id: 'coder', name: 'CODER', skin: 'robot', dx: 5, dy: 2 },
  { id: 'scraper', name: 'SCRAPER', skin: 'crewmate', dx: -8, dy: 6 },
  { id: 'analyst', name: 'ANALYST', skin: 'plaguedoctor', dx: -3, dy: 6 },
  { id: 'tester', name: 'TESTER', skin: 'skeleton', dx: 5, dy: 6 },
];

// the delegation, as the bus would carry it: [ms offset, event, payload]
const LEAD = '__hero__';
const SCRIPT = [
  [0, 'agent.tool_call', { agentId: LEAD, name: 'team.dispatch', callId: 'd1' }],
  [100, 'agent.run.start', { agentId: 'researcher', runId: 'r-res', trigger: 'directive', model: 'claude-sonnet-4-5' }],
  [700, 'agent.run.start', { agentId: 'writer', runId: 'r-wri', trigger: 'directive', model: 'claude-sonnet-4-5' }],
  [1300, 'agent.run.start', { agentId: 'coder', runId: 'r-cod', trigger: 'directive', model: 'gpt-5.1' }],
  [1500, 'agent.tool_result', { agentId: LEAD, callId: 'd1' }],
  [3200, 'agent.tool_call', { agentId: 'researcher', name: 'team.dispatch', callId: 'd2' }],
  [3300, 'agent.run.start', { agentId: 'scraper', runId: 'r-scr', trigger: 'directive', model: 'claude-haiku-4-5' }],
  [3900, 'agent.run.start', { agentId: 'analyst', runId: 'r-ana', trigger: 'directive', model: 'claude-sonnet-4-5' }],
  [4100, 'agent.tool_result', { agentId: 'researcher', callId: 'd2' }],
  [4600, 'agent.tool_call', { agentId: 'coder', name: 'team.dispatch', callId: 'd3' }],
  [4700, 'agent.run.start', { agentId: 'tester', runId: 'r-tes', trigger: 'directive', model: 'claude-haiku-4-5' }],
  [4900, 'agent.tool_result', { agentId: 'coder', callId: 'd3' }],
  // what each run is doing (the ACTIVITY PLATES read these): tool calls with their real argsSummary shape, then costs
  [5200, 'agent.tool_call', { agentId: 'researcher', runId: 'r-res', callId: 't1', name: 'web_search', argsSummary: '{"query":"saas pricing pages 2026"}' }],
  [5300, 'agent.tool_call', { agentId: 'writer', runId: 'r-wri', callId: 't2', name: 'fs_read', argsSummary: '{"path":"brand/voice-guide.md"}' }],
  [5400, 'agent.tool_call', { agentId: 'coder', runId: 'r-cod', callId: 't3', name: 'fs_write', argsSummary: '{"path":"src/pages/pricing.tsx","content":"export default'}],
  [5500, 'agent.tool_call', { agentId: 'scraper', runId: 'r-scr', callId: 't4', name: 'web_fetch', argsSummary: '{"url":"https://linear.app/pricing"}' }],
  [5600, 'agent.tool_call', { agentId: 'analyst', runId: 'r-ana', callId: 't5', name: 'fs_read', argsSummary: '{"path":"notes/scrape.md"}' }],
  [5700, 'agent.tool_call', { agentId: 'tester', runId: 'r-tes', callId: 't6', name: 'browser_open', argsSummary: '{"url":"http://localhost:3000/pricing"}' }],
  [5800, 'agent.tool_call', { agentId: LEAD, runId: 'r-lead', callId: 't0', name: 'team_status', argsSummary: '{}' }],
  [6200, 'agent.tool_result', { agentId: 'writer', runId: 'r-wri', callId: 't2', ok: true, isError: false }],
  [6300, 'cost.estimate', { agentId: 'researcher', runId: 'r-res', usd: 0.031, tokens: 9100 }],
  [6300, 'cost.estimate', { agentId: 'writer', runId: 'r-wri', usd: 0.018, tokens: 5200 }],
  [6300, 'cost.estimate', { agentId: 'coder', runId: 'r-cod', usd: 0.044, tokens: 12000 }],
  [6300, 'cost.estimate', { agentId: 'scraper', runId: 'r-scr', usd: 0.004, tokens: 3100 }],
  [6300, 'cost.estimate', { agentId: 'tester', runId: 'r-tes', usd: 0.006, tokens: 2400 }],
  [9000, 'agent.run.end', { agentId: 'scraper', runId: 'r-scr', reason: 'done' }],
  [11000, 'agent.run.end', { agentId: 'tester', runId: 'r-tes', reason: 'done' }],
];

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'summonlines-'));
  materializeSeedWorkspace(join(scratch, 'ws'));
  const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws') });
  let chrome = null, cdp = null;
  try {
    if (!(await waitUp(URL))) throw new Error('sidecar never came up on ' + URL);
    chrome = launchChrome({ cdpPort: CDP_PORT, profileDir: join(scratch, 'chrome'), win: '1440,900' });
    await sleep(1200);
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Runtime.enable');
    const diag = collectDiagnostics(cdp);
    await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never reached the game screen');
    await sleep(2500);
    mkdirSync(OUT, { recursive: true });

    const hero = await evalJS(cdp, `(() => { const h = World.bodies().find(b => b.hero); return h; })()`);
    console.log('hero', JSON.stringify({ id: hero && hero.id, tile: hero && hero.tile, px: hero && hero.px, py: hero && hero.py }));
    const placed = await evalJS(cdp, `(() => {
      const crew = ${JSON.stringify(CREW)}; const h = World.bodies().find(b => b.hero);
      for (const c of crew) World.spawnAgent({ id: c.id, name: c.name, skin: c.skin });
      const out = [];
      // walk each to its spot, or the nearest walkable tile to it (ring search)
      for (const c of crew) {
        let ok = false;
        for (let r = 0; r <= 3 && !ok; r++) for (let ox = -r; ox <= r && !ok; ox++) for (let oy = -r; oy <= r && !ok; oy++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          if (World._dbgReviewWalk(c.id, h.tile.x + c.dx + ox, h.tile.y + c.dy + oy)) ok = [h.tile.x + c.dx + ox, h.tile.y + c.dy + oy];
        }
        out.push([c.id, ok]);
      }
      if (World.setCinecamIdle) World.setCinecamIdle(false);   // pin the camera: an idle cinecam drifts between shots
      return out;
    })()`);
    console.log('placed', JSON.stringify(placed));
    await sleep(6000);   // let them walk to their spots
    console.log('bodies', JSON.stringify(await evalJS(cdp, `World.bodies().map(b => [b.name, b.tile && b.tile.x, b.tile && b.tile.y, b.moving])`)));
    await capture(cdp, OUT, '0-crew');
    if (LOOK) return;

    const heroId = hero.id;
    const script = JSON.stringify(SCRIPT).split(JSON.stringify(LEAD)).join(JSON.stringify(heroId));
    await evalJS(cdp, `(() => { for (const [ms, ev, p] of ${script}) setTimeout(() => U.bus.emit(ev, p), ms); return true; })()`);
    const start = Date.now();
    for (const [ms, name] of [[1100, '1-summon-pulse'], [2600, '2-three-summoned'], [5600, '3-nested'], [7600, '4-all-live'], [9500, '5-result-home'], [13500, '6-after']]) {
      await sleep(Math.max(0, ms - (Date.now() - start)));
      console.log(name, JSON.stringify(await capture(cdp, OUT, name)));
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 222, y: 250, width: 676, height: 470, scale: 2 } });
      writeFileSync(join(OUT, name + '-zoom.png'), Buffer.from(r.data, 'base64'));
    }
    console.log('diag', JSON.stringify({ exceptions: diag.exceptions.slice(0, 5), console: diag.consoleMsgs.filter(m => m.type === 'error').slice(0, 5) }));
  } finally {
    try { if (chrome) chrome.proc.kill(); } catch (e) { console.error(e.message); }
    try { side.kill(); } catch (e) { console.error(e.message); }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
