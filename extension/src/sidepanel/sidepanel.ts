import type { NextActionResponse, RedactionEntry, RiskTier, RunMetrics, StepMetrics } from "../types";
import type { ExtensionMessage } from "../messages";
import { clearVault } from "../privacy/vault";

const messagesEl = document.getElementById("messages") as HTMLElement;
const composer = document.getElementById("composer") as HTMLFormElement;
const goalInput = document.getElementById("goal") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
const sendLabel = document.getElementById("sendLabel") as HTMLSpanElement;
const micButton = document.getElementById("mic") as HTMLButtonElement;
const voiceToggle = document.getElementById("voiceToggle") as HTMLButtonElement;
const clearVaultButton = document.getElementById("clearVault") as HTMLButtonElement;
const serverStatusEl = document.getElementById("serverStatus") as HTMLParagraphElement;

const SERVER_BASE = "http://localhost:8100";

let activeRunId: string | null = null;
let workingEl: HTMLElement | null = null;
let stepsEl: HTMLOListElement | null = null;
let introEl: HTMLElement | null = null;
let pendingConfirmRespond: ((approved: boolean) => void) | null = null;
let pendingAskUserRespond: ((answer: string | null) => void) | null = null;
let voiceEnabled = true;

// ---------- small DOM helpers (textContent only: nothing from a page or model is parsed as HTML)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function add<T extends HTMLElement>(node: T): T {
  introEl?.remove();
  introEl = null;
  messagesEl.appendChild(node);
  scrollToBottom();
  return node;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

// Readable names for redaction types, used inside the black bars.
const TYPE_NAMES: Record<string, string> = {
  password_field: "password",
  card_number: "card",
  phone_number: "phone",
  person_name: "name",
  date_of_birth: "birth date",
  bank_account: "account no.",
  ip_address: "ip address"
};
const typeName = (t: string) => TYPE_NAMES[t] ?? t.replace(/_/g, " ");

// ---------- voice out

function speak(text: string): void {
  if (!voiceEnabled || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // speech is a convenience; never let it break the log
  }
}

// ---------- building blocks

function setWorking(text: string | null): void {
  workingEl?.remove();
  workingEl = text ? add(el("p", "note working", text)) : null;
}

function masksFor(manifest: RedactionEntry[]): HTMLDivElement | null {
  if (!manifest.length) return null;
  const groups = new Map<string, { n: number; weak: boolean; conf: number[] }>();
  for (const entry of manifest) {
    const g = groups.get(entry.type) ?? { n: 0, weak: false, conf: [] };
    g.n++;
    g.conf.push(entry.confidence);
    if (entry.confidence < 0.5) g.weak = true;
    groups.set(entry.type, g);
  }
  const row = el("div", "masks");
  row.setAttribute("aria-label", `${manifest.length} regions masked before sending`);
  let i = 0;
  for (const [type, g] of groups) {
    const bar = el("span", g.weak ? "mask weak" : "mask", typeName(type));
    if (g.n > 1) bar.appendChild(el("span", "n", `×${g.n}`));
    bar.title = `${typeName(type)}: confidence ${g.conf.map((c) => Math.round(c * 100) + "%").join(", ")}${
      g.weak ? " (weak, masked anyway)" : ""
    }`;
    bar.style.animationDelay = `${i++ * 60}ms`;
    row.appendChild(bar);
  }
  return row;
}

function latencyStrip(local: number, remote: number, act: number, label: string): HTMLDivElement {
  const strip = el("div", "lat");
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", label);
  const total = Math.max(local + remote + act, 1);
  for (const [cls, v] of [["local", local], ["remote", remote], ["act", act]] as const) {
    const seg = el("span", cls);
    seg.style.flexGrow = String(v / total);
    strip.appendChild(seg);
  }
  return strip;
}

function stepTitle(action: NextActionResponse | undefined, status: string): HTMLParagraphElement {
  const p = el("p", "step-title");
  const failed = /failed|error/i.test(status);
  if (!action || failed || action.action === "ask_user") {
    p.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    return p;
  }
  const sel = action.target.selector;
  const verbs: Record<string, string> = {
    click: "Clicked",
    type: "Filled in",
    scroll: "Scrolled the page",
    navigate: "Went to",
    open_tab: "Opened a tab at",
    none: "Finished the task"
  };
  p.append(verbs[action.action] ?? action.action);
  const where = action.action === "navigate" || action.action === "open_tab" ? action.value : sel;
  if (where && action.action !== "scroll" && action.action !== "none") {
    p.append(" ");
    p.appendChild(el("code", "", where));
  }
  return p;
}

function sentDetails(action: NextActionResponse | undefined, m: StepMetrics | undefined): HTMLDetailsElement {
  const details = el("details", "sent");
  details.appendChild(el("summary", "", "What was measured and sent"));
  if (m) {
    const d = m.context.detectors;
    const rows: [string, string][] = [
      ["Sent to planner", `${m.payloadKB.toFixed(0)} KB, masked image and field types only`],
      ["Memory in use", m.context.heapMB !== null ? `${m.context.heapMB} MB` : "not reported"],
      ["Runs on", m.context.webgpu ? "WebGPU, WASM fallback" : "WASM"],
      ["Capture", fmtMs(m.captureMs)],
      ["Text reading (OCR)", fmtMs(d.ocrMs)],
      ["Faces", fmtMs(d.facesMs)],
      ["Objects (YOLO)", fmtMs(d.yoloMs)],
      ["Layout (Florence-2)", fmtMs(d.florenceMs)],
      ["Names (NER)", fmtMs(d.nerMs)],
      ["Planner, server side", m.serverMs !== null ? fmtMs(m.serverMs) : "not reported"]
    ];
    const dl = el("dl");
    for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
    details.appendChild(dl);
  }
  if (action) details.appendChild(el("pre", "", JSON.stringify(action, null, 2)));
  return details;
}

function ensureSteps(): HTMLOListElement {
  if (!stepsEl || !stepsEl.isConnected) stepsEl = add(el("ol", "steps"));
  return stepsEl;
}

function addStep(step: number, status: string, action?: NextActionResponse, manifest?: RedactionEntry[], m?: StepMetrics): void {
  const li = el("li", /failed|error/i.test(status) ? "step failed" : "step");
  li.appendChild(el("div", "step-n", String(step)));
  const body = el("div", "step-body");
  body.appendChild(stepTitle(action, status));
  const masks = masksFor(manifest ?? []);
  if (masks) body.appendChild(masks);
  if (m) {
    const local = m.captureMs + m.context.totalMs;
    body.appendChild(
      latencyStrip(local, m.plannerMs, m.execMs, `${fmtMs(local)} on this device, ${fmtMs(m.plannerMs)} at the planner`)
    );
    const text = el("p", "lat-text");
    text.append(el("b", "", fmtMs(m.stepMs)), ` total, ${fmtMs(local)} on this device, ${fmtMs(m.plannerMs)} planner`);
    body.appendChild(text);
  }
  body.appendChild(sentDetails(action, m));
  li.appendChild(body);
  ensureSteps().appendChild(li);
  // keep the working indicator below the newest step
  if (workingEl) messagesEl.appendChild(workingEl);
  scrollToBottom();
}

function addRunSummary(m: RunMetrics): void {
  if (!m.steps) return;
  const box = el("section", "summary");
  box.setAttribute("aria-label", "Run summary");
  box.appendChild(el("h2", "", `Finished in ${fmtMs(m.totalMs)}`));
  const local = m.avgPerceptionMs;
  const remote = m.avgPlannerMs;
  const other = Math.max(m.avgStepMs - local - remote, 0);
  box.appendChild(latencyStrip(local, remote, other, `Average step: ${fmtMs(local)} on this device, ${fmtMs(remote)} at the planner`));
  box.appendChild(el("p", "lat-text", `Average step ${fmtMs(m.avgStepMs)}: ${fmtMs(local)} on this device, ${fmtMs(remote)} at the planner`));
  const dl = el("dl");
  const cell = (k: string, v: string, unit?: string) => {
    const pair = el("div");
    const dd = el("dd", "", v);
    if (unit) dd.appendChild(el("small", "", ` ${unit}`));
    pair.append(el("dt", "", k), dd);
    dl.appendChild(pair);
  };
  cell("Steps", String(m.steps));
  cell("Regions masked", String(m.totalRedactions));
  cell("Sent to planner", m.sentKB.toFixed(0), "KB");
  cell("Peak memory", m.peakHeapMB !== null ? String(m.peakHeapMB) : "n/a", m.peakHeapMB !== null ? "MB" : undefined);
  box.appendChild(dl);
  add(box);
}

// ---------- running state

function setRunning(running: boolean): void {
  sendButton.classList.toggle("running", running);
  sendButton.title = running ? "Stop" : "Run";
  sendLabel.textContent = running ? "Stop" : "Run";
  if (!running) {
    activeRunId = null;
    setWorking(null);
    stepsEl = null;
  }
}

// ---------- prompts that wait for the person

function addConfirmPrompt(requestId: string, action: NextActionResponse, _riskTier: RiskTier, unfilled: string[]): void {
  setWorking(null);
  const box = el("section", "prompt");
  box.appendChild(el("h2", "", "Needs your OK"));
  const target = action.target.selector ? ` ${action.target.selector}` : "";
  const text = `The next step is to ${action.action === "click" ? "click" : action.action}${target}. That can submit, pay or delete, so it waits for you.`;
  box.appendChild(el("p", "", text));
  if (unfilled.length) {
    box.appendChild(el("p", "", "These are still empty, because the agent never fills them for you:"));
    const list = el("div", "still-empty");
    for (const t of unfilled) list.appendChild(el("span", "", typeName(t)));
    box.appendChild(list);
  }
  const row = el("div", "row");
  const yes = el("button", "btn go", "Go ahead");
  const no = el("button", "btn quiet", "Stop here");
  row.append(yes, no);
  box.appendChild(row);
  box.appendChild(el("p", "hint", "You can also say yes or no."));

  const respond = (approved: boolean) => {
    chrome.runtime.sendMessage({ type: "CONFIRM_RESPONSE", requestId, approved });
    row.replaceWith(el("p", "answered", approved ? "You said go ahead." : "You stopped it here."));
    box.querySelector(".hint")?.remove();
    if (pendingConfirmRespond === respond) pendingConfirmRespond = null;
    if (approved) setWorking("Working");
  };
  pendingConfirmRespond = respond;
  yes.addEventListener("click", () => respond(true));
  no.addEventListener("click", () => respond(false));
  add(box);
  speak(`${text} Go ahead?`);
  yes.focus();
}

// A field the planner has no value for. The answer goes straight to the page through the
// background script and is never sent to the server (see background/index.ts, ask_user).
function addAskUserPrompt(requestId: string, question: string): void {
  setWorking(null);
  const box = el("section", "prompt local");
  box.appendChild(el("h2", "", question));
  const input = el("input");
  input.type = "text";
  input.setAttribute("aria-label", question);
  input.placeholder = "Your answer";
  const row = el("div", "row");
  const fill = el("button", "btn go", "Fill it in");
  const skip = el("button", "btn quiet", "Skip");
  row.append(fill, skip);
  box.append(input, row, el("p", "hint", "Your answer is typed into the page from here. It never goes to the planner."));

  const respond = (answer: string | null) => {
    chrome.runtime.sendMessage({ type: "ASK_USER_RESPONSE", requestId, answer });
    input.remove();
    row.replaceWith(el("p", "answered", answer ? "Filled in. Kept in this browser only." : "Skipped."));
    if (pendingAskUserRespond === respond) pendingAskUserRespond = null;
    setWorking("Working");
  };
  pendingAskUserRespond = respond;
  fill.addEventListener("click", () => respond(input.value.trim() || null));
  skip.addEventListener("click", () => respond(null));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      respond(input.value.trim() || null);
    }
  });
  add(box);
  speak(question);
  input.focus();
}

// ---------- running a task

function addYou(text: string, fromJarvis = false): void {
  const bubble = el("div", "you");
  if (fromJarvis) bubble.appendChild(el("span", "from", "Sent from Jarvis"));
  bubble.append(text);
  add(bubble);
}

function autoGrow(): void {
  goalInput.style.height = "auto";
  goalInput.style.height = `${Math.min(goalInput.scrollHeight, 110)}px`;
}

function runTask(): void {
  const taskGoal = goalInput.value.trim();
  if (!taskGoal || activeRunId) return;
  addYou(taskGoal);
  goalInput.value = "";
  autoGrow();
  setRunning(true);
  setWorking("Reading the page and masking private data on this device");

  chrome.runtime.sendMessage({ type: "RUN_TASK", taskGoal }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      setRunning(false);
      add(el("p", "error", `Couldn't start: ${chrome.runtime.lastError?.message ?? response?.error ?? "unknown error"}`));
      return;
    }
    activeRunId = response.runId as string;
  });
}

function adoptRemoteRun(runId: string, taskGoal: string): void {
  if (activeRunId === runId) return;
  addYou(taskGoal, true);
  setRunning(true);
  activeRunId = runId;
  setWorking("Reading the page and masking private data on this device");
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  switch (message.type) {
    case "TASK_STEP":
      if (message.runId !== activeRunId) return;
      addStep(message.step, message.status, message.action, message.redactionManifest, message.metrics);
      speak(message.status);
      setWorking("Working");
      return;
    case "TASK_DONE":
      if (message.runId !== activeRunId) return;
      setRunning(false);
      if (message.reason === "error") add(el("p", "error", message.message));
      else add(el("p", "done", message.message));
      if (message.metrics) addRunSummary(message.metrics);
      speak(message.message);
      return;
    case "TASK_STARTED":
      if (message.source === "jarvis") adoptRemoteRun(message.runId, message.taskGoal);
      return;
    case "CONFIRM_REQUEST":
      if (message.runId !== activeRunId) return;
      addConfirmPrompt(message.requestId, message.action, message.riskTier, message.unfilledSensitiveTypes);
      return;
    case "ASK_USER_REQUEST":
      if (message.runId !== activeRunId) return;
      addAskUserPrompt(message.requestId, message.question);
      return;
  }
});

// ---------- voice in: recorded here, transcribed by Whisper on this device (perception/asr.ts)
// Chrome's SpeechRecognition isn't available to extension pages and would send audio to
// Google anyway; this records with getUserMedia and never lets audio leave the browser.

let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

async function startRecording(): Promise<void> {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    add(el("p", "error", `Microphone is blocked or missing. Allow it for this extension and try again. (${String(err)})`));
    return;
  }
  window.speechSynthesis?.cancel();
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.start();
  micButton.classList.add("listening");
  micButton.title = "Stop and transcribe";
}

async function stopRecordingAndTranscribe(): Promise<void> {
  const recorder = mediaRecorder;
  if (!recorder) return;
  const blob: Blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(audioChunks, { type: recorder.mimeType }));
    recorder.stop();
  });
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  micButton.classList.remove("listening");
  micButton.title = "Speak your task (transcribed on this device)";

  const note = add(el("p", "note working", "Transcribing on this device"));
  try {
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const samples = decoded.numberOfChannels > 1 ? mixToMono(decoded) : decoded.getChannelData(0);
    void audioCtx.close();
    // Whisper "hears" words in silence, so a quiet clip is rejected before transcribing.
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    if (!samples.length || Math.sqrt(energy / samples.length) < 0.004) {
      note.remove();
      add(el("p", "error", "Didn't hear anything. Try again a little closer to the mic."));
      return;
    }
    const { transcribeAudio } = await import("../perception/asr");
    const text = await transcribeAudio(samples);
    note.remove();
    if (!text) {
      add(el("p", "error", "Didn't catch any words. Try again."));
      return;
    }
    const lower = text.toLowerCase();
    if (pendingAskUserRespond) {
      pendingAskUserRespond(text);
      return;
    }
    if (pendingConfirmRespond) {
      if (/\b(yes|confirm|go ahead|do it|proceed)\b/.test(lower)) return pendingConfirmRespond(true);
      if (/\b(no|stop|cancel)\b/.test(lower)) return pendingConfirmRespond(false);
    }
    goalInput.value = text;
    autoGrow();
    runTask();
  } catch (err) {
    note.remove();
    add(el("p", "error", `Transcription failed: ${String(err)}`));
  }
}

micButton.addEventListener("click", () => {
  if (mediaRecorder) void stopRecordingAndTranscribe();
  else void startRecording();
});

// ---------- header tools

try {
  voiceEnabled = localStorage.getItem("fpa.voice") !== "off";
} catch {
  // storage can be unavailable; spoken progress simply stays on
}
voiceToggle.setAttribute("aria-pressed", String(voiceEnabled));
voiceToggle.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  voiceToggle.setAttribute("aria-pressed", String(voiceEnabled));
  if (!voiceEnabled) window.speechSynthesis?.cancel();
  try {
    localStorage.setItem("fpa.voice", voiceEnabled ? "on" : "off");
  } catch {
    // ignore
  }
});

clearVaultButton.addEventListener("click", async () => {
  await clearVault();
  add(el("p", "done", "Forgot every saved answer. It will ask again next time."));
});

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (activeRunId) {
    chrome.runtime.sendMessage({ type: "CANCEL_TASK", runId: activeRunId });
    return;
  }
  runTask();
});
goalInput.addEventListener("input", autoGrow);
goalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runTask();
  }
});

// ---------- Jarvis hand-off: while this panel is open, check for queued tasks every 1.5 s
// (the background's own alarm only fires every 30 s).

setInterval(() => {
  if (activeRunId) return;
  chrome.runtime.sendMessage({ type: "POLL_REMOTE_TASK" }, (response) => {
    if (chrome.runtime.lastError || !response?.started) return;
    adoptRemoteRun(response.started.runId, response.started.taskGoal);
  });
}, 1500);

// ---------- server status in the header

async function refreshServerStatus(): Promise<void> {
  try {
    const res = await fetch(`${SERVER_BASE}/health`, { signal: AbortSignal.timeout(2500) });
    const info = await res.json();
    const model = String(info.planner_model ?? "unknown").split("/").pop();
    serverStatusEl.textContent = info.open_weights
      ? `Planner online, ${model}, open weights`
      : `Planner online, ${model}, not open weights`;
    serverStatusEl.dataset.state = info.open_weights ? "ok" : "warn";
  } catch {
    serverStatusEl.textContent = "Planner offline. Start it with node scripts/dev.mjs demo";
    serverStatusEl.dataset.state = "down";
  }
}
void refreshServerStatus();
setInterval(() => void refreshServerStatus(), 10000);

// ---------- first screen: what the colours mean, then get out of the way

function showIntro(): void {
  const box = el("div", "intro");
  box.appendChild(el("p", "", "Open a page and say what to do. Before anything is sent, private details on the screen are blacked out on this device."));
  const legend = el("ul", "legend");
  const item = (swatch: HTMLElement, text: string) => {
    const li = el("li");
    li.append(swatch, text);
    legend.appendChild(li);
  };
  item(el("span", "swatch local"), "Work done on this device");
  item(el("span", "swatch remote"), "Time spent at the planner server");
  const bar = el("span", "mask", "email");
  bar.style.animation = "none";
  item(bar, "Masked before sending");
  box.appendChild(legend);
  messagesEl.appendChild(box);
  introEl = box;
}
showIntro();
