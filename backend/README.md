# SecondShift backend (MVP)

The AI voice agent behind SecondShift: answers a shop's forwarded after-hours calls, books the job
into Google Calendar, routes emergencies to the on-call phone, and emails the owner a summary.
Separate from the marketing site in the repo root — its own deployable (`node src/server.js`), no npm
dependencies, Node 22+.

## How a call flows
1. Twilio number receives a forwarded call → `POST /voice/twilio` → TwiML `<Connect><Stream>` to `wss://…/media/twilio`, then `<Redirect>` to `/voice/twilio/after`.
2. **Phone layer** (`src/phone/`, from Tiny Paws v1.0): Twilio Media Streams, 8 kHz μ-law, barge-in "clear", playback marks.
3. **Brain** (`src/brain/`): Deepgram streaming STT → `BookingAgent` (issue → name → address → callback number → time → confirm) → Deepgram Aura TTS (μ-law, no transcoding). Understanding = deterministic rules, plus an optional OpenAI-compatible LLM whose output is only accepted when grounded in the caller's own words.
4. **Booking** (`src/booking/`): first open slot within business hours / lead time / existing calendar busy blocks / caller preference → Google Calendar event (or local file calendar).
5. **Emergencies**: keyword rules (+ optional model flag). With `emergency.transferNumber` set, the agent says the transfer line, closes the stream, and `/voice/twilio/after` returns `<Dial>` to the on-call number — **no Twilio REST credentials needed**. Without a number: books the earliest slot and flags URGENT.
6. **After the call**: transcript-only call log (`data/logs/calls.jsonl`), optional audio (`recording.storeAudio`), owner email via Gmail API (or local outbox).

## Disclosure / recording (configurable per shop, `tenants/<shop>.json`)
- `disclosure` — the opening line, `{shop}` filled in. Default: *"Thanks for calling {shop} — this call is recorded and answered by an automated assistant so I can book your service. How can I help?"*
- `recording.storeAudio` (default **false**: transcript only) and `recording.storeTranscript`.
- A compliance lint refuses to load a shop whose opening line doesn't name the shop, disclose the automated assistant, and (when anything is stored) say the call is recorded.

## Secrets (read from files at runtime; never committed)
Default dir `C:\Users\scott\secrets` (override `SECONDSHIFT_SECRETS_DIR`):
| File | Used for | Status |
|---|---|---|
| `Deepgram_api.txt` | STT + TTS | present, verified |
| `secondshift_google_oauth.json` | Calendar + Gmail | created by `node tools/google-auth.js` after Scott's consent |
| `secondshift_llm_key.txt` (+ `SECONDSHIFT_LLM_PROVIDER/MODEL/BASE_URL`) | optional LLM | not present (rules-only works) |
| `twilio_auth_token.txt` | webhook signature check | optional; not present |

## Run / test
```
npm test                  # 11 unit tests (time parsing, slots, agent flows, emergencies, lint, grounding guard)
npm run e2e               # simulated Twilio call against the real server: real Deepgram STT+TTS, booking, email
node test/e2e-sim.js emergency
npm start                 # PORT=8790; needs a public https URL (PUBLIC_BASE_URL) for Twilio
```
`/health` reports which modules are live vs falling back.

## Status (2026-10-12)
- **Verified:** simulated Twilio call end-to-end (real Deepgram STT/TTS) books correctly and emails the owner; emergency → `<Dial>` transfer; transcript-only storage.
- **Not yet verified:** a real phone call over Twilio (needs a public URL + a live number), Google Calendar / Gmail (needs consent), Twilio signature check.
- **Known gap:** reply latency ~1.5–2.5 s after the caller stops talking (STT end-of-turn detection); greeting plays in ~20 ms.
