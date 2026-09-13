# OnPoint Sky — Voice Mission Checklist

An installable, iPhone-friendly checklist reader for DJI Air 3S and Parrot ANAFI USA. Reads the supplied Trello template items using ElevenLabs voice `TWutjvRaJqAX89preB4e` and advances one item when you say **check**.

**Implementation status:** local app, production build, and automated tests are complete. The existing n8n **ElevenLabs** Header Auth credential successfully generated audio with the specified voice and created a Scribe listening token. The app-to-n8n webhook guard, HTTPS deployment, and physical iPhone microphone test remain to be completed. The UI clearly identifies device speech when ElevenLabs is unavailable.

## Run locally

Requires Node.js 24+.

```sh
npm ci
cp .env.example .env
npm run dev
```

On Windows, use `Copy-Item .env.example .env`. Open `http://localhost:5173`. Without an ElevenLabs connection, you can use touch controls and the device voice. For browser speech recognition, open Voice settings and choose Device recognition. Browser support and network requirements vary.

```sh
npm test       # State machine, source fidelity, auth/API, audio interruption and caching
npm run build # TypeScript check, Vite build, offline service worker
npm start     # Serve the built app and API together on port 3001
```

## Use on iPhone

1. Open the deployed **HTTPS** address in Safari.
2. Tap **Share → Add to Home Screen → Add**.
3. Open the app. Select your aircraft and a segment, such as Pre-departure.
4. In Voice settings, unlock voice using your private app access code.
5. Tap **Enable voice** and allow microphone access. Keep the app open and the screen unlocked. A headset improves separation between your voice and the readout.
6. Complete each item, then say **check**. Check, Back, Repeat, Start/Resume and Pause also have touch controls.

| Say | Result |
| --- | --- |
| Check | Acknowledge exactly one active item and read the next |
| Repeat / Say again | Read the current item again |
| Back / Previous | Reopen the previous item |
| Pause / Hold | Stop reading; keep listening for commands |
| Start / Resume | Resume reading the current item |
| Pre-departure, On-site, Crew, Launch, In-flight, Landing, Post-flight | Select a normal segment |
| Emergency | Stop current audio and ask “Lost link, GPS, VLOS, or uncommanded input?” |
| Lost link / GPS / VLOS / Uncommanded input | Start that emergency procedure for the selected aircraft |
| Return to home | Open the Parrot RTH procedure while in emergency mode |
| Resume checklist | Leave emergency mode and restore the normal checklist, paused |

An emergency never automatically returns to normal operation. Repeating Emergency preserves the original normal-checklist bookmark. Aircraft and normal-segment changes are disabled during an emergency.

The interrupt is immediate **after recognition delivers the keyword**. Browser, microphone, network and speech recognition latency still apply. This web app cannot provide a background or lock-screen wake word. Returning from the background requires tapping the microphone again; the UI does not pretend listening is still active. Touch Emergency remains available when the microphone is off.

## Connect the existing n8n credential

The app supports an n8n bridge so the ElevenLabs API key can stay in n8n. `n8n/voice-bridge.json` is a reusable import template with credential placeholders. A [draft bridge is already imported](https://n8n.onpointhq.com/workflow/P6nt6GLoaVDD7Gs3) in the owner's n8n instance. Live manual checks verified both ElevenLabs endpoints using the existing **ElevenLabs** Header Auth credential, with header name `xi-api-key`. Its secret was not exported.

1. Open the existing draft bridge, or import `n8n/voice-bridge.json` into another n8n instance.
2. In both ElevenLabs HTTP Request nodes, choose the existing **Header Auth** credential whose header is `xi-api-key`. If the stored credential uses a dedicated ElevenLabs credential type, configure the HTTP Request nodes' predefined credential type to match; do not copy the secret into node fields.
3. Set both Webhook nodes to a private Header Auth credential named **OnPoint Sky Voice Guard**, header name `X-OnPoint-Voice`, with a strong randomly generated value.
4. Set the app server's `N8N_VOICE_SECRET` to that guard value and `N8N_VOICE_BASE_URL` to `https://n8n-hooks.onpointhq.com/webhook/onpoint-sky-voice` (the webhook host shown by this n8n instance).
5. If Cloudflare Access protects these webhook routes, configure an approved service token through `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Keep the existing access policy in place.
6. Test both speech and token routes using the guard header. Then publish the workflow and test the app's **Test voice** and **Enable voice** controls.

The bridge has separate `/speech` and `/token` webhooks, a fixed voice/model, a 3,000-character input limit, and execution-data saving disabled. Never remove the webhook authentication. The app never sends its permanent key to the iPhone; it obtains a short-lived single-use Scribe token for the microphone WebSocket.

Alternatively, provide `ELEVENLABS_API_KEY` directly as a **server-only** environment variable. The n8n bridge takes precedence if `N8N_VOICE_BASE_URL` is set. In bridge mode, keep the configured voice and model consistent with the fixed values in the workflow.

## Deploy with Coolify / Docker

The repository includes a multi-stage Dockerfile and health check. Create a Coolify application from this repository and select the Dockerfile build. Expose container port **3001** behind an HTTPS domain. Set these runtime variables:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Exact HTTPS app origin, without a trailing slash |
| `APP_ACCESS_CODE` | A private, strong passphrase used to unlock voice on your phone |
| `SESSION_SECRET` | A random server secret of at least 32 bytes |
| `N8N_VOICE_BASE_URL`, `N8N_VOICE_SECRET` | Your authenticated n8n bridge; or use `ELEVENLABS_API_KEY` |
| `ELEVENLABS_VOICE_ID` | `TWutjvRaJqAX89preB4e` (default) |
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` (default) |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Only when Cloudflare protects the n8n webhook |

Generate a session secret locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and put it directly into the server's secret settings. Do not commit it. Production startup refuses to run without an access code, session secret and HTTPS origin. `compose.yaml` binds the local container port to loopback for use behind a reverse proxy.

Do not deploy this as GitHub Pages or a static-only site: the voice endpoints require the Node server. The application has not yet been deployed.

## Checklist source and known gaps

Source board: [Flight Ops](https://trello.com/b/ZODVUaPx/flight-ops).

- [DJI Air 3S template](https://trello.com/c/Bw3sn6Oh/1-dji-air-3s-checklist): 7 normal segments, 107 normal items, and an 11-item generic Emergency Procedures checklist whose supplied contents address lost link. It is explicitly mapped to lost link. **GPS, VLOS and uncommanded-input procedures are absent.** The app shows and reads an unavailable message for those branches; it never uses Parrot procedures for DJI.
- [Parrot ANAFI USA template](https://trello.com/c/n4RDKJtB/3-parrot-anafi-usa): 7 normal segments and lost-link, GPS, VLOS, uncommanded-input and RTH procedures. **The lost-link source repeats the same 12 entries twice.** All 24 entries are preserved pending the owner's decision.
- Only the aircraft templates are imported. Mission names, addresses and historical cards are not bundled. The separate PostFlight_Template card was inspected but not imported: each aircraft already has its own post-flight segment, and the separate card contains DJI RC2-specific directions.

`data/trello-source.json` preserves source IDs, positions, item wording and import time. Rendering and speech trim leading/trailing whitespace. No operational procedure was generated or rewritten. Progress reflects the pilot's acknowledgements; it does not verify the aircraft state or modify the source Trello template.

To update the source, set server-only `TRELLO_API_KEY` and `TRELLO_TOKEN`. **Refresh from Trello** in settings atomically updates the runtime catalog only after both templates load successfully. A changed revision resets mission progress after confirmation. Runtime refreshes are held in server memory and on the device; for a durable baseline, run `npm run sync:trello`, review the diff and rebuild/redeploy. Restarting a server restores its bundled baseline.

## Offline behavior and privacy

- The production service worker caches the app shell, fonts and bundled checklists. First use requires connectivity. New service workers wait for old app windows to close, so updates do not replace a running mission.
- **Download aircraft audio** generates and caches all selected-aircraft speech and shared prompts. This uses ElevenLabs credits for uncached recordings. Downloads can be paused and resumed; cached recordings are reused. Each pack is scoped by checklist revision and voice configuration.
- Offline operation uses cached audio and touch controls. Speech recognition still requires a usable connection. Device speech is an explicitly identified fallback; it is not the requested ElevenLabs voice.
- Phone storage can be cleared or evicted. Re-verify the pack before departure. Progress is stored in localStorage; **Export progress** saves a JSON snapshot.
- Permanent credentials remain on the server or in n8n. Signed sessions use HttpOnly, Secure, SameSite cookies in production. API requests have authentication, origin checks, rate limits and an allowlist of speech items. Scribe sends microphone audio directly to ElevenLabs while enabled. Device recognition uses the browser's speech service.

See [validation notes](docs/VALIDATION.md) for what has and has not been verified.
