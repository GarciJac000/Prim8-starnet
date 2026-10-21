---
fingerprint: 13dd465a
slug: at-phone-width-the-glass-topbar-keeps-the-level
title: At phone width the glass topbar keeps the level lamp and clips UPLINK / LINK DOWN off-screen
surface: world
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/world
fix: 3a89e04f4
origin: audit
---

# At phone width the glass topbar keeps the level lamp and clips UPLINK / LINK DOWN off-screen

## Symptom

At phone width (the starnetos.com live embed on a phone, or a desktop window dragged narrow — the Tauri window has no minimum width) the topbar still shows the COMMANDER level lamp and pushes the UPLINK cluster past the right edge: it reads "UPLI" and the ONLINE / LINK DOWN state is not on screen at all.

## Repro

1. Default (glass) skin, in game, viewport 390×844.
2. Read `#topbar` — level lamp display, `scrollWidth` vs `clientWidth`, and the `.tb-status` rect.

## Evidence

Live before (CDP `Emulation.setDeviceMetricsOverride` 390×844): `matchMedia('(max-width: 600px)').matches === true`, yet `#tb-station` computed `display: grid`; `#topbar` `scrollWidth 503` in a `378` box (overflow hidden); `.tb-status` at x 338–495. Screenshot: "UPLI" clipped at the right edge. Cause: the phone contract in `frontend/css/topbar.css` / `interface.css` (`@media (max-width: 600px) { #topbar #tb-station { display: none } }`, locked as text by `test/mobile-control-reachability.test.js`) is out-ranked by the default glass skin's `body.glass-demo:not(.hud-mode) #topbar #tb-station { display: grid; … }` and its 16px+16px `.tb-status` divider inset (`frontend/css/pipglass.css`).

After the fix (`pipglass.css` restates the phone rule at glass specificity): `#tb-station` `display:none`, `#topbar` `scrollWidth 378 = clientWidth 378`, UPLINK cluster at x 231–370, screenshot shows "UPLINK ● ONLINE"; 320/601/650/720/800 px all keep the cluster inside the bar. Regression: `test/mobile-topbar-glass-cascade.test.js` (reads the cascade, red before, green after).

_Found by the `sweep/world` lane (small-viewport failure state), 2026-10-20._

## Verdict

The phone-width topbar rule is restated inside `pipglass.css` at the glass skin's specificity; live at 390×844 the level lamp sheds and UPLINK ● ONLINE sits fully inside the bar. Fix: `3a89e04f4`.
