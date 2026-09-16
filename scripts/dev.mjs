#!/usr/bin/env node
// Small, honest process launcher for the fusion-agent server -- start/stop/status without
// leaving orphaned uvicorn processes behind between demo runs. Deliberately much simpler
// than the PID-lineage-verification approach in one of the other SIH26171 attempts: we only
// ever signal a PID this script itself recorded in pid.json, and we re-check the recorded
// command line before killing it, which is enough to avoid killing an unrelated process that
// happens to reuse the PID -- full ancestry verification is more machinery than a hackathon
// demo launcher needs.
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, "..", "server");
const pidFile = path.join(__dirname, "pid.json");
const port = process.env.PORT || "8100";

function readPidFile() {
  if (!existsSync(pidFile)) return null;
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return null;
  }
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
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`
      ).toString();
      return out;
    }
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function start() {
  const existing = readPidFile();
  if (existing && isRunning(existing.pid) && commandLineOf(existing.pid).includes("uvicorn")) {
    console.log(`Already running (pid ${existing.pid}, port ${existing.port}).`);
    return;
  }

  const pythonExe = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
  // detached:true is what lets the child outlive this script's own process on BOTH
  // platforms -- on Windows it's required (not just POSIX) for the child to survive this
  // process exiting, which is easy to get backwards.
  const child = spawn(pythonExe, ["-m", "uvicorn", "app.main:app", "--port", port], {
    cwd: serverDir,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }, null, 2));
  console.log(`Started uvicorn (pid ${child.pid}) on port ${port}. Logs are not captured by this launcher; run in foreground for debugging: cd server && ${pythonExe} -m uvicorn app.main:app --port ${port}`);
}

function stop() {
  const existing = readPidFile();
  if (!existing) {
    console.log("Nothing recorded as running.");
    return;
  }
  if (!isRunning(existing.pid)) {
    console.log("Recorded process is already gone.");
    unlinkSync(pidFile);
    return;
  }
  if (!commandLineOf(existing.pid).includes("uvicorn")) {
    console.log(`Recorded pid ${existing.pid} is no longer the uvicorn process (PID reuse) -- not killing it.`);
    unlinkSync(pidFile);
    return;
  }
  process.kill(existing.pid);
  unlinkSync(pidFile);
  console.log(`Stopped pid ${existing.pid}.`);
}

function status() {
  const existing = readPidFile();
  if (!existing) {
    console.log("Not running (no pid.json).");
    return;
  }
  const running = isRunning(existing.pid) && commandLineOf(existing.pid).includes("uvicorn");
  console.log(running ? `Running: pid ${existing.pid}, port ${existing.port}, started ${existing.startedAt}` : "pid.json exists but process is not running.");
}

const cmd = process.argv[2];
if (cmd === "start") start();
else if (cmd === "stop") stop();
else if (cmd === "status") status();
else console.log("Usage: node scripts/dev.mjs <start|stop|status>");
