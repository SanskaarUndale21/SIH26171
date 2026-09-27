// Actions Jarvis can take on this machine. Each has a risk tier: "low" actions can be
// auto-approved from Settings, "high" ones always wait for the user to click Allow.
const { spawn } = require("child_process");
const { shell, clipboard } = require("electron");

const IS_WIN = process.platform === "win32";
const MAX_OUTPUT = 4000;

const TOOLS = [
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

async function execute(name, args, ctx) {
  switch (name) {
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
