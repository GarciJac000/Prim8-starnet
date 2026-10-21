/* STARNET — battlepass.js : the PURE battle-pass projection behind the QUEST LOG's PASS view.

   Andrew, 2026-10-19: "it should feel like a Fortnite battle pass, except the goals are based off the user's
   actual goals and desires." This engine dresses the Commander's EXISTING, sidecar-owned progression as a pass —
   tiers, rank titles, a daily streak, a season, and weekly challenges — without minting anything:

     • TIER      = the Commander level (sidecar/journey-store.js progressionFor: floor(points / 100) + 1).
     • PASS PTS  = the Commander achievement points. They are only ever awarded by the sidecar for verified,
                   goal-linked outcomes (+10 per quest / planned step / metric checkpoint, +100 per confirmed goal).
     • STREAK    = consecutive LOCAL days on which at least one of those achievements landed (progression.activity).
     • SEASON    = the calendar month; season pts = points whose achievement landed this month.
     • CHALLENGES = this week's counts of the same achievements, aimed at the ACTIVE goal. A challenge is a LENS
                   over points the sidecar already awarded — completing one never adds points of its own.
     • REWARDS   = cosmetic only, and applied the moment they are earned: a rank title per tier and an ASCII frame
                   upgrade every five tiers. Nothing is locked, nothing is bought, no tool/model/permission is gated
                   (the sandbox law) — an upcoming tier reads "ahead", never as locked loot.

   PURE + node-testable (a `BattlePass` global in the browser, module.exports under node), mirroring quests.js:
   no Date.now / Math.random — the clock is injected, and day boundaries use the host's LOCAL calendar (the
   sidecar and the webview share one machine). Absent/partial input degrades to an honest empty pass, never a throw. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.BattlePass = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PER_TIER = 100;          // mirrors journey-store progressionFor (level = floor(points / 100) + 1)
  const DAY = 86400000;
  const RANKS = ['DRIFTER', 'SIGNAL', 'OPERATOR', 'NAVIGATOR', 'VANGUARD', 'PATHFINDER', 'ARCHITECT', 'WARDEN', 'ADMIRAL', 'ASCENDANT'];
  // the header frame the pass wears — upgraded every five tiers. Plain ASCII so VT323 draws every glyph.
  const FRAMES = [
    { at: 1, name: 'BASIC', corner: '+', run: '-' },
    { at: 5, name: 'DOUBLE', corner: '+', run: '=' },
    { at: 10, name: 'HULL', corner: '#', run: '=' },
    { at: 15, name: 'STARLINE', corner: '*', run: '~' },
    { at: 20, name: 'DEEP FIELD', corner: '@', run: ':' }
  ];
  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

  const int = v => { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : 0; };
  // clip by CODE POINT, not UTF-16 unit: a goal like "Ship the 🚀 launch" must never be cut into a lone surrogate (sweep 10-20)
  const clip = (s, n) => { const cp = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim()); return cp.length > n ? cp.slice(0, n - 1).join('') + '…' : cp.join(''); };

  function rankOf(tier) {
    const t = Math.max(1, int(tier));
    return t <= RANKS.length ? RANKS[t - 1] : RANKS[RANKS.length - 1] + ' +' + (t - RANKS.length);
  }
  function frameOf(tier) {
    const t = Math.max(1, int(tier));
    let f = FRAMES[0];
    for (const x of FRAMES) if (t >= x.at) f = x;
    return f;
  }
  // what reaching tier t gives you — always its title; on a frame tier, the frame too.
  function rewardOf(tier) {
    const t = Math.max(1, int(tier));
    const frame = FRAMES.find(f => f.at === t && t > 1);
    return { title: rankOf(t), frame: frame ? frame.name : null };
  }

  // ASCII meter: [#######.......] — width counts the cells between the brackets.
  function bar(pct, width) {
    const w = Math.max(4, int(width) || 20);
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const fill = Math.round((p / 100) * w);
    return '[' + '#'.repeat(fill) + '.'.repeat(w - fill) + ']';
  }

  // local calendar helpers — the day ORDINAL is computed from the local Y/M/D through Date.UTC so DST
  // transitions (23h / 25h days) never split or merge a day.
  function ymd(ms) { const d = new Date(ms); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), wd: d.getDay() }; }
  function ordinal(ms) { const t = ymd(ms); return Math.round(Date.UTC(t.y, t.m, t.d) / DAY); }
  function startOfDay(ms) { const t = ymd(ms); return new Date(t.y, t.m, t.d).getTime(); }
  function startOfWeek(ms) {   // Monday 00:00 local
    const t = ymd(ms); const back = (t.wd + 6) % 7;
    return new Date(t.y, t.m, t.d - back).getTime();
  }
  function startOfMonth(ms) { const t = ymd(ms); return new Date(t.y, t.m, 1).getTime(); }
  function startOfNextMonth(ms) { const t = ymd(ms); return new Date(t.y, t.m + 1, 1).getTime(); }

  // the point-earning events, cleaned. progression.activity is the additive sidecar field; older sidecars only
  // ship the last 30 `achievements`, which carry the same {at, kind, points, goalId} — use whichever is there.
  function events(progression) {
    const p = progression || {};
    const raw = Array.isArray(p.activity) ? p.activity : (Array.isArray(p.achievements) ? p.achievements : []);
    const out = [];
    for (const a of raw) {
      if (!a) continue;
      const at = int(a.at), points = int(a.points);
      if (at <= 0 || points <= 0) continue;
      const kind = String(a.kind || '');
      const step = a.step === true || kind === 'milestone' || /^milestone:/.test(String(a.key || ''));
      out.push({ at, kind, points, goalId: a.goalId ? String(a.goalId) : null, step });
    }
    return out.sort((x, y) => x.at - y.at);
  }

  /* the streak: consecutive local days with points. A streak whose last active day is YESTERDAY is still alive
     (atRisk — today has not counted yet); one whose last day is older is broken (current 0). best = the longest
     run in the recorded history. week = the last seven days ending today, each { label, active, today, future }. */
  function streakOf(evts, now) {
    const days = new Set(evts.map(e => ordinal(e.at)));
    const today = ordinal(now);
    let current = 0, anchor = days.has(today) ? today : (days.has(today - 1) ? today - 1 : null);
    if (anchor != null) { for (let d = anchor; days.has(d); d--) current++; }
    let best = 0, run = 0, prev = null;
    for (const d of Array.from(days).sort((a, b) => a - b)) {
      run = (prev != null && d === prev + 1) ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
    // the strip is the LAST SEVEN DAYS ending today (not the calendar week), so a streak that crossed Monday
    // stays visible as the run it is.
    const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const t0 = ymd(now);
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const dayMs = new Date(t0.y, t0.m, t0.d - i, 12).getTime();
      const o = ordinal(dayMs);
      week.push({ label: LETTERS[ymd(dayMs).wd], active: days.has(o), today: i === 0, future: false });
    }
    return { current, best: Math.max(best, current), today: days.has(today), atRisk: current > 0 && !days.has(today), week };
  }

  /* this week's challenges, aimed at the Commander's REAL goal. Every count reads point-earning achievements that
     landed since Monday 00:00 local; `pts` names what the sidecar already pays for the counted thing. */
  function challengesOf(evts, input, now) {
    const since = startOfWeek(now);
    const wk = evts.filter(e => e.at >= since);
    const goal = input.goal && input.goal.id ? input.goal : null;
    const out = [];
    const mk = (id, title, have, need, pts, go) => ({ id, title, have: Math.min(have, need), need, done: have >= need, pts, go });
    if (!goal || !input.goalRegistered) {
      // no registered goal → the sidecar cannot award a single point yet; the one honest challenge is to set one.
      // a goal that HAS a success condition but whose registration never reached the sidecar (offline at save) is not
      // "missing" one — say what is actually true: it is saved here and still has to reach the journey (sweep 10-20).
      const title = !goal ? 'Set a goal and say what success looks like'
        : input.goalSaved ? 'Finish saving “' + clip(goal.text, 48) + '” to your journey — retry its success condition'
        : 'Give “' + clip(goal.text, 48) + '” a success condition';
      out.push(mk('goal', title, 0, 1, 'starts your pass', { view: 'goals' }));
      return out;
    }
    const steps = wk.filter(e => e.step && e.goalId === goal.id).length;
    const open = Math.max(0, int(goal.total) - int(goal.done));
    if (open > 0 || steps > 0) out.push(mk('steps', 'Finish ' + Math.max(1, Math.min(2, open + steps)) + ' planned step' + (Math.min(2, open + steps) > 1 ? 's' : '') + ' on “' + clip(goal.text, 48) + '”',
      steps, Math.max(1, Math.min(2, open + steps)), '+10 PTS EACH', { view: 'goals' }));
    const quests = wk.filter(e => e.kind === 'quest' && !e.step).length;
    // only a goal-linked quest the Commander CONFIRMS earns points (journey-store recordQuest: commander-confirmed +
    // an active registered goal) — station / dossier / build / fix-it quests never do, so the challenge names exactly that.
    out.push(mk('quests', 'Confirm 3 quests for your goals', quests, 3, '+10 PTS EACH', { view: 'available', category: 'missions' }));
    const activeDays = new Set(wk.map(e => ordinal(e.at))).size;
    // the need never exceeds what the week still allows (Sunday with 0 days asks for 1, not an impossible 3) (sweep 10-20)
    const daysLeft = 7 - ((ymd(now).wd + 6) % 7);   // today included: Mon → 7 … Sun → 1
    const todayCounted = wk.some(e => ordinal(e.at) === ordinal(now));
    const dayNeed = Math.max(1, Math.min(3, activeDays + daysLeft - (todayCounted ? 1 : 0)));
    out.push(mk('days', 'Earn points on ' + dayNeed + ' different day' + (dayNeed === 1 ? '' : 's'), activeDays, dayNeed, 'BUILDS YOUR STREAK', { view: 'available' }));
    if (input.metric && input.metric.label) {
      const metric = wk.filter(e => e.kind === 'metric' && e.goalId === goal.id).length;
      out.push(mk('metric', 'Move “' + clip(input.metric.label, 40) + '” past its next checkpoint', metric, 1, '+10 PTS', { view: 'progress' }));
    }
    if (int(goal.total) > 0 && int(goal.done) >= int(goal.total)) {
      const reached = wk.filter(e => e.kind === 'goal' && e.goalId === goal.id).length;
      out.push(mk('outcome', 'Confirm “' + clip(goal.text, 48) + '” is achieved', reached, 1, '+100 PTS', { view: 'goals' }));
    }
    return out;
  }

  // "6D 9H" / "9H" / "<1H" — the weekly reset countdown, never rounded up into a day that has not started.
  function resetLabel(ms) {
    const h = Math.max(0, Math.floor(ms / 3600000));
    if (h < 1) return '<1H';
    return h >= 24 ? (Math.floor(h / 24) + 'D ' + (h % 24) + 'H') : (h + 'H');
  }

  /* build(input) → the whole pass model. input:
       progression    — JourneyStore.status().progression ({ level, points, levelStartsAt, nextLevelAt, activity|achievements, startedAt })
       goal           — the ACTIVE goal { id, text, done, total } (or null)
       goalRegistered — true when the sidecar knows that goal (it has a success condition) — points can only land then
       metric         — the active goal's first live metric { label } (or null)
       claimedTier    — the highest tier this viewer already claimed (per-viewer acknowledgement, never a gate)
       now            — injected clock (ms) */
  function build(input) {
    input = input || {};
    const now = int(input.now);
    const p = input.progression || null;
    const points = Math.max(0, int(p && p.points));
    const tier = Math.max(1, int(p && p.level) || (Math.floor(points / PER_TIER) + 1));
    const base = p && Number.isFinite(Number(p.levelStartsAt)) ? int(p.levelStartsAt) : (tier - 1) * PER_TIER;
    const into = Math.max(0, Math.min(PER_TIER, points - base));
    const evts = events(p);
    const claimed = Math.max(1, Math.min(tier, int(input.claimedTier) || 1));

    // the track: a window around the current tier (a pass never ends — there is always a next title to reach).
    const from = Math.max(1, tier - 3), to = Math.max(from + 9, tier + 6);
    const track = [];
    for (let t = from; t <= to; t++) {
      const r = rewardOf(t);
      track.push({ tier: t, title: r.title, frame: r.frame,
        state: t < tier ? 'done' : t === tier ? 'now' : 'ahead',
        claimable: t > claimed && t <= tier });
    }

    const monthStart = startOfMonth(now), monthEnd = startOfNextMonth(now);
    const firstAt = int(p && p.startedAt) || (evts.length ? evts[0].at : now);
    const fm = ymd(firstAt || now), nm = ymd(now);
    const seasonNo = Math.max(1, (nm.y - fm.y) * 12 + (nm.m - fm.m) + 1);
    const seasonPts = evts.filter(e => e.at >= monthStart && e.at < monthEnd).reduce((s, e) => s + e.points, 0);
    const weekEnd = startOfWeek(now) + 7 * DAY;

    return {
      tier, points, into, perTier: PER_TIER, toNext: PER_TIER - into, pct: Math.round((into / PER_TIER) * 100),
      rank: rankOf(tier), nextRank: rankOf(tier + 1), frame: frameOf(tier),
      claimable: track.filter(t => t.claimable).map(t => t.tier), claimedTier: claimed,
      track,
      streak: streakOf(evts, now),
      season: { no: seasonNo, name: MONTHS[nm.m], pts: seasonPts, daysLeft: Math.max(0, Math.ceil((monthEnd - startOfDay(now)) / DAY) - 1) },
      week: { resetsIn: resetLabel(weekEnd - now) },
      challenges: challengesOf(evts, input, now),
      empty: points === 0 && !evts.length
    };
  }

  return { build, bar, rankOf, frameOf, rewardOf, streakOf, events, PER_TIER, RANKS, FRAMES };
});
