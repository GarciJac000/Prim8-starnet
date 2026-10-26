# Autonomy Driver — Stage A build plan (the idle self-direction engine)

> The missing consumer. Slices 1–2 of the autonomy layer shipped a **posture dial** and a
> **cron self-initiation** path, but nothing reads the posture to actually drive idle work — so the
> agent never decides anything on its own. This plan builds that driver: when you go idle, the
> station either **earns more context** (asks one sharp question) or **does real reason/draft work**
> and leaves it on your desk — gated by how well it actually knows you.

Status: **PLAN ONLY — not started.** Lane: `autonomy`. Builds on `autonomy.js`, `autojobs.js`,
`dossier.js`, `profile.js`, `cron-driver.js`. See memory `starnet-autonomy-layer` for the locked vision.

---

## 1. What's already true (the foundation we're extending)

- **The dial persists but drives nothing.** [`autonomy.js`](../frontend/app/autonomy.js) models
  `INITIATIVE (wait→propose→leash→free) × REACH (observe→sandbox→reach)`;
  [`autonomystore.js`](../frontend/app/autonomystore.js) persists it; the SETTINGS panel writes it.
  The **only** runtime reader is `autojobstore`, and it reads one boolean (`.enabled`). The rich
  read surface — `actsUnattended` / `buildsUnattended` / `reachesOut` — is consumed by **nothing**.
  There is **no idle detection anywhere**.
- **A real autonomous execution path exists.** [`cron-driver.js`](../sidecar/cron-driver.js) runs work
  through `runOnce` with `surface:'autonomous'`, places a **workitem on the conveyor** (the sprite
  walks to its desk — the visible payoff), assembles the reply, and records the outcome. We reuse the
  *pattern*; the new part is the **trigger** (idle, not schedule) and the **work selection**.
- **The anti-slop pattern is written.** [`autojobs.js`](../frontend/app/autojobs.js) — a grounding-gated
  directive + strict-tagged parse + the deterministic gate — is the template for the selection pipeline.
- **The dossier is confirmed-only and already carries what we need.**
  [`dossier.js`](../frontend/app/dossier.js): every belief has `source` (provenance), `createdAt`/`updatedAt`
  (**recency**), `pinned` (importance), and `summary()` returns per-dim `counts`, `known`/`blank`, and a
  ready-made **`familiarity`** (fraction of dims known). It **never auto-infers** — every belief is
  user-authored/confirmed. So the deterministic readiness floor is a **pure read over existing data; no
  new field is required**.
- **A separate "observed" layer exists.** [`profile.js`](../frontend/app/profile.js) is a time-decaying
  affinity vector ("what you actually work on"), deliberately kept *out* of confirmed beliefs.

---

## 2. The converged design (decisions already locked with Andrew)

| Decision | Choice |
| --- | --- |
| **Trigger** | **Idle in-session** — no interaction for N minutes while the app is open. |
| **First-slice scope** | **Reason/draft only** — no Reach grant; same achievable-now envelope as `autojobs`. |
| **Below the confidence floor** | **Earn context, then act** — spend the idle cycle asking one sharp question; graduate to doing work once confidence crosses the bar (the flywheel). |
| **Confidence measure** | **Hybrid** — a deterministic floor (hard gate) + a model-judged per-candidate score that must cite a real belief (engine verifies the citation). |

**The governing rule (ceiling vs earned):** the dial is the ceiling the Commander *permits*; confidence
is the level the station has *earned*; it operates at the **lower of the two and always says which is
binding** ("you set me free, but I'm still learning you — here's a question instead of a guess").
`WAIT` means nothing ever, regardless of confidence.

**Implementation note (2026-10-21, bug 41b2d015 — the decisions above are unchanged; the bug stays open for
Andrew's ruling):** the deterministic floor's numbers moved from "goals + 4 dossier areas, or 4 recent runs" to
one fresh *grounded* aim or one recent user run (`frontend/app/autopilot.js` `HOT_MIN` / `ACTIVITY_HOT_MIN` = 1).
The trust line below still holds: a goals belief only counts when its weight is stated / synth / observed — a
`seed` (the quick-setup chip's canned purpose, a thin run's synthesis and its BELIEF lines, a dig reply written
before the Commander typed anything, any doc copy; `dossier.js` WEIGHTS; `onboarding.js` labels each write by what
the Commander gave; a mission they TYPE at the fallback question — quick setup, a keyless wake, a synthesis that
could not land — is `stated`) is known breadth, never acting grounds. So a Commander whose awakening gave nothing of their
own still sees "earn context, then act" until they say what they want or run one task. Whether a chosen away posture may lift even
that hold (the DECISIONS "no usage walls" conflict the bug names) is the owner's call, not this note's. The
per-candidate half is unchanged: every job must cite a real belief or run, clear `MIN_ACT_SCORE`, and survive
the self-critique.

**Two-tier grounding maps onto the ask→propose→act ladder:**
- **Confirmed beliefs (dossier)** may ground **acting**.
- **Observed affinity (profile)** may only ground **proposing** — and, crucially, it **targets the
  cold-start question** ("you spend most of your time on X — is that a goal?"). The answer converts soft
  signal into a confirmed belief, which unlocks acting. That is the flywheel's fuel.
- **Trust line:** inferred/observed signal may *propose* but never *act*; only confirmed beliefs cross
  the acting line.

---

## 3. Architecture — pure engine + thin store (mirrors `autojobs.js` / `pitch.js`)

Two new files, same discipline as every other proactive subsystem:

### `frontend/app/autopilot.js` — the PURE engine (clock-injected, node-testable, NO `Date.now`/`Math.random`)
The deterministic scaffold; the model fills only narrow reasoning slots.

- **`readiness(dossierSummary, beliefsByDim, now)`** → `{ tier: 'cold'|'warm'|'hot', familiarity, freshKnownDims, perDim }`.
  Derived purely from existing dossier data: a dim counts as *usable* only if it is **known AND not
  stale** (recency via `updatedAt` vs `now`). `pinned` and belief count raise per-dim strength.
- **`effectiveMode(posture, readiness)`** → `'act' | 'earn' | 'none'`. Implements the ceiling-vs-earned
  rule: `min(dial-allows, confidence-earned)`. Returns the binding reason for legible messaging.
- **`shouldRun(state)`** → `{ go, mode, reason }`. The gate, ordered like `autojobs.shouldPropose`:
  posture-on → graduation (`firstPitchDone`) → idle (`now - lastActivity ≥ idleMs`) → under today's
  leash budget → not already running → not in onboarding/intake/dialogue. Side-effect free (testable).
- **The 5 archetypes (locked):** `advance-goal · kill-pain · prep-next · maintain-extend · scout`, each
  with its **required dim** (no usable grounding in that dim → archetype ineligible). Fixed tie-break
  order when scores are close: `advance › kill-pain › prep › maintain › scout`.
- **Selection pipeline (directive builders + strict parsers, mirroring `autojobs`):**
  - `buildCandidateDirective(beliefs, eligibleArchetypes, envelope)` — hands the model the beliefs,
    demands **typed candidates each citing a specific belief**, constrained to the **reason/draft
    envelope** (no tools/web/writes/sends — same wording `autojobs` uses).
  - `parseCandidates(text)` — strict tagged parse; **drops any candidate whose citation doesn't match a
    real belief** (the grounding veto — structure overrules the model).
  - `scoreAndSelect(candidates)` — deterministic score = grounding-strength × model-confidence, + the
    fixed tie-break, + the **confidence gate** (nothing clears the bar → `none`/downgrade, never ship
    slop). The per-user **learn** re-weighting hooks here later.
  - `buildDoDirective(selected)` / `parseDeliverable(text)` — one self-contained reason/draft run that
    ends with a clear draft.
  - `buildCritiqueDirective(deliverable, spec, style, standingOrders)` / `parseCritique(text)` — the
    self-review pass: adversarially check the draft against its own spec + the Commander's
    `style`/`standing_orders` before it hits the desk; fail → revise once or drop.
  - `buildQuestionPick(blankAndStaleDims, observedAffinity)` — the **earn-context** branch: choose the
    highest-value dim to ask about, biased by observed affinity; reuse the existing curiosity question
    shape so the ask honors the awakening-question rule (concrete, never "it-depends").

### `frontend/app/autopilotstore.js` — the thin live wiring (the clock + the side effects)
- **READ-ONLY bus citizen** — `.on()`s what it needs, **never `.emit()`s** (keeps `lint-emits` green).
- Owns: `lastActivity` stamp, today's autonomous-action count (resets at the local day boundary), the
  idle check, and fire-once/anti-nag bookkeeping. Self-persists its **own** localStorage key
  (`starnet.autopilot.v1`); no `save.js` change. `reset()` on new hero.
- **Idle stamping:** lightweight listeners (pointer/key/chat-send) stamp `lastActivity` at the edge.
- **The tick:** reuse the existing app loop / a single `setInterval` at the edge → gather inputs
  (`AutonomyStore.summary()`, `DossierStore.summary()` + `beliefs(dim)`, `ProfileStore.summary()`,
  `PitchStore.done()`, run-in-flight + `Dialogue.isOpen()`/`Onboarding.isRunning()`/`Intake.isRunning()`)
  → `Autopilot.shouldRun` → branch:
  - **`earn`** → open one curiosity question via the existing `Dialogue` path; commit the answer through
    `DossierStore.upsert(dim, { text, source:'curiosity' })` (the path `chat.js:597` already uses).
  - **`act`** → run the pipeline via `Harness.chat`:
    - selection/critique calls are **`internal:true`** (deliberation — doesn't count, per the honesty seam);
    - the actual work run is **`isTask:true, surface:'autonomous'`** (counts honestly, conveyor-visible);
    - `placeWorkitem(agentId, prompt, runId)` so the sprite walks to its desk;
    - deliver the draft to the desk + a single honest beat ("while you were heads-down I drafted X —
      it's on your desk").
- **Anti-nag:** every proactive surfacing (the earn question, the "I did X" beat) goes through the
  **one shared post-run beat slot** the other proactive stores already arbitrate — never two asks at once.

### Wiring touchpoints (`app.js`)
- `AutopilotStore.init({...deps})` alongside the other store inits.
- Add `AutopilotStore.reset()` to the new-hero reset block (next to `AutonomyStore.reset()` at
  [`app.js:1011`](../frontend/app/app.js)).
- Register the activity listeners + the idle tick at the composition edge (where `Date.now` is allowed).

---

## 4. The confidence model, concretely (no new data model needed for Stage A)

**Deterministic floor (hard gate) — pure read over `DossierStore`:**
- `firstPitchDone` (graduation) required — reuse `PitchStore.done()`.
- A dim is **usable** iff `known` AND its newest belief is **not stale** (`now - updatedAt < staleMs`).
- Tiers (tunable constants): **cold** = below the propose bar; **warm** = goals usable + ≥2 usable dims
  (the existing `shouldPropose` bar) → may **propose**; **hot** = warm + the archetype's required dim
  usable (+ optionally a `pinned`/multi-belief depth signal) → may **act**.
- The bar to **act** is strictly above **propose**, strictly above **ask**.

**Model score (soft, per-candidate):** the model rates each candidate and must cite a belief; the engine
verifies the citation exists (`parseCandidates` veto). Model proposes, structure vetoes — robust on weak
models (the same property that made the First Pitch reliable on gpt-4o-mini).

**Deferred (not needed to ship):** a numeric per-belief strength and an explicit decay flag — proxied
today by `pinned` + recency + count.

---

## 5. Build slices (each additive, each green before merge)

> Per `CLAUDE.md`: do this in a **worktree** (`gen-trees\new-agent-tree.ps1 autopilot`) on
> `agent/autopilot`; never feature-edit the integration tree. `npm run test:fast` green + rebase-sync
> before merge. `shared/events.js`/`shared/schema.js` are additive-only and owned by `cortex-memory` —
> request, don't edit (see §6).

### Slice A1 — Idle substrate + posture wiring + the **earn-context** branch
The smallest thing that makes the dial visibly *do something*, at zero run cost.
- `lastActivity` stamping + idle detection + the pure `shouldRun`/`readiness`/`effectiveMode` gate.
- The `earn` branch only: when idle + posture-on + below the act floor → ask **one** curiosity question
  (observed-affinity-targeted), commit the answer to the dossier, honor the one-ask beat slot.
- **Observable proof:** with the dial at BUILD/FREE and a thin dossier, stepping away pops exactly one
  grounded question; answering it raises `familiarity`; WAIT produces nothing.
- **Tests:** `autopilot.test.js` (readiness tiers, gate matrix, question-pick); `autopilotstore.test.js`
  (idle math, day-count reset, branch dispatch w/ mocked deps, never-emits, reset-on-new-hero);
  `newhero-reset.test.js` (+`AutopilotStore.reset()`). Chain into `test:fast`.

### Slice A2 — The **act** branch: anti-slop selection → one reason/draft run → desk
The meat.
- `buildCandidateDirective` → `parseCandidates` (grounding veto) → `scoreAndSelect` (tie-break +
  confidence gate) → `buildDoDirective` → `parseDeliverable`.
- Execute: selection `internal:true`; work run `isTask:true, surface:'autonomous'`; `placeWorkitem` →
  conveyor; deliver draft to the desk + one honest beat.
- Leash/day accounting: increment on a completed act; cap at `posture.leashPerDay`; reset at day boundary.
- **Observable proof:** idle + hot dossier → a crate appears, the sprite works, a grounded draft lands on
  the desk citing a real goal/pain; an ungrounded candidate is dropped, not shipped.
- **Tests:** candidate parse + veto, score/tie-break/confidence-gate, deliverable parse, leash accounting,
  the `internal` vs `isTask` split.

### Slice A3 — Self-critique + the "while you were away" digest + the learn hook
- `buildCritiqueDirective`/`parseCritique`: review the draft vs its spec + `style`/`standing_orders`
  before delivery; fail → revise once or drop (idle-doing-nothing beats slop).
- **Digest:** compose a "while you were heads-down" summary from **existing data only** (runstore + xp
  milestones + deliverables — **no new events**, per the frozen contract), surfaced on return-to-activity
  (the "you're back" hook). Truthful: what ran / produced / skipped.
- **Learn hook:** a per-item *useful / not* control on each delivered draft; record the signal so
  `scoreAndSelect` can re-weight per-user later (the compounding moat — wiring now, weighting later).
- **Tests:** critique parse + revise/drop, digest composition from fixtures, the feedback round-trip.

---

## 6. Contract & coordination (keep the frozen spine untouched)

- **Prefer zero new events.** The work run reuses `surface:'autonomous'`. The digest composes from
  existing data. The dossier/profile/pitch reads already exist.
- **One open question for the contract owner (`cortex-memory`):** the autonomous run's `trigger` value.
  `cron-driver` uses `trigger:'schedule'`; an idle-driven run is honestly `trigger:'self'` (or `'idle'`).
  If `trigger` is enum-validated in `shared/schema.js`, this is an **additive** request — get the new
  value added by the owner, or reuse `'autonomous'`/`'schedule'` until then. **Do not edit the shared
  files directly.**
- **Beat arbiter:** the earn-question and the "I did X" beat must register with the existing single
  post-run beat slot (the pitch/suggest/seed/curiosity arbiter) — one ask per task, anti-nag.
- **Determinism lint:** the pure `autopilot.js` must stay clock-/RNG-free. Note (from the autonomy memory):
  `lint-determinism.js` does **not** currently scan `frontend/app/` — enforce by inspection, and consider
  extending the lint as a follow-up.

---

## 7. Safety posture (why Stage A is safe by construction)

- The work run is `surface:'autonomous'` → the consent broker (`sidecar/permissions.js`) **default-denies**
  tools/network/writes. So "reason/draft only" is **enforced by the platform**, not just by prompt — even a
  misbehaving model can't send/spend/overwrite in Stage A.
- No Reach grant is introduced. `REACH` stays capped at `sandbox`/`observe` behavior regardless of dial,
  because nothing yet honors `reachesOut`. Raising that ceiling is **Stage B**.
- Everything is logged + surfaced (the dial's `describe()` already promises "you see everything it did").

---

## 8. Out of scope — Stage B (the careful, later slice)

The **Reach axis** as a real capability: the standing-grant trust UX so `SANDBOX` actually writes files
locally and `REACH-OUT` can send/publish/spend — the grant-management knot flagged in the autonomy memory
(grants currently live in RAM, reset on restart). Designed deliberately, not fast, after Stage A proves the
selection loop is trustworthy. Stage A is explicitly built so that turning Reach on later is the *only*
new risk surface.

---

## 9. File-change summary

| File | Change |
| --- | --- |
| `frontend/app/autopilot.js` | **new** — pure idle-driver engine (readiness, gate, archetypes, pipeline directives/parsers) |
| `frontend/app/autopilotstore.js` | **new** — thin store (idle stamping, the tick, branch dispatch, persistence, reset) |
| `frontend/app/app.js` | init + new-hero reset + activity listeners + idle tick (edge wiring only) |
| `frontend/index.html` | load the two new scripts |
| `test/autopilot.test.js` | **new** — pure-engine tests |
| `test/autopilotstore.test.js` | **new** — wiring tests (mocked deps) |
| `test/newhero-reset.test.js` | + `AutopilotStore.reset()` |
| `package.json` | chain the new tests into `test:fast` |

No changes to `shared/*`, `sidecar/*` (pending the §6 trigger decision), or the save envelope schema.
