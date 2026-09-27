// Actions Jarvis can take on this machine. Each has a risk tier: "low" actions can be
// auto-approved from Settings, "high" ones always wait for the user to click Allow.
const { spawn } = require("child_process");
const { shell, clipboard } = require("electron");

const IS_WIN = process.platform === "win32";
const MAX_OUTPUT = 4000;

const BROWSER_TASK_TIMEOUT_MS = 6 * 60 * 1000;

const TOOLS = [
  {
    name: "browser_task",
    risk: "high",
    // Placeholders stay placeholders: the goal goes to the SIH server and on to the planner,
    // so real values must not be restored into it. The browser asks the user for them locally.
    restoreArgs: false,
    description:
      "Hand a task to the privacy-preserving browser agent in Chrome (the SIH extension): fill in forms, " +
      "click, navigate on the user's current tab. The extension redacts the screen on-device before " +
      "anything reaches the planner, and you get step summaries back. Use this for anything inside a web page.",
    parameters: {
      goal: { type: "string", description: "What to do in the browser, in plain words. Keep placeholders like [EMAIL_1] exactly as written." },
    },
    required: ["goal"],
  },
  {
    name: "look_at_screen",
    risk: "high",
    description:
      "Look at what is on the user's screen right now. The screenshot is redacted on this computer first " +
      "(OCR + PII rules, NER for names, YOLO for people) and only the masked image goes to a vision model. " +
      "Use when the user refers to something on their screen.",
    parameters: { question: { type: "string", description: "What to find out from the screen." } },
    required: ["question"],
  },
  {
    name: "open_url",
    risk: "low",
    description: "Open a web page in the default browser.",
    parameters: { url: { type: "string", description: "Full http(s) URL" } },
    required: ["url"],
  },
  {
    name: "open_app",
    risk: "high",
    description: "Launch an installed application or open a file/folder path, e.g. 'notepad', 'calc', 'C:\\\\Users'.",
    parameters: { target: { type: "string", description: "App name or path" } },
    required: ["target"],
  },
  {
    name: "run_command",
    risk: "high",
    description: `Run a ${IS_WIN ? "PowerShell" : "bash"} command and return its output. Prefer read-only commands.`,
    parameters: { command: { type: "string" } },
    required: ["command"],
  },
  {
    name: "type_text",
    risk: "high",
    description: "Type text into whichever window had focus before Jarvis was opened.",
    parameters: { text: { type: "string" } },
    required: ["text"],
  },
  {
    name: "read_clipboard",
    risk: "low",
    description: "Read the current clipboard text (PII in it is redacted before you see it).",
    parameters: {},
    required: [],
  },
  {
    name: "write_clipboard",
    risk: "low",
    description: "Put text on the clipboard.",
    parameters: { text: { type: "string" } },
    required: ["text"],
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function openAiTools() {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: "object", properties: t.parameters, required: t.required },
    },
  }));
}

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    const add = (d) => {
      if (out.length < MAX_OUTPUT * 2) out += d.toString();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      child.kill();
      out += "\n[timed out]";
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`Failed to start: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim().slice(0, MAX_OUTPUT) || "(no output)";
      resolve(code === 0 ? text : `exit code ${code}\n${text}`);
    });
  });
}

function shellRun(command) {
  return IS_WIN
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command])
    : run("/bin/bash", ["-lc", command]);
}

// SendKeys treats + ^ % ~ ( ) { } [ ] as control syntax; wrap each in braces to type it literally.
function sendKeysEscape(text) {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, "{ENTER}");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Queues the goal on the SIH server, then follows the extension's progress events until the
// run finishes. Confirmations and ask-user prompts are answered in the browser, not here.
async function runBrowserTask(goal, ctx) {
  if (!goal.trim()) return "No goal given.";
  const hub = ctx.hubUrl;
  let task;
  try {
    const res = await fetch(`${hub}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, source: "jarvis" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return `The SIH server refused the task (${res.status}).`;
    task = await res.json();
  } catch {
    return `Can't reach the SIH server at ${hub}. Start it with: node scripts/dev.mjs demo`;
  }

  ctx.progress("Sent to the browser agent. Waiting for Chrome to pick it up...");
  const lines = [];
  const started = Date.now();
  let after = 0;
  let status = task.status;
  let hinted = false;
  while (Date.now() - started < BROWSER_TASK_TIMEOUT_MS) {
    await sleep(1000);
    let view;
    try {
      const res = await fetch(`${hub}/api/tasks/${task.id}?after=${after}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      view = await res.json();
    } catch {
      continue;
    }
    after = view.next;
    status = view.status;
    for (const ev of view.events) {
      lines.push(ev.text);
      ctx.progress(ev.text);
    }
    if (status === "pending" && !hinted && Date.now() - started > 8000) {
      hinted = true;
      ctx.progress("Still waiting. Open the extension's side panel in Chrome so it picks this up right away.");
    }
    if (status !== "pending" && status !== "running") break;
  }
  if (status === "pending" || status === "running") lines.push("Timed out waiting for the browser agent.");
  return `Browser task ${status}.\n${lines.join("\n")}`;
}

const VISION_PROMPT =
  "You are looking at a screenshot of the user's desktop. Black rectangles are private data that was " +
  "masked on the user's computer before you received the image. Never guess what is under a black box; " +
  "refer to it only by its type (e.g. 'a masked email address'). Answer the question briefly.";

async function captureScreen() {
  const { desktopCapturer, screen } = require("electron");
  const display = screen.getPrimaryDisplay();
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const [source] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  if (!source) throw new Error("No screen available to capture.");
  return source.thumbnail.toPNG();
}

// Capture -> redact on-device -> send only the masked image. Fails closed: if redaction
// throws or the models are missing, nothing leaves the machine.
async function lookAtScreen(question, ctx) {
  const sharp = require("sharp");
  const { redactScreen, modelsAvailable } = require("./perception");
  const { chatCompletion } = require("./llm");
  if (!modelsAvailable()) {
    return "On-device models not found (expected in extension/public), so the screen was not sent anywhere.";
  }

  ctx.hideWindow();
  await sleep(350); // let the Jarvis window get out of the shot
  let png;
  try {
    png = await captureScreen();
  } finally {
    ctx.showWindow();
  }
  ctx.progress("Captured the screen. Masking private data on this computer...");

  let result;
  try {
    result = await redactScreen(png);
  } catch (err) {
    return `On-device redaction failed (${err.message}), so the screen was not sent.`;
  }
  const counts = {};
  for (const m of result.manifest) counts[m.type] = (counts[m.type] || 0) + 1;
  const names = { person_name: "name", person: "person", phone: "phone", email: "email", card: "card", aadhaar: "aadhaar", pan: "pan", secret: "secret", ip: "ip address" };
  const kinds = Object.entries(counts).map(([t, n]) => `${names[t] || t}${n > 1 ? ` ×${n}` : ""}`).join(", ");
  const preview = await sharp(result.masked).resize({ width: 640 }).jpeg({ quality: 70 }).toBuffer();
  ctx.image(`data:image/jpeg;base64,${preview.toString("base64")}`);
  const secs = (result.timings.totalMs / 1000).toFixed(1);
  ctx.progress(
    result.manifest.length
      ? `Masked ${result.manifest.length} ${result.manifest.length === 1 ? "area" : "areas"} on this computer in ${secs} s (${kinds}). Only the masked image is sent.`
      : `Checked the screen on this computer in ${secs} s and found nothing private to mask.`
  );

  const outgoing = await sharp(result.masked).resize({ width: 1600, withoutEnlargement: true }).png().toBuffer();
  const msg = await chatCompletion(ctx.cfg, [
    { role: "system", content: VISION_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `${question}\n\nMasked regions (types only): ${JSON.stringify(counts)}` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${outgoing.toString("base64")}` } },
      ],
    },
  ]);
  return msg.content || "(no answer)";
}

async function execute(name, args, ctx) {
  switch (name) {
    case "browser_task":
      return runBrowserTask(String(args.goal || ""), ctx);
    case "look_at_screen":
      return lookAtScreen(String(args.question || "Describe what is on the screen."), ctx);
    case "open_url": {
      let url;
      try {
        url = new URL(String(args.url));
      } catch {
        return "Invalid URL.";
      }
      if (!/^https?:$/.test(url.protocol)) return "Only http(s) URLs are allowed.";
      await shell.openExternal(url.href);
      return `Opened ${url.href}`;
    }
    case "open_app": {
      const target = String(args.target || "").trim();
      if (!target) return "No target given.";
      if (/[&|<>^"`;$]/.test(target)) return "Refused: target contains shell metacharacters.";
      if (IS_WIN) {
        return run("powershell.exe", ["-NoProfile", "-Command", "Start-Process", "-FilePath", `'${target.replace(/'/g, "''")}'`], 10000)
          .then((r) => (r === "(no output)" ? `Launched ${target}` : r));
      }
      const err = await shell.openPath(target);
      return err ? `Failed: ${err}` : `Opened ${target}`;
    }
    case "run_command":
      return shellRun(String(args.command || ""));
    case "type_text": {
      const text = String(args.text || "");
      if (!IS_WIN) return "type_text is only implemented on Windows.";
      ctx.hideWindow();
      await sleep(450); // let focus return to the previous window
      const esc = sendKeysEscape(text).replace(/'/g, "''");
      const r = await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `$w = New-Object -ComObject WScript.Shell; $w.SendKeys('${esc}')`,
      ]);
      return r === "(no output)" ? `Typed ${text.length} characters.` : r;
    }
    case "read_clipboard":
      return clipboard.readText() || "(clipboard is empty)";
    case "write_clipboard":
      clipboard.writeText(String(args.text || ""));
      return "Copied to clipboard.";
    default:
      return `Unknown tool ${name}`;
  }
}

module.exports = { TOOLS, byName, openAiTools, execute, sendKeysEscape };
