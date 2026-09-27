# Privacy-Preserving Browser Agent (SIH 26171)

On-device visual perception for a lightweight browser agent. A Chrome extension redacts PII
locally before anything leaves the browser; a FastAPI server plans the next action from the
sanitized context only. Interaction happens through a persistent side panel (not a popup) —
a chat-style sidebar, similar to Brave's Leo or Edge Copilot, that stays open alongside the
page you're working on.

This is the single, consolidated build. It started as two parallel attempts at the same spec
and was merged into one project after surveying four independent teams' takes on the same
problem statement; see "What this combines" below for what was actually kept from that
comparison, and why.

## What this combines

1. **Live on-page redaction overlay** (`extension/src/content/overlay.ts`) — the extension
   draws the actual redaction boxes directly on the live page (colored outlines + type/
   confidence labels) instead of only logging the redacted payload to the console, so what
   got protected is visible without opening devtools.
2. **Confidence fusion instead of first-hit-wins** (`extension/src/privacy/confidence.ts`) —
   when independent detectors (regex + NER, say) both flag the same span, their confidences
   combine with a noisy-OR instead of keeping one arbitrary hit. Below
   `LOW_CONFIDENCE_THRESHOLD` a lone detection is still redacted by default (fail-safe), never
   silently dropped.
3. **DOM-confirmed-safe zones** (`extension/src/privacy/fuse.ts`) — a field the DOM
   structurally confirms is not single-value PII (a `<textarea>`, a `<select>`) suppresses an
   overlapping vision false positive, the same "DOM wins" rule applied in both directions.
4. **Real eval harness** (`eval/`) — bundles the actual `privacy/fuse.ts` +
   `perception/regex.ts` with esbuild and runs them against a ground-truth fixture
   (`eval/fixture.ts`) in Node; no mocked numbers. Run it with `cd eval && npm install && npm
   run eval` — regenerates `results.md` and `benchmark_output.json`.
5. **Safe dev launcher** (`scripts/dev.mjs`) — `node scripts/dev.mjs start|stop|status` runs
   the server detached and tracks its PID in `scripts/pid.json`, re-checking the recorded
   command line before ever killing anything, so repeated demo runs don't leave orphaned
   uvicorn processes or kill an unrelated process that reused the PID.
6. **Server-side type-into-redacted-region guard** (`server/app/safety.py`) — verified against
   a live model call: the planner can hallucinate a value and try to type it into a field it
   was never allowed to see the contents of. The server downgrades any such `type` action to a
   harmless `click` regardless of what the model returns.
7. **A real multi-step agent loop** (`extension/src/background/index.ts`) — not one action per
   click. The extension observes (DOM + screenshot), redacts, asks the planner, executes,
   folds the outcome into a short history, and observes again, until the planner says the task
   is done, a step budget (15) is hit, an action fails, or the user cancels. A submit/payment/
   delete-shaped (`risk_tier: "high_risk"`) action pauses and asks the user to confirm in the
   side panel before it runs — the one point that stays human-gated on purpose.
8. **Fully local model weights** (`extension/public/`) — BlazeFace, the NER model, YOLOv8n, and
   Florence-2 are all downloaded and bundled into the extension at build time, not fetched
   from a CDN on first use. Nothing about on-device perception depends on network access.

Explicitly not carried over from the comparison: a trained PII classifier (real training data
+ eval is a separate project in its own right; the confidence-fusion scorer above is the
lightweight, honest version of that idea), and any Qwen or other Chinese-origin model.

## Architecture

- `extension/` — Manifest V3 extension.
  - `content/` reads the DOM, executes actions, and draws the redaction overlay on the real
    page. Deliberately thin — no ML code runs here.
  - `offscreen/` runs the actual ML perception (OCR, NER, face/element detection, redaction)
    inside a `chrome.offscreen` document, under the extension's own CSP rather than whatever
    the host page enforces (some sites, e.g. Google Docs/Forms, block the Worker/
    `importScripts` calls the ML stack needs from inside a content script's context outright).
  - `background/` orchestrates the agent loop described above and is the only place that
    talks to the server.
  - `sidepanel/` is the persistent chat UI — opens on toolbar-icon click, stays open across
    navigation, streams each step of a run live, and is where a high-risk action's
    confirmation prompt appears.
  - `public/models/`, `public/yolo/`, `public/blazeface/`, `public/mediapipe-wasm/`,
    `public/tesseract/` — the bundled model weights and runtimes (~420MB total).
- `server/` — FastAPI. `planner.py` exposes a single swappable `get_next_action(...)`
  interface and is provider-agnostic (`PLANNER_BASE_URL`/`PLANNER_API_KEY` work with OpenAI,
  Groq, OpenRouter, Together, or a local model server) — no other file needs to change to
  swap the backend model.
- `eval/` — bundles and runs the real redaction/PII logic against a ground-truth fixture.
- `demo/` — a sample form fixture for manual testing.
- `scripts/` — the dev server launcher.
- `Jarvis/` — desktop companion (Electron tray assistant) with the same redact-before-cloud rule
  and per-action approval. See `Jarvis/README.md`.

## Setup

```
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env   # fill in your API key
cd ..
node scripts/dev.mjs start      # or: cd server && uvicorn app.main:app --port 8100

cd extension
npm install
npm run build
```

Load `extension/dist` as an unpacked extension (`chrome://extensions` → Developer mode → Load
unpacked). Click the extension icon to open the side panel, open `demo/fixture.html` in the
active tab, type a task goal, and run it.

To see the measured numbers instead of just reading the description above:

```
cd eval
npm install
npm run eval
```
