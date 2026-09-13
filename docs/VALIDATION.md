# Validation

## Automated

`npm test`: 36 passing tests covering:

- One-item acknowledgement, pause, completion boundaries, previous-item reopening and per-segment progress.
- Emergency priority, all four Parrot branches, repeated interruption, normal-checklist bookmarking and explicit restoration.
- Missing DJI emergency procedures; source text and order preservation; duplicate-source detection.
- Interim versus final transcripts, duplicate Check deliveries and stale acknowledgements after context changes.
- Invalid/revised saved state and safe paused restoration.
- Production startup requirements, signed sessions, authentication failures, CSRF/origin controls, guess limits and secret redaction.
- Fixed voice requests, scoped Scribe token creation, audio cache reuse, n8n bridge routing and failed Trello refresh retention.
- Audio interruption races: a delayed old response never plays after Emergency or Stop; cached audio plays without another network request.

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
- Both checks are manual workflows with execution-data saving disabled. They verify credential and endpoint access, not an end-to-end microphone session.

## Outstanding integration checks

- The [app-to-n8n bridge](https://n8n.onpointhq.com/workflow/P6nt6GLoaVDD7Gs3) is imported and remains unpublished. A dedicated private webhook guard must be selected on both webhooks and shared with the app server. Import can auto-select an existing Header Auth credential, so verify the guard explicitly before publishing. The reusable repository template retains credential placeholders.
- Cloudflare Access blocks local requests to n8n's management API. The separate `n8n-hooks.onpointhq.com` host is reachable and returns the expected unpublished-webhook response. No Cloudflare service token was needed for that connectivity check.
- No external HTTPS host has been selected or deployed.
- Real Scribe microphone transcription and app-server-to-n8n audio delivery still need an authenticated integration test.
- A physical iPhone Safari/Home Screen test remains necessary for microphone permissions, headset echo cancellation, voice interruption latency, audio routing, screen wake lock, background/resume behavior and storage persistence. A resized desktop browser is not a hardware test.
- The missing DJI procedures and repeated Parrot lost-link sequence remain source-content decisions for the owner.

The app is a checklist reader, not a certified aircraft monitoring or control system. Operational readiness has not been established by these software checks.
