const { contextBridge, ipcRenderer } = require("electron");

// The only surface the UI gets: no Node, no ipcRenderer, just these calls.
contextBridge.exposeInMainWorld("jarvis", {
  send: (text) => ipcRenderer.invoke("chat:send", text),
  reset: () => ipcRenderer.invoke("chat:reset"),
  answer: (id, ok) => ipcRenderer.send("confirm:answer", { id, ok }),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (c) => ipcRenderer.invoke("config:set", c),
  hide: () => ipcRenderer.send("window:hide"),
  on: (channel, fn) => {
    const allowed = ["agent:event", "chat:cleared", "settings:open", "window:shown"];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
