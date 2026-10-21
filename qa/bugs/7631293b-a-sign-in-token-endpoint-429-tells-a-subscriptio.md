---
fingerprint: 7631293b
slug: a-sign-in-token-endpoint-429-tells-a-subscriptio
title: A sign-in token-endpoint 429 tells a subscription user their account is out of credit
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 8650b980a
origin: audit
---

# A sign-in token-endpoint 429 tells a subscription user their account is out of credit

## Symptom

When OpenAI's (ChatGPT sign-in) or xAI/Kimi's sign-in service throttles a token refresh, the run fails with "Your provider account is out of credit — top it up, then try again." These are subscriptions with no wallet, and a refresh throttle is not a quota at all.

## Repro

1. Make `auth.openai.com/oauth/token` (or a device-OAuth provider's token URL) answer HTTP 429 to a refresh.
2. Classify the thrown error message the way the browser does (friendlyerror.js without `require`).

## Evidence

Before: `codex-auth.refreshTokens` threw "Codex provider quota exhausted (429). Credentials are still valid; retry after the limit resets."; `oauth-device` threw "Provider quota exhausted (429)…". Browser + node friendlyError of the codex message: `billing false | Your provider account is out of credit — top it up, then try again.` (the bare word "quota" falls to the billing pattern). This is defect 3 of the 07-27 Codex 429 support incident, recorded as unbuilt and still live on trunk.

Code: `sidecar/providers/codex-auth.js:194` and `sidecar/providers/oauth-device.js:196`. Regression: `test/oauth-refresh-throttle-copy.test.js` (RED 14 problems, GREEN 22).

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Both refresh-429 sentences now name the throttle ("…sign-in service is rate-limiting token refresh (HTTP 429). Your credentials are still valid; wait a minute and try again."), keep their codes (`codex_rate_limited` / `oauth_rate_limited`) and `reloginRequired:false`, and read as `rate_limit` on both friendlyerror paths. No live token-endpoint 429 was induced (the token URLs have no override); proven at the adapter seam with an injected fetch.
