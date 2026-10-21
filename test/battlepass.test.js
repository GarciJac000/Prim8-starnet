/* node test/battlepass.test.js — the quest-log battle pass is a pure, honest projection of Commander progression:
   tiers = levels, streak = local days with verified points, challenges = this week's verified awards, rewards cosmetic. */
'use strict';
const A = require('./_assert.js');
const BP = require('../frontend/app/battlepass.js');

const at = (y, m, d, h) => new Date(y, m - 1, d, h == null ? 12 : h).getTime();
const NOW = at(2026, 10, 21, 15);   // Wednesday, Oct 21 2026 (local)
const goal = { id: 'g1', text: 'Land a remote design job', done: 1, total: 4 };
const prog = (points, activity) => ({ level: Math.floor(points / 100) + 1, points, levelStartsAt: Math.floor(points / 100) * 100, activity });

// ---- empty / offline input never throws and never invents progress
const empty = BP.build({ now: NOW });
A.eq(empty.tier, 1, 'no progression reads tier 1');
A.eq(empty.points, 0, 'no progression reads zero points');
A.eq(empty.streak.current, 0, 'no activity, no streak');
A.ok(empty.empty, 'an untouched pass says so');
A.eq(empty.challenges.length, 1, 'without a registered goal there is exactly one challenge');
A.eq(empty.challenges[0].id, 'goal', 'the only honest challenge is to set a goal (points cannot land without one)');

// ---- tiers mirror the sidecar level; rewards are cosmetic titles/frames
const p = BP.build({ progression: prog(364, []), goal, goalRegistered: true, now: NOW, claimedTier: 2 });
A.eq(p.tier, 4, 'tier is the Commander level');
A.eq(p.into, 64, 'points into the tier come from levelStartsAt');
A.eq(p.toNext, 36, 'points to the next tier');
A.eq(p.rank, 'NAVIGATOR', 'tier 4 wears its rank title');
A.eq(p.nextRank, 'VANGUARD', 'the next title is named');
A.eq(p.frame.name, 'BASIC', 'frames upgrade only at tier 5');
A.eq(BP.frameOf(5).name, 'DOUBLE', 'tier 5 earns the double frame');
A.eq(BP.rewardOf(10).frame, 'HULL', 'a frame tier names its frame');
A.eq(BP.rewardOf(7).frame, null, 'an ordinary tier only gives its title');
A.eq(BP.rankOf(13), 'ASCENDANT +3', 'the pass never runs out of titles');
A.eq(p.claimable.join(','), '3,4', 'earned-but-unclaimed tiers are claimable');
A.ok(p.track.every(t => t.state !== 'ahead' || !t.claimable), 'a tier ahead can never be claimed');
A.eq(p.track.find(t => t.tier === 4).state, 'now', 'the current tier is marked');
A.eq(p.track.find(t => t.tier === 5).state, 'ahead', 'upcoming tiers read ahead — not locked');
A.eq(BP.build({ progression: prog(364, []), now: NOW, claimedTier: 99 }).claimedTier, 4, 'a stale claim above the current tier clamps (new Commander)');

// ---- ASCII meters
A.eq(BP.bar(50, 10), '[#####.....]', 'half bar');
A.eq(BP.bar(0, 4), '[....]', 'empty bar');
A.eq(BP.bar(250, 4), '[####]', 'overfull bar clamps');

// ---- streak: consecutive local days, alive through yesterday, broken after a gap
const ev = (t, kind, extra) => Object.assign({ at: t, kind: kind || 'quest', points: 10, goalId: 'g1' }, extra || {});
const streakActs = [ev(at(2026, 10, 17)), ev(at(2026, 10, 19, 9)), ev(at(2026, 10, 20, 23)), ev(at(2026, 10, 21, 1))];
let s = BP.build({ progression: prog(40, streakActs), goal, goalRegistered: true, now: NOW }).streak;
A.eq(s.current, 3, 'Mon+Tue+Wed (today) = 3-day streak; Sat before the gap does not count');
A.ok(s.today && !s.atRisk, 'today already counted');
A.eq(s.week.map(d => d.label).join(''), 'TFSSMTW', 'the strip is the last seven days ending today');
A.eq(s.week.map(d => d.active ? '#' : '.').join(''), '..#.###', 'Sat, then Mon/Tue/Wed lit — the run reads across the week boundary');
A.ok(s.week[6].today && !s.week.some(d => d.future), 'today is the last cell; nothing in the strip is in the future');
s = BP.build({ progression: prog(30, streakActs.slice(0, 3)), now: NOW }).streak;
A.eq(s.current, 2, 'a streak whose last day is yesterday is still alive');
A.ok(s.atRisk, '…but at risk until today counts');
s = BP.build({ progression: prog(10, [ev(at(2026, 10, 18))]), now: NOW }).streak;
A.eq(s.current, 0, 'a gap breaks the streak');
A.eq(s.best, 1, 'best remembers the longest run');
s = BP.build({ progression: prog(20, [ev(at(2026, 10, 21, 9)), ev(at(2026, 10, 21, 10))]), now: NOW }).streak;
A.eq(s.current, 1, 'two awards on one day are one streak day');
s = BP.build({ progression: prog(10, [{ at: at(2026, 10, 21), kind: 'quest', points: 0 }]), now: NOW }).streak;
A.eq(s.current, 0, 'a zero-point row never counts as activity');

// ---- weekly challenges are lenses over this week's verified awards, aimed at the real goal
const weekActs = [
  ev(at(2026, 10, 18), 'quest'),                       // last Sunday — previous week, must not count
  ev(at(2026, 10, 19), 'milestone'),                   // a planned step on g1 (Mon)
  ev(at(2026, 10, 20), 'quest', { step: true }),       // a step finished through its quest (key milestone:…)
  ev(at(2026, 10, 20), 'quest'),
  ev(at(2026, 10, 21), 'quest', { goalId: 'other' }),
  ev(at(2026, 10, 21), 'metric')
];
const c = BP.build({ progression: prog(60, weekActs), goal, goalRegistered: true, metric: { label: 'Applications sent' }, now: NOW }).challenges;
const byId = id => c.find(x => x.id === id);
A.eq(byId('steps').have, 2, 'both step-shaped awards on the active goal this week count');
A.ok(byId('steps').done, 'two steps finishes the step challenge');
A.eq(byId('quests').have, 2, 'plain quests count across goals, steps excluded, last week excluded');
A.ok(!byId('quests').done, 'three are needed');
A.ok(/^Confirm 3 quests for your goals$/.test(byId('quests').title) && byId('quests').go.category === 'missions', 'the quest challenge names the only quests that earn points and lands on Missions');
A.eq(byId('days').have, 3, 'Mon/Tue/Wed = three active days');
A.eq(byId('metric').have, 1, 'a metric checkpoint on the goal counts');
A.ok(!byId('outcome'), 'no confirm-outcome challenge until the plan is complete');
A.ok(c.every(x => x.have <= x.need), 'progress never overshoots its need');
const fin = BP.build({ progression: prog(40, []), goal: Object.assign({}, goal, { done: 4 }), goalRegistered: true, now: NOW }).challenges;
A.ok(fin.some(x => x.id === 'outcome' && x.pts === '+100 PTS'), 'a complete plan offers the confirm-your-outcome challenge');
A.ok(!fin.some(x => x.id === 'steps'), 'no step challenge when no step is open or done this week');
const unreg = BP.build({ progression: prog(0, []), goal, goalRegistered: false, now: NOW }).challenges;
A.ok(unreg.length === 1 && /success condition/.test(unreg[0].title), 'an unregistered goal is asked for its success condition');

// ---- season = calendar month, season pts = this month's awards
const se = BP.build({ progression: Object.assign(prog(60, weekActs.concat([ev(at(2026, 9, 30))])), { startedAt: at(2026, 8, 3) }), now: NOW }).season;
A.eq(se.name, 'OCTOBER', 'season is the local month');
A.eq(se.no, 3, 'Aug = season 1, Oct = season 3');
A.eq(se.pts, 60, 'only this month\'s awards count toward the season');
A.eq(se.daysLeft, 10, 'Oct 21 → 10 days left after today');

A.eq(BP.build({ now: NOW }).week.resetsIn, '4D 9H', 'Wed 15:00 → next Monday 00:00 is 4D 9H');
A.eq(BP.build({ now: at(2026, 10, 25, 23) }).week.resetsIn, '1H', 'Sunday 23:00 → 1H');

// ---- sweep 10-20 regressions
const astral = BP.build({ progression: prog(0, []), goal: { id: 'g1', text: 'a'.repeat(46) + '🚀 tail of the goal', done: 0, total: 3 }, goalRegistered: true, now: NOW }).challenges[0].title;
A.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral), 'a clipped goal title never ends in a lone surrogate (no broken emoji)');
const pendingReg = BP.build({ progression: prog(0, []), goal, goalRegistered: false, goalSaved: true, now: NOW }).challenges[0].title;
A.ok(/^Finish saving/.test(pendingReg) && !/a success condition$/.test(pendingReg), 'a goal saved offline is not told it lacks a success condition');
const SUN = at(2026, 10, 25, 18);
A.eq(BP.build({ progression: prog(10, []), goal, goalRegistered: true, now: SUN }).challenges.find(x => x.id === 'days').need, 1, 'Sunday with no active days asks for 1 day, never an impossible 3');
const satActs = [ev(at(2026, 10, 19)), ev(at(2026, 10, 24, 9))];
A.eq(BP.build({ progression: prog(20, satActs), goal, goalRegistered: true, now: at(2026, 10, 24, 15) }).challenges.find(x => x.id === 'days').need, 3, 'Saturday with Mon+Sat counted still allows a 3rd day (Sunday)');

// ---- older sidecars without `activity` fall back to the achievements window
const legacy = BP.build({ progression: { level: 1, points: 10, achievements: [{ at: at(2026, 10, 21), kind: 'quest', points: 10, goalId: 'g1', key: 'quest:q1' }] }, now: NOW });
A.eq(legacy.streak.current, 1, 'legacy achievements feed the streak');

A.report('battlepass.test');
