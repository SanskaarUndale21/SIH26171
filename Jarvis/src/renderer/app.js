// Chat UI. Everything the model or a tool produced is inserted with textContent, never
// innerHTML, so a crafted reply or command output can't inject markup into the window.
const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const sendBtn = $("sendBtn");
const statusEl = $("status");
const statusText = $("statusText");
const emptyEl = $("empty");

const actionCards = new Map();
let typingEl = null;
let busy = false;

const TOOL_LABELS = {
  open_url: "Open URL",
  open_app: "Launch app",
  run_command: "Run command",
  type_text: "Type text",
  read_clipboard: "Read clipboard",
  write_clipboard: "Write clipboard",
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function scroll() {
  log.scrollTop = log.scrollHeight;
}

function add(node) {
  emptyEl.hidden = true;
  log.appendChild(node);
  scroll();
  return node;
}

function setStatus(text, mode = "") {
  statusText.textContent = text;
  statusEl.className = `status ${mode}`;
}

function setBusy(on) {
  busy = on;
  sendBtn.disabled = on;
  if (on) setStatus("Working...", "busy");
}

function showTyping() {
  if (typingEl) return;
  typingEl = add(el("div", "typing"));
  for (let i = 0; i < 3; i++) typingEl.appendChild(el("span"));
}

function hideTyping() {
  typingEl?.remove();
  typingEl = null;
}

function shieldIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z");
  svg.appendChild(p);
  return svg;
}

function describeArgs(name, args) {
  switch (name) {
    case "open_url": return args.url;
    case "open_app": return args.target;
    case "run_command": return args.command;
    case "type_text":
    case "write_clipboard": return args.text;
    default: return Object.keys(args || {}).length ? JSON.stringify(args, null, 2) : "(no arguments)";
  }
}

function actionCard(action, auto) {
  const card = el("div", `action ${action.risk}`);
  const head = el("div", "action-head");
  head.appendChild(el("span", "action-name", TOOL_LABELS[action.name] || action.name));
  head.appendChild(el("span", `risk ${action.risk}`, action.risk === "high" ? "needs approval" : "low risk"));
  card.appendChild(head);
  card.appendChild(el("pre", "", describeArgs(action.name, action.args)));

  if (auto) {
    card.appendChild(el("div", "verdict", "Auto-approved (low risk)"));
  } else {
    const buttons = el("div", "buttons");
    const allow = el("button", "primary", "Allow");
    const deny = el("button", "deny", "Deny");
    const answer = (ok) => {
      window.jarvis.answer(action.id, ok);
      buttons.remove();
      card.appendChild(el("div", `verdict ${ok ? "ok" : "no"}`, ok ? "Allowed" : "Denied"));
      setStatus(ok ? "Running..." : "Working...", "busy");
    };
    allow.onclick = () => answer(true);
    deny.onclick = () => answer(false);
    buttons.append(allow, deny);
    card.appendChild(buttons);
    setStatus("Waiting for your approval", "busy");
    setTimeout(() => allow.focus(), 0);
  }
  actionCards.set(action.id, card);
  return add(card);
}

function actionResult({ id, ok, result }) {
  const card = actionCards.get(id);
  if (!card || !ok) return;
  const det = el("details", "result");
  det.appendChild(el("summary", "", "Output"));
  det.appendChild(el("pre", "", result));
  card.appendChild(det);
  scroll();
}

window.jarvis.on("agent:event", (ev) => {
  switch (ev.type) {
    case "thinking":
      showTyping();
      break;
    case "redacted": {
      hideTyping();
      const note = el("div", "note");
      note.appendChild(shieldIcon());
      note.appendChild(document.createTextNode(`${ev.count} private item${ev.count > 1 ? "s" : ""} masked in ${ev.where} (${ev.kinds.join(", ").toLowerCase()})`));
      add(note);
      break;
    }
    case "action":
      hideTyping();
      actionCard(ev.action, ev.auto);
      break;
    case "action_result":
      actionResult(ev);
      break;
    case "reply":
      hideTyping();
      add(el("div", "msg bot", ev.text));
      break;
    case "error":
      hideTyping();
      add(el("div", "msg error", ev.text));
      break;
  }
});

async function submit(text) {
  const value = (text ?? input.value).trim();
  if (!value || busy) return;
  input.value = "";
  autosize();
  add(el("div", "msg user", value));
  setBusy(true);
  const res = await window.jarvis.send(value);
  hideTyping();
  setBusy(false);
  if (res.ok) setStatus("Ready");
  else setStatus("Error", "error");
  input.focus();
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
  if (e.key === "Escape") window.jarvis.hide();
});
input.addEventListener("input", autosize);
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => submit(c.textContent)));

function clearLog() {
  for (const n of [...log.children]) if (n !== emptyEl) n.remove();
  actionCards.clear();
  emptyEl.hidden = false;
  setStatus("Ready");
}

$("newChat").onclick = async () => {
  if (await window.jarvis.reset()) clearLog();
};
$("hide").onclick = () => window.jarvis.hide();
window.jarvis.on("chat:cleared", clearLog);
window.jarvis.on("window:shown", () => input.focus());

// settings
const sheet = $("settings");
async function openSettings() {
  const c = await window.jarvis.getConfig();
  $("cfgBase").value = c.baseUrl;
  $("cfgModel").value = c.model;
  $("cfgKey").value = "";
  $("cfgKey").placeholder = c.hasKey ? "Saved (leave blank to keep)" : "Paste your API key";
  $("cfgAuto").checked = c.autoApproveLow;
  sheet.hidden = false;
  $("cfgBase").focus();
}
$("openSettings").onclick = openSettings;
window.jarvis.on("settings:open", openSettings);
$("cfgCancel").onclick = () => (sheet.hidden = true);
$("cfgSave").onclick = async () => {
  await window.jarvis.setConfig({
    baseUrl: $("cfgBase").value,
    model: $("cfgModel").value,
    apiKey: $("cfgKey").value,
    autoApproveLow: $("cfgAuto").checked,
  });
  sheet.hidden = true;
  input.focus();
};

window.jarvis.getConfig().then((c) => {
  if (!c.hasKey) openSettings();
});
input.focus();
