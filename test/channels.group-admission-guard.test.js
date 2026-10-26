/* node test/channels.group-admission-guard.test.js — another bot's /allow or /deny is not ours.

   1. ANOTHER BOT'S /allow. Moderation bots use "/allow @user" and "/deny @user". The admission rule accepted any bare
      /allow or /deny, arguments and all, so the owner moderating a room admitted it to their station ("Anyone here can
      now talk to me … every answer is a real run on your station"), and in an admitted room "/deny @spammer" closed it.
      A non-owner's moderation command also made a bot that sat silent in the room post a refusal line. Ours takes no
      argument unless it names this bot (/allow@thisbot …).

   Real adapter + real hub; fakes only, no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

const OWNER = '5';
function mkAdapter(opts) {
  const got = [], sent = [];
  const ad = makeChannelAdapter(Object.assign({
    transport: { getUpdates: async () => [], send: async (chatId, text, o) => { sent.push({ chatId, text, o }); return { ok: true, messageId: 'm' + sent.length }; } },
    normalize: (r) => r, name: 'telegram', clock: { now: () => 1000 },
    botUsername: 'halcyonbot', ownerUserId: OWNER,
    onInbound: (im) => got.push(im)
  }, opts || {}));
  return { ad, got, sent };
}
const group = (extra) => Object.assign({ chatId: '-1001', chatType: 'group', userId: '9', userName: 'Ana', text: 'hello', messageId: String(Math.random()) }, extra);
const flush = () => new Promise(r => setTimeout(r, 0));
function fakeStore() {
  const recs = new Map();
  return {
    recs, loadHistory: () => [], appendTurn: () => [],
    getChatRecord: (c) => recs.get(String(c)),
    saveChatRecord: (c, patch) => { const m = Object.assign({}, recs.get(String(c)), patch); recs.set(String(c), m); return m; }
  };
}
function mkHub(over) {
  const sends = [], runs = [];
  const store = (over && over.store) || fakeStore();
  let n = 0;
  const hub = makeChannelHub(Object.assign({
    channel: 'telegram', store,
    runOnce: async (o) => { runs.push(o); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
    send: (c, t) => { sends.push({ chatId: String(c), text: t }); return Promise.resolve({ ok: true }); },
    secrets: () => ({ key: 'k', model: 'm', agentId: 'ultron' }), classify: () => false, newId: () => 'r' + (++n),
    isOwner: (m) => String(m.userId) === OWNER
  }, over || {}));
  return { hub, sends, runs, store };
}
const inbound = (userId, text, extra) => Object.assign({ channel: 'telegram', chatId: '-1001', chatType: 'group', userId, text, messageId: String(Math.random()), ts: 1 }, extra || {});

(async () => {
  // ---- 1a. the adapter: a closed group's moderation command is not an admission ----
  {
    const { ad, got, sent } = mkAdapter({ allowedChats: () => false });
    const adm = ad._internals.admission;
    A.eq(adm(group({ userId: OWNER, text: '/allow @newmember' })), 'drop', 'the owner\'s "/allow @user" (a moderation bot\'s) is not an admission');
    A.eq(adm(group({ userId: OWNER, text: '/deny spammer' })), 'drop', 'nor is "/deny spammer"');
    A.eq(adm(group({ userId: OWNER, text: '/allow' })), 'admit', 'a bare /allow still admits');
    A.eq(adm(group({ userId: OWNER, text: '/allow   ' })), 'admit', 'trailing spaces are not an argument');
    A.eq(adm(group({ userId: OWNER, text: '/allow@halcyonbot please', mentions: ['halcyonbot'] })), 'admit', 'an argument is fine when the command names US');
    ad._internals.dispatch({ offset: 1, message: group({ userId: '9', text: '/allow @newmember' }) });
    ad._internals.dispatch({ offset: 2, message: group({ userId: OWNER, text: '/allow @newmember' }) });
    await flush();
    A.eq(sent.length, 0, 'a bot silent in that room stays silent: no refusal line for someone else\'s moderation');
    A.eq(got.length, 0, 'and nothing reaches the hub');
  }

  // ---- 1b. the hub: in an ADMITTED room "/deny @spammer" does not close it, "/allow @x" says nothing ----
  {
    const t = mkHub();
    t.store.saveChatRecord('-1001', { admittedOn: 'telegram' });
    await t.hub.onInbound(inbound(OWNER, '/allow @newmember'));
    await t.hub.onInbound(inbound('9', '/deny @spammer'));
    A.eq(t.sends, [], 'a no-op /allow and a member\'s moderation command say nothing into their conversation');
    // the OWNER's /deny with something after it is not taken as ours — but an ignored close must never pass for one:
    // the owner is told the room is still open and how to close it
    await t.hub.onInbound(inbound(OWNER, '/deny @spammer'));
    A.eq(t.store.getChatRecord('-1001').admittedOn, 'telegram', 'the room is still admitted');
    A.eq(t.sends.length, 1, 'one line, to the owner\'s /deny only: ' + JSON.stringify(t.sends));
    A.ok(/still admitted/.test((t.sends[0] || {}).text || '') && /\/deny on its own/.test((t.sends[0] || {}).text || ''), 'it says the room is still open and how to close it: ' + JSON.stringify(t.sends[0]));
    A.eq(t.runs.length, 0, 'and nothing ran');
    t.sends.length = 0;
    await t.hub.onInbound(inbound(OWNER, '/deny@halcyonbot now'));
    A.eq(t.store.getChatRecord('-1001').admittedOn, '', 'an argument WITH our own @name still works');
    await t.hub.onInbound(inbound(OWNER, '/allow'));
    A.eq(t.store.getChatRecord('-1001').admittedOn, 'telegram', 'and a bare /allow re-admits');
    const dm = mkHub();
    await dm.hub.onInbound(inbound(OWNER, '/allow everyone', { chatId: 'c5', chatType: 'dm' }));
    A.ok(/for groups/.test((dm.sends[0] || {}).text || ''), 'a DM keeps its answer: ' + JSON.stringify(dm.sends));
  }

  // ---- 1c. the adapter: an argument that names THIS bot ("/allow @halcyonbot" — natural in a room with several
  //          bots) is ours, the same address as "/allow@halcyonbot"; any other name is still someone else's ----
  {
    const { ad } = mkAdapter({ allowedChats: () => false });
    const adm = ad._internals.admission;
    A.eq(adm(group({ userId: OWNER, text: '/allow @halcyonbot', mentions: ['halcyonbot'] })), 'admit', '"/allow @thisbot" admits');
    A.eq(adm(group({ userId: OWNER, text: '/allow @HalcyonBot ', mentions: ['halcyonbot'] })), 'admit', 'whatever the case');
    A.eq(adm(group({ userId: OWNER, text: '/allow @otherbot', mentions: ['otherbot'] })), 'drop', '"/allow @otherbot" is not ours');
    A.eq(adm(group({ userId: OWNER, text: '/allow @halcyonbot @newmember', mentions: ['halcyonbot', 'newmember'] })), 'drop', 'nor is a list that names someone else too');
    const anon = mkAdapter({ allowedChats: () => false, botUsername: '' });
    A.eq(anon.ad._internals.admission(group({ userId: OWNER, text: '/allow @halcyonbot' })), 'drop', 'while our own name is unknown it cannot name us');
  }

  // ---- 2. END TO END, real adapter feeding the real hub (allow-list read from the hub's own chat record): the owner
  //         opens and closes a room by naming this bot as the argument ----
  {
    const t = mkHub();
    const { ad } = mkAdapter({
      allowedChats: (id) => { const r = t.store.getChatRecord(id); return !!(r && r.admittedOn === 'telegram'); },
      onInbound: (im) => { t.pending = t.hub.onInbound(im); }
    });
    const say = async (userId, text, mentions) => {
      t.pending = null;
      ad._internals.dispatch({ offset: 1, message: group({ userId, text, mentions }) });
      if (t.pending) await t.pending;
      await flush();
    };
    await say(OWNER, '/allow @halcyonbot', ['halcyonbot']);
    A.eq((t.store.getChatRecord('-1001') || {}).admittedOn, 'telegram', '"/allow @halcyonbot" admitted the closed room');
    A.ok(/This group is admitted/.test((t.sends[0] || {}).text || ''), 'and said so: ' + JSON.stringify(t.sends));
    await say(OWNER, '/deny @halcyonbot', ['halcyonbot']);
    A.eq(t.store.getChatRecord('-1001').admittedOn, '', '"/deny @halcyonbot" closed it — the owner\'s close is never ignored');
    A.ok(/^Removed\./.test((t.sends[1] || {}).text || ''), 'and said so: ' + JSON.stringify(t.sends[1]));
    A.eq(t.runs.length, 0, 'no run');
  }

  A.report('channels.group-admission-guard');
})().catch(e => { console.error(e); process.exit(1); });
