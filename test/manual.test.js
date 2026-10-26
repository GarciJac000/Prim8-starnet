/* node test/manual.test.js — the StarNet operator manual appended to the system prompt so an agent
   can guide a stuck Commander. Verifies it is deterministic, structurally defers to the authoritative
   capabilities block (so it can never over-promise THIS agent's powers), and names props/UI with the
   SAME labels the live floor uses (guards label drift). */
'use strict';
const A = require('./_assert.js');
const { starnetManual } = require('../sidecar/manual.js');

(function () {
  const m = starnetManual();

  // 1) non-empty string, and deterministic (resume-safe — same bytes every call, ignores any arg)
  A.eq(typeof m, 'string', 'returns a string');
  A.ok(m.length > 200, 'manual is substantive');
  A.eq(starnetManual(), m, 'deterministic: identical across calls');
  A.eq(starnetManual({ surface: 'interactive', role: 'lead' }), m, 'argless: ignores opts, same bytes');

  // 2) fenced as a manual block (so it reads as a distinct section, like <capabilities_ground_truth>)
  A.ok(/<starnet_operator_manual>/.test(m) && /<\/starnet_operator_manual>/.test(m), 'wrapped in the manual fence');

  // 3) NO-CONTRADICTION GUARANTEE: it explicitly defers to <capabilities_ground_truth> and disclaims
  //    that it is the agent's own power list — this is what keeps it from ever lying about what the agent can do.
  A.ok(/capabilities_ground_truth/.test(m), 'defers to the authoritative capabilities block');
  A.ok(/NOT a list of your own powers/i.test(m), 'disclaims being the agent\'s own capability list');

  // 4) prop → power pairings use the REAL live labels (worldmodel CAP_LABEL / capsummary). A mismatch here
  //    means the manual would tell the Commander to place the wrong thing — exactly the drift we guard against.
  A.ok(/DISH[^\n]*WEB/.test(m), 'pairing: DISH → WEB');
  A.ok(/INTEL CAB[^\n]*FILES/.test(m), 'pairing: INTEL CAB → FILES');
  A.ok(/WORKBENCH[^\n]*TERMINAL/.test(m), 'pairing: WORKBENCH → TERMINAL');
  A.ok(/SERVER CART[^\n]*MEMORY/.test(m), 'pairing: SERVER CART → MEMORY');
  A.ok(/WORKSTATION[^\n]*COMPUTE/.test(m), 'pairing: WORKSTATION → COMPUTE');

  // 5) the user-facing surfaces are named so the agent points at the right control
  A.ok(/BUILD MODE/.test(m), 'names BUILD MODE (the builder)');
  A.ok(/COMMS/.test(m), 'names COMMS (where you task an agent)');
  A.ok(/SCHEDULES/.test(m), 'names SCHEDULES (built-in scheduled work, AUTOMATE)');
  // the 0.13 dock (sweep 2026-10-02): every menu path the agent tells the Commander exists — no 0.12.5 dock buttons
  A.ok(!/⇄ ABILITIES|✉ CHANNELS|AUTOMATION \(dock|MCP CONNECTORS|Add a custom API key|BUILD STATION/.test(m), 'names no 0.12.5 dock button or removed tab');
  A.ok(/CONNECT › ABILITIES/.test(m) && /CONNECT › CHANNELS/.test(m) && /MY WORK/.test(m) && /AUTOMATE/.test(m), 'names the 0.13 menus');
  A.ok(/Recruitment Bay/.test(m), 'names the Recruitment Bay (summon)');
  A.ok(/APPROVAL/.test(m), 'names APPROVAL/APPROVALS');

  // 6) troubleshooting cues a stuck Commander actually hits
  A.ok(/NO COMPUTE/.test(m), 'troubleshoots the NO COMPUTE / needs-a-workstation case');
  A.ok(/CALL station\.inspect first/.test(m), 'live harness-state questions route to the authoritative inspector');
  A.ok(/needs no placed prop or approval/.test(m), 'self-inspection is correctly described as a base read');
  A.ok(/Never[\s\S]{0,160}invent a StarNet CLI command/.test(m), 'manual forbids guessing a diagnostic command');
  A.ok(/place the matching prop/i.test(m), 'tells the agent to place the matching prop for a missing power');
  A.ok(/Windows Task Scheduler/.test(m) && /OS crontab/.test(m), 'routine guidance points away from OS schedulers');

  /* 7) CONNECTING A PLATFORM (regression, 2026-07-28). A real Commander could not connect Google Drive and
        their agent made it worse: the manual's NAVIGATION section named COMMS/ROUTINES/TASKS/REFIT/Recruitment
        Bay/APPROVALS and NEVER the window where platforms are actually connected, so a model asked "how do I
        connect X" had nothing true to say and invented a menu path. These assertions pin the surfaces. */
  A.ok(/ABILITIES/.test(m), 'names the ABILITIES window (where platforms are connected)');
  A.ok(/\bAPPS\b/.test(m) && /CONNECTED › API KEYS/.test(m) && /CONNECTED, by address/.test(m), 'names the three connect routes, by the places on screen (ONE FLAT LIST 2026-10-26: APPS, CONNECTED › API KEYS, CONNECTED by address)');
  A.ok(/CHANNELS/.test(m), 'names the CHANNELS window (inbound messaging)');
  A.ok(/SETTINGS › AI & MODELS/.test(m), 'separates AI-provider keys from platform keys');

  /* 8) THE PROP RULE DOES NOT APPLY TO CONNECTORS — the defect that produced the "gaslighting". The manual
        used to list CONNECTOR PORTAL under "no prop placed means no power", but capability/office.js rides
        every configured connector onto the office unconditionally ("account-level, not a placed floor prop").
        So the agent authoritatively sent Commanders into REFIT to place a portal that is both unnecessary and
        a dead end (a portal binds a connectorId that only exists after ABILITIES configured it). */
  A.ok(/ACCOUNT-LEVEL/.test(m), 'states that a connector is account-level, not a placed prop');
  A.ok(/NEVER send the Commander to BUILD MODE to connect a platform/i.test(m), 'forbids the BUILD MODE dead end');
  A.ok(!/CONNECTOR PORTAL → an MCP/.test(m), 'CONNECTOR PORTAL is no longer listed as a prop that grants a connector');

  /* 9) ANTI-INVENTION. The agent has no catalog in its prompt, so absent the connectors.list tool (block 10)
        any specific claim about what is or is not connectable is a guess. It must route to the search box
        instead of improvising, and must not argue when the Commander reports that its suggestion failed. */
  A.ok(/HONESTY RULE/.test(m), 'carries the honesty rule for connect questions');
  A.ok(/NEVER\s+(?:assert|invent)/.test(m), 'forbids inventing menu paths / asserting catalog contents');
  A.ok(/universal fallback/i.test(m), 'names KEYS + web_request as the always-works fallback');

  /* 10) THE AGENT MUST USE THE HARNESS KNOWLEDGE IT ACTUALLY HAS (2026-07-29). `connectors.list` shipped
         2026-07-28 (sidecar/tools/builtin/connectors.js, capability `web`) and returns the REAL catalog —
         connected AND available-but-not-installed. The manual, written the same week, still told the agent
         flatly that it had no reliable list, which understated its own harness and left it guessing on the
         single most common request. So: route to the tool FIRST, and keep the don't-guess rule for the case
         where the agent genuinely lacks it (no dish placed → no `web` capability → no tool). */
  A.ok(/connectors\.list/.test(m), 'points the agent at the connectors.list tool for connect questions');
  A.ok(/If you have the connectors\.list tool, CALL IT/.test(m), 'tells the agent to call it rather than answer from memory');
  A.ok(/WITHOUT that tool you do NOT have a reliable/.test(m),
    'the anti-guessing rule is now scoped to the case where the tool is absent, not stated unconditionally');
  /* and the specific lie a Commander reports as gaslighting: "StarNet can't do that" when the truth is
     "that isn't connected yet". Those are different claims and the manual must separate them. */
  A.ok(/not connected YET/.test(m), 'separates "cannot reach" from "not connected yet"');

  // hygiene: no template leakage
  const clearSendTo = 'to:null clears it';
  A.ok(m.includes(clearSendTo), 'documents the intentional empty SEND TO destination');
  A.ok(!/undefined|null|\[object/.test(m.replace(clearSendTo, 'clearing the destination clears it')), 'no junk leaks outside the documented reset literal');

  A.report('manual.test');
})();
