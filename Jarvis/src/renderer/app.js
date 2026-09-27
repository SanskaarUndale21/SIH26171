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
  browser_task: "Hand this to the browser agent",
  look_at_screen: "Look at your screen",
  open_url: "Open a link",
  open_app: "Open an app",
  run_command: "Run a command",
  type_text: "Type into your last window",
  read_clipboard: "Read your clipboard",
  write_clipboard: "Copy to your clipboard",
};

// Plain names for the placeholder types in the black bars.
const MASK_NAMES = { EMAIL: "email", PHONE: "phone", CARD: "card", AADHAAR: "aadhaar", PAN: "pan", SECRET: "secret", IP: "ip address" };

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
  if (on) setStatus("Working", "busy");
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

// "Masked before sending: [email] [phone ×2]" as redaction bars.
function maskNote(where, kinds, count) {
  const note = el("div", "note");
  note.appendChild(el("span", "", where === "message" ? "Masked before sending:" : "Masked in the result before the model saw it:"));
  kinds.forEach((k, i) => {
    const bar = el("span", "mask", MASK_NAMES[k] || k.toLowerCase());
    bar.style.animationDelay = `${i * 60}ms`;
    note.appendChild(bar);
  });
  note.title = `${count} private item${count > 1 ? "s" : ""} replaced with placeholders on this computer`;
  return note;
}

// Placeholders such as [EMAIL_1] are shown as the redaction bars they stand for, so what
// leaves the computer reads the same way everywhere in the app.
const PLACEHOLDER = /\[(EMAIL|PHONE|CARD|AADHAAR|PAN|SECRET|IP)_(\d+)\]/g;
function withMasks(node, text) {
  let last = 0;
  for (const m of String(text).matchAll(PLACEHOLDER)) {
    node.append(text.slice(last, m.index));
    const bar = el("span", "mask static", MASK_NAMES[m[1]] || m[1].toLowerCase());
    if (m[2] !== "1") bar.appendChild(el("span", "n", m[2]));
    bar.title = `${m[0]}: the real value stays on this computer`;
    node.appendChild(bar);
    last = m.index + m[0].length;
  }
  node.append(String(text).slice(last));
  return node;
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
  const card = el("div", auto ? "action" : "action waiting");
  card.appendChild(el("p", "action-name", TOOL_LABELS[action.name] || action.name));
  const sub = el("p", "action-sub", auto ? "Ran without asking, as set in Settings" : "Waits for your OK. You can also say yes or no.");
  card.appendChild(sub);
  card.appendChild(withMasks(el("pre"), describeArgs(action.name, action.args)));

  if (!auto) {
    const buttons = el("div", "buttons");
    const allow = el("button", "primary", "Allow");
    const deny = el("button", "deny", "Don't allow");
    const answer = (ok) => {
      pendingAnswer = null;
      window.jarvis.answer(action.id, ok);
      buttons.remove();
      card.classList.remove("waiting");
      sub.textContent = ok ? "You allowed this." : "You didn't allow this.";
      if (!ok) sub.classList.add("verdict", "no");
      setStatus(ok ? "Working" : "Ready", ok ? "busy" : "");
    };
    allow.onclick = () => answer(true);
    deny.onclick = () => answer(false);
    pendingAnswer = (ok) => {
      if (buttons.isConnected) answer(ok);
    };
    buttons.append(allow, deny);
    card.appendChild(buttons);
    setStatus("Waiting for your OK", "busy");
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
  card.appendChild(el("p", "img-caption", "This is exactly what the model receives. The black boxes were masked on this computer."));
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
  list.appendChild(withMasks(el("li"), text));
  setStatus("Working", "busy");
  scroll();
}

function actionResult({ id, ok, result }) {
  const card = actionCards.get(id);
  if (!card || !ok) return;
  const det = el("details", "result");
  det.appendChild(el("summary", "", "Show the result"));
  det.appendChild(el("pre", "", result));
  card.appendChild(det);
  scroll();
}

window.jarvis.on("agent:event", (ev) => {
  switch (ev.type) {
    case "thinking":
      showTyping();
      break;
    case "redacted":
      hideTyping();
      add(maskNote(ev.where, ev.kinds, ev.count));
      break;
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
  input.style.overflowY = input.scrollHeight > 140 ? "auto" : "hidden";
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
