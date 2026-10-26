/* node test/channels.user-allow-command.test.js — a Commander's own /allow or /deny keeps running in a DM.
   0.14.0 added /allow and /deny as hub built-ins (group admission), and built-ins are parsed before the Commander's
   own commands — so an "allow" or "deny" they defined in usercommands.json under 0.13.x silently stopped running over
   messaging and the owner got "/allow and /deny are for groups" instead. The built-in only means something in a
   group; in a direct chat theirs runs again. Real hub + the real slash registry; no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const slash = require('../sidecar/slash.js');
const { makeUserCommands } = require('../sidecar/usercommands.js');

function build(file) {
  const ucs = makeUserCommands({ fs: { existsSync: () => true, readFileSync: () => JSON.stringify(file) }, file: 'usercommands.json' });
  const entries = ucs.catalogEntries(ucs.load());
  const sends = [], runs = [], slashCalls = [], recs = new Map();
  let n = 0;
  const hub = makeChannelHub({
    channel: 'telegram',
    store: { loadHistory: () => [], appendTurn: () => [], getChatRecord: (c) => recs.get(String(c)) || null,
      saveChatRecord: (c, p) => { recs.set(String(c), Object.assign({}, recs.get(String(c)) || {}, p)); } },
    runOnce: async (o) => { runs.push(o); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++n),
    runSlash: async (input) => {
      slashCalls.push(input);
      const out = slash.dispatch(input, { userCommands: entries });
      return (out && out.ok && out.directive) ? { ok: true, text: 'ran ' + (out.directive.action || out.directive.type) } : { ok: false, text: 'Unknown command.' };
    },
    userCommandNames: () => entries.map(c => c.name),
    isOwner: (m) => String(m.userId) === 'boss'
  });
  return { hub, sends, runs, slashCalls, recs };
}
const msg = (text, chatType, userId) => ({ channel: 'telegram', chatId: chatType === 'group' ? '-100' : 'c-boss', chatType: chatType || 'dm', userId: userId || 'boss', text, messageId: String(Math.random()), ts: 1 });

(async () => {
  const FILE = { commands: [{ name: 'allow', type: 'alias', target: '/usage' }, { name: 'deny', type: 'alias', target: '/tools' }] };
  // ---- 1. the owner's DM: their own /allow and /deny run ----
  {
    const t = build(FILE);
    await t.hub.onInbound(msg('/allow'));
    await t.hub.onInbound(msg('/deny@halcyonbot'));
    A.eq(t.slashCalls, ['/allow', '/deny'], 'both reached the registry as the Commander\'s commands');
    A.eq(t.sends, ['ran usage', 'ran tools'], 'and answered with their targets');
    A.eq(t.runs.length, 0, 'no model run');
  }
  // ---- 2. a group: the built-in admission still wins (that is what /allow means there) ----
  {
    const t = build(FILE);
    await t.hub.onInbound(msg('/allow', 'group'));
    A.eq(t.slashCalls, [], 'not the user command');
    A.eq((t.recs.get('-100') || {}).admittedOn, 'telegram', 'the group was admitted');
  }
  // ---- 3. without such a command the DM answer is unchanged ----
  {
    const t = build({ commands: [] });
    await t.hub.onInbound(msg('/allow'));
    A.ok(/for groups/.test(t.sends[0] || ''), 'the built-in explains itself: ' + JSON.stringify(t.sends));
  }
  A.report('channels.user-allow-command');
})().catch(e => { console.error(e); process.exit(1); });
