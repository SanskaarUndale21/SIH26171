# Privacy-Preserving Browser Agent (SIH 26171)

On-device visual perception for a lightweight browser agent, plus a desktop assistant that
hands it work. A Chrome extension redacts PII locally before anything leaves the browser; a
FastAPI server plans the next action from the sanitized context only, using an open-weights
model. **Jarvis**, a tray assistant on the desktop, sends browser tasks to the extension through
the same server and applies the same redact-before-cloud rule to everything it sends.

```
 Jarvis (desktop)  --- goal with placeholders --->  FastAPI server  <--- masked screenshot,
   redacts chat &                                    (hub + planner      manifest, DOM skeleton
   tool output locally  <--- step summaries ----      + model proxy)  ---> next action --->  Chrome extension
                                                          |                                  (on-device ViT/YOLO/
                                                   open-weights LLM/VLM                       OCR/NER/BlazeFace,
                                                                                              redaction, agent loop)
```

Run the whole thing: `node scripts/dev.mjs demo`. Demo script: [DEMO.md](DEMO.md).

## What is in it

1. **Live on-page redaction overlay** (`extension/src/content/overlay.ts`): the extension draws
   the actual redaction boxes on the live page (outlines + type/confidence labels), so what got
   protected is visible without devtools.
2. **DOM + vision fusion** (`extension/src/privacy/fuse.ts`): DOM types and names (password,
   email, tel, Aadhaar, PAN, account number, DOB, OTP/CVV, address) are authoritative and always
   masked; vision (OCR + regex, OCR + NER, BlazeFace) covers everything the DOM can't see, like
   names in plain inputs, photos and PII printed as page text. A `<textarea>` or `<select>` the
   DOM confirms safe suppresses an overlapping vision false positive.
3. **Confidence fusion instead of first-hit-wins** (`extension/src/privacy/confidence.ts`):
   detectors agreeing on a span combine with a noisy-OR; a weak lone detection is still masked
   (fail-safe), never silently dropped.
4. **One set of PII rules** (`shared/pii-rules.json`): email, cards (Luhn), Aadhaar (Verhoeff),
   PAN, phone, IP, `password: ...` style secrets. Used by the extension on OCR text and by
   Jarvis on chat and tool output.
5. **A real multi-step agent loop** (`extension/src/background/index.ts`): observe, redact,
   plan, act, repeat until done, a 15-step budget, a failure, or cancel. Submit/payment/delete
   actions pause for the user. Values the planner can't know are asked for in the browser and
   filled locally (answer vault), never sent to the server.
6. **Server guards** (`server/app/safety.py`): the planner can't type into a masked region, and
   can't type a placeholder like `[EMAIL_1]`; both are rewritten regardless of what the model
   returns.
7. **Live latency and resource metrics** (side panel): every step shows capture, on-device
   perception (per detector), planner and action time, JS heap, WebGPU/WASM and KB sent; every
   run ends with a summary card.
8. **Jarvis hand-off** (`server/app/hub.py`, `Jarvis/`): Jarvis queues a browser task on the
   server, the extension claims it (side panel poll, or a 30 s alarm), runs it, and streams step
   summaries back. Confirmations and ask-user answers stay in the browser on purpose.
9. **Open-weights by default** (`server/app/planner.py`): Llama 4 Scout (vision) for the planner,
   Llama 3.3 70B for Jarvis, over any OpenAI-compatible endpoint (Groq, OpenRouter, Together,
   or self-hosted vLLM / Ollama). The side panel header warns if a closed model is configured.
10. **Fully local model weights** (`extension/public/`): Florence-2, YOLOv8n, BlazeFace, the NER
    model, Whisper-tiny and the Tesseract English data are bundled; perception needs no network
    access in either app.
11. **Same privacy tech on the desktop** (`Jarvis/src/perception.js`): Jarvis's
    `look_at_screen` captures the screen, masks it on-device (OCR + shared PII rules, NER, YOLO
    people) and sends only the masked image; it fails closed. Voice works in both apps with the
    same on-device Whisper model, plus spoken replies and spoken yes/no approvals.
12. **Real eval harness** (`eval/`): runs the shipping fusion/redaction/regex code against a
    labelled scholarship-form fixture. Current results (`eval/results.md`): detection recall
    100%, precision 91.3% on 32 items; pixel-level redaction precision 92.8%, mean IoU 0.988;
    text PII detector 100% precision and recall on 25 Indian-format cases.

Explicitly not included: a trained PII classifier (real training data + eval is a separate
project; the confidence-fusion scorer is the lightweight, honest version of that idea), and any
Qwen or other Chinese-origin model.

## Layout

- `extension/`: Manifest V3 extension.
  - `content/` reads the DOM, executes actions, draws the overlay. No ML code runs here.
  - `offscreen/` runs perception (OCR, NER, face/element detection, redaction) in a
    `chrome.offscreen` document under the extension's own CSP, since some sites block the
    Worker/`importScripts` calls the ML stack needs inside a content script.
  - `background/` runs the agent loop, talks to the server, relays progress for Jarvis tasks.
  - `sidepanel/` is the persistent chat UI with live metrics and confirmation prompts.
  - `public/` holds the bundled model weights and runtimes (~420MB).
- `server/`: FastAPI. `planner.py` (swappable `get_next_action`, Jarvis model proxy),
  `hub.py` (task bridge), `safety.py` (guards). Tests in `server/tests/`.
- `Jarvis/`: Electron tray assistant. See [Jarvis/README.md](Jarvis/README.md).
- `shared/`: PII rules used by both clients.
- `eval/`: eval harness and results. `demo/`: the scholarship-form test page.
- `scripts/dev.mjs`: launcher (`demo | start | stop | status`), tracks PIDs and never kills a
  process it didn't start. Server logs go to `scripts/server.log`.

## Setup (once)

```
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env   # add PLANNER_API_KEY (e.g. a Groq key)
cd ..\extension
npm install
npm run build
cd ..\Jarvis
npm install
```

Load `extension/dist` as an unpacked extension (`chrome://extensions`, Developer mode, Load
unpacked).

## Run

```
node scripts/dev.mjs demo
```

Starts the server, checks the model config, launches Jarvis and prints the checklist. Open
`demo/fixture.html`, open the side panel, then give the task either in the side panel or to
Jarvis (`Ctrl+Shift+J`).

## Tests

```
cd server && .venv\Scripts\python -m pip install -r requirements-dev.txt && .venv\Scripts\python -m pytest -q
cd Jarvis && npm test        # redaction, agent loop, and a full Jarvis -> server -> extension bridge test
cd eval && npm install && npm run eval
cd extension && npm run typecheck
```
