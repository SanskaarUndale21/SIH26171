// Settings live in the OS user-data folder, never in the repo. The API key is encrypted with
// Electron's safeStorage (DPAPI on Windows, Keychain on macOS) when available. Env vars
// JARVIS_BASE_URL / JARVIS_API_KEY / JARVIS_MODEL / JARVIS_HUB_URL override the file.
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const DEFAULTS = {
  // By default Jarvis talks to the project's own server, which proxies to the configured
  // open-weights model (server/.env), so there is one key and one model config for the whole
  // project. Point this at any OpenAI-compatible endpoint to run Jarvis standalone.
  baseUrl: "http://localhost:8100/api/jarvis",
  model: "server-default",
  // The SIH server that bridges browser tasks to the extension.
  hubUrl: "http://localhost:8100",
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
    hubUrl: process.env.JARVIS_HUB_URL || stored.hubUrl || DEFAULTS.hubUrl,
    apiKey: process.env.JARVIS_API_KEY || decryptKey(stored),
    autoApproveLow: stored.autoApproveLow ?? DEFAULTS.autoApproveLow,
  };
}

// What the renderer is allowed to see: never the key itself.
function publicView() {
  const c = load();
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    hubUrl: c.hubUrl,
    hasKey: Boolean(c.apiKey),
    needsKey: !isLocal(c.baseUrl),
    autoApproveLow: c.autoApproveLow,
  };
}

function save(update) {
  const stored = readFile();
  if (typeof update.baseUrl === "string") stored.baseUrl = update.baseUrl.trim().replace(/\/+$/, "");
  if (typeof update.model === "string") stored.model = update.model.trim();
  if (typeof update.hubUrl === "string") stored.hubUrl = update.hubUrl.trim().replace(/\/+$/, "");
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

function isLocal(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url || "");
}

module.exports = { load, publicView, save, isLocal };
