# Demo script (SIH 26171)

Target: 6 minutes, one story. A student asks a desktop assistant to fill a scholarship form.
Nothing personal ever reaches the server, and the judges can see that happen live.

## Before you walk in (10 min)

1. `server/.env`: set an **open-weights** planner (see `server/.env.example`), e.g. Groq with
   `meta-llama/llama-4-scout-17b-16e-instruct`. The side panel header must say
   **"(open-weights)"**, not "(not open-weights)".
2. `node scripts/dev.mjs demo` starts the server and Jarvis and prints the checklist.
3. Chrome: `chrome://extensions` -> reload the unpacked extension from `extension/dist`.
4. Open `demo/fixture.html`, open the side panel (extension icon). Header shows "Server online".
5. `cd Jarvis && npm run self-test` must print `"ok": true` (OCR, NER, YOLO, Whisper, capture).
   Do one full warm-up run. The first run loads the on-device models; later runs are faster.
   Keep that tab open so the models stay warm.
6. Have `eval/results.md` open in a second tab, and the terminal with `scripts/server.log`
   (`Get-Content scripts\server.log -Wait`) visible on a second screen if possible.
7. Backup: screen-record one clean run the day before, in case the venue network is bad.

## Flow

**1. The problem (30 s).** "Cloud agents need to see your screen. Your screen has your
Aadhaar, bank details and face on it. We keep the vision on the device and send the cloud only
a masked view."

**2. Jarvis hands off the task (60 s).** Press `Ctrl+Shift+J`, type:

> Fill in the scholarship form in Chrome. My email is priya.sharma@example.org

Point at:
- the green chip **"1 private item masked in message (email)"**: the model got `[EMAIL_1]`.
- the **Browser agent (Chrome)** approval card showing the goal with the placeholder. Click Allow.

**3. On-device perception + redaction (90 s).** Switch to Chrome.
- The page gets **live redaction boxes**: password, Aadhaar, PAN, card, CVV, OTP, account
  number, DOB, address, the photo, and the Aadhaar / card / mobile printed as page text.
- Side panel, each step: the redaction chips, then the metrics line, e.g.
  `4.1 s total · capture 90 ms · on-device 1.6 s · planner 2.2 s · act 40 ms`
  and `heap 310 MB · WebGPU · sent 84 KB · ocr ..., face ..., yolo ..., florence ..., ner ...`.
- Say it: "Everything before 'planner' happened on this laptop. 84 KB left the device, and
  it's a masked image plus field types, never values."

**4. The agent never guesses private data (60 s).**
- When it reaches the email field, the planner can't type `[EMAIL_1]` (the server guard turns
  that into a question). The side panel asks you. Answer there: "this answer never goes to the
  server". Jarvis's card shows **"Answer in the browser (stays local)"**.
- Before Submit, the **high-risk confirmation** appears, listing sensitive fields still empty.

**4b. Same tech on the desktop (45 s).** Click Jarvis's mic and say "What's on my screen right
now?" (on-device Whisper). Allow the **Look at screen** card: it shows the captured screen with
black boxes, captioned "What the model receives". Say "yes" to approve by voice.

**5. Numbers (60 s).** The **Run summary** card (steps, avg step, avg on-device, avg planner,
peak heap, regions masked, KB sent). Then `eval/results.md`:
- detection recall **100%**, precision **91.3%** on 32 labelled items,
- pixel-level redaction precision **92.8%**, mean IoU **0.988**,
- text PII detector **100% / 100%** on 25 Indian-format cases incl. look-alikes,
- and the two false positives we show on purpose, and why they are the safe failure.

**6. Close (30 s).** Map to the rubric: accuracy (DOM + vision fusion), PII recall/precision
(eval), redaction precision (pixel metric), client resources (heap, quantized models, WebGPU),
latency (per-step breakdown).

## Likely questions

- **Firefox?** Chrome is the demo target. The ML pipeline is plain Web APIs (WebGPU / WASM,
  ONNX Runtime Web). The Chrome-only parts are the offscreen document and side panel; on
  Firefox those map to a background page and `sidebar_action`. Not built yet, and we say so.
- **Which model?** Open-weights Llama 4 Scout (vision) for the planner and Llama 3.3 70B for
  Jarvis, via an OpenAI-compatible endpoint. Swappable for a self-hosted vLLM / Ollama with a
  one-line `.env` change.
- **What exactly does the server see?** Masked PNG, redaction manifest (type + box, no values),
  DOM skeleton (tags, labels, selectors, no values), and the goal with placeholders. The raw
  request is in `scripts/server.log`, so you can show it.
- **What if detection misses something?** DOM rules catch structured fields regardless of
  vision. A weak lone detection is still masked (fail-safe). The server guard blocks typing into
  masked regions and typing placeholders.
- **Why not blur?** Blur is reversible for text at low radius. Solid masks are not.
- **Is the eval real?** The fusion, redaction and regex code in the eval is the shipping code.
  The vision detections in the fixture are scripted inputs; live model accuracy is what the
  side panel shows on real pages. We say this upfront.

## If something breaks

- Side panel says "Server offline": `node scripts/dev.mjs demo` again.
- Jarvis says "Still waiting... open the side panel": the panel wasn't open. Open it; the
  background also polls every 30 s.
- Planner error in the panel: check `scripts/server.log` (usually the API key or model name).
- Stop everything: `node scripts/dev.mjs stop`.
