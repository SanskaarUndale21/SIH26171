const path = require("path");
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen } = require("electron");
const config = require("./config");
const { Session, runTurn } = require("./agent");

const HOTKEY = "CommandOrControl+Shift+J";
const ASSETS = path.join(__dirname, "..", "assets");

let win = null;
let tray = null;
let busy = false;
const session = new Session();
const pendingConfirms = new Map();

if (!app.requestSingleInstanceLock()) {
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
      ctx: { hideWindow: () => win.hide() },
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

app.on("second-instance", showWindow);

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.hexabits.jarvis");
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

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", (e) => e.preventDefault());
