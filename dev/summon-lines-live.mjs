#!/usr/bin/env node
/* dev/summon-lines-live.mjs — SUMMON LINES + ACTIVITY PLATES under REAL model runs.
 *
 * Boots a seeded sidecar from THIS worktree with the real OpenRouter key from the trunk's gitignored
 * dev/.env.dev (server-held; never typed into the page), recruits three workers through the real recruit
 * path (App.summonAgent, desk included), sets Andrew's real look (1x DPR, custom hue 216, TEXT SIZE 90,
 * 400px crew rail), then sends NOVA one real COMMS message asking it to delegate. Shots are taken while
 * the delegated runs work; the bus log of what actually fired is printed at the end.
 *
 *   node dev/summon-lines-live.mjs     (ports: SKYNET_SHOT_PORT / SKYNET_CDP_PORT; SL_LEAD_MODEL / SL_WORKER_MODEL)
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const PORT = process.env.SKYNET_SHOT_PORT || '9522';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9523);
const URL = `http://127.0.0.1:${PORT}/`;
const RECORD = process.argv.includes('--record');   // CDP screencast of the real page → OUT/run.mp4 (ffmpeg on PATH or SL_FFMPEG)
const SCEN = (process.argv.find(a => a.startsWith('--scenario=')) || '--scenario=fanout').split('=')[1];
const OUT = process.env.SKYNET_SHOT_OUT || join(process.cwd(), 'dev', '.shots-summon-live', SCEN);
const LEAD_MODEL = process.env.SL_LEAD_MODEL || 'anthropic/claude-sonnet-4.6';
const WORKER_MODEL = process.env.SL_WORKER_MODEL || 'anthropic/claude-haiku-4.5';

function devKey() {
  for (const p of [join(process.cwd(), 'dev', '.env.dev'), join(homedir(), 'Desktop', 'gen', 'dev', '.env.dev')]) {
    if (!existsSync(p)) continue;
    const m = /^SKYNET_OPENROUTER_KEY=(.+)$/m.exec(readFileSync(p, 'utf8'));
    if (m) return m[1].trim();
  }
  throw new Error('no SKYNET_OPENROUTER_KEY in dev/.env.dev');
}

const VEGA = { name: 'Researcher', agentName: 'VEGA', skin: 'astronaut' };
const QUILL = { name: 'Writer', agentName: 'QUILL', skin: 'secretagent' };
const BOLT = { name: 'Engineer', agentName: 'BOLT', skin: 'robot' };
const ECHO = { name: 'Analyst', agentName: 'ECHO', skin: 'plaguedoctor' };
const RUNE = { name: 'Tester', agentName: 'RUNE', skin: 'skeleton' };
// desks spread across the seeded room (18x11 tiles; the lead's desk is at 8,1). Each recruit adopts the next free one.
const SCENARIOS = {
  fanout: { crew: [VEGA, QUILL, BOLT], desks: [[2, 5], [14, 5], [8, 8]],
    ask: 'Split this across the crew and run it in parallel with team.dispatch — do not do the parts yourself. '
      + 'VEGA: search the web for the current monthly price of Linear Standard and Notion Plus and report both with sources. '
      + 'QUILL: write a 3-line tagline for a SaaS pricing page and save it to notes/tagline.md. '
      + 'BOLT: write pricing.html, a minimal static page with three plan cards (Free, Pro, Team), and save it in the workspace. '
      + 'When all three are back, give me a 3-line summary.' },
  relay: { crew: [VEGA, QUILL, BOLT], desks: [[2, 4], [14, 4], [8, 8]],
    ask: 'Run this as a relay with team.dispatch, ONE worker at a time, each one building on the result before it — do not do the parts yourself. '
      + 'Step 1, VEGA: find the current monthly price of the Raycast Pro plan and two things it includes (search + fetch the page). '
      + 'Step 2, QUILL: using exactly what VEGA found, write a 4-line product blurb and save it to notes/raycast-blurb.md. '
      + 'Step 3, BOLT: turn the blurb from QUILL into raycast.html, a one-card static page, and save it. '
      + 'Dispatch each step only after the previous one returns, passing its result along. Then tell me in 2 lines what each produced.' },
  crew5: { crew: [VEGA, QUILL, BOLT, ECHO, RUNE], desks: [[2, 4], [14, 4], [2, 8], [8, 8], [11, 8]],
    ask: 'Big parallel job — split it across all five crew with team.dispatch, all at once, and do not do the parts yourself. '
      + 'VEGA: search the web for the top 3 open-source vector databases and their GitHub star counts. '
      + 'QUILL: write a 5-line README intro for a tool called StarNet and save it to notes/readme-intro.md. '
      + 'BOLT: write tools/wordcount.js, a node script that counts words in a file passed as an argument, and run it on itself with the terminal. '
      + 'ECHO: fetch https://news.ycombinator.com and list the top 3 story titles. '
      + 'RUNE: create notes/checklist.md with a 6-item launch checklist, then read it back to confirm it saved. '
      + 'When everyone is back, give me one line per crew member.' },
};
const SC = SCENARIOS[SCEN]; if (!SC) throw new Error('unknown scenario ' + SCEN);
const CREW = SC.crew, ASK = SC.ask;

async function main() {
  const key = devKey();
  const scratch = mkdtempSync(join(tmpdir(), 'summonlive-'));
  materializeSeedWorkspace(join(scratch, 'ws'), LEAD_MODEL);
  const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws'), model: LEAD_MODEL, key });
  let chrome = null, cdp = null;
  try {
    if (!(await waitUp(URL))) throw new Error('sidecar never came up on ' + URL);
    chrome = launchChrome({ cdpPort: CDP_PORT, profileDir: join(scratch, 'chrome'), win: '1920,1080' });
    await sleep(1200);
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    const diag = collectDiagnostics(cdp);
    await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never reached the game screen');
    // Andrew's real view (memory: shoot-ui-at-andrews-real-settings): rail + chat widths need a reload to apply
    await evalJS(cdp, `(() => { localStorage.setItem('starnet.crewrail.w', '400'); localStorage.setItem('starnet.crewrail.rows', '2'); localStorage.setItem('starnet.chatw', '767'); return true; })()`);
    await evalJS(cdp, `location.reload()`);
    await sleep(1500);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never came back after reload');
    console.log('look', JSON.stringify(await evalJS(cdp, `(() => { try { StationUI.setLook({ theme: 'custom', themeHue: 216, themeSat: 100, themeGlow: 20, panelBright: -100, flicker: false, textScale: 90 }); return 'ok'; } catch (e) { return e.message; } })()`)));
    await sleep(2000);
    mkdirSync(OUT, { recursive: true });

    // spread desks across the room first (unowned, so each recruit adopts one in order), then recruit
    console.log('desks', JSON.stringify(await evalJS(cdp, `(() => { const st = Build.__test__.station(); return ${JSON.stringify(SC.desks)}.map(([x, y]) => {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const r = st.addProp({ t: 'desk', x: x + dx, y: y + dy, w: 2, h: 1 }); if (r && r.ok) return [x + dx, y + dy]; }
      return [x, y, 'FAILED']; }); })()`)));
    await sleep(800);
    // recruit the crew through the real path, give them full approval (as the dossier's ASK/FULL toggle would)
    const recruited = await evalJS(cdp, `(() => {
      const out = [];
      for (const s of ${JSON.stringify(CREW)}) {
        const a = App.summonAgent({ ...s, modelPin: { model: ${JSON.stringify(WORKER_MODEL)}, provider: 'openrouter' } }, { activate: false, desk: true });
        if (a && a.id) { App.setApproval(a.id, 'full'); out.push([a.id, a.name]); } else out.push([s.agentName, null]);
      }
      App.setApproval('agent', 'full');
      // the bus log: every event the floor reacts to, so the report says what REALLY fired
      window.__sl = [];
      for (const ev of ['agent.run.start', 'agent.tool_call', 'agent.tool_result', 'agent.run.end', 'cost.estimate', 'agent.cost'])
        U.bus.on(ev, p => window.__sl.push([Date.now(), ev, p && p.agentId, p && (p.name || p.reason || p.usd || p.model || ''), p && p.argsSummary ? String(p.argsSummary).slice(0, 60) : '']));
      return out;
    })()`);
    console.log('recruited', JSON.stringify(recruited));
    await sleep(5000);   // let them walk to their new desks
    await capture(cdp, OUT, '0-crew');

    // one real COMMS message, through the real composer
    await evalJS(cdp, `(() => { const t = document.getElementById('chat-input'); t.value = ${JSON.stringify(ASK)}; t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return true; })()`);
    // RECORD: the browser's own frames (Page.startScreencast) from the moment the message is sent, timed by the frame
    // metadata so the video plays at real speed; encoded with ffmpeg's concat demuxer after the run.
    const frames = [];
    if (RECORD) {
      mkdirSync(join(OUT, 'frames'), { recursive: true });
      await cdp.send('Page.enable');
      cdp.on('Page.screencastFrame', (p) => {
        const file = join(OUT, 'frames', 'f' + String(frames.length).padStart(5, '0') + '.jpg');
        writeFileSync(file, Buffer.from(p.data, 'base64'));
        frames.push({ file, ts: p.metadata && p.metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    }
    const t0 = Date.now(); let n = 0, sawWorker = false;
    while (Date.now() - t0 < 360000) {
      await sleep(2500);
      const st = await evalJS(cdp, `(() => { const L = window.__sl || []; return { starts: L.filter(e => e[1] === 'agent.run.start').map(e => e[2]), ends: L.filter(e => e[1] === 'agent.run.end').map(e => e[2]), tools: L.filter(e => e[1] === 'agent.tool_call').length }; })()`);
      const workers = st.starts.filter(a => a !== 'agent');
      if (workers.length) sawWorker = true;
      const live = st.starts.length - st.ends.length;
      if (sawWorker && live > 0) { n++; console.log('shot', n, JSON.stringify(st)); console.log('  bodies', JSON.stringify(await evalJS(cdp, `World.bodies().map(b => [b.name, b.renderTile && b.renderTile.x, b.renderTile && b.renderTile.y, b.seated ? 'seated' : b.moving ? 'walking' : 'standing', b.working ? 'W' : ''])`))); await capture(cdp, OUT, 'live-' + String(n).padStart(2, '0')); }
      if (st.ends.includes('agent') && st.ends.length >= st.starts.length) break;
    }
    if (RECORD) { await sleep(3000); await cdp.send('Page.stopScreencast'); }
    await capture(cdp, OUT, '9-end');
    if (RECORD && frames.length > 1) {
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const next = frames[i + 1];
        const d = next && frames[i].ts && next.ts ? Math.max(0.01, Math.min(2, next.ts - frames[i].ts)) : 0.1;
        lines.push("file '" + frames[i].file.replace(/\\/g, '/') + "'", 'duration ' + d.toFixed(3));
      }
      lines.push("file '" + frames[frames.length - 1].file.replace(/\\/g, '/') + "'");
      const list = join(OUT, 'frames.txt'); writeFileSync(list, lines.join('\n') + '\n');
      const ff = process.env.SL_FFMPEG || 'ffmpeg';
      execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', join(OUT, 'run.mp4')]);
      console.log('video', join(OUT, 'run.mp4'), frames.length, 'frames');
    }
    const log = await evalJS(cdp, `(window.__sl || []).map(e => [Math.round((e[0] - ${t0}) / 100) / 10].concat(e.slice(1)))`);
    writeFileSync(join(OUT, 'bus-log.json'), JSON.stringify(log, null, 1));
    console.log('events', log.length, 'tool calls', log.filter(e => e[1] === 'agent.tool_call').length);
    for (const e of log.filter(e => e[1] !== 'cost.estimate')) console.log(JSON.stringify(e));
    console.log('diag', JSON.stringify({ exceptions: diag.exceptions.slice(0, 5), console: diag.consoleMsgs.filter(m => m.type === 'error').slice(0, 5) }));
  } finally {
    try { if (chrome) chrome.proc.kill(); } catch (e) { console.error(e.message); }
    try { side.kill(); } catch (e) { console.error(e.message); }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
