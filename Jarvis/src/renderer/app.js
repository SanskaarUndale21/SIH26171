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
let pendingAnswer = null; // answers the current approval card; set while one is open
let typingEl = null;
let busy = false;

const TOOL_LABELS = {
  browser_task: "Browser agent (Chrome)",
  look_at_screen: "Look at screen (masked on-device)",
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
    case "browser_task": return args.goal;
    case "look_at_screen": return args.question;
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
      pendingAnswer = null;
      window.jarvis.answer(action.id, ok);
      buttons.remove();
      card.appendChild(el("div", `verdict ${ok ? "ok" : "no"}`, ok ? "Allowed" : "Denied"));
      setStatus(ok ? "Running..." : "Working...", "busy");
    };
    allow.onclick = () => answer(true);
    deny.onclick = () => answer(false);
    pendingAnswer = (ok) => {
      if (buttons.isConnected) answer(ok);
    };
    buttons.append(allow, deny);
    card.appendChild(buttons);
    setStatus("Waiting for your approval", "busy");
    setTimeout(() => allow.focus(), 0);
  }
  actionCards.set(action.id, card);
  return add(card);
}

function actionImage({ id, dataUrl }) {
  const card = actionCards.get(id);
  if (!card || !/^data:image\/(jpeg|png);base64,/.test(dataUrl)) return;
  const img = el("img", "masked");
  img.src = dataUrl;
  img.alt = "Screenshot after on-device masking";
  card.appendChild(img);
  card.appendChild(el("div", "img-caption", "What the model receives: black boxes were masked on this computer."));
  scroll();
}

function actionProgress({ id, text }) {
  const card = actionCards.get(id);
  if (!card) return;
  let list = card.querySelector(".progress");
  if (!list) {
    list = el("ul", "progress");
    card.appendChild(list);
  }
  list.appendChild(el("li", "", text));
  setStatus("Browser agent working...", "busy");
  scroll();
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
    case "action_progress":
      actionProgress(ev);
      break;
    case "action_image":
      actionImage(ev);
      break;
    case "action_result":
      actionResult(ev);
      break;
    case "reply":
      hideTyping();
      add(el("div", "msg bot", ev.text));
      speak(ev.text);
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

// --- voice: push-to-talk in, spoken replies out, both on this machine ---
// Recording happens here; the audio is resampled to 16 kHz mono (what Whisper expects) by
// decoding through an AudioContext at that rate, then transcribed by Whisper in the main
// process. Replies are read out with the OS speech engine. No audio leaves the computer.
const micBtn = $("micBtn");
const speakBtn = $("speak");
let voiceOut = true;
let recorder = null;
let chunks = [];

try {
  voiceOut = localStorage.getItem("jarvis.voiceOut") !== "off";
} catch {}
speakBtn.setAttribute("aria-pressed", String(voiceOut));

function speak(text) {
  if (!voiceOut || !("speechSynthesis" in window) || !text) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 600)));
}

speakBtn.onclick = () => {
  voiceOut = !voiceOut;
  speakBtn.setAttribute("aria-pressed", String(voiceOut));
  if (!voiceOut) speechSynthesis.cancel();
  try {
    localStorage.setItem("jarvis.voiceOut", voiceOut ? "on" : "off");
  } catch {}
};

async function startListening() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    add(el("div", "msg error", `Microphone unavailable: ${err.message}`));
    return;
  }
  speechSynthesis.cancel();
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  micBtn.classList.add("listening");
  setStatus("Listening... click the mic again to stop", "busy");
}

async function stopListening() {
  const rec = recorder;
  recorder = null;
  micBtn.classList.remove("listening");
  const blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }));
    rec.stop();
  });
  rec.stream.getTracks().forEach((t) => t.stop());
  micBtn.classList.add("busy");
  setStatus("Transcribing on this computer...", "busy");
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    ctx.close();
    // Whisper "hears" words in pure silence (famously "you"); don't transcribe a quiet clip.
    let energy = 0;
    for (let i = 0; i < mono.length; i++) energy += mono[i] * mono[i];
    if (!mono.length || Math.sqrt(energy / mono.length) < 0.004) {
      setStatus("Didn't hear anything. Try again.", "error");
      return;
    }
    const res = await window.jarvis.transcribe(mono);
    if (!res.ok) throw new Error(res.error);
    handleSpoken(res.text);
  } catch (err) {
    add(el("div", "msg error", `Voice input failed: ${err.message}`));
    setStatus("Ready");
  } finally {
    micBtn.classList.remove("busy");
  }
}

// A spoken yes/no answers an open approval card; anything else is a new message.
function handleSpoken(text) {
  const said = (text || "").trim();
  if (!said) {
    setStatus("Didn't catch that. Try again.", "error");
    return;
  }
  if (pendingAnswer) {
    if (/\b(yes|allow|go ahead|do it|approve|okay|ok)\b/i.test(said)) return pendingAnswer(true);
    if (/\b(no|deny|stop|cancel|don't)\b/i.test(said)) return pendingAnswer(false);
  }
  if (busy) {
    input.value = said;
    autosize();
    setStatus("Still working. Your words are in the box.", "busy");
    return;
  }
  submit(said);
}

micBtn.onclick = () => (recorder ? stopListening() : startListening());

// settings
const sheet = $("settings");
async function openSettings() {
  const c = await window.jarvis.getConfig();
  $("cfgBase").value = c.baseUrl;
  $("cfgModel").value = c.model;
  $("cfgHub").value = c.hubUrl;
  $("cfgKey").value = "";
  $("cfgKey").placeholder = c.hasKey
    ? "Saved (leave blank to keep)"
    : c.needsKey
      ? "Paste your API key"
      : "Not needed: the SIH server holds the key";
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
    hubUrl: $("cfgHub").value,
    apiKey: $("cfgKey").value,
    autoApproveLow: $("cfgAuto").checked,
  });
  sheet.hidden = true;
  input.focus();
};

window.jarvis.getConfig().then((c) => {
  if (c.needsKey && !c.hasKey) openSettings();
});
input.focus();
