# Validation

## Automated

`npm test`: 39 passing tests covering:

- One-item acknowledgement, pause, completion boundaries, previous-item reopening and per-segment progress.
- Emergency priority, all four Parrot branches, repeated interruption, normal-checklist bookmarking and explicit restoration.
- Missing DJI emergency procedures; source text and order preservation; duplicate-source detection.
- Interim versus final transcripts, duplicate Check deliveries and stale acknowledgements after context changes.
- Invalid/revised saved state and safe paused restoration.
- Production startup requirements, signed sessions, authentication failures, CSRF/origin controls, guess limits and secret redaction.
- Fixed voice requests, scoped Scribe token creation, audio cache reuse, n8n bridge routing and failed Trello refresh retention.
- Audio interruption races: a delayed old response never plays after Emergency or Stop; cached audio plays without another network request.
- The hosted Request/Response adapter: signed-cookie round trips, byte-exact binary audio, origin and body-size enforcement, and resistance to spoofed forwarding headers in login limits.

`npm run build`: TypeScript validation and production build pass. The ElevenLabs client SDK is loaded separately from the initial interface. Its vendor chunk is approximately 139 KB gzip and generates Vite's default large-chunk advisory.

## Browser checks

Checked the actual app in Chromium at desktop size and at a 393 × 852 iPhone viewport:

- Aircraft selection, current item, source counts and segment selection.
- Start and Check from the fixed mobile control bar; one-item advancement.
- Emergency during playback, all four category buttons, unavailable DJI GPS branch, and normal-checklist restoration at the saved item.
- Switching to Parrot and selecting GPS starts “Announce: ‘GPS Issue.’” followed by its own manual-control item.
- Mobile Emergency hides the normal aircraft/segment panels and keeps the category choices reachable. Check remains fixed at the bottom for long items.

## Live ElevenLabs checks

On September 13, 2026, n8n executed both requests with the existing **ElevenLabs** Header Auth credential. The header name was corrected to `xi-api-key`; the stored secret was left in n8n.

- [Voice connection check](https://n8n.onpointhq.com/workflow/ZySPimmErb3xH2bT): the requested voice `TWutjvRaJqAX89preB4e` returned 57.3 kB of `audio/mpeg` for the app's voice-test phrase.
- [Listening connection check](https://n8n.onpointhq.com/workflow/Q7XXNbVcXKkY2dZQ): the realtime Scribe endpoint returned a nonempty single-use token, validated by a Code node without exposing the token in its output.
- These were manual endpoint checks, not an end-to-end microphone session. The browser's file import did not preserve the requested execution-storage settings; production bridge storage settings were subsequently set explicitly and verified by exporting the saved workflow.

## Deployed integration checks

[Live application](https://onpoint-sky-checklists.netlify.app), deployed September 13, 2026. [Deployment log](https://app.netlify.com/projects/onpoint-sky-checklists/deploys/6aa71e8bdcefc0e1463205a2).

- The n8n bridge is published. Export verification confirmed both webhooks select **OnPoint Sky Voice Guard**, outgoing HTTP nodes select **ElevenLabs**, and failed/successful/manual/progress execution payload saving is disabled.
- An unauthenticated n8n token request returned 403; the configured guard returned 200 with a token.
- The hosted app requires authentication. Anonymous audio returned 401; access-code login returned 200 and a Secure, HttpOnly session cookie.
- Authenticated hosted audio returned 200, `audio/mpeg`, and 55,633 bytes. The app's listening-token endpoint returned 200 with a token. Manifest and service worker returned 200.
- A real Scribe WebSocket accepted an app-issued token and started the requested `scribe_v2_realtime` session.
- Generated audio samples saying **Check**, **Emergency**, and **GPS** were streamed to the actual speech service. Its transcripts passed through the application's command gate and state engine, producing CHECK → EMERGENCY → GPS branch, with normal-checklist item index 1 preserved. This uses synthetic samples, not an iPhone microphone or acoustic echo test.
- Chromium rendered the live site at desktop and 393 × 852 sizes. Enable voice opened the private access-code screen. Local browser playback through the same bridge reached the Reading state without using device voice.

## Outstanding integration checks

- A physical iPhone Safari/Home Screen test remains necessary for microphone permissions, headset echo cancellation, voice interruption latency, audio routing, screen wake lock, background/resume behavior and storage persistence. A resized desktop browser is not a hardware test.
- The missing DJI procedures and repeated Parrot lost-link sequence remain source-content decisions for the owner.

The app is a checklist reader, not a certified aircraft monitoring or control system. Operational readiness has not been established by these software checks.
