/* node test/skills.pin-lock.test.js — a model cannot take off the Commander's pin (bug 97743dff).

   PINNED IS A LOCK (skillstore.js pinnedGuard): a pinned skill refuses every content action from a model. pin/unpin
   were classed as lifecycle, applied directly (never staged, never guarded), so skill.manage {action:'unpin'} from a
   run removed the lock at once and the model's next patch went through. Real store + real skill tools.
     A. skill.manage unpin from a run is refused and the skill stays pinned; a later patch is still refused
     B. the store refuses an unpin by any writer but the Commander (createdBy 'user', the HTTP manage route)
     C. the Commander's own unpin keeps working, and a model may still pin */
'use strict';
const A = require('./_assert.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');

function rig(stageReviews) {
  const lines = [];
  const store = makeSkillStore({ io: { readAll: () => lines.slice(), append: e => lines.push(JSON.parse(JSON.stringify(e))) }, clock: { now: () => 9000 },
    stageReviews });
  const tools = makeSkillTools({ store });
  return { store, tools, lines };
}
const pinned = (r) => !!r.store.view('a', 'Deploy', { bump: false }).pinned;

for (const staged of [undefined, false]) {
  const label = staged === false ? ' (unstaged store)' : '';
  // ---- A. the model tool ----
  {
    const r = rig(staged);
    A.ok(r.store.manage({ agentId: 'a', action: 'create', name: 'Deploy', body: '1. build\n2. ship', createdBy: 'user' }).ok, 'A: precondition: the Commander writes a skill' + label);
    A.ok(r.store.manage({ agentId: 'a', action: 'pin', target: 'Deploy', createdBy: 'user' }).ok && pinned(r), 'A: precondition: the Commander pins it' + label);
    const out = r.tools.manageTool.run({ action: 'unpin', target: 'Deploy' }, { agentId: 'a', runId: 'run-1' });
    A.ok(/Commander/.test(out.content) && out.summary === 'not saved', 'A: a run\'s unpin is refused and says only the Commander can: ' + out.content + label);
    A.ok(pinned(r), 'A: the skill is still pinned' + label);
    const patch = r.tools.manageTool.run({ action: 'patch', target: 'Deploy', find: 'ship', replace: 'ship to prod' }, { agentId: 'a', runId: 'run-1' });
    A.ok(/pinned/.test(patch.content), 'A: the model\'s next patch is still refused by the pin: ' + patch.content + label);
    A.ok(r.store.view('a', 'Deploy', { bump: false }).body.indexOf('ship to prod') < 0, 'A: the body is unchanged' + label);
    const viaPin = r.tools.manageTool.run({ action: 'pin', target: 'Deploy', pinned: false }, { agentId: 'a', runId: 'run-1' });
    A.ok(pinned(r), 'A: pin with pinned:false does not unpin it either (' + viaPin.summary + ')' + label);
    for (const by of ['background-review', 'curator']) {
      const rv = r.tools.manageTool.run({ action: 'unpin', target: 'Deploy' }, { agentId: 'a', runId: 'run-2', createdBy: by });
      A.ok(rv.summary === 'not saved' && pinned(r), 'A: the ' + by + ' pass cannot unpin it either' + label);
    }
  }
  // ---- B. the store itself ----
  {
    const r = rig(staged);
    r.store.manage({ agentId: 'a', action: 'create', name: 'Deploy', body: '1. build', createdBy: 'user' });
    r.store.manage({ agentId: 'a', action: 'pin', target: 'Deploy', createdBy: 'user' });
    for (const by of ['agent', 'background-review', 'curator', 'community', undefined]) {
      const res = r.store.manage({ agentId: 'a', action: 'unpin', target: 'Deploy', createdBy: by });
      A.ok(!res.ok && pinned(r), 'B: the store refuses an unpin by ' + by + label);
    }
  }
  // ---- C. the Commander's path ----
  {
    const r = rig(staged);
    r.store.manage({ agentId: 'a', action: 'create', name: 'Deploy', body: '1. build', createdBy: 'user' });
    const p = r.tools.manageTool.run({ action: 'pin', target: 'Deploy' }, { agentId: 'a', runId: 'run-1' });
    A.ok(p.summary === 'pin' && pinned(r), 'C: a model may still pin a skill (it only adds the lock)' + label);
    const u = r.store.manage({ agentId: 'a', action: 'unpin', target: 'Deploy', createdBy: 'user' });   // POST /api/agent-skills/manage
    A.ok(u.ok && !pinned(r), 'C: the Commander unpins it from ABILITIES > SKILLS' + label);
  }
}
A.report('skills.pin-lock');
