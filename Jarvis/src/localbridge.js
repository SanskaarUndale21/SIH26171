// Private, on-this-computer channel between Jarvis and the browser extension.
//
// When a browser task Jarvis handed over needs something from the person (a masked value like
// [EMAIL_1], or an OK before submitting), the extension asks HERE instead of in its side panel.
// Jarvis either answers straight away with the value it is already holding locally, or asks the
// person (by voice or on screen) and returns the answer. None of this goes through the SIH
// planner server: values travel only between two processes on the same machine.
//
// Bound to 127.0.0.1 and only accepts requests from a chrome-extension:// origin.
const http = require("http");

const PORT = Number(process.env.JARVIS_LOCAL_PORT || 8766);
const PLACEHOLDER = /\[(SECRET|EMAIL|CARD|AADHAAR|PAN|PHONE|IP)_\d+\]/g;

const tasks = new Map(); // hub task id -> redactor holding that conversation's real values
const prompts = new Map(); // requestId -> { status, answer, approved, kind }
let handlers = { onPrompt: () => {}, onDismiss: () => {} };

function registerTask(taskId, redactor) {
  tasks.set(taskId, redactor);
}

function unregisterTask(taskId) {
  tasks.delete(taskId);
}

// Resolves every placeholder in `value` from the task's redactor, or null if any is unknown.
function resolvePlaceholders(redactor, value) {
  if (!value || !redactor) return null;
  const tokens = String(value).match(PLACEHOLDER);
  if (!tokens) return null;
  const restored = redactor.restore(String(value));
  return tokens.some((t) => restored.includes(t)) ? null : restored;
}

function answer(requestId, result) {
  const p = prompts.get(requestId);
  if (!p || p.status !== "pending") return false;
  Object.assign(p, result, { status: "answered" });
  return true;
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 20000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, status, obj, origin) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const origin = req.headers.origin || "";
  if (!origin.startsWith("chrome-extension://")) {
    res.writeHead(403);
    return res.end();
  }
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean); // ["prompts", id?, "cancel"?]

  if (req.method === "GET" && parts[0] === "health") return send(res, 200, { ok: true }, origin);

  if (req.method === "POST" && parts[0] === "prompts" && parts.length === 1) {
    const body = await readJson(req);
    const redactor = tasks.get(body.taskId);
    if (!redactor) return send(res, 404, { error: "not a Jarvis task" }, origin);
    // Asked for a value Jarvis already holds: answer at once, no human needed.
    if (body.kind === "ask") {
      const value = resolvePlaceholders(redactor, body.placeholder);
      if (value) {
        handlers.onPrompt({ ...body, auto: true });
        return send(res, 200, { status: "answered", answer: value, auto: true }, origin);
      }
    }
    prompts.set(body.requestId, { status: "pending", kind: body.kind });
    handlers.onPrompt({ requestId: body.requestId, taskId: body.taskId, kind: body.kind, text: String(body.text || "") });
    return send(res, 200, { status: "pending" }, origin);
  }

  if (parts[0] === "prompts" && parts[1]) {
    const p = prompts.get(parts[1]);
    if (!p) return send(res, 404, { error: "unknown prompt" }, origin);
    if (req.method === "POST" && parts[2] === "cancel") {
      // answered in the browser instead
      p.status = "cancelled";
      handlers.onDismiss(parts[1]);
      return send(res, 200, { status: "cancelled" }, origin);
    }
    if (req.method === "GET") {
      const out = { status: p.status, answer: p.answer ?? null, approved: p.approved ?? null };
      if (p.status !== "pending") prompts.delete(parts[1]);
      return send(res, 200, out, origin);
    }
  }
  send(res, 404, { error: "not found" }, origin);
}

function start(h) {
  handlers = { ...handlers, ...h };
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    });
  });
  server.on("error", (err) => console.warn(`Local bridge not started on ${PORT}: ${err.message}`));
  server.listen(PORT, "127.0.0.1");
  return server;
}

module.exports = { start, registerTask, unregisterTask, answer, resolvePlaceholders, PORT };
