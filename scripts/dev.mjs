#!/usr/bin/env node
// Small, honest process launcher for the project -- start/stop/status without leaving orphaned
// uvicorn or Jarvis processes behind between demo runs. We only ever signal a PID this script
// itself recorded in pid.json, and we re-check the recorded command line before killing it,
// which is enough to avoid killing an unrelated process that happens to reuse the PID.
//
//   node scripts/dev.mjs demo     server + extension build check + Jarvis, then a checklist
//   node scripts/dev.mjs start    server only
//   node scripts/dev.mjs stop     stop server and Jarvis
//   node scripts/dev.mjs status
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const serverDir = path.join(root, "server");
const jarvisDir = path.join(root, "Jarvis");
const extensionDir = path.join(root, "extension");
const pidFile = path.join(__dirname, "pid.json");
const logFile = path.join(__dirname, "server.log");
const port = process.env.PORT || "8100";
const pythonExe = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";

function readPidFile() {
  if (!existsSync(pidFile)) return {};
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return {};
  }
}

function writePidFile(data) {
  writeFileSync(pidFile, JSON.stringify(data, null, 2));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLineOf(pid) {
  try {
    if (process.platform === "win32") {
      // wmic is deprecated/absent on recent Windows builds -- Get-CimInstance is the
      // supported replacement.
      return execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`
      ).toString();
    }
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

const serverAlive = (rec) => rec && isRunning(rec.pid) && commandLineOf(rec.pid).includes("uvicorn");
const jarvisAlive = (rec) => rec && isRunning(rec.pid) && /electron/i.test(commandLineOf(rec.pid));

function start() {
  const state = readPidFile();
  if (serverAlive(state.server)) {
    console.log(`Server already running (pid ${state.server.pid}, port ${state.server.port}).`);
    return;
  }
  if (!existsSync(path.join(serverDir, pythonExe))) {
    console.log("Server venv missing. Run ./start.sh once (or see README Setup), then try again.");
    process.exit(1);
  }
  // detached:true is what lets the child outlive this script on BOTH platforms -- on Windows
  // it's required (not just POSIX) for the child to survive this process exiting.
  const log = openSync(logFile, "a");
  const child = spawn(pythonExe, ["-m", "uvicorn", "app.main:app", "--port", port], {
    cwd: serverDir,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true
  });
  child.unref();
  writePidFile({ ...state, server: { pid: child.pid, port, startedAt: new Date().toISOString() } });
  console.log(`Started server (pid ${child.pid}) on port ${port}. Logs: scripts/server.log`);
}

async function waitForHealth(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function startJarvis() {
  const state = readPidFile();
  if (jarvisAlive(state.jarvis)) {
    console.log(`Jarvis already running (pid ${state.jarvis.pid}).`);
    return;
  }
  if (!existsSync(path.join(jarvisDir, "node_modules", "electron"))) {
    console.log("Installing Jarvis dependencies (first run)...");
    execSync("npm install --no-audit --no-fund", { cwd: jarvisDir, stdio: "inherit" });
  }
  // The electron package's main export is the path to the Electron binary; spawning that
  // directly (not the .cmd shim) is what lets it run detached on Windows.
  const electronPath = createRequire(path.join(jarvisDir, "package.json"))("electron");
  const child = spawn(electronPath, ["."], { cwd: jarvisDir, detached: true, stdio: "ignore" });
  child.unref();
  writePidFile({ ...readPidFile(), jarvis: { pid: child.pid, startedAt: new Date().toISOString() } });
  console.log(`Started Jarvis (pid ${child.pid}). Toggle it with Ctrl+Shift+J.`);
}

function stop() {
  const state = readPidFile();
  for (const [name, alive] of [["server", serverAlive], ["jarvis", jarvisAlive]]) {
    const rec = state[name];
    if (!rec) continue;
    if (alive(rec)) {
      process.kill(rec.pid);
      console.log(`Stopped ${name} (pid ${rec.pid}).`);
    } else {
      console.log(`${name}: recorded pid ${rec.pid} is gone or reused, not killing it.`);
    }
  }
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

function status() {
  const state = readPidFile();
  console.log(serverAlive(state.server) ? `Server: running, pid ${state.server.pid}, port ${state.server.port}` : "Server: not running");
  console.log(jarvisAlive(state.jarvis) ? `Jarvis: running, pid ${state.jarvis.pid}` : "Jarvis: not running");
}

async function demo() {
  if (!existsSync(path.join(serverDir, ".env"))) {
    console.log("!! server/.env missing: copy server/.env.example to server/.env and add PLANNER_API_KEY.\n");
  }
  start();
  const health = await waitForHealth();
  if (!health) {
    console.log("Server did not come up. Check scripts/server.log.");
    process.exit(1);
  }
  console.log(`Planner: ${health.planner_model} via ${health.endpoint} ${health.open_weights ? "(open-weights)" : "(NOT open-weights: set PLANNER_MODEL in server/.env)"}`);
  console.log(`Jarvis model: ${health.jarvis_model}`);

  if (!existsSync(path.join(extensionDir, "dist", "manifest.json"))) {
    console.log("Building the extension (first run)...");
    execSync("npm install --no-audit --no-fund && npm run build", { cwd: extensionDir, stdio: "inherit" });
  }
  startJarvis();

  const page = pathToFileURL(path.join(root, "demo", "fixture.html")).href;
  console.log(`
Demo checklist
  1. chrome://extensions -> Developer mode -> Load unpacked -> ${path.join(extensionDir, "dist")}
     (already loaded? click its reload icon so it picks up the latest build)
  2. Open the demo page: ${page}
  3. Click the extension icon to open the side panel. The header should say "Server online".
  4. Press Ctrl+Shift+J for Jarvis and try:
       "Fill in the scholarship form in Chrome. My email is priya.sharma@example.org"
  Script: DEMO.md. Stop everything: node scripts/dev.mjs stop`);
}

const cmd = process.argv[2];
if (cmd === "start") start();
else if (cmd === "stop") stop();
else if (cmd === "status") status();
else if (cmd === "demo") await demo();
else console.log("Usage: node scripts/dev.mjs <demo|start|stop|status>");
