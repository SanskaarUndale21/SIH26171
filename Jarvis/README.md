# Jarvis

Desktop companion to the SIH 26171 browser agent. Same rule as the extension: private data is
masked on this machine before anything reaches the model, and the model can still act on it
through placeholders it never sees the contents of.

## What it does

- Lives in the system tray. `Ctrl+Shift+J` toggles a small chat window in the corner.
- Talks to any OpenAI-compatible endpoint with tool calling (Groq, OpenRouter, Together, or a
  local Ollama / vLLM server). Defaults to an open-weights model.
- Can act on the machine: open a URL, launch an app, run a PowerShell/bash command, type text into
  the previously focused window, read or write the clipboard.
- **Every high-risk action waits for Allow / Deny.** Low-risk ones (open URL, clipboard) can be
  auto-approved from Settings.

## Privacy model

`src/redact.js` replaces emails, phone numbers, Aadhaar, PAN, Luhn-valid card numbers, IPs and
`password: ...` / `token=...` style secrets with stable placeholders such as `[EMAIL_1]`, both in
your messages and in tool output (clipboard, command results) before they go back to the model.
When the model uses a placeholder in a tool call, the real value is restored locally just before
the action runs, and the reply you see is restored too. The model's side of the conversation
only ever holds placeholders. `test/agent.test.js` checks exactly that against a fake LLM server.

The API key is stored encrypted with Electron `safeStorage` in your user-data folder, never in
the repo, and the UI can't read it back.

## Run

```
cd Jarvis
npm install
npm start
```

On first launch Settings opens: add your endpoint, model and key. Or set `JARVIS_BASE_URL`,
`JARVIS_MODEL`, `JARVIS_API_KEY` in the environment.

```
npm test        # redaction + agent loop tests
npm run icons   # regenerate assets/ from the SVG in scripts/make-icons.js
```

## Layout

- `src/main.js` window, tray, hotkey, IPC, approval flow
- `src/agent.js` redact, call model, run approved tools, loop (max 8 steps)
- `src/tools.js` tool definitions, risk tiers, execution
- `src/redact.js` local PII redaction and restore
- `src/llm.js` OpenAI-compatible client (plain fetch)
- `src/config.js` settings + encrypted key
- `src/preload.js` the only API the UI can call
- `src/renderer/` chat UI (sandboxed, CSP locked, no innerHTML for model output)
