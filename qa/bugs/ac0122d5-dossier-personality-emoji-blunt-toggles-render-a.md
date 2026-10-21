---
fingerprint: ac0122d5
slug: dossier-personality-emoji-blunt-toggles-render-a
title: Dossier personality EMOJI / BLUNT toggles render as the browser's white checkbox
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/world
fix: ee35dabc6
origin: audit
---

# Dossier personality EMOJI / BLUNT toggles render as the browser's white checkbox

## Symptom

AGENT DOSSIER › CONFIG › PERSONALITY › FINE-TUNE PERSONALITY shows its EMOJI and BLUNT switches as the browser's own checkbox: a small white square with a grey rim beside the phosphor labels — OS paint inside the station hardware, the defect class the CONTROL FLOOR law forbids.

## Repro

1. Open CREW › AGENTS (the dossier), CONFIG tab, expand PERSONALITY, then FINE-TUNE PERSONALITY.
2. Look at (or read the computed style of) `#ag-persona-card input[data-persona-toggle]`.

## Evidence

Live sweep of every window + tab, computed style (sweep/world rig, 1440×900): the ONLY native-painted control in the app was `div.cf-group-body>div#ag-persona-card.cf-card>details>label.cf-desc>input` — `appearance:auto`, `colorScheme:normal`, `accent-color: rgb(255,170,51)`. A clip screenshot showed two white UA boxes next to "EMOJI" and "BLUNT". Cause: the dossier's switch skin is keyed on `.agent-dossier .set-row input[type="checkbox"]` (`frontend/css/agent-dossier.css`), and these toggles are emitted inline in a `label.cf-desc` (`frontend/app/stationui.js` `data-persona-toggle`); the CONTROL FLOOR only sets `accent-color`, which tints a CHECKED tick and never the unchecked box.

After the fix: computed `appearance:none`, track `rgba(255,170,51,.07)`, border `rgba(255,170,51,.4)`; the clip shows two station switches; a real CDP click toggles `checked` false→true (knob `left: 17px`) and back. Regression: `test/dossier-persona-toggle-skin.test.js` (red before the CSS rule, green after).

_Found by the `sweep/world` lane (no-white-controls failure state), 2026-10-20._

## Verdict

The two persona toggles now carry the dossier switch skin (`.agent-dossier input[data-persona-toggle]`, plus `:checked::after` knob), live-verified by computed style, a clip screenshot and a real click. The CONTROL FLOOR itself is unchanged (locked: element-level, no geometry); a bare checkbox anywhere else would still paint its unchecked box white — the live sweep of every window and tab found no other. Fix: `ee35dabc6`.
