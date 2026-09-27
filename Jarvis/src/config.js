// Settings live in the OS user-data folder, never in the repo. The API key is encrypted with
// Electron's safeStorage (DPAPI on Windows, Keychain on macOS) when available. Env vars
// JARVIS_BASE_URL / JARVIS_API_KEY / JARVIS_MODEL override the file, handy for demos.
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const DEFAULTS = {
  // Any OpenAI-compatible endpoint with tool calling: Groq, OpenRouter, Together, a local
  // Ollama / vLLM / llama.cpp server. Defaults to an open-weights model.
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  autoApproveLow: false,
};

function file() {
  return path.join(app.getPath("userData"), "jarvis-config.json");
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

function decryptKey(stored) {
  if (!stored.apiKeyEnc) return stored.apiKey || "";
  try {
    return safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, "base64"));
  } catch {
    return "";
  }
}

function load() {
  const stored = readFile();
  return {
    baseUrl: process.env.JARVIS_BASE_URL || stored.baseUrl || DEFAULTS.baseUrl,
    model: process.env.JARVIS_MODEL || stored.model || DEFAULTS.model,
    apiKey: process.env.JARVIS_API_KEY || decryptKey(stored),
    autoApproveLow: stored.autoApproveLow ?? DEFAULTS.autoApproveLow,
  };
}

// What the renderer is allowed to see: never the key itself.
function publicView() {
  const c = load();
  return { baseUrl: c.baseUrl, model: c.model, hasKey: Boolean(c.apiKey), autoApproveLow: c.autoApproveLow };
}

function save(update) {
  const stored = readFile();
  if (typeof update.baseUrl === "string") stored.baseUrl = update.baseUrl.trim().replace(/\/+$/, "");
  if (typeof update.model === "string") stored.model = update.model.trim();
  if (typeof update.autoApproveLow === "boolean") stored.autoApproveLow = update.autoApproveLow;
  if (typeof update.apiKey === "string" && update.apiKey.trim()) {
    const key = update.apiKey.trim();
    if (safeStorage.isEncryptionAvailable()) {
      stored.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
      delete stored.apiKey;
    } else {
      stored.apiKey = key;
      delete stored.apiKeyEnc;
    }
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(stored, null, 2));
  return publicView();
}

module.exports = { load, publicView, save };
