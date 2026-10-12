# SecondShift backend — product direction

Set by Scott, 2026-10-12. The demo runs on Claude via Abacus; production does not.

## 1. Go-to-market brain: a small, local, task-specific model
- Booking is a narrow task: understand what the caller said and fill five fields (problem, name,
  number, address, preferred time), plus yes/no and an emergency flag. A small local model is
  enough, with **no per-token cost** and lower, steadier latency.
- Candidates: a small instruct model through Ollama / llama.cpp (both serve the OpenAI-compatible
  API the `openai`/`ollama` providers already speak), an ONNX model run in-process, or a fine-tuned
  classifier plus slot-filler trained on pilot transcripts.
- **Abacus/Claude is the demo and an optional cloud provider only.** Use it sparingly: test runs
  default to rules only (`SECONDSHIFT_LLM_PROVIDER=none`), and short yes/no turns never call a model.

**The swap point is already in place, so a local model needs no rework elsewhere:**
- `src/brain/llm.js` defines one contract: `json(system, user) -> object | null`, where null means
  "no answer". Providers today: `abacus`, `anthropic`, `openai`-compatible, `ollama`, `none`.
- `src/brain/understand.js` treats the model as advisory. The deterministic rules run first, and a
  grounding guard rejects anything the caller didn't say, so a weaker local model can't make up a
  booking. Any error or timeout (over 5 s) falls back to the rules.
- The rest of the call is scripted and independent of the model: the opening line, which question
  comes next, slot finding, confirmation, booking, emergency routing and transcript-only storage.
- To try a model: `SECONDSHIFT_LLM_PROVIDER=ollama SECONDSHIFT_LLM_MODEL=<model> node test/e2e-sim.js onebreath`
  checks it on real speech against the same pass/fail checks.

**Next steps for the local brain:**
- Build an evaluation set from pilot transcripts (labelled turns → expected fields). Then compare
  1–4B instruct models, measuring field accuracy and latency.
- Pick the smallest model that matches Claude on the evaluation set. A fine-tuned slot-filler is the
  fallback if the general-purpose models don't measure up.

## 2. An MCP interface from the start
Being reachable by other AI agents is table stakes, so SecondShift should be agent-reachable from day one.

**MCP server (SecondShift as a tool).** Planned tools:
- `check_availability(tenant, from, to)`: the open slots, using the same `slots.js` logic as the phone flow.
- `book_service(tenant, name, phone, address, issue, start)`: goes through the same scheduler and the
  same owner email as a phone booking.
- `get_call_summaries(tenant, since)`: call outcomes and transcripts, subject to the tenant's
  recording settings.
- `get_tenant_profile(tenant)`: hours, service area, and the emergency policy (but not the on-call
  number).
- Transport: Streamable HTTP alongside the voice server, with per-tenant auth.

**MCP client (SecondShift using tools).** Calendar and CRM become pluggable through MCP tools. The
calendar today exposes `busy()` and `create()`; an `mcpCalendar` adapter would follow the same
contract, so a shop's existing calendar or CRM agent can be used without a custom integration.

**Design rule now:** booking logic stays in `booking/` and is driven only through
`scheduler.findSlot` / `scheduler.book`, so the phone call and the MCP server share one path. Build
the MCP server after the demo.

## 3. Latency
- A phone silence over about 2 s feels broken.
- Through Abacus, Claude Haiku took 3.5–4.5 s on a long, one-breath first message, because Abacus
  runs it with hidden reasoning switched on. That's exactly why production needs a local model:
  cloud latency varies and is out of our control.
- Demo trims already in place:
  - `reasoning_effort: "minimal"`: about 0.7 s per model call;
  - short yes/no answers skip the model;
  - fixed lines are pre-rendered, so the greeting plays in about 20 ms.
- The demo measures 1.0–1.8 s from the caller finishing to the agent speaking. Most of that is
  speech-recognition end-of-turn detection, not the model.
- Further gains are for production: a local model, sending speech recognition's partial results to
  the model before the caller finishes, and starting playback before the whole reply has been
  turned into audio.
