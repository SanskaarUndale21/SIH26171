const path = require("path");
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, session: electronSession } = require("electron");
const config = require("./config");
const { Session, runTurn } = require("./agent");
const perception = require("./perception");

const HOTKEY = "CommandOrControl+Shift+J";
const ASSETS = path.join(__dirname, "..", "assets");

let win = null;
let tray = null;
let busy = false;
const session = new Session();
const pendingConfirms = new Map();

if (!process.argv.includes("--self-test") && !app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = 640;
  win = new BrowserWindow({
    width,
    height,
    minWidth: 340,
    minHeight: 420,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#0b0f17",
    icon: path.join(ASSETS, "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Closing the window only hides it; Jarvis keeps living in the tray until Quit.
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function showWindow() {
  win.show();
  win.focus();
  win.webContents.send("window:shown");
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, "tray-icon.png"));
  tray = new Tray(icon);
  tray.setToolTip(`Jarvis (${HOTKEY.replace("CommandOrControl", "Ctrl")})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Jarvis", click: showWindow },
      { label: "New chat", click: () => { session.reset(); win.webContents.send("chat:cleared"); showWindow(); } },
      { label: "Settings", click: () => { showWindow(); win.webContents.send("settings:open"); } },
      { type: "separator" },
      { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
    ])
  );
  tray.on("click", toggleWindow);
}

function send(event) {
  if (win && !win.isDestroyed()) win.webContents.send("agent:event", event);
}

function askConfirm(action) {
  return new Promise((resolve) => {
    pendingConfirms.set(action.id, resolve);
    if (!win.isVisible()) showWindow();
  });
}

ipcMain.handle("chat:send", async (_e, text) => {
  if (busy) return { ok: false, error: "Still working on the last request." };
  const input = String(text || "").trim();
  if (!input) return { ok: false, error: "Empty message." };
  busy = true;
  try {
    await runTurn(session, input, {
      cfg: config.load(),
      emit: send,
      confirm: askConfirm,
      ctx: { hideWindow: () => win.hide(), showWindow },
    });
    return { ok: true };
  } catch (err) {
    send({ type: "error", text: err.message });
    return { ok: false, error: err.message };
  } finally {
    busy = false;
    for (const resolve of pendingConfirms.values()) resolve(false);
    pendingConfirms.clear();
  }
});

ipcMain.on("confirm:answer", (_e, { id, ok }) => {
  const resolve = pendingConfirms.get(id);
  if (resolve) {
    pendingConfirms.delete(id);
    resolve(Boolean(ok));
  }
});

ipcMain.handle("chat:reset", () => {
  if (busy) return false;
  session.reset();
  return true;
});

ipcMain.handle("config:get", () => config.publicView());
ipcMain.handle("config:set", (_e, update) => config.save(update || {}));
ipcMain.on("window:hide", () => win.hide());

// Push-to-talk: the renderer records and resamples to 16 kHz mono, Whisper runs here on-device.
ipcMain.handle("voice:transcribe", async (_e, samples) => {
  if (!perception.modelsAvailable()) return { ok: false, error: "Whisper model not found (extension/public/models)." };
  try {
    return { ok: true, text: await perception.transcribe(Float32Array.from(samples)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.on("second-instance", showWindow);

// `npm run self-test`: proves the on-device stack loads inside Electron (not just Node) before
// a demo. Uses a synthetic image, never the real screen; screen capture is only size-checked.
async function selfTest() {
  const sharp = require("sharp");
  const { desktopCapturer } = require("electron");
  const report = { modelsDir: perception.MODELS_ROOT };
  const step = (name) => console.error(`[self-test] ${name}`);
  try {
    step("redaction (OCR + NER + YOLO)");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="100%" height="100%" fill="#fff"/>
      <text x="30" y="80" font-family="Arial" font-size="32">Mail priya.sharma@example.org</text>
      <text x="30" y="150" font-family="Arial" font-size="32">Mobile 98765 43210, Rahul Verma</text></svg>`;
    const r = await perception.redactScreen(await sharp(Buffer.from(svg)).png().toBuffer());
    report.redaction = { masked: r.manifest.map((m) => m.type), ms: Math.round(r.timings.totalMs) };
    step("whisper");
    const t0 = performance.now();
    report.whisper = { text: await perception.transcribe(new Float32Array(16000)), ms: Math.round(performance.now() - t0) };
    step("screen capture");
    const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 320, height: 180 } });
    report.screenCapture = src ? "ok" : "no screen";
    report.ok = report.redaction.masked.includes("email") && report.redaction.masked.includes("phone");
  } catch (err) {
    report.ok = false;
    report.error = err.stack || String(err);
  }
  console.log(JSON.stringify(report, null, 2));
  await perception.shutdown();
  app.exit(report.ok ? 0 : 1);
}

app.whenReady().then(() => {
  if (process.argv.includes("--self-test")) return selfTest();
  if (process.platform === "win32") app.setAppUserModelId("com.hexabits.jarvis");
  // Only the microphone is ever granted, and only to Jarvis's own window.
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
    callback(permission === "media" && wc === win?.webContents)
  );
  createWindow();
  createTray();
  if (!globalShortcut.register(HOTKEY, toggleWindow)) {
    console.warn(`Could not register ${HOTKEY}; use the tray icon instead.`);
  }
  win.once("ready-to-show", showWindow);

  // JARVIS_SMOKE=<file.png>: render once, save a screenshot, exit. Used to check the UI in CI.
  if (process.env.JARVIS_SMOKE) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require("fs").writeFileSync(process.env.JARVIS_SMOKE, img.toPNG());
        app.isQuitting = true;
        app.quit();
      }, 1500);
    });
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void perception.shutdown();
});
app.on("window-all-closed", (e) => e.preventDefault());
