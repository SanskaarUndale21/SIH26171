# Jarvis

Desktop half of the SIH 26171 project. Same rule as the browser extension: voice, screen and
personal data are processed on this computer, and only masked data reaches a model.

## Features

| | Browser extension | Jarvis (desktop) |
|---|---|---|
| Voice in | Whisper-tiny, on-device | Whisper-tiny, on-device (same model files) |
| Voice out | spoken progress | spoken replies (toggle in header) |
| Voice approvals | say yes / no to a confirm prompt | say yes / no to an approval card |
| Screen redaction | OCR + regex + NER + BlazeFace + YOLO + DOM fusion, black boxes | OCR + regex + NER + YOLO people, black boxes |
| Text redaction | shared PII rules on OCR text | shared PII rules on chat, clipboard, command output |
| What the model gets | masked screenshot + manifest + DOM skeleton | placeholders like `[EMAIL_1]`, masked screenshot |
| Human in the loop | submit / pay / delete need OK | every high-risk action needs Allow |

Both use `shared/pii-rules.json` (email, cards with Luhn, Aadhaar with Verhoeff, PAN, phone,
IP, secrets) and the model files bundled in `extension/public/`, so nothing is downloaded twice
and nothing is downloaded at runtime.

- Lives in the tray. `Ctrl+Shift+J` toggles the window. Mic button for push-to-talk.
- Tools: **browser_task** (hands a task to the extension through the SIH server),
  **look_at_screen** (capture, mask on-device, then ask the vision model), open URL / app, run a
  command, type text, clipboard.
- Talks to the SIH server by default (`http://localhost:8100/api/jarvis`), which proxies to the
  open-weights model in `server/.env`, so there is one key for the whole project. Requests with
  a (masked) image go to the vision model, text to the text model.

## Privacy model

`src/redact.js` swaps PII for stable placeholders (`[EMAIL_1]`) in messages and tool output.
Local tools get the real value back just before they run; tools that send data off the machine
(`browser_task`) keep placeholders, and the server refuses to type a placeholder into a page (the
browser asks the user instead).

`src/perception.js` masks the screen before `look_at_screen` sends it: Tesseract OCR +
the shared PII rules, BERT-NER for names, YOLOv8n for people, then solid black boxes. It fails
closed: if the models are missing or redaction throws, the screenshot is not sent. The card in
the chat shows exactly the masked image the model received.

Voice: the window records, resamples to 16 kHz mono and hands the samples to Whisper in the
main process. Silent clips are dropped (Whisper hallucinates words in silence). Replies are read
out by the OS speech engine. No audio leaves the machine.

## Run

```
npm install
npm start           # or from the repo root: node scripts/dev.mjs demo
npm run self-test   # proves OCR, NER, YOLO, Whisper and screen capture load inside Electron
npm test            # redaction, agent loop, on-device models, full Jarvis -> server -> extension bridge
```

`JARVIS_MODELS_DIR` overrides where the models are read from (default `../extension/public`).
The API key (only needed when not using the SIH server) is stored encrypted with `safeStorage`.

## Layout

- `src/main.js` window, tray, hotkey, IPC, approvals, mic permission, `--self-test`
- `src/agent.js` redact, call model, run approved tools, loop (max 8 steps)
- `src/tools.js` tools, risk tiers, browser hand-off, screen capture
- `src/perception.js` on-device OCR / NER / YOLO / Whisper, screen masking
- `src/redact.js` text PII redaction and restore (shared rules)
- `src/llm.js` OpenAI-compatible client, `src/config.js` settings + encrypted key
- `src/preload.js` the only API the UI can call; `src/renderer/` chat UI
